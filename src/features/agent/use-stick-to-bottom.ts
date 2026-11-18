import { useCallback, useEffect, useRef, type UIEvent } from "react";

/** Отступ, в котором прокрутка ещё считается «в конце», а не «человек читает выше». */
const NEAR_BOTTOM_PX = 24;

/**
 * Держит прокрутку у конца только пока человек сам не ушёл выше. Раньше каждый новый кусок
 * размышлений безусловно ставил `scrollTop = scrollHeight`, поэтому прочитать середину было
 * невозможно: текст обновлялся несколько раз в секунду и каждый раз возвращал вниз.
 *
 * `trigger` — любое меняющееся значение (текст, шаги): новая порция сначала проверяет, что
 * читатель всё ещё внизу, и только тогда прокручивает.
 */
export function useStickToBottom<T extends HTMLElement>(active: boolean, trigger: unknown) {
  const ref = useRef<T | null>(null);
  const pinned = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger is the content change that should keep a reader at the end
  useEffect(() => {
    if (!active) return;
    const box = ref.current;
    if (!box || !pinned.current) return;
    box.scrollTop = box.scrollHeight;
  }, [active, trigger]);

  const onScroll = useCallback((event: UIEvent<T>) => {
    const box = event.currentTarget;
    pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  return { ref, onScroll };
}
