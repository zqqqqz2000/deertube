import { BrowserWindow, WebContentsView, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserViewSelectionPayload {
  text?: unknown;
  url?: unknown;
  title?: unknown;
  rect?: unknown;
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
    typeof rectRaw === "object" &&
    "x" in rectRaw &&
    "y" in rectRaw &&
    "width" in rectRaw &&
    "height" in rectRaw
      ? {
          x: Number((rectRaw as { x: unknown }).x),
          y: Number((rectRaw as { y: unknown }).y),
          width: Number((rectRaw as { width: unknown }).width),
          height: Number((rectRaw as { height: unknown }).height),
        }
      : undefined;

  return {
    text: text.length > MAX_SELECTION_LENGTH ? `${text.slice(0, MAX_SELECTION_LENGTH)}...` : text,
    url,
    title,
    rect,
  };
};

class BrowserViewController {
  private window: BrowserWindow | null = null;
  private views = new Map<string, WebContentsView>();
  private viewState = new Map<string, { url: string | null; bounds: BrowserViewBounds | null }>();
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
  }

  openExternal(url: string) {
    if (isAllowedUrl(url)) {
      void shell.openExternal(url);
    }
  }
}

const browserViewController = new BrowserViewController();

export function getBrowserViewController() {
  return browserViewController;
}
