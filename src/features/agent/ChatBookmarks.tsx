import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Закладки чата: полоска у правого края переписки, по одной метке на каждый запрос
 * пользователя. Метка стоит там же, где её сообщение в переписке (позиция считается по
 * настоящим координатам строк, а не «поровну»), при наведении показывает сам запрос, а клик
 * переносит переписку к нему.
 *
 * Сама полоска — и есть прокрутка: системный бегунок в переписке спрятан, а перетаскивание вдоль
 * меток двигает переписку, как ползунок. Клик по метке остаётся переходом к запросу, поэтому
 * короткое нажатие и перетаскивание различаются по смещению пальца или курсора.
 *
 * Почему это отдельный компонент, а не часть панели: ему нужен доступ к скролл-контейнеру
 * переписки и к списку запросов, но ничего больше. Панель владеет только прокруткой — она
 * делает её так же, как и остальные свои прокрутки, и подсвечивает найденное сообщение.
 */

export type ChatBookmark = { index: number; text: string };

/** В подсказке должен быть текст пользователя, а не markdown: разметку убираем, строки склеиваем. */
function preview(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " … ")
    .replace(/[`*_>#[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function ChatBookmarks({ containerRef, items, onJump }: {
  /** Скролл-контейнер переписки: тот же узел, в котором живут строки сообщений. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  items: ChatBookmark[];
  onJump: (index: number) => void;
}) {
  const [marks, setMarks] = useState<Array<{ index: number; ratio: number; top: number }>>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // На телефоне рельса узкая, и полоски в настоящих координатах слипаются в одну. Там это точки —
  // по одной на запрос и поровну — поэтому «каждая точка = мой запрос» читается сразу, а не
  // превращается в пунктир из десятка соседних полосок.
  // Перетаскивание полоски: moved — смещение больше порога, тогда отпускание не считается кликом
  // по метке. Слушатели висят на window, а не на самой полоске: палец во время перетаскивания
  // уходит за её пределы, а захват указателя отнял бы click у меток — по ним нужен переход.
  const dragRef = useRef<{ moved: boolean; startY: number; top: number; height: number } | null>(null);
  const suppressClickRef = useRef(false);
  const detachRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { detachRef.current?.(); }, []);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 650px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 650px)");
    const onChange = () => setCompact(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  // Список и высота контента меняются на каждом кадре стрима, поэтому измерения читаются из
  // ref-ов: эффекты не должны переподписываться из-за нового массива на каждый рендер.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const heightRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const indices = items.map(item => item.index).join(",");

  const measure = useCallback(() => {
    const box = containerRef.current;
    if (!box) return;
    const height = box.scrollHeight;
    heightRef.current = height;
    // Верх контента в координатах страницы: так позиция строки не зависит от того, кто
    // оказался offsetParent у сообщения.
    const contentTop = box.getBoundingClientRect().top - box.scrollTop;
    const next = itemsRef.current.flatMap(item => {
      const row = box.querySelector<HTMLElement>('[data-message-index="' + item.index + '"]');
      if (!row) return [];
      const top = Math.max(0, row.getBoundingClientRect().top - contentTop);
      const ratio = height > 0 ? Math.min(1, top / height) : 0;
      return [{ index: item.index, ratio, top }];
    });
    setMarks(next);
  }, [containerRef]);

  // Стрим переписывает сообщение на каждый токен, а замер — это чтение раскладки. Поэтому
  // пересчёт склеивается: не чаще одного раза за ~140 мс, сколько бы изменений ни пришло.
  const scheduleMeasure = useCallback(() => {
    if (pendingRef.current !== null) return;
    pendingRef.current = window.setTimeout(() => { pendingRef.current = null; measure(); }, 140);
  }, [measure]);

  // Позиции меняет не прокрутка, а длина переписки: пересчитываем на появление сообщений и на
  // изменение окна, а на прокрутке — только если высота контента разошлась с замеренной.
  useEffect(() => { measure(); }, [indices, measure]);

  useEffect(() => {
    const onResize = () => scheduleMeasure();
    window.addEventListener("resize", onResize);
    // Шрифты и картинки догружаются уже после первого замера и меняют высоту строк.
    const observer = new MutationObserver(() => scheduleMeasure());
    const box = containerRef.current;
    if (box) observer.observe(box, { childList: true, subtree: true, characterData: true });
    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      if (pendingRef.current !== null) { window.clearTimeout(pendingRef.current); pendingRef.current = null; }
    };
  }, [containerRef, scheduleMeasure]);

  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const onScroll = () => {
      if (box.scrollHeight !== heightRef.current) scheduleMeasure();
      // Метка текущего чтения — последняя, чей запрос уже выше середины видимой части.
      const anchor = box.scrollTop + box.clientHeight * 0.4;
      let current: number | null = null;
      for (const mark of marksRef.current) if (mark.top <= anchor) current = mark.index;
      setActiveIndex(current);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => box.removeEventListener("scroll", onScroll);
  }, [containerRef, measure, scheduleMeasure]);

  // Прокрутка полоской: доля от высоты рельсы — та же доля от прокручиваемой длины переписки.
  const scrollToRatio = useCallback((ratio: number) => {
    const box = containerRef.current;
    if (!box) return;
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) return;
    box.scrollTop = Math.max(0, Math.min(1, ratio)) * max;
  }, [containerRef]);

  function railPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const drag = { moved: false, startY: event.clientY, top: rect.top, height: rect.height };
    dragRef.current = drag;

    const move = (e: PointerEvent) => {
      // Порог в несколько пикселей: палец на телефоне всегда чуть смещается, и без него каждый
      // клик по метке превращался бы в прокрутку.
      if (!drag.moved && Math.abs(e.clientY - drag.startY) < 4) return;
      drag.moved = true;
      if (drag.height > 0) scrollToRatio((e.clientY - drag.top) / drag.height);
    };
    const end = () => {
      detachRef.current?.();
      dragRef.current = null;
      if (!drag.moved) return;
      suppressClickRef.current = true;
      // Снять запрет после того, как браузер разошлёт click по метке под пальцем.
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    detachRef.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      detachRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  if (items.length < 2) return null;

  const textOf = (index: number) => itemsRef.current.find(item => item.index === index)?.text ?? "";

  return <div className="chat-bookmarks" aria-label="Прокрутка и закладки переписки" role="navigation"
    onPointerDown={railPointerDown}>
    {marks.map((mark, position) => <button
      key={mark.index}
      type="button"
      className={"chat-bookmark" + (activeIndex === mark.index ? " is-active" : "")}
      style={{ top: ((compact ? (position + 0.5) / marks.length : mark.ratio) * 100) + "%" }}
      onClick={() => { if (suppressClickRef.current) return; onJump(mark.index); }}
      onMouseEnter={() => { setHovered(mark.index); measure(); }}
      onMouseLeave={() => setHovered(current => (current === mark.index ? null : current))}
      onFocus={() => { setHovered(mark.index); measure(); }}
      onBlur={() => setHovered(null)}
      aria-label={"Перейти к запросу: " + preview(textOf(mark.index))}
    >
      <i aria-hidden="true"/>
      {hovered === mark.index && !compact && <span className="chat-bookmark-tip" role="tooltip">
        <strong>Ваш запрос</strong>
        {preview(textOf(mark.index))}
      </span>}
    </button>)}
  </div>;
}
