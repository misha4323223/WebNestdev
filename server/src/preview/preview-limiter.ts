import { listPreviews } from "./preview-store.js";
import type { PreviewState } from "./types.js";

/**
 * How many *live* runtime previews this host keeps at once.
 *
 * This is the opposite bound to the static preview: a static preview is a listener in this
 * process (~0.5 MB measured), while a container dev server holds a few hundred megabytes for as
 * long as it runs. A count, not a queue: a preview that cannot start is answered with a reason
 * the user can act on, because a queued preview would mean an empty iframe that looks broken.
 *
 * `PREVIEW_MAX_CONTAINERS=0` removes the cap — the same escape hatch the idle sweep has.
 */
export function runtimePreviewLimit() {
  const raw = process.env.PREVIEW_MAX_CONTAINERS?.trim();
  if (!raw) return 3;
  const parsed = Number(raw);
  // Deliberately not `positiveInt`: here `0` is a value, not a mistake — it means "no cap",
  // the same escape hatch `PREVIEW_IDLE_MS=0` opens for the sweeper.
  if (!Number.isFinite(parsed) || parsed < 0) return 3;
  return Math.floor(parsed);
}

/** Live runtime previews right now, cheapest source of truth for the cap and for /api/health. */
export function liveRuntimePreviews(): PreviewState[] {
  return listPreviews().filter(state => state.mode === "container");
}

/** Live static previews: a listener each, for the same health line. */
export function liveStaticPreviews(): PreviewState[] {
  return listPreviews().filter(state => state.mode === "static");
}

export type LiveRuntimePreview = { projectId: string; userId?: string; lastUsedAt: number };
export type RuntimeStartDecision = { ok: true; stopProjectId?: string } | { ok: false; reason: string };

/**
 * Whether one more runtime preview fits. Three answers, in this order:
 *
 * - there is room — start it;
 * - the host is full, but the oldest live preview belongs to *this* user — stop that one and
 *   start the new one: their own two projects should not fight over the host, and stopping their
 *   idle preview is what they would do themselves;
 * - the host is full and every other preview belongs to someone else — refuse, naming the limit,
 *   instead of stopping a stranger's running app behind their back.
 */
export function decideRuntimePreviewStart(input: {
  live: LiveRuntimePreview[];
  projectId: string;
  userId: string;
  limit?: number;
}): RuntimeStartDecision {
  const limit = input.limit ?? runtimePreviewLimit();
  const others = input.live.filter(preview => preview.projectId !== input.projectId);
  if (limit <= 0) return { ok: true };
  if (others.length < limit) return { ok: true };
  // Only a preview with a known owner can be this user's: an unknown owner is never stopped on
  // someone else's behalf, and a request without an owner cannot claim anything.
  const own = (input.userId ? others.filter(preview => preview.userId === input.userId) : [])
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  if (own.length) return { ok: true, stopProjectId: own[0].projectId };
  return {
    ok: false,
    reason:
      "На этом хосте одновременно работают " + limit + " серверных предпросмотров (PREVIEW_MAX_CONTAINERS): " +
      "остановите предпросмотр другого проекта или поднимите лимит. Готовые статические проекты этот лимит не занимают.",
  };
}

/**
 * Printed once at startup, so the host's real ceilings are visible in the logs next to the
 * preview mode. The idle timeout is logged by the sweeper, which owns that number.
 */
export function describePreviewLimits() {
  const limit = runtimePreviewLimit();
  return "серверных предпросмотров одновременно: " + (limit > 0 ? limit : "без ограничения");
}
