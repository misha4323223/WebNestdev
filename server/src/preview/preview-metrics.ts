/**
 * Small in-memory history of preview starts per node. It is deliberately not persisted: the
 * number answers "is this node slow right now", survives no restart, and must not grow with
 * project count. The admin response is the only reader; no per-request work.
 */
export type PreviewStartStats = {
  /** Starts in the recent window (successful and failed). */
  count: number;
  /** Nearest-rank p95 of start duration; null until there is a sample. */
  p95Ms: number | null;
  failures: number;
};

type Sample = { node: string; durationMs: number; at: number; ok: boolean };

const WINDOW_MS = 30 * 60_000;
const MAX_SAMPLES = 500;
const samples: Sample[] = [];

export function recordPreviewStart(node: string, durationMs: number, ok: boolean, now = Date.now()) {
  samples.push({
    node: node || "local",
    durationMs: Math.max(0, Math.round(durationMs)),
    at: now,
    ok,
  });
  const cutoff = now - WINDOW_MS;
  while (samples.length > MAX_SAMPLES || (samples[0] && samples[0].at < cutoff)) samples.shift();
}

export function previewStartStats(now = Date.now()): Map<string, PreviewStartStats> {
  const cutoff = now - WINDOW_MS;
  const byNode = new Map<string, number[]>();
  const failures = new Map<string, number>();
  for (const sample of samples) {
    if (sample.at < cutoff) continue;
    const values = byNode.get(sample.node) ?? [];
    values.push(sample.durationMs);
    byNode.set(sample.node, values);
    if (!sample.ok) failures.set(sample.node, (failures.get(sample.node) ?? 0) + 1);
  }
  const result = new Map<string, PreviewStartStats>();
  for (const [node, values] of byNode) {
    values.sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(values.length * 0.95) - 1);
    result.set(node, { count: values.length, p95Ms: values[index] ?? null, failures: failures.get(node) ?? 0 });
  }
  return result;
}

/** Tests and the boot path need a clean window; production never calls this. */
export function resetPreviewStartStatsForTests() {
  samples.length = 0;
}
