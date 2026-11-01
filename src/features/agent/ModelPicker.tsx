import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Lock } from "lucide-react";
import type { PlatformModelOption } from "../../lib/types";

/**
 * Выбор модели у поля ввода. Это не настройки провайдера: здесь только модели платформы,
 * которые разрешены тарифом. Свой AI-провайдер проекта по-прежнему открывается в настройках,
 * потому что его адрес и ключ — отдельная история.
 *
 * Закрытые модели остаются в списке: так на бесплатном тарифе видно, что Max и Mini есть, и
 * понятно, что именно открывает подписка. Нажатие на такую строку ведёт к тарифам, а не молчит.
 */
export function ModelPicker({ name, options, canChoose, freeModel, title, onSelect, onLocked, onOpenSettings }: {
  name: string;
  options: PlatformModelOption[];
  canChoose: boolean;
  freeModel: boolean;
  title: string;
  onSelect: (option: PlatformModelOption) => void;
  onLocked: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const choosable = canChoose && options.length > 1;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(option: PlatformModelOption) {
    if (option.locked) {
      setOpen(false);
      onLocked();
      return;
    }
    if (!option.available) return;
    onSelect(option);
    setOpen(false);
  }

  return <div className="model-picker" ref={boxRef}>
    <button
      type="button"
      className={"composer-model" + (open ? " open" : "")}
      onClick={() => choosable ? setOpen(value => !value) : onOpenSettings()}
      title={title}
      aria-label={title}
      aria-expanded={choosable ? open : undefined}
      aria-haspopup={choosable ? "dialog" : undefined}
    >
      <Cpu size={12}/>
      <span className="composer-model-name">{name}</span>
      {freeModel && <span className="model-free-pill">Free</span>}
      {choosable && <ChevronDown size={11} className="model-caret"/>}
    </button>

    {open && choosable && <div className="model-menu" role="dialog" aria-label="Выбор модели">
      <div className="model-menu-head">
        <span className="eyebrow">МОДЕЛЬ</span>
        <small>Можно менять в любой момент</small>
      </div>
      <div className="model-menu-list">
        {options.map(option => {
          return <button
            key={option.id}
            type="button"
            className={"model-option" + (option.current ? " active" : "") + (option.locked ? " locked" : "") + (!option.available && !option.locked ? " unavailable" : "")}
            aria-pressed={option.current}
            disabled={!option.locked && !option.available}
            onClick={() => choose(option)}
            title={!option.available && !option.locked ? "Модель ещё не настроена администратором" : option.description}
          >
            <span className="model-option-icon">{option.locked ? <Lock size={12}/> : <Cpu size={12}/>}</span>
            <span className="model-option-text">
              <strong>{option.name}</strong>
              <small>{option.locked ? "Открывается на платном тарифе" : option.available ? option.description : "Пока не настроена"}</small>
            </span>
            {option.creditMultiplier > 0 && <span className="model-credit-pill" title="Расход кредитов относительно основной модели">{option.creditMultiplier === 1 ? "1×" : "×" + option.creditMultiplier}</span>}
            {option.current && !option.locked && <Check size={13} className="model-option-check"/>}
            {option.locked && <span className="model-option-lock">Плюс</span>}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
