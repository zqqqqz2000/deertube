import type {
  BorderNode,
  IJsonModel,
  ITabRenderValues,
  ITabSetRenderValues,
  TabNode,
  TabSetNode,
} from "@massbug/flexlayout-react";
import { Layout, Model } from "@massbug/flexlayout-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import "@/assets/flexlayout.css";
import "@/assets/flexlayout-overrides.css";

interface FlowFlexLayoutProps {
  model: IJsonModel;
  onModelChange: (model: IJsonModel) => void;
  renderTab: (tabId: string) => ReactNode;
  renderTabLabel?: (tabId: string) => ReactNode;
  renderTabButtons?: (tabId: string) => ReactNode[] | null;
  renderTabSetActions?: (node: TabSetNode | BorderNode) => ReactNode | null;
  realtimeResize?: boolean;
}

export function FlowFlexLayout({
  model,
  onModelChange,
  renderTab,
  renderTabLabel,
  renderTabButtons,
  renderTabSetActions,
  realtimeResize = true,
}: FlowFlexLayoutProps) {
  const layoutHostRef = useRef<HTMLDivElement | null>(null);
  const layoutModel = useMemo(() => Model.fromJson(model), [model]);
  const onModelChangeRef = useRef(onModelChange);
  const renderTabRef = useRef(renderTab);
  const renderTabLabelRef = useRef(renderTabLabel);
  const renderTabButtonsRef = useRef(renderTabButtons);
  const renderTabSetActionsRef = useRef(renderTabSetActions);

  onModelChangeRef.current = onModelChange;
  renderTabRef.current = renderTab;
  renderTabLabelRef.current = renderTabLabel;
  renderTabButtonsRef.current = renderTabButtons;
  renderTabSetActionsRef.current = renderTabSetActions;

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent() ?? node.getId();
      return renderTabRef.current(component);
    },
    [],
  );

  const handleModelChange = useCallback(
    (nextModel: Model) => {
      onModelChangeRef.current(nextModel.toJson());
    },
    [],
  );

  const onRenderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      const component = node.getComponent() ?? node.getId();
      const renderTabLabelCurrent = renderTabLabelRef.current;
      const renderTabButtonsCurrent = renderTabButtonsRef.current;
      if (!renderTabLabelCurrent) {
        if (renderTabButtonsCurrent) {
          const buttons = renderTabButtonsCurrent(component);
          if (buttons?.length) {
            renderValues.buttons.push(...buttons);
          }
        }
      } else {
        renderValues.content = renderTabLabelCurrent(component);
        if (renderTabButtonsCurrent) {
          const buttons = renderTabButtonsCurrent(component);
          if (buttons?.length) {
            renderValues.buttons.push(...buttons);
          }
        }
      }
    },
    [],
  );

  const onRenderTabSet = useCallback(
    (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
      const renderTabSetActionsCurrent = renderTabSetActionsRef.current;
      if (!renderTabSetActionsCurrent) {
        return;
      }
      const actions = renderTabSetActionsCurrent(node);
      if (actions) {
        renderValues.stickyButtons.push(actions);
      }
    },
    [],
  );

  useEffect(() => {
    const host = layoutHostRef.current;
    if (!host) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const tabbarInner = event.target.closest(".flexlayout__tabset_tabbar_inner");
      if (!(tabbarInner instanceof HTMLElement)) {
        return;
      }

      const tabContainer = tabbarInner.querySelector(".flexlayout__tabset_tabbar_inner_tab_container");
      if (!(tabContainer instanceof HTMLElement)) {
        return;
      }

      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) {
        return;
      }

      let contentWidth = 0;
      for (const child of tabContainer.children) {
        if (!(child instanceof HTMLElement)) {
          continue;
        }
        const childRight = child.offsetLeft + child.offsetWidth;
        if (childRight > contentWidth) {
          contentWidth = childRight;
        }
      }

      const visibleWidth = tabbarInner.clientWidth;
      if (contentWidth <= visibleWidth) {
        tabContainer.style.left = "0px";
        return;
      }

      const minLeft = visibleWidth - contentWidth;
      const currentLeft = Number.parseFloat(tabContainer.style.left || "0");
      const nextLeft = Math.max(minLeft, Math.min(0, currentLeft - delta));

      tabContainer.style.left = `${nextLeft}px`;
      event.preventDefault();
      event.stopPropagation();
    };

    host.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => {
      host.removeEventListener("wheel", handleWheel, true);
    };
  }, []);

  return (
    <div ref={layoutHostRef} className="h-full w-full">
      <Layout
        model={layoutModel}
        factory={factory}
        onModelChange={handleModelChange}
        onRenderTab={onRenderTab}
        onRenderTabSet={onRenderTabSet}
        realtimeResize={realtimeResize}
      />
    </div>
  );
}
