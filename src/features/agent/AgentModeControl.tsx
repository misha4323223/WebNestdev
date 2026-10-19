import { useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronDown, ClipboardList, Code2 } from "lucide-react";
import type { AgentMode, ReasoningEffort } from "../../lib/types";

/**
 * Режим и глубина размышления — одна настройка запуска, поэтому и один контрол:
 * кнопка показывает, как агент отработает следующее сообщение, а меню рядом
 * переключает и роль, и глубину. Отдельная подсказка под полем ввода больше не нужна.
 */
export const reasoningLabels: Record<ReasoningEffort, string> = { low: "Лёгкое", medium: "Среднее", high: "Глубокое" };

const modeHints: Record<AgentMode, string> = {
  developer: "Пишет код, запускает проверки и меняет проект",
  planner: "Изучает проект и готовит план, не меняя файлы",
};

const reasoningHints: Record<ReasoningEffort, string> = {
  low: "Быстрые ответы для простых правок",
  medium: "Баланс скорости и качества",
  high: "Глубокий разбор сложных задач",
};

const modes: AgentMode[] = ["developer", "planner"];
const depths: ReasoningEffort[] = ["low", "medium", "high"];

export function AgentModeControl({ mode, reasoning, onMode, onReasoning }: {
  mode: AgentMode;
  reasoning: ReasoningEffort;
  onMode: (mode: AgentMode) => void;
  onReasoning: (reasoning: ReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Меню закрывается щелчком мимо него и клавишей Escape: это поповер, а не отдельный экран.
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

  const modeLabel = mode === "planner" ? "Планировщик" : "Разработчик";
  const ModeIcon = mode === "planner" ? ClipboardList : Code2;

  return <div className="agent-mode" ref={boxRef}>
    <button
      type="button"
      className={"agent-mode-trigger" + (mode === "planner" ? " planner" : "") + (open ? " open" : "")}
      onClick={() => setOpen(value => !value)}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={modeLabel + " · размышление " + reasoningLabels[reasoning].toLowerCase() + ". Открыть настройки запуска."}
    >
      <ModeIcon size={12}/>
      <span className="agent-mode-label">{modeLabel}</span>
      <span className="agent-mode-dot" aria-hidden="true">·</span>
      <span className="agent-mode-depth">{reasoningLabels[reasoning]}</span>
      <ChevronDown size={12} className="agent-mode-caret"/>
    </button>

    {open && <div className="agent-mode-menu" role="dialog" aria-label="Режим и размышление агента">
      <div className="agent-mode-head"><span className="eyebrow">РЕЖИМ АГЕНТА</span></div>
      <div className="agent-mode-options">
        {modes.map(id => {
          const Icon = id === "planner" ? ClipboardList : Code2;
          const active = mode === id;
          return <button
            key={id}
            type="button"
            className={"agent-mode-option" + (active ? " active" : "")}
            aria-pressed={active}
            onClick={() => onMode(id)}
          >
            <span className="agent-mode-option-icon"><Icon size={13}/></span>
            <span className="agent-mode-option-text">
              <strong>{id === "planner" ? "Планировщик" : "Разработчик"}</strong>
              <small>{modeHints[id]}</small>
            </span>
            {active && <Check size={13} className="agent-mode-check"/>}
          </button>;
        })}
      </div>

      <div className="agent-mode-head with-icon"><Brain size={11}/> <span className="eyebrow">РАЗМЫШЛЕНИЕ</span></div>
      <div className="agent-mode-depths" role="group" aria-label="Глубина размышления">
        {depths.map(id => <button
          key={id}
          type="button"
          className={reasoning === id ? "active" : ""}
          aria-pressed={reasoning === id}
          onClick={() => onReasoning(id)}
        >{reasoningLabels[id]}</button>)}
      </div>
      <p className="agent-mode-note">{reasoningHints[reasoning]}</p>
    </div>}
  </div>;
}
