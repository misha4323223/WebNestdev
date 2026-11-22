import { useState } from "react";
import { Check } from "lucide-react";
import { checklistPrompt, type UiChecklistBlock } from "../../../lib/ui-blocks";
import type { UiActionHandler } from "./UiBlocks";

/**
 * Чек-лист приёмки: человек отмечает то, что уже проверено, и отправляет выбранное
 * агенту одним сообщением. Это не форма ввода и не набор кнопок — состояние живёт
 * только до отправки, а сервер по-прежнему не исполняет действий из разметки.
 */
export function UiChecklist({ block, busy, onAction }: {
  block: UiChecklistBlock;
  busy?: boolean;
  onAction: UiActionHandler;
}) {
  const [selected, setSelected] = useState<string[]>(() => block.items.filter(item => item.checked).map(item => item.label));
  const toggle = (label: string) => {
    if (busy) return;
    setSelected(current => current.includes(label) ? current.filter(item => item !== label) : [...current, label]);
  };
  return <section className="ui-block ui-checklist" aria-label={block.title}>
    <header className="ui-block-head">
      <strong>{block.title}</strong>
      {block.description && <p>{block.description}</p>}
    </header>
    <div className="ui-checklist-items">
      {block.items.map(item => {
        const active = selected.includes(item.label);
        return <button
          type="button"
          key={item.label}
          className={"ui-checklist-item" + (active ? " is-selected" : "")}
          onClick={() => toggle(item.label)}
          disabled={busy}
          aria-pressed={active}
        >
          <span className="ui-checklist-mark">{active ? <Check size={12}/> : null}</span>
          <span className="ui-checklist-copy">
            <strong>{item.label}</strong>
            {item.description && <span>{item.description}</span>}
          </span>
        </button>;
      })}
    </div>
    <footer className="ui-block-foot">
      <span className="ui-checklist-count">{selected.length ? "Выбрано: " + selected.length : "Отметьте пункты"}</span>
      <button
        type="button"
        className="ui-block-submit"
        disabled={busy || !selected.length}
        onClick={() => onAction(checklistPrompt(block, selected))}
      >
        {block.submitLabel ?? "Отправить"}
      </button>
    </footer>
  </section>;
}
