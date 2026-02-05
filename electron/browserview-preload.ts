import { ipcRenderer } from "electron";

type SelectionRect = { x: number; y: number; width: number; height: number };

interface SelectionPayload {
  text: string;
  url: string;
  title?: string;
  rect?: SelectionRect;
}

const MAX_SELECTION_LENGTH = 5000;
const THROTTLE_MS = 180;

let lastText = "";
let lastUrl = "";
let scheduled = false;

const buildSelectionPayload = (): SelectionPayload => {
  const selection = window.getSelection();
  const rawText = selection?.toString() ?? "";
  const text =
    rawText.length > MAX_SELECTION_LENGTH
      ? `${rawText.slice(0, MAX_SELECTION_LENGTH)}...`
      : rawText;

  let rect: SelectionRect | undefined;
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
  const payload = buildSelectionPayload();
  if (payload.text === lastText && payload.url === lastUrl) {
    return;
  }
  lastText = payload.text;
  lastUrl = payload.url;
  ipcRenderer.send("browserview-selection", payload);
};

const scheduleSend = () => {
  if (scheduled) {
    return;
  }
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    sendSelection();
  }, THROTTLE_MS);
};

document.addEventListener("selectionchange", scheduleSend);
document.addEventListener("mouseup", sendSelection);
document.addEventListener("keyup", scheduleSend);
window.addEventListener("blur", () => {
  ipcRenderer.send("browserview-selection", {
    text: "",
    url: window.location.href,
    title: document.title,
  });
});
