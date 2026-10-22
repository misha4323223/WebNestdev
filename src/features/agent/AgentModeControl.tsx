import { useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronDown, ClipboardList, Code2, Globe, SlidersHorizontal } from "lucide-react";
import type { AgentMode, ReasoningEffort } from "../../lib/types";

/**
 * Режим, глубина размышления и поиск в интернете — настройки одного запуска, поэтому и один
 * контрол: кнопка показывает, как агент отработает следующее сообщение, а меню рядом переключает
 * роль, глубину и разрешение выйти в сеть. Отдельная подсказка под полем ввода больше не нужна.
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

export function AgentModeControl({ mode, reasoning, webSearch, reasoningAvailable = true, onMode, onReasoning, onWebSearch }: {
  mode: AgentMode;
  reasoning: ReasoningEffort;
  webSearch: boolean;
  /**
   * Шлюз этой модели отклонил `reasoning_effort` (или глубину выключил администратор). Выбор
   * глубины тогда скрыт: переключатель, который ничего не меняет, только обещает лишнее.
   */
  reasoningAvailable?: boolean;
  onMode: (mode: AgentMode) => void;
  onReasoning: (reasoning: ReasoningEffort) => void;
  onWebSearch: (enabled: boolean) => void;
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
  const triggerTitle = "Режимы агента · сейчас: " + modeLabel
    + (reasoningAvailable ? ", размышление " + reasoningLabels[reasoning].toLowerCase() : ", глубина размышления недоступна")
    + (webSearch ? ", поиск в интернете включён" : "") + ". Открыть настройки запуска.";

  return <div className="agent-mode" ref={boxRef}>
    <button
      type="button"
      className={"agent-mode-trigger" + (mode === "planner" ? " planner" : "") + (open ? " open" : "") + (webSearch ? " search-on" : "")}
      onClick={() => setOpen(value => !value)}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={triggerTitle}
    >
      <SlidersHorizontal size={12}/>
      <span className="agent-mode-label">Режимы</span>
      {reasoningAvailable && <>
        <span className="agent-mode-dot" aria-hidden="true">·</span>
        <span className="agent-mode-depth">{reasoningLabels[reasoning]}</span>
      </>}
      {webSearch && <Globe size={11} className="agent-mode-globe" aria-hidden="true"/>}
      <ChevronDown size={12} className="agent-mode-caret"/>
    </button>

    {open && <div className="agent-mode-menu" role="dialog" aria-label="Режим, размышление и интернет">
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

      {reasoningAvailable ? <>
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
      </> : <p className="agent-mode-note">Эта модель не принимает глубину размышления — выбор скрыт, подробности в настройках AI-провайдера.</p>}

      <div className="agent-mode-head with-icon"><Globe size={11}/> <span className="eyebrow">ИНТЕРНЕТ</span></div>
      <button
        type="button"
        role="switch"
        aria-checked={webSearch}
        className={"agent-mode-switch" + (webSearch ? " active" : "")}
        onClick={() => onWebSearch(!webSearch)}
        title={webSearch ? "Поиск включён на этот запуск — нажмите, чтобы выключить" : "Разрешить агенту искать и открывать страницы"}
      >
        <span className="agent-mode-switch-icon"><Globe size={13}/></span>
        <span className="agent-mode-switch-text">
          <strong>Поиск в интернете</strong>
          <small>{webSearch ? "Включён: ищет и открывает страницы" : "Выключен: только проект и память"}</small>
        </span>
        <span className="agent-mode-pill" aria-hidden="true"><span/></span>
      </button>
    </div>}
  </div>;
}
