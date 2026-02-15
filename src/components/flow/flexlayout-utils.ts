import type { IJsonModel } from "@massbug/flexlayout-react";

export const CHAT_TABSET_ID = "chat-tabset";
export const GRAPH_TABSET_ID = "graph-tabset";
export const CHAT_TAB_ID = "chat-tab";
export const GRAPH_TAB_ID = "graph-tab";
export const CHAT_DEFAULT_WEIGHT = 32;
export const TOTAL_LAYOUT_WEIGHT = 100;
export const BROWSER_TAB_PREFIX = "browser:";

export interface FlexLayoutNode {
  id?: string;
  type?: string;
  weight?: number;
  component?: string;
  selected?: number;
  children?: FlexLayoutNode[];
}

const findLayoutNode = (
  node: FlexLayoutNode | undefined,
  id: string,
): FlexLayoutNode | null => {
  if (!node) {
    return null;
  }
  if (node.id === id) {
    return node;
  }
  if (!node.children) {
    return null;
  }
  for (const child of node.children) {
    const found = findLayoutNode(child, id);
    if (found) {
      return found;
    }
  }
  return null;
};

export const findFirstTabsetId = (
  node: FlexLayoutNode | undefined,
): string | null => {
  if (!node) {
    return null;
  }
  if (node.type === "tabset" && node.id) {
    return node.id;
  }
  if (!node.children) {
    return null;
  }
  for (const child of node.children) {
    const found = findFirstTabsetId(child);
    if (found) {
      return found;
    }
  }
  return null;
};

const isGraphTabNode = (node: FlexLayoutNode | undefined): boolean => {
  if (!node || node.type !== "tab") {
    return false;
  }
  const id = node.id ?? "";
  const component = node.component ?? "";
  return (
    id === "graph" ||
    id === GRAPH_TAB_ID ||
    component === "graph" ||
    component === GRAPH_TAB_ID
  );
};

export const findTabsetIdContainingGraph = (
  node: FlexLayoutNode | undefined,
): string | null => {
  if (!node) {
    return null;
  }
  if (
    node.type === "tabset" &&
    node.id &&
    Array.isArray(node.children) &&
    node.children.some((child) => isGraphTabNode(child))
  ) {
    return node.id;
  }
  if (!node.children) {
    return null;
  }
  for (const child of node.children) {
    const found = findTabsetIdContainingGraph(child);
    if (found) {
      return found;
    }
  }
  return null;
};

export const parseBrowserTabId = (value: string): string | null => {
  if (value.startsWith(BROWSER_TAB_PREFIX)) {
    return value.slice(BROWSER_TAB_PREFIX.length);
  }
  if (value.startsWith("browser-")) {
    return value;
  }
  return null;
};

export const findTabsetIdContainingBrowserTab = (
  node: FlexLayoutNode | undefined,
  browserTabId: string,
): string | null => {
  if (!node) {
    return null;
  }
  if (
    node.type === "tabset" &&
    node.id &&
    Array.isArray(node.children) &&
    node.children.some((child) => {
      if (!child || child.type !== "tab") {
        return false;
      }
      const component = child.component ?? child.id ?? "";
      const parsedBrowserTabId = parseBrowserTabId(String(component));
      return parsedBrowserTabId === browserTabId;
    })
  ) {
    return node.id;
  }
  if (!node.children) {
    return null;
  }
  for (const child of node.children) {
    const found = findTabsetIdContainingBrowserTab(child, browserTabId);
    if (found) {
      return found;
    }
  }
  return null;
};

export const collectBrowserTabIds = (
  node: FlexLayoutNode | undefined,
): Set<string> => {
  const ids = new Set<string>();
  const visit = (current?: FlexLayoutNode) => {
    if (!current) {
      return;
    }
    if (current.type === "tab" && current.id) {
      const component = current.component ?? current.id;
      const tabId = parseBrowserTabId(String(component));
      if (tabId) {
        ids.add(tabId);
      }
    }
    if (current.children) {
      current.children.forEach((child) => visit(child));
    }
  };
  visit(node);
  return ids;
};

export const collectVisibleBrowserTabIds = (
  node: FlexLayoutNode | undefined,
): Set<string> => {
  const ids = new Set<string>();
  const visit = (current?: FlexLayoutNode) => {
    if (!current) {
      return;
    }
    if (current.type === "tabset" && Array.isArray(current.children)) {
      const selectedValue = current.selected;
      let selectedNode: FlexLayoutNode | undefined;
      if (typeof selectedValue === "number" && current.children[selectedValue]) {
        selectedNode = current.children[selectedValue];
      } else if (typeof selectedValue === "string") {
        selectedNode = current.children.find(
          (child) =>
            child.type === "tab" &&
            (child.id === selectedValue || child.component === selectedValue),
        );
      }
      if (!selectedNode) {
        selectedNode = current.children[0];
      }
      if (selectedNode?.type === "tab") {
        const component = selectedNode.component ?? selectedNode.id;
        const tabId = component ? parseBrowserTabId(String(component)) : null;
        if (tabId) {
          ids.add(tabId);
        }
      }
      return;
    }
    if (current.children) {
      current.children.forEach((child) => visit(child));
    }
  };
  visit(node);
  return ids;
};

