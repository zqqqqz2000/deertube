export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserViewTabState {
  id: string;
  url: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  referenceHighlight?: BrowserViewReferenceHighlight;
}

export interface BrowserViewSelection {
  tabId?: string;
  text: string;
  url: string;
  title?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  viewBounds?: BrowserViewBounds | null;
}

export interface BrowserViewStatePayload {
  tabId: string;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
}

export interface BrowserViewReferenceHighlight {
  refId: number;
  text: string;
  startLine?: number;
  endLine?: number;
}
