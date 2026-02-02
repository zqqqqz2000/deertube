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