export const hasTab = (
  layout: FlexLayoutNode | undefined,
  tabId: string,
): boolean => {
  const node = findLayoutNode(layout, tabId);
  return Boolean(node && node.type === "tab");
};

export const hasTabset = (
  layout: FlexLayoutNode | undefined,
  tabsetId: string,
): boolean => {
  const node = findLayoutNode(layout, tabsetId);
  return Boolean(node && node.type === "tabset");
};

export const normalizeLayoutModel = (model: IJsonModel): IJsonModel => {
  const next = JSON.parse(JSON.stringify(model)) as IJsonModel;
  next.global = {
    ...next.global,
    tabEnableFloat: false,
    tabEnableClose: true,
    tabEnableRenderOnDemand: false,
    tabSetAutoSelectTab: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetMinWidth: 100,
    tabSetMinHeight: 100,
    borderMinSize: 100,
  };

  const ensureSelected = (node: FlexLayoutNode | undefined) => {
    if (!node?.children) {
      return;
    }
    if (node.type === "tabset" && node.children.length > 0) {
      const selected =
        typeof node.selected === "number" ? node.selected : undefined;
      if (selected === undefined || selected < 0) {
        node.selected = 0;
      }
    }
    node.children.forEach((child) => ensureSelected(child));
  };

  ensureSelected(next.layout as FlexLayoutNode);
  return next;
};

export const createDefaultLayoutModel = (): IJsonModel =>
  normalizeLayoutModel({
    global: {
      tabEnableFloat: false,
      tabEnableClose: true,
      tabEnableRenderOnDemand: false,
      tabSetEnableClose: false,
      tabSetEnableDeleteWhenEmpty: true,
      tabSetMinWidth: 100,
      tabSetMinHeight: 100,
      borderMinSize: 100,
    },
    borders: [],
    layout: {
      type: "row",
      weight: TOTAL_LAYOUT_WEIGHT,
      children: [
        {
          type: "tabset",
          id: CHAT_TABSET_ID,
          weight: CHAT_DEFAULT_WEIGHT,
          selected: 0,
          enableClose: false,
          enableDeleteWhenEmpty: true,
          children: [
            {
              type: "tab",
              id: CHAT_TAB_ID,
              component: "chat",
              name: "Chat",
              enableClose: true,
            },
          ],
        },
        {
          type: "tabset",
          id: GRAPH_TABSET_ID,
          weight: TOTAL_LAYOUT_WEIGHT - CHAT_DEFAULT_WEIGHT,
          selected: 0,
          enableClose: false,
          enableDeleteWhenEmpty: true,
          children: [
            {
              type: "tab",
              id: GRAPH_TAB_ID,
              component: "graph",
              name: "Graph",
              enableClose: true,
            },
          ],
        },
      ],
    },
  } as IJsonModel);

export const createSingleTabLayoutModel = (
  tabKind: "chat" | "graph",
): IJsonModel => {
  const tabId = tabKind === "chat" ? CHAT_TAB_ID : GRAPH_TAB_ID;
  const tabsetId = tabKind === "chat" ? CHAT_TABSET_ID : GRAPH_TABSET_ID;
  return normalizeLayoutModel({
    global: {
      tabEnableFloat: false,
      tabEnableClose: true,
      tabEnableRenderOnDemand: false,
      tabSetEnableClose: false,
      tabSetEnableDeleteWhenEmpty: true,
      tabSetMinWidth: 100,
      tabSetMinHeight: 100,
      borderMinSize: 100,
    },
    borders: [],
    layout: {
      type: "row",
      weight: TOTAL_LAYOUT_WEIGHT,
      children: [
        {
          type: "tabset",
          id: tabsetId,
          weight: TOTAL_LAYOUT_WEIGHT,
          selected: 0,
          enableClose: false,
          enableDeleteWhenEmpty: true,
          children: [
            {
              type: "tab",
              id: tabId,
              component: tabKind,
              name: tabKind === "chat" ? "Chat" : "Graph",
              enableClose: true,
            },
          ],
        },
      ],
    },
  } as IJsonModel);
};

export const createSingleBrowserLayoutModel = (
  tabId: string,
  label?: string,
): IJsonModel => {
  const trimmed = label?.trim();
  const resolvedLabel = trimmed && trimmed.length > 0 ? trimmed : undefined;
  return {
    global: {
      tabEnableFloat: false,
      tabEnableClose: true,
      tabSetEnableClose: false,
      tabSetEnableDeleteWhenEmpty: true,
      tabSetMinWidth: 100,
      tabSetMinHeight: 100,
      borderMinSize: 100,
    },
    borders: [],
    layout: {
      type: "row",
      weight: TOTAL_LAYOUT_WEIGHT,
      children: [
        {
          type: "tabset",
          id: GRAPH_TABSET_ID,
          weight: TOTAL_LAYOUT_WEIGHT,
          selected: 1,
          enableClose: false,
          enableDeleteWhenEmpty: true,
          children: [
            {
              type: "tab",
              id: GRAPH_TAB_ID,
              component: "graph",
              name: "Graph",
              enableClose: true,
            },
            {
              type: "tab",
              id: tabId,
              component: `${BROWSER_TAB_PREFIX}${tabId}`,
              name: resolvedLabel ?? "Browser",
              enableClose: true,
            },
          ],
        },
      ],
    },
  };
};
