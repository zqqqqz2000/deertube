import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron'
import { exposeElectronTRPC } from 'electron-trpc-experimental/preload'

process.once('loaded', () => {
  exposeElectronTRPC()
})

// --------- Expose some API to the Renderer process ---------
type IpcListener = (event: IpcRendererEvent, ...args: unknown[]) => void

contextBridge.exposeInMainWorld('ipcRenderer', {
  on(channel: string, listener: IpcListener) {
    return ipcRenderer.on(channel, (event: IpcRendererEvent, ...args: unknown[]) =>
      listener(event, ...args),
    )
  },
  off(channel: string, listener: IpcListener) {
    return ipcRenderer.off(channel, listener)
  },
  send(channel: string, ...args: unknown[]) {
    return ipcRenderer.send(channel, ...args)
  },
  invoke(channel: string, ...args: unknown[]) {
    return ipcRenderer.invoke(channel, ...args)
  },

  // You can expose other APTs you need here.
  // ...
})

type SelectionRect = { x: number; y: number; width: number; height: number }
interface SelectionPayload {
  text: string
  url: string
  title?: string
  rect?: SelectionRect
}

const MAX_SELECTION_LENGTH = 5000
const THROTTLE_MS = 180

let lastText = ''
let lastUrl = ''
let scheduled = false

const buildSelectionPayload = (): SelectionPayload => {
  const selection = window.getSelection()
  const rawText = selection?.toString() ?? ''
  const text =
    rawText.length > MAX_SELECTION_LENGTH
      ? `${rawText.slice(0, MAX_SELECTION_LENGTH)}...`
      : rawText

  let rect: SelectionRect | undefined
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    const bounds = range.getBoundingClientRect()
    if (bounds && (bounds.width > 0 || bounds.height > 0)) {
      rect = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }
    }
  }

  return {
    text,
    url: window.location.href,
    title: document.title,
    rect,
  }
}

const sendSelection = () => {
  const payload = buildSelectionPayload()
  if (payload.text === lastText && payload.url === lastUrl) {
    return
  }
  lastText = payload.text
  lastUrl = payload.url
  ipcRenderer.send('browserview-selection', payload)
}

const scheduleSend = () => {
  if (scheduled) {
    return
  }
  scheduled = true
  window.setTimeout(() => {
    scheduled = false
    sendSelection()
  }, THROTTLE_MS)
}

document.addEventListener('selectionchange', scheduleSend)
document.addEventListener('mouseup', sendSelection)
document.addEventListener('keyup', scheduleSend)
window.addEventListener('blur', () => {
  ipcRenderer.send('browserview-selection', {
    text: '',
    url: window.location.href,
    title: document.title,
  })
})
