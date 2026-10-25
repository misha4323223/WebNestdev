import { useEffect, useRef } from "react";
import { describeElement, type PickedElement } from "../../lib/element-pick";

/** Подсветка элемента под мышью и режим выбора — классы живут внутри кадра, а не в панели. */
const HOVER_CLASS = "__nest-pick-hover";
const PICKING_CLASS = "__nest-picking";
const STYLE_ID = "__nest-pick-style";

const PICKER_CSS =
  "." + HOVER_CLASS + "{outline:2px solid #cfbc9c !important;outline-offset:2px !important;cursor:crosshair !important}" +
  "." + PICKING_CLASS + ",." + PICKING_CLASS + " *{cursor:crosshair !important}";

/**
 * Выбор элемента прямо в кадре предпросмотра.
 *
 * Кадр отдаётся через прокси панели, то есть с того же origin: документ доступен родителю и
 * слушатели можно повесить на него напрямую. Для публичного адреса (`<проект>.preview.<домен>`)
 * документ чужой — тогда выбор просто недоступен, и панель об этом честно пишет, вместо того
 * чтобы отправлять агенту «элемент», которого никто не выбрал.
 *
 * Клик перехватывается в фазе перехвата и гасится: в режиме выбора нельзя случайно нажать кнопку
 * внутри приложения. Подсветка ставится классом на сам элемент, а не отдельным слоем — так она
 * видна и внутри `overflow:hidden`, и при любом масштабе кадра.
 */
export function useElementPicker({ frame, active, onPick, onCancel }: {
  frame: HTMLIFrameElement | null;
  active: boolean;
  onPick: (picked: PickedElement) => void;
  onCancel: () => void;
}) {
  // Колбэки держатся в ref: подписка не должна пересоздаваться на каждый рендер панели.
  const pick = useRef(onPick);
  pick.current = onPick;
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    if (!active || !frame) return;

    let detach: (() => void) | null = null;

    const bind = () => {
      let loaded: Document | null = null;
      try {
        loaded = frame.contentDocument;
      } catch {
        loaded = null;
      }
      // Чужой документ (публичный адрес предпросмотра) — выбора нет, выходим из режима.
      if (!loaded || !loaded.documentElement) return () => undefined;

      const frameDoc: Document = loaded;
      const root = frameDoc.documentElement;
      let hovered: Element | null = null;
      let done = false;

      const style = frameDoc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = PICKER_CSS;
      frameDoc.head?.appendChild(style);
      root.classList.add(PICKING_CLASS);

      function clearHover() {
        if (hovered) hovered.classList.remove(HOVER_CLASS);
        hovered = null;
      }

      function stop() {
        frameDoc.removeEventListener("mousemove", onMove, true);
        frameDoc.removeEventListener("click", onClick, true);
        frameDoc.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keydown", onKey, true);
        clearHover();
        root.classList.remove(PICKING_CLASS);
        style.remove();
      }

      function finish(picked: Element | null) {
        if (done) return;
        done = true;
        clearHover();
        if (!picked) {
          stop();
          cancel.current();
          return;
        }
        // Стили читаются до снятия подсветки: она не меняет цвет и шрифт, но порядок так честнее.
        const described = describeElement(picked);
        stop();
        pick.current(described);
      }

      function pickable(target: EventTarget | null): Element | null {
        if (!target || (target as Element).nodeType !== 1) return null;
        const element = target as Element;
        // html и body — это страница целиком, а не элемент, который можно поправить.
        if (element === frameDoc.documentElement || element === frameDoc.body) return null;
        return element;
      }

      function onMove(event: Event) {
        const target = pickable(event.target);
        if (!target || target === hovered) return;
        clearHover();
        hovered = target;
        target.classList.add(HOVER_CLASS);
      }

      function onClick(event: Event) {
        // Клик по приложению не должен до него дойти: режим выбора — это инструмент, а не навигация.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        finish(pickable(event.target));
      }

      function onKey(event: Event) {
        if ((event as KeyboardEvent).key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }

      frameDoc.addEventListener("mousemove", onMove, true);
      frameDoc.addEventListener("click", onClick, true);
      frameDoc.addEventListener("keydown", onKey, true);
      // Escape нажимают, когда фокус остался в панели: кадр его не получит.
      window.addEventListener("keydown", onKey, true);

      return () => {
        if (done) return;
        done = true;
        stop();
      };
    };

    const attach = () => {
      detach?.();
      detach = bind();
    };

    // Кадр перезагружается после правок агента: подписка должна переехать на новый документ
    // вместе с ним, иначе выбор молча перестаёт работать через минуту работы.
    frame.addEventListener("load", attach);
    attach();
    return () => {
      frame.removeEventListener("load", attach);
      detach?.();
      detach = null;
    };
  }, [active, frame]);
}
