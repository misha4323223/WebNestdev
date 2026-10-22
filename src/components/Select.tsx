import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/**
 * Выпадающий список в стиле панели: тёмная плитка, подсветка вариантов и галочка у выбранного.
 * Системный `<select>` рисует меню средствами ОС — на тёмной панели оно выглядит чужим, а на
 * телефоне открывает отдельный нативный лист, который не подчиняется теме. Здесь меню живёт в
 * портале и позиционируется по кнопке, поэтому его не обрезает `overflow:hidden` карточки или
 * панели настроек.
 */
export type SelectOption = {
  value: string;
  label: string;
  /** Вторая строка: короткое имя провайдера, движок или пояснение. */
  note?: string;
  /** Значок слева: логотип бренда или иконка. */
  icon?: ReactNode;
  disabled?: boolean;
};

type Placement = { left: number; top: number; width: number; maxHeight: number };

export function Select({ value, options, onChange, ariaLabel, placeholder = "Выберите", emptyLabel = "Нет вариантов", disabled, className }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const optionId = (index: number) => listId + "-option-" + index;

  const selectedIndex = options.findIndex(option => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  /** Меню раскрывается вниз, а у нижнего края экрана — вверх: как список, а не как обрезанный блок. */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const box = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(box.width, 220), window.innerWidth - 16);
    const left = Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8));
    const below = window.innerHeight - box.bottom - 14;
    const above = box.top - 14;
    const upwards = below < 190 && above > below;
    const space = Math.max(140, Math.min(320, upwards ? above : below));
    setPlacement({ left, width, maxHeight: space, top: upwards ? box.top - space - 6 : box.bottom + 6 });
  }, []);

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || !options.length) return;
    setActive(Math.max(0, selectedIndex));
    place();
    setOpen(true);
  }, [disabled, options.length, place, selectedIndex]);

  const choose = useCallback((option: SelectOption | undefined) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  }, [close, onChange]);

  // Подсветка не должна уезжать за край списка: при выборе стрелками прокручиваем её в вид.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(Math.min(active, options.length - 1)))?.scrollIntoView({ block: "nearest" });
  }, [open, active, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onMove = () => place();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onMove);
    // true — ловим и прокрутку внутренних контейнеров, а не только страницы.
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  function move(step: number) {
    if (!options.length) return;
    let next = active;
    for (let count = 0; count < options.length; count++) {
      next = (next + step + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setActive(next);
  }

  /** Печатный символ переводит к варианту с такой буквы — привычное поведение системного списка. */
  function typeAhead(key: string) {
    const now = Date.now();
    const text = (now - typed.current.at < 700 ? typed.current.text : "") + key.toLowerCase();
    typed.current = { text, at: now };
    const found = options.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(text));
    if (found >= 0) setActive(found);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(options[active]); }
    else if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "Tab") { setOpen(false); }
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) typeAhead(event.key);
  }

  const activeOption = options[active];

  return <div className={"select" + (className ? " " + className : "")}>
    <button
      ref={triggerRef}
      type="button"
      className="select-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open && activeOption ? optionId(active) : undefined}
      disabled={disabled}
      onClick={() => (open ? close() : openMenu())}
      onKeyDown={onKeyDown}
    >
      {selected?.icon && <span className="select-trigger-icon" aria-hidden="true">{selected.icon}</span>}
      <span className={"select-value" + (selected ? "" : " is-placeholder")}>{selected?.label ?? placeholder}</span>
      <ChevronDown size={13} className="select-chevron" aria-hidden="true"/>
    </button>

    {open && placement && createPortal(
      <div ref={menuRef} className="select-menu" style={{ left: placement.left, top: placement.top, width: placement.width }}>
        <div id={listId} className="select-menu-scroll" role="listbox" aria-label={ariaLabel} style={{ maxHeight: placement.maxHeight }}>
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return <button
              key={option.value}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={isSelected}
              disabled={option.disabled}
              className={"select-option" + (isSelected ? " is-selected" : "") + (index === active ? " is-active" : "")}
              onPointerMove={() => { if (index !== active) setActive(index); }}
              onClick={() => choose(option)}
            >
              {option.icon && <span className="select-option-icon" aria-hidden="true">{option.icon}</span>}
              <span className="select-option-body">
                <strong>{option.label}</strong>
                {option.note && <small>{option.note}</small>}
              </span>
              {isSelected && <Check size={13} className="select-option-check" aria-hidden="true"/>}
            </button>;
          })}
          {!options.length && <div className="select-empty">{emptyLabel}</div>}
        </div>
      </div>,
      document.body,
    )}
  </div>;
}
