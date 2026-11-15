import { useState } from "react";
import { Check } from "lucide-react";
import { choicePrompt, type UiChoiceBlock } from "../../../lib/ui-blocks";
import type { UiActionHandler } from "./UiBlocks";

export function UiChoice({ block, busy, onAction }: {
  block: UiChoiceBlock;
  busy?: boolean;
  onAction: UiActionHandler;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const multiple = block.multiple === true;
  const toggle = (label: string) => {
    if (busy) return;
    if (!multiple) {
      onAction(choicePrompt(block, [label]));
      return;
    }
    setSelected(current => current.includes(label) ? current.filter(item => item !== label) : [...current, label]);
  };
  return <section className="ui-block ui-choice" aria-label={block.title}>
    <header className="ui-block-head">
      <strong>{block.title}</strong>
      {block.description && <p>{block.description}</p>}
    </header>
    <div className="ui-choice-options">
      {block.options.map(option => {
        const active = selected.includes(option.label);
        return <button
          type="button"
          key={option.label}
          className={"ui-choice-option" + (active ? " is-selected" : "")}
          onClick={() => toggle(option.label)}
          disabled={busy}
          aria-pressed={multiple ? active : undefined}
        >
          <span className="ui-choice-mark">{active ? <Check size={12}/> : null}</span>
          <span className="ui-choice-copy">
            <strong>{option.label}</strong>
            {option.description && <span>{option.description}</span>}
          </span>
        </button>;
      })}
    </div>
    {multiple && <footer className="ui-block-foot">
      <button type="button" className="ui-block-submit" disabled={busy || !selected.length} onClick={() => onAction(choicePrompt(block, selected))}>
        Продолжить
      </button>
    </footer>}
  </section>;
}
