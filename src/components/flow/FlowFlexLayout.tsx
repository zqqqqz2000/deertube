import type { IJsonModel, ITabRenderValues, TabNode } from "@massbug/flexlayout-react";
import { Layout, Model } from "@massbug/flexlayout-react";
import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import "@/assets/flexlayout.css";
import "@/assets/flexlayout-overrides.css";

interface FlowFlexLayoutProps {
  model: IJsonModel;
  onModelChange: (model: IJsonModel) => void;
  renderTab: (tabId: string) => ReactNode;
  renderTabLabel?: (tabId: string) => ReactNode;
  realtimeResize?: boolean;
}

export function FlowFlexLayout({
  model,
  onModelChange,
  renderTab,
  renderTabLabel,
  realtimeResize = true,
}: FlowFlexLayoutProps) {
  const layoutModel = useMemo(() => Model.fromJson(model), [model]);

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent() ?? node.getId();
      return renderTab(component);
    },
    [renderTab],
  );

  const handleModelChange = useCallback(
    (nextModel: Model) => {
      onModelChange(nextModel.toJson());
    },
    [onModelChange],
  );

  const onRenderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      if (!renderTabLabel) {
        return;
      }
      const component = node.getComponent() ?? node.getId();
      renderValues.content = renderTabLabel(component);
    },
    [renderTabLabel],
  );

  return (
    <Layout
      model={layoutModel}
      factory={factory}
      onModelChange={handleModelChange}
      onRenderTab={onRenderTab}
      realtimeResize={realtimeResize}
    />
  );
}
