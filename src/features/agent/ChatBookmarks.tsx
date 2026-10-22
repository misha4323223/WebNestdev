import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Закладки чата: полоска у правого края переписки, по одной метке на каждый запрос
 * пользователя. Метка стоит там же, где её сообщение в переписке (позиция считается по
 * настоящим координатам строк, а не «поровну»), при наведении показывает сам запрос, а клик
 * переносит переписку к нему. В долгом чате метки собираются в группы по десять: иначе они
 * сливаются в сплошной пунктир (см. buildGroups).
 *
 * Группа — матрёшка, а не ярлык «перейти к первому». Пока группа закрыта, на рельсе одна
 * большая мятная точка; клик по ней раскрывает группу — точка исчезает, а на её месте встают
 * десять обычных меток, каждая на позиции своего запроса. Раскрывается и без клика: группа,
 * в которой сейчас читают, открывается сама, чтобы на рельсе было видно место внутри десятка.
 * Уход (прокрутка дальше, курсор с рельсы, переход по метке) собирает её обратно: на рельсе
 * снова одна большая точка. На телефоне поведение то же — тап раскрывает, тап по метке ведёт
 * к запросу.
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

/** Десять запросов на одну точку: рельса остаётся читаемой, сколько бы их ни было. */
const GROUP_SIZE = 10;

