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
  const inlineMarkerAttribute = "data-deertube-inline-highlight";
  const styleId = "deertube-ref-highlight-style";
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/\s+/g, " ").trim();
  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenized = (value: string): string[] => {
    const normalized = normalize(value);
    const latinTokens = normalized
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    const cjkTokens = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    return Array.from(new Set([...latinTokens, ...cjkTokens])).slice(0, 36);
  };
  const extractPhrases = (excerpt: string): string[] => {
    const lines = excerpt
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 8);
    const sentenceParts = excerpt
      .split(/[。！？!?;；]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 10);
    const merged = [excerpt.trim(), ...lines, ...sentenceParts]
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter((item) => item.length >= 8);
    const unique = Array.from(new Set(merged));
    unique.sort((a, b) => b.length - a.length);
    return unique.slice(0, 12);
  };
  const ensureStyle = () => {
    if (document.getElementById(styleId)) {
      return;
    }
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      mark[${inlineMarkerAttribute}="true"] {
        background: rgba(0, 245, 255, 0.62) !important;
        color: #00121a !important;
        border-radius: 0.18em !important;
        padding: 0 0.08em !important;
        box-shadow: 0 0 0 1px rgba(0, 220, 255, 0.7) inset !important;
      }
    `;
    document.head.appendChild(style);
  };
  const clearExistingHighlights = () => {
    const marks = document.querySelectorAll<HTMLElement>(`mark[${inlineMarkerAttribute}="true"]`);
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) {
        return;
      }
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    });
  };
  const collectTextNodes = (element: HTMLElement): Text[] => {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }
          const tag = parent.tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "noscript" || tag === "textarea") {
            return NodeFilter.FILTER_REJECT;
          }
          if (!node.textContent || node.textContent.trim().length === 0) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }
    return textNodes;
  };
  const findRangeInText = (
    text: string,
    candidates: string[],
  ): { start: number; end: number; phrase: string } | null => {
    for (const candidate of candidates) {
      const phrase = candidate.trim();
      if (phrase.length < 4) {
        continue;
      }
      const regex = new RegExp(escapeRegex(phrase).replace(/\s+/g, "\\s+"), "i");
      const match = regex.exec(text);
      if (match && typeof match.index === "number") {
        return {
          start: match.index,
          end: match.index + match[0].length,
          phrase,
        };
      }
    }
    return null;
  };
  const applyInlineHighlight = (
    element: HTMLElement,
    start: number,
    end: number,
  ): number => {
    if (start < 0 || end <= start) {
      return 0;
    }
    const textNodes = collectTextNodes(element);
    if (textNodes.length === 0) {
      return 0;
    }
    let cursor = 0;
    let wrapped = 0;
    textNodes.forEach((textNode) => {
      const text = textNode.textContent ?? "";
      if (!text) {
        return;
      }
      const nodeStart = cursor;
      const nodeEnd = cursor + text.length;
      cursor = nodeEnd;
      if (end <= nodeStart || start >= nodeEnd) {
        return;
      }
      const overlapStart = Math.max(start, nodeStart);
      const overlapEnd = Math.min(end, nodeEnd);
      const localStart = overlapStart - nodeStart;
      const localEnd = overlapEnd - nodeStart;
      if (localEnd <= localStart) {
        return;
      }
      let workingNode: Text = textNode;
      if (localStart > 0) {
        workingNode = workingNode.splitText(localStart);
      }
      if (localEnd - localStart < workingNode.length) {
        workingNode.splitText(localEnd - localStart);
      }
      const parent = workingNode.parentNode;
      if (!parent) {
        return;
      }
      const mark = document.createElement("mark");
      mark.setAttribute(inlineMarkerAttribute, "true");
      parent.replaceChild(mark, workingNode);
      mark.appendChild(workingNode);
      wrapped += 1;
    });
    return wrapped;
  };

  const excerpt = typeof payload.text === "string" ? payload.text : "";
  const targetText = normalize(excerpt);
  if (!targetText || !document.body) {
    return { ok: false, reason: "empty-target" };
  }

  ensureStyle();
  clearExistingHighlights();

  const tokens = tokenized(excerpt);
  const primarySelector = "p,li,blockquote,pre,code,h1,h2,h3,h4,h5,h6,td,th";
  const fallbackSelector = "article,section,main,div";

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
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "textarea") {
      currentNode = walker.nextNode();
      continue;
    }
    const container =
      parent.closest<HTMLElement>(primarySelector) ??
      parent.closest<HTMLElement>(fallbackSelector) ??
      parent;
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
    let score = exact ? 1400 + Math.min(500, targetText.length) : 0;
    for (const token of tokens) {
      if (content.includes(token)) {
        score += 24;
      }
    }
    score -= Math.min(Math.abs(content.length - targetText.length) / 30, 130);
    score -= Math.min(content.length / 240, 50);
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

  const target = bestMatch.element;
  const textNodes = collectTextNodes(target);
  const combinedText = textNodes.map((node) => node.textContent ?? "").join("");
  if (!combinedText.trim()) {
    return { ok: false, reason: "empty-element-text" };
  }

  const phraseCandidates = extractPhrases(excerpt);
  const tokenCandidates = tokens.sort((a, b) => b.length - a.length);
  const range =
    findRangeInText(combinedText, phraseCandidates) ??
    findRangeInText(combinedText, tokenCandidates) ??
    {
      start: 0,
      end: Math.min(combinedText.length, Math.max(16, Math.min(120, excerpt.trim().length))),
      phrase: excerpt.trim().slice(0, 120),
    };

  const highlightedSegments = applyInlineHighlight(target, range.start, range.end);
  const firstInlineMark = target.querySelector<HTMLElement>(`mark[${inlineMarkerAttribute}="true"]`);
  (firstInlineMark ?? target).scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });

  return {
    ok: highlightedSegments > 0,
    refId: payload.refId,
    score: bestMatch.score,
    exact: bestMatch.exact,
    highlightedSegments,
  };
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
