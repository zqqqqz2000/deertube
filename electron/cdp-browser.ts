import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { runReferenceHighlightScript } from "./browserview";
import { isJsonObject, type JsonValue } from "../src/types/json";
import type { BrowserViewReferenceHighlight } from "../src/types/browserview";

interface CdpTargetDescriptor {
  id: string;
  webSocketDebuggerUrl: string;
  url?: string;
  title?: string;
}

interface CdpCommandPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CdpSession {
  id: string;
  targetId: string;
  socket: WebSocket;
  nextCommandId: number;
  pending: Map<number, CdpCommandPending>;
  pendingHighlight?: BrowserViewReferenceHighlight;
  lastSelectionSignature: string;
}

interface CdpSelectionBridgePayload {
  text?: JsonValue;
  url?: JsonValue;
  title?: JsonValue;
  rect?: JsonValue;
}

interface SanitizedSelectionPayload {
  text: string;
  url: string;
  title?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

const CDP_ENDPOINT_ORIGIN = "http://127.0.0.1:9222";
const CDP_ENDPOINT_VERSION_PATH = "/json/version";
const CDP_ENDPOINT_LIST_PATH = "/json/list";
const CDP_READY_TIMEOUT_MS = 12000;
const CDP_REQUEST_TIMEOUT_MS = 2500;
const CDP_COMMAND_TIMEOUT_MS = 12000;
const CDP_SELECTION_BINDING_NAME = "__deertubeEmitSelection";
const MAX_SELECTION_LENGTH = 5000;
const SELECTION_THROTTLE_MS = 180;
const MAX_HIGHLIGHT_TEXT_LENGTH = 4000;

const normalizeHttpUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const parseJsonString = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const fetchJson = async (
  url: string,
  init?: RequestInit,
  timeoutMs = CDP_REQUEST_TIMEOUT_MS,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
};

const toMessageText = (data: unknown): string | null => {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(
      "utf-8",
    );
  }
  return null;
};

