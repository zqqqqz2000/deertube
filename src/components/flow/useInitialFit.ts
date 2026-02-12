import { useEffect, useRef } from "react";
import type { ReactFlowInstance } from "reactflow";

export function useInitialFit(
  flowInstance: ReactFlowInstance | null,
  nodesLength: number,
) {
  const initialFitDone = useRef(false);

  useEffect(() => {
    if (!flowInstance || initialFitDone.current || nodesLength === 0) {
      return;
    }
    initialFitDone.current = true;
    requestAnimationFrame(() => {
      flowInstance.fitView({ padding: 0.35, maxZoom: 0.82, duration: 400 });
    });
  }, [flowInstance, nodesLength]);
}
