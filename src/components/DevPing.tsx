import { useState } from "react";
import { pingSidecar, PingResult } from "../ipc/commands";
import { Button } from "./ui/button";

export function DevPing() {
  const [result, setResult] = useState<PingResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      setResult(await pingSidecar());
    } catch (e) {
      setResult({ id: "", ok: false, error: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={run} disabled={busy}>
        {busy ? "Pinging…" : "Ping sidecar"}
      </Button>
      {result && (
        <span className="font-mono text-[11px] text-muted-foreground">
          {result.ok ? `v${result.result?.version}` : result.error}
        </span>
      )}
    </div>
  );
}
