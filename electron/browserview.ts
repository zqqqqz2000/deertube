import { BrowserWindow, WebContentsView, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { JsonValue } from "../src/types/json";
import { isJsonObject } from "../src/types/json";
import type { BrowserViewReferenceHighlight } from "../src/types/browserview";

interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserViewSelectionPayload {
  text?: JsonValue;
  url?: JsonValue;
  title?: JsonValue;
  rect?: JsonValue;
}

interface BrowserViewState {
  tabId: string;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_PRELOAD = path.join(__dirname, "preload.mjs");
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_SELECTION_LENGTH = 5000;
const MAX_HIGHLIGHT_TEXT_LENGTH = 4000;

const isAllowedUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
};

const sanitizeSelection = (payload: BrowserViewSelectionPayload) => {
  const text = typeof payload.text === "string" ? payload.text : "";
  const url = typeof payload.url === "string" ? payload.url : "";
  const title = typeof payload.title === "string" ? payload.title : undefined;
  const rectRaw = payload.rect;
  const rect =
    rectRaw &&
    isJsonObject(rectRaw) &&
    "x" in rectRaw &&
    "y" in rectRaw &&
    "width" in rectRaw &&
    "height" in rectRaw
      ? {
          x: Number(rectRaw.x),
          y: Number(rectRaw.y),
          width: Number(rectRaw.width),
          height: Number(rectRaw.height),
        }
      : undefined;

  return {
    text: text.length > MAX_SELECTION_LENGTH ? `${text.slice(0, MAX_SELECTION_LENGTH)}...` : text,
    url,
    title,
    rect,
  };
};

const sanitizeReferenceHighlight = (
  payload: BrowserViewReferenceHighlight,
): BrowserViewReferenceHighlight => {
  const text = payload.text.trim();
  return {
    refId: payload.refId,
    text:
      text.length > MAX_HIGHLIGHT_TEXT_LENGTH
        ? `${text.slice(0, MAX_HIGHLIGHT_TEXT_LENGTH)}...`
        : text,
    startLine: payload.startLine,
    endLine: payload.endLine,
  };
};

function runReferenceHighlightScript(payload: { refId: number; text: string }) {
  const markerAttribute = "data-deertube-ref-highlight";
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/\s+/g, " ").trim();
  const tokenized = (value: string): string[] =>
    normalize(value)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .slice(0, 24);

  const excerpt = typeof payload.text === "string" ? payload.text : "";
  const targetText = normalize(excerpt);
  if (!targetText || !document.body) {
    return { ok: false, reason: "empty-target" };
  }

  const tokens = tokenized(excerpt);
  const selector = "p,li,blockquote,pre,code,h1,h2,h3,h4,h5,h6,td,th,article,section,main,div";

  let bestMatch:
    | {
        element: HTMLElement;
        score: number;
        exact: boolean;
      }
    | null = null;
  const seenElements = new Set<HTMLElement>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let currentNode: Node | null = walker.nextNode();

  while (currentNode) {
    const parent = currentNode.parentElement;
    if (!parent) {
      currentNode = walker.nextNode();
      continue;
    }
    const tag = parent.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") {
      currentNode = walker.nextNode();
      continue;
    }
    const container = parent.closest<HTMLElement>(selector) ?? parent;
    if (seenElements.has(container)) {
      currentNode = walker.nextNode();
      continue;
    }
    seenElements.add(container);

    const content = normalize(container.innerText || container.textContent || "");
    if (!content) {
      currentNode = walker.nextNode();
      continue;
    }

    const exact = content.includes(targetText);
    let score = exact ? 1000 + Math.min(400, targetText.length) : 0;
    for (const token of tokens) {
      if (content.includes(token)) {
        score += 20;
      }
    }
    score -= Math.min(Math.abs(content.length - targetText.length) / 40, 100);
    if (score <= 0) {
      currentNode = walker.nextNode();
      continue;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        element: container,
        score,
        exact,
      };
    }

    currentNode = walker.nextNode();
  }

  if (!bestMatch) {
    return { ok: false, reason: "not-found" };
  }

  const previousHighlighted = document.querySelectorAll<HTMLElement>(`[${markerAttribute}="true"]`);
  previousHighlighted.forEach((element) => {
    if (element === bestMatch?.element) {
      return;
    }
    element.removeAttribute(markerAttribute);
    element.style.backgroundColor = "";
    element.style.boxShadow = "";
  });

  const target = bestMatch.element;
  target.setAttribute(markerAttribute, "true");
  target.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });
  target.style.transition = "background-color 1200ms ease, box-shadow 600ms ease";
  target.style.backgroundColor = "rgba(255, 235, 59, 0.55)";
  target.style.boxShadow = "0 0 0 3px rgba(255, 193, 7, 0.6)";

  window.setTimeout(() => {
    target.style.backgroundColor = "rgba(255, 235, 59, 0.18)";
    target.style.boxShadow = "0 0 0 1px rgba(255, 193, 7, 0.4)";
  }, 1800);
  window.setTimeout(() => {
    target.style.backgroundColor = "";
    target.style.boxShadow = "";
  }, 3600);

  return { ok: true, refId: payload.refId, score: bestMatch.score, exact: bestMatch.exact };
}

class BrowserViewController {
  private window: BrowserWindow | null = null;
  private views = new Map<string, WebContentsView>();
  private viewState = new Map<string, { url: string | null; bounds: BrowserViewBounds | null }>();
  private pendingHighlights = new Map<string, BrowserViewReferenceHighlight>();
  private senderToTab = new Map<number, string>();
  private listenersRegistered = false;

