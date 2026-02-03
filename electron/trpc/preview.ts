import { BrowserWindow, WebContentsView } from 'electron'

interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

class PreviewController {
  private window: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private currentUrl: string | null = null

  attachWindow(window: BrowserWindow) {
    this.window = window
  }

  private ensureView() {
    if (!this.window) {
      return null
    }
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: {
          sandbox: true,
        },
      })
      this.window.contentView.addChildView(this.view)
      this.view.setVisible(false)
    }
    return this.view
  }

  async show(url: string, bounds: PreviewBounds) {
    const view = this.ensureView()
    if (!view) {
      return
    }
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })
    view.setVisible(true)
    if (this.currentUrl !== url) {
      this.currentUrl = url
      await view.webContents.loadURL(url)
    }
  }

  hide() {
    if (this.view) {
      this.view.setVisible(false)
    }
  }
}

const previewController = new PreviewController()

export function getPreviewController() {
  return previewController
}
