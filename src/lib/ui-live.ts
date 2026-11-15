import type { UiBlock } from "./ui-blocks";

/** Blocks of one live `ui.render` call, kept separate so a repeated event is idempotent. */
export type LiveUiCall = { callId: string; blocks: UiBlock[] };

/**
 * Add or replace one call's blocks. The order of calls is preserved: a later
 * `ui.render` extends the answer instead of replacing the previous interface.
 */
export function upsertLiveUiCall(current: LiveUiCall[], callId: string, blocks: UiBlock[]): LiveUiCall[] {
  if (!blocks.length) return current;
  const index = current.findIndex(call => call.callId === callId);
  if (index < 0) return [...current, { callId, blocks }];
  if (current[index].blocks === blocks) return current;
  const next = current.slice();
  next[index] = { callId, blocks };
  return next;
}

/** A failed `ui.render` removes only its own blocks, not earlier successful calls. */
export function removeLiveUiCall(current: LiveUiCall[], callId: string): LiveUiCall[] {
  return current.some(call => call.callId === callId)
    ? current.filter(call => call.callId !== callId)
    : current;
}

/** Flatten calls in arrival order for the live renderer. */
export function flattenLiveUi(current: LiveUiCall[]): UiBlock[] {
  return current.flatMap(call => call.blocks);
}