  attachWindow(window: BrowserWindow) {
    this.window = window;
  }

  private ensureView(tabId: string) {
    if (!this.window) {
      return null;
    }
    const existing = this.views.get(tabId);
    if (existing) {
      return existing;
    }
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: BROWSER_PRELOAD,
      },
    });
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.registerWebContentsHandlers(tabId, view);
    this.views.set(tabId, view);
    this.viewState.set(tabId, { url: null, bounds: null });
    return view;
  }

  private registerWebContentsHandlers(tabId: string, view: WebContentsView) {
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    view.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedUrl(url)) {
        event.preventDefault();
        return;
      }
      const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
      this.viewState.set(tabId, { ...state, url });
      this.sendState(tabId);
    });

    const handleNav = (_event: Electron.Event, url: string) => {
      if (isAllowedUrl(url)) {
        const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
        this.viewState.set(tabId, { ...state, url });
      }
      this.sendState(tabId);
    };

    view.webContents.on("did-navigate", handleNav);
    view.webContents.on("did-navigate-in-page", handleNav);
    view.webContents.on("did-finish-load", () => {
      this.sendState(tabId);
      void this.applyPendingHighlight(tabId);
    });
    view.webContents.on("page-title-updated", (_event, title) => {
      this.sendState(tabId, { title });
    });

    this.senderToTab.set(view.webContents.id, tabId);

    if (this.listenersRegistered) {
      return;
    }
    this.listenersRegistered = true;
    ipcMain.on("browserview-selection", (event, payload) => {
      const senderId = event.sender.id;
      const selectionTabId = this.senderToTab.get(senderId);
      if (!selectionTabId) {
        return;
      }
      const viewForSender = this.views.get(selectionTabId);
      if (!viewForSender || event.sender !== viewForSender.webContents) {
        return;
      }
      if (!this.window) {
        return;
      }
      const selection = sanitizeSelection(payload as BrowserViewSelectionPayload);
      const state = this.viewState.get(selectionTabId);
      this.window.webContents.send("browserview-selection", {
        ...selection,
        tabId: selectionTabId,
        viewBounds: state?.bounds ?? null,
      });
    });
  }

  private sendState(tabId: string, partial?: Partial<BrowserViewState>) {
    if (!this.window) {
      return;
    }
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    const state = this.viewState.get(tabId);
    const payload: BrowserViewState = {
      tabId,
      url: state?.url ?? view.webContents.getURL(),
      title: view.webContents.getTitle(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
      ...partial,
    };
    this.window.webContents.send("browserview-state", payload);
  }

  private async applyPendingHighlight(tabId: string): Promise<boolean> {
    const view = this.views.get(tabId);
    if (!view) {
      return false;
    }
    const payload = this.pendingHighlights.get(tabId);
    if (!payload) {
      return false;
    }
    if (view.webContents.isLoadingMainFrame()) {
      return false;
    }
    try {
      const result: unknown = await view.webContents.executeJavaScript(
        `(${runReferenceHighlightScript.toString()})(${JSON.stringify({
          refId: payload.refId,
          text: payload.text,
        })})`,
        true,
      );
      const ok = isJsonObject(result) && result.ok === true;
      if (ok) {
        this.pendingHighlights.delete(tabId);
      }
      return ok;
    } catch {
      return false;
    }
  }

  async open(tabId: string, url: string, bounds: BrowserViewBounds) {
    if (!isAllowedUrl(url)) {
      return false;
    }
    const view = this.ensureView(tabId);
    if (!view) {
      return false;
    }
    const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
    const previousUrl = state.url;
    this.viewState.set(tabId, { url, bounds });
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    view.setVisible(true);
    if (previousUrl !== url) {
      await view.webContents.loadURL(url);
    } else {
      this.sendState(tabId);
      void this.applyPendingHighlight(tabId);
    }
    return true;
  }

  updateBounds(tabId: string, bounds: BrowserViewBounds) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    const state = this.viewState.get(tabId) ?? { url: null, bounds: null };
    this.viewState.set(tabId, { ...state, bounds });
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    view.setVisible(true);
  }

  hide() {
    this.views.forEach((view) => {
      view.setVisible(false);
    });
  }

  hideTab(tabId: string) {
    const view = this.views.get(tabId);
    if (view) {
      view.setVisible(false);
    }
  }

  reload(tabId: string) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    view.webContents.reload();
  }

  goBack(tabId: string) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    if (view.webContents.canGoBack()) {
      view.webContents.goBack();
    }
  }

  goForward(tabId: string) {
    const view = this.views.get(tabId);
    if (!view) {
      return;
    }
    if (view.webContents.canGoForward()) {
      view.webContents.goForward();
    }
  }

  close(tabId: string) {
    const view = this.views.get(tabId);
    if (!view || !this.window) {
      return;
    }
    this.window.contentView.removeChildView(view);
    this.senderToTab.delete(view.webContents.id);
    this.views.delete(tabId);
    this.viewState.delete(tabId);
    this.pendingHighlights.delete(tabId);
  }

  openExternal(url: string) {
    if (isAllowedUrl(url)) {
      void shell.openExternal(url);
    }
  }

  async highlightReference(tabId: string, reference: BrowserViewReferenceHighlight) {
    const view = this.views.get(tabId);
    if (!view) {
      return false;
    }
    const payload = sanitizeReferenceHighlight(reference);
    if (!payload.text) {
      return false;
    }
    this.pendingHighlights.set(tabId, payload);
    return this.applyPendingHighlight(tabId);
  }
}

const browserViewController = new BrowserViewController();

export function getBrowserViewController() {
  return browserViewController;
}
