import { useEffect, useRef } from "react";
import type { PickedElement } from "../../lib/element-pick";

/**
 * Выбор элемента в кадре с чужого origin — публичного адреса предпросмотра.
 *
 * Читать DOM такого кадра панели нельзя (same-origin policy), поэтому подсветку и клик выполняет
 * мост внутри приложения (server/src/preview/pick-bridge.ts), а обмен идёт сообщениями. Команда
 * уходит только в конкретный origin кадра, ответ принимается только от того же окна и только с
 * того же origin: чужое окно не может ни включить выбор, ни подсунуть «элемент».
 */

/** Команда панели → приложение. Имена совпадают с серверным мостом. */
const COMMAND = "nest-pick-command";
/** Ответ приложения → панель. */
const RESULT = "nest-picked";

type BridgeMessage = { type?: string; pick?: PickedElement | null; cancelled?: boolean };

export function useRemoteElementPicker({ frame, active, targetOrigin, onPick, onCancel }: {
  frame: HTMLIFrameElement | null;
  active: boolean;
  /** Origin публичного адреса предпросмотра: другой адрес команду не получит. */
  targetOrigin: string;
  onPick: (picked: PickedElement) => void;
  onCancel: () => void;
}) {
  const pick = useRef(onPick);
  pick.current = onPick;
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    if (!frame || !targetOrigin) return;
    const window_ = frame.contentWindow;
    if (!window_) return;

    const post = (action: "start" | "stop") => {
      try {
        window_.postMessage({ type: COMMAND, action }, targetOrigin);
      } catch {
        // Кадр мог перезагрузиться между рендером и отправкой: следующая попытка придёт с reload.
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window_) return;
      if (event.origin !== targetOrigin) return;
      const data = event.data as BridgeMessage | null;
      if (!data || data.type !== RESULT) return;
      if (data.cancelled) {
        cancel.current();
        return;
      }
      if (data.pick) pick.current(data.pick);
    };

    window.addEventListener("message", onMessage);
    if (active) post("start");
    return () => {
      window.removeEventListener("message", onMessage);
      // Выход из режима — это и кнопка, и Esc, и уход из панели: мост не должен остаться включённым.
      if (active) post("stop");
    };
  }, [active, frame, targetOrigin]);
}
