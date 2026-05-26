import { useEffect } from "react";
import { useProjectStore } from "../state/projectStore";

export function usePlayheadTick() {
  const playing = useProjectStore((s) => s.transport.playing);
  const seek = useProjectStore((s) => s.seek);
  const setPlaying = useProjectStore((s) => s.setPlaying);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastTs = performance.now();

    const tick = (ts: number) => {
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      const { transport, project } = useProjectStore.getState();
      const next = transport.positionSec + dt;
      const duration = Math.max(project.durationSec, 5);
      if (next >= duration) {
        seek(duration);
        setPlaying(false);
        return;
      }
      seek(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, seek, setPlaying]);
}