const sanitizeSelectionPayload = (
  payload: CdpSelectionBridgePayload,
): SanitizedSelectionPayload => {
  const textRaw = typeof payload.text === "string" ? payload.text : "";
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
  const text =
    textRaw.length > MAX_SELECTION_LENGTH
      ? `${textRaw.slice(0, MAX_SELECTION_LENGTH)}...`
      : textRaw;
  return { text, url, title, rect };
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

const buildSelectionBridgeScript = (): string => `
(() => {
  const bindingName = ${JSON.stringify(CDP_SELECTION_BINDING_NAME)};
  const installedKey = "__deertubeSelectionBridgeInstalled";
  if (window[installedKey]) {
    return;
  }
  window[installedKey] = true;
  const maxSelectionLength = ${MAX_SELECTION_LENGTH};
  const throttleMs = ${SELECTION_THROTTLE_MS};
  let lastText = "";
  let lastUrl = "";
  let scheduled = false;
  const emitPayload = (payload) => {
    const binding = window[bindingName];
    if (typeof binding !== "function") {
      return;
    }
    try {
      binding(JSON.stringify(payload));
    } catch {}
  };
  const buildPayload = () => {
    const selection = window.getSelection();
    const rawText = selection ? selection.toString() : "";
    const text =
      rawText.length > maxSelectionLength
        ? rawText.slice(0, maxSelectionLength) + "..."
        : rawText;
    let rect;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const bounds = range.getBoundingClientRect();
      if (bounds && (bounds.width > 0 || bounds.height > 0)) {
        rect = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      }
    }
    return {
      text,
      url: window.location.href,
      title: document.title,
      rect,
    };
  };
  const sendSelection = () => {
    const payload = buildPayload();
    if (payload.text === lastText && payload.url === lastUrl) {
      return;
    }
    lastText = payload.text;
    lastUrl = payload.url;
    emitPayload(payload);
  };
  const scheduleSend = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      sendSelection();
    }, throttleMs);
  };
  document.addEventListener("selectionchange", scheduleSend);
  document.addEventListener("mouseup", sendSelection);
  document.addEventListener("keyup", scheduleSend);
  window.addEventListener("blur", () => {
    emitPayload({
      text: "",
      url: window.location.href,
      title: document.title,
    });
  });
})();
`;

const tryCandidatePaths = async (candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

const getChromeExecutableCandidates = (): string[] => {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
};

class CdpBrowserController {
  private window: BrowserWindow | null = null;
  private chromeProcess: ChildProcess | null = null;
  private sessions = new Map<string, CdpSession>();

  attachWindow(window: BrowserWindow) {
    this.window = window;
  }

  private async isEndpointReady(): Promise<boolean> {
    try {
      await fetchJson(`${CDP_ENDPOINT_ORIGIN}${CDP_ENDPOINT_VERSION_PATH}`);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveChromeExecutable(): Promise<string | null> {
    const fromEnv = process.env.DEERTUBE_CHROME_PATH?.trim();
    if (fromEnv) {
      const found = await tryCandidatePaths([fromEnv]);
      if (found) {
        return found;
      }
    }
    return tryCandidatePaths(getChromeExecutableCandidates());
  }

  private async ensureChromeProcess(): Promise<void> {
    if (this.chromeProcess && !this.chromeProcess.killed) {
      return;
    }
    const executablePath = await this.resolveChromeExecutable();
    if (!executablePath) {
      throw new Error("Chrome executable not found for CDP mode.");
    }
    const userDataDir = path.join(app.getPath("userData"), "cdp-chrome-profile");
    await fs.mkdir(userDataDir, { recursive: true });
    const args = [
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ];
    const processRef = spawn(executablePath, args, {
      stdio: "ignore",
      detached: false,
    });
    processRef.unref();
    processRef.once("exit", () => {
      if (this.chromeProcess === processRef) {
        this.chromeProcess = null;
      }
    });
    this.chromeProcess = processRef;
  }

  private async ensureEndpointReady(): Promise<void> {
    if (await this.isEndpointReady()) {
      return;
    }
    await this.ensureChromeProcess();
    const startedAt = Date.now();
    while (Date.now() - startedAt < CDP_READY_TIMEOUT_MS) {
      if (await this.isEndpointReady()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    throw new Error("CDP endpoint is not reachable at http://127.0.0.1:9222.");
  }

  private parseTargetDescriptor(value: unknown): CdpTargetDescriptor | null {
    if (!isJsonObject(value)) {
      return null;
    }
    const id = typeof value.id === "string" ? value.id : null;
    const webSocketDebuggerUrl =
      typeof value.webSocketDebuggerUrl === "string"
        ? value.webSocketDebuggerUrl
        : null;
    if (!id || !webSocketDebuggerUrl) {
      return null;
    }
    return {
      id,
      webSocketDebuggerUrl,
      url: typeof value.url === "string" ? value.url : undefined,
      title: typeof value.title === "string" ? value.title : undefined,
    };
  }

  private async createTarget(url: string): Promise<CdpTargetDescriptor> {
    const encodedUrl = encodeURIComponent(url);
    const attempts: { init: RequestInit; path: string }[] = [
      { init: { method: "PUT" }, path: `/json/new?${encodedUrl}` },
      { init: { method: "GET" }, path: `/json/new?${encodedUrl}` },
      { init: { method: "PUT" }, path: `/json/new?url=${encodedUrl}` },
      { init: { method: "GET" }, path: `/json/new?url=${encodedUrl}` },
    ];
    let lastError: Error | null = null;
    for (const attempt of attempts) {
      try {
        const raw = await fetchJson(
          `${CDP_ENDPOINT_ORIGIN}${attempt.path}`,
          attempt.init,
        );
        const target = this.parseTargetDescriptor(raw);
        if (target) {
          return target;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    const listRaw = await fetchJson(`${CDP_ENDPOINT_ORIGIN}${CDP_ENDPOINT_LIST_PATH}`);
    if (Array.isArray(listRaw)) {
      for (const item of listRaw) {
        const target = this.parseTargetDescriptor(item);
        if (!target) {
          continue;
        }
        if (target.url === url) {
          return target;
        }
      }
    }
    throw lastError ?? new Error("Unable to create CDP browser target.");
  }

  private async createSocketConnection(webSocketUrl: string): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out while connecting to CDP target."));
      }, 8000);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve(socket);
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Failed to connect websocket for CDP target."));
      };
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });
  }

  private handleSocketClosed(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const pendingError = new Error("CDP session closed.");
    session.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(pendingError);
    });
    session.pending.clear();
    this.sessions.delete(sessionId);
  }

  private handleSelectionBinding(session: CdpSession, params: unknown) {
    if (!isJsonObject(params)) {
      return;
    }
    const name = typeof params.name === "string" ? params.name : "";
    const payloadString = typeof params.payload === "string" ? params.payload : "";
    if (name !== CDP_SELECTION_BINDING_NAME || !payloadString) {
      return;
    }
    const parsed = parseJsonString(payloadString);
    const selection = sanitizeSelectionPayload(
      (parsed as CdpSelectionBridgePayload | null) ?? {},
    );
    if (!this.window) {
      return;
    }
    const signature = `${selection.url}::${selection.text}`;
    if (signature === session.lastSelectionSignature) {
      return;
    }
    session.lastSelectionSignature = signature;
    this.window.webContents.send("browserview-selection", {
      ...selection,
      tabId: `cdp:${session.id}`,
      viewBounds: null,
    });
  }

  private handleSocketMessage(session: CdpSession, rawText: string) {
    const message = parseJsonString(rawText);
    if (!isJsonObject(message)) {
      return;
    }
    const responseId =
      typeof message.id === "number" && Number.isFinite(message.id)
        ? message.id
        : null;
    if (responseId !== null) {
      const pending = session.pending.get(responseId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      session.pending.delete(responseId);
      if (isJsonObject(message.error)) {
        const errorMessage =
          typeof message.error.message === "string"
            ? message.error.message
            : "CDP command failed.";
        pending.reject(new Error(errorMessage));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    if (!method) {
      return;
    }
    if (method === "Runtime.bindingCalled") {
      this.handleSelectionBinding(session, message.params);
      return;
    }
    if (method === "Page.loadEventFired") {
      void this.applyPendingHighlight(session.id);
    }
  }

  private async sendCommand(
    session: CdpSession,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (session.socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP socket is not open.");
    }
    const commandId = session.nextCommandId;
    session.nextCommandId += 1;
    const payload = JSON.stringify({
      id: commandId,
      method,
      params: params ?? {},
    });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(commandId);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      session.pending.set(commandId, { resolve, reject, timer });
      try {
        session.socket.send(payload);
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(commandId);
        reject(
          error instanceof Error
            ? error
            : new Error(`Failed to send CDP command: ${method}`),
        );
      }
    });
  }

  private async installSessionScripts(session: CdpSession): Promise<void> {
    const selectionScript = buildSelectionBridgeScript();
    await this.sendCommand(session, "Runtime.enable");
    await this.sendCommand(session, "Page.enable");
    await this.sendCommand(session, "Runtime.addBinding", {
      name: CDP_SELECTION_BINDING_NAME,
    });
    await this.sendCommand(session, "Page.addScriptToEvaluateOnNewDocument", {
      source: selectionScript,
    });
    await this.sendCommand(session, "Runtime.evaluate", {
      expression: selectionScript,
      returnByValue: true,
    });
  }

  private readRuntimeEvaluateValue(result: unknown): unknown {
    if (!isJsonObject(result)) {
      return undefined;
    }
    const runtimeResult = result.result;
    if (!isJsonObject(runtimeResult)) {
      return undefined;
    }
    return "value" in runtimeResult ? runtimeResult.value : undefined;
  }

  private async applyPendingHighlight(
    sessionId: string,
    attempt = 0,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingHighlight) {
      return;
    }
    const payload = session.pendingHighlight;
    try {
      const evaluateResult = await this.sendCommand(session, "Runtime.evaluate", {
        expression: `(${runReferenceHighlightScript.toString()})(${JSON.stringify(
          {
            refId: payload.refId,
            text: payload.text,
          },
        )})`,
        awaitPromise: true,
        returnByValue: true,
      });
      const value = this.readRuntimeEvaluateValue(evaluateResult);
      if (isJsonObject(value) && value.ok === true) {
        session.pendingHighlight = undefined;
        return;
      }
    } catch {
      // Retry below.
    }
    if (attempt >= 6) {
      return;
    }
    const delay = Math.min(1600, 220 * (attempt + 1));
    setTimeout(() => {
      void this.applyPendingHighlight(sessionId, attempt + 1);
    }, delay);
  }

  async open(input: {
    url: string;
    reference?: BrowserViewReferenceHighlight;
  }): Promise<{ ok: true; sessionId: string }> {
    const normalizedUrl = normalizeHttpUrl(input.url);
    if (!normalizedUrl) {
      throw new Error("Invalid URL for CDP browser.");
    }
    await this.ensureEndpointReady();
    const target = await this.createTarget(normalizedUrl);
    const socket = await this.createSocketConnection(target.webSocketDebuggerUrl);
    const session: CdpSession = {
      id: randomUUID(),
      targetId: target.id,
      socket,
      nextCommandId: 1,
      pending: new Map(),
      pendingHighlight: input.reference
        ? sanitizeReferenceHighlight(input.reference)
        : undefined,
      lastSelectionSignature: "",
    };
    socket.addEventListener("message", (event) => {
      const text = toMessageText(event.data);
      if (!text) {
        return;
      }
      this.handleSocketMessage(session, text);
    });
    socket.addEventListener("close", () => {
      this.handleSocketClosed(session.id);
    });
    socket.addEventListener("error", () => {
      this.handleSocketClosed(session.id);
    });
    this.sessions.set(session.id, session);
    try {
      await this.installSessionScripts(session);
      if (session.pendingHighlight) {
        void this.applyPendingHighlight(session.id);
      }
    } catch (error) {
      this.handleSocketClosed(session.id);
      socket.close();
      throw error;
    }
    return { ok: true, sessionId: session.id };
  }
}

const cdpBrowserController = new CdpBrowserController();

export function getCdpBrowserController() {
  return cdpBrowserController;
}
