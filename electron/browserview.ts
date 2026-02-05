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
  private view: WebContentsView | null = null;
  private currentUrl: string | null = null;
  private activeTabId: string | null = null;
  private bounds: BrowserViewBounds | null = null;
  private listenersRegistered = false;

  attachWindow(window: BrowserWindow) {
    this.window = window;
  }

  private ensureView() {
    if (!this.window) {
      return null;
    }
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: BROWSER_PRELOAD,
        },
      });
      this.window.contentView.addChildView(this.view);
      this.view.setVisible(false);
      this.registerWebContentsHandlers(this.view);
    }
    return this.view;
  }

  private registerWebContentsHandlers(view: WebContentsView) {
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
      this.currentUrl = url;
      this.sendState();
    });

    const handleNav = (_event: Electron.Event, url: string) => {
      if (isAllowedUrl(url)) {
        this.currentUrl = url;
      }
      this.sendState();
    };

    view.webContents.on("did-navigate", handleNav);
    view.webContents.on("did-navigate-in-page", handleNav);
    view.webContents.on("page-title-updated", (_event, title) => {
      this.sendState({ title });
    });

    if (this.listenersRegistered) {
      return;
    }
    this.listenersRegistered = true;
    ipcMain.on("browserview-selection", (event, payload) => {
      if (!this.view || event.sender !== this.view.webContents) {
        return;
      }
      if (!this.window || !this.activeTabId) {
        return;
      }
      const selection = sanitizeSelection(payload as BrowserViewSelectionPayload);
      this.window.webContents.send("browserview-selection", {
        ...selection,
        tabId: this.activeTabId,
        viewBounds: this.bounds,
      });
    });
  }

  private sendState(partial?: Partial<BrowserViewState>) {
    if (!this.window || !this.view || !this.activeTabId) {
      return;
    }
    const payload: BrowserViewState = {
      tabId: this.activeTabId,
      url: this.currentUrl ?? this.view.webContents.getURL(),
      title: this.view.webContents.getTitle(),
      canGoBack: this.view.webContents.canGoBack(),
      canGoForward: this.view.webContents.canGoForward(),
      ...partial,
    };
    this.window.webContents.send("browserview-state", payload);
  }

  async open(tabId: string, url: string, bounds: BrowserViewBounds) {
    if (!isAllowedUrl(url)) {
      return false;
    }
    const view = this.ensureView();
    if (!view) {
      return false;
    }
    this.activeTabId = tabId;
    this.bounds = bounds;
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    view.setVisible(true);
    if (this.currentUrl !== url) {
      this.currentUrl = url;
      await view.webContents.loadURL(url);
    } else {
      this.sendState();
    }
    return true;
  }

  updateBounds(tabId: string, bounds: BrowserViewBounds) {
    if (!this.view || this.activeTabId !== tabId) {
      return;
    }
    this.bounds = bounds;
    this.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  hide() {
    if (this.view) {
      this.view.setVisible(false);
    }
  }

  reload(tabId: string) {
    if (!this.view || this.activeTabId !== tabId) {
      return;
    }
    this.view.webContents.reload();
  }

  goBack(tabId: string) {
    if (!this.view || this.activeTabId !== tabId) {
      return;
    }
    if (this.view.webContents.canGoBack()) {
      this.view.webContents.goBack();
    }
  }

  goForward(tabId: string) {
    if (!this.view || this.activeTabId !== tabId) {
      return;
    }
    if (this.view.webContents.canGoForward()) {
      this.view.webContents.goForward();
    }
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