/** В подсказке должен быть текст пользователя, а не markdown: разметку убираем, строки склеиваем. */
function preview(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " … ")
    .replace(/[`*_>#[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

type Mark = { index: number; ratio: number; top: number };
type RailGroup = { key: string; start: number; members: Mark[]; ratio: number };

/**
 * Метки рельсы. Пока запросов немного — один запрос, одна метка, как раньше. Но в долгом чате
 * сорок запросов превращали полоску в сплошной пунктир, где уже не видно ни позиции, ни смысла:
 * поэтому каждые десять соседних запросов собираются в одну точку светлого каму. Такая точка
 * отличается от одиночной и раскрывается в свои запросы (см. компонент).
 */
function buildGroups(marks: Mark[], compact: boolean): RailGroup[] {
  if (marks.length <= GROUP_SIZE) {
    return marks.map((mark, position) => ({
      key: String(mark.index),
      start: position,
      members: [mark],
      ratio: compact ? (position + 0.5) / marks.length : mark.ratio,
    }));
  }
  const groups: RailGroup[] = [];
  for (let start = 0; start < marks.length; start += GROUP_SIZE) {
    const members = marks.slice(start, start + GROUP_SIZE);
    // Середина группы: точка стоит там, где её запросы, а не на одном из них.
    const ratio = compact
      ? (start + members.length / 2) / marks.length
      : (members[0].ratio + members[members.length - 1].ratio) / 2;
    groups.push({ key: "g" + start, start, members, ratio });
  }
  return groups;
}

export function ChatBookmarks({ containerRef, items, onJump }: {
  /** Скролл-контейнер переписки: тот же узел, в котором живут строки сообщений. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  items: ChatBookmark[];
  onJump: (index: number) => void;
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Раскрытая кликом группа. Живёт до первого ухода: прокрутки, курсора с рельсы или перехода
  // по метке — дальше раскрытием снова владеет позиция чтения.
  const [expanded, setExpanded] = useState<string | null>(null);
  // Раскрытие по позиции включается только после настоящей прокрутки: при открытии чата
  // рельса показывает те самые большие точки, а не одну уже раскрытую.
  const [scrolled, setScrolled] = useState(false);
  // Подсказка привязана к точке рельсы, а не к сообщению: у группы запросов одна точка.
  const [hovered, setHovered] = useState<string | null>(null);
  // На телефоне рельса узкая, и полоски в настоящих координатах слипаются в одну. Там это точки,
  // расставленные поровну (по одной на запрос или на группу), — так «точка = мой запрос» читается
  // сразу, а не превращается в пунктир из десятка соседних полосок.
  // Перетаскивание полоски: moved — смещение больше порога, тогда отпускание не считается кликом
  // по метке. Слушатели висят на window, а не на самой полоске: палец во время перетаскивания
  // уходит за её пределы, а захват указателя отнял бы click у меток — по ним нужен переход.
  const railRef = useRef<HTMLDivElement>(null);
  // Высота рельсы в пикселях: по ней раскрытая группа считает, сколько места у неё на одну
  // метку. Без этого в узком окне десять кнопок ложились друг на друга и тап попадал в соседнюю.
  const [railHeight, setRailHeight] = useState(0);
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
    const rail = railRef.current;
    if (rail) {
      const measured = rail.getBoundingClientRect().height;
      setRailHeight(current => Math.abs(current - measured) < 0.5 ? current : measured);
    }
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
      // Прокрутка — это уход от группы, раскрытой кликом: дальше раскрытием владеет позиция чтения.
      setExpanded(null);
      // Метка текущего чтения — последняя, чей запрос уже выше середины видимой части.
      const anchor = box.scrollTop + box.clientHeight * 0.4;
      let current: number | null = null;
      for (const mark of marksRef.current) if (mark.top <= anchor) current = mark.index;
      setActiveIndex(current);
    };
    const onUserScroll = () => { onScroll(); setScrolled(true); };
    box.addEventListener("scroll", onUserScroll, { passive: true });
    // Первый замер — не прокрутка: он только расставляет активную метку.
    onScroll();
    return () => box.removeEventListener("scroll", onUserScroll);
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
  const groups = buildGroups(marks, compact);
  // Группа, в которой сейчас читают: она раскрыта и без клика, чтобы на рельсе было видно место
  // внутри десятка. Клик важнее позиции, пока не случился уход.
  const activeGroup = !scrolled || activeIndex === null
    ? null
    : groups.find(group => group.members.length > 1 && group.members.some(member => member.index === activeIndex)) ?? null;
  const clickedGroup = expanded ? groups.find(group => group.key === expanded && group.members.length > 1) ?? null : null;
  const openKey = (clickedGroup ?? activeGroup)?.key ?? null;

  /** Метки раскрытой группы: та же группа, но каждый запрос — своей меткой. */
  const renderMembers = (group: RailGroup) => {
    // Самый тесный промежуток в группе: по нему ограничивается зона нажатия, чтобы метки
    // не перекрывали друг друга и тап всегда попадал в ту, по которой попали.
    const gaps = group.members.slice(1).map((member, position) => member.ratio - group.members[position].ratio).filter(gap => gap > 0);
    const gapRatio = compact ? 1 / Math.max(1, marks.length) : (gaps.length ? Math.min(...gaps) : 0);
    const hit = railHeight > 0 && gapRatio > 0
      ? Math.max(6, Math.min(compact ? 18 : 12, gapRatio * railHeight - 1))
      : undefined;
    return group.members.map((member, position) => {
      const ratio = compact ? (group.start + position + 0.5) / marks.length : member.ratio;
      const key = "m" + member.index;
      const active = member.index === activeIndex;
      return <button
        key={key}
        type="button"
        className={"chat-bookmark is-member" + (active ? " is-active" : "")}
        style={{ top: (ratio * 100) + "%", height: hit }}
        onClick={() => {
          if (suppressClickRef.current) return;
          // Переход — это уход из группы: после него рельса снова собирается в большие точки.
          setExpanded(null);
          onJump(member.index);
        }}
        onMouseEnter={() => { setHovered(key); measure(); }}
        onMouseLeave={() => setHovered(current => (current === key ? null : current))}
        onFocus={() => { setHovered(key); measure(); }}
        onBlur={() => setHovered(null)}
        aria-label={"Перейти к запросу: " + preview(textOf(member.index))}
      >
        <i aria-hidden="true"/>
        {hovered === key && !compact && <span className="chat-bookmark-tip" role="tooltip">
          <strong>Ваш запрос</strong>
          {preview(textOf(member.index))}
        </span>}
      </button>;
    });
  };

  return <div className="chat-bookmarks" ref={railRef} aria-label="Прокрутка и закладки переписки" role="navigation"
    onPointerDown={railPointerDown}
    // Курсор ушёл с рельсы — раскрытая кликом группа собирается обратно. На телефоне «уход»
    // наступает прокруткой, поэтому исчезновение пальца здесь ничего не закрывает.
    onPointerLeave={event => { if (event.pointerType !== "touch") setExpanded(null); }}
  >
    {groups.map(group => {
      if (openKey === group.key) return renderMembers(group);
      // Точка — это один запрос или группа из десяти: группа раскрывается, одиночная ведёт к себе.
      const lead = group.members[0];
      const grouped = group.members.length > 1;
      const active = group.members.some(member => member.index === activeIndex);
      return <button
        key={group.key}
        type="button"
        className={"chat-bookmark" + (active ? " is-active" : "") + (grouped ? " is-group" : "")}
        style={{ top: (group.ratio * 100) + "%" }}
        onClick={() => {
          if (suppressClickRef.current) return;
          if (grouped) { setExpanded(group.key); return; }
          setExpanded(null);
          onJump(lead.index);
        }}
        onMouseEnter={() => { setHovered(group.key); measure(); }}
        onMouseLeave={() => setHovered(current => (current === group.key ? null : current))}
        onFocus={() => { setHovered(group.key); measure(); }}
        onBlur={() => setHovered(null)}
        aria-label={grouped
          ? "Раскрыть группу из " + group.members.length + " запросов, первый: " + preview(textOf(lead.index))
          : "Перейти к запросу: " + preview(textOf(lead.index))}
      >
        <i aria-hidden="true"/>
        {hovered === group.key && !compact && <span className="chat-bookmark-tip" role="tooltip">
          <strong>{grouped ? "Группа · " + group.members.length + " запросов" : "Ваш запрос"}</strong>
          {preview(textOf(lead.index))}
          {grouped && <em>Нажмите, чтобы раскрыть группу</em>}
        </span>}
      </button>;
    })}
  </div>;
}
