import { useEffect, useRef, useState } from "react";

export function usePanelState(selectedId: string | null, isDragging: boolean) {
  const [panelVisible, setPanelVisible] = useState(false);
  const [panelNodeId, setPanelNodeId] = useState<string | null>(null);
  const panelHideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setPanelVisible(false);
      return;
    }
    setPanelNodeId(selectedId);
    setPanelVisible(false);
    const id = window.requestAnimationFrame(() => setPanelVisible(true));
    return () => window.cancelAnimationFrame(id);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId && !panelVisible && panelNodeId) {
      if (panelHideTimer.current) {
        window.clearTimeout(panelHideTimer.current);
      }
      panelHideTimer.current = window.setTimeout(() => {
        setPanelNodeId(null);
      }, 300);
      return () => {
        if (panelHideTimer.current) {
          window.clearTimeout(panelHideTimer.current);
        }
      };
    }
    return () => undefined;
  }, [panelNodeId, panelVisible, selectedId]);

  useEffect(() => {
    if (isDragging) {
      setPanelVisible(false);
      return;
    }
    if (selectedId) {
      setPanelVisible(false);
      const id = window.requestAnimationFrame(() => setPanelVisible(true));
      return () => window.cancelAnimationFrame(id);
    }
    return () => undefined;
  }, [isDragging, selectedId]);

  return { panelVisible, panelNodeId };
}
