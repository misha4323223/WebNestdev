import { useId, useState } from "react";
import { formPrompt, type UiFormBlock } from "../../../lib/ui-blocks";
import type { UiActionHandler } from "./UiBlocks";

export function UiForm({ block, busy, onAction }: {
  block: UiFormBlock;
  busy?: boolean;
  onAction: UiActionHandler;
}) {
  const prefix = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const submit = () => {
    if (busy) return;
    const missing = block.fields.find(field => field.required && !(values[field.name] ?? "").trim());
    if (missing) {
      setError("Заполните поле «" + missing.label + "»");
      return;
    }
    const prompt = formPrompt(block, values);
    if (!prompt) {
      setError("Заполните хотя бы одно поле");
      return;
    }
    setError("");
    onAction(prompt);
  };
  return <form className="ui-block ui-form" aria-label={block.title} onSubmit={event => { event.preventDefault(); submit(); }}>
    <header className="ui-block-head">
      <strong>{block.title}</strong>
      {block.description && <p>{block.description}</p>}
    </header>
    <div className="ui-form-fields">
      {block.fields.map(field => {
        const id = prefix + "-" + field.name;
        const value = values[field.name] ?? "";
        const onChange = (next: string) => {
          setValues(current => ({ ...current, [field.name]: next }));
          if (error) setError("");
        };
        return <label className="ui-form-field" key={field.name} htmlFor={id}>
          <span>{field.label}{field.required ? <em> *</em> : null}</span>
          {field.type === "textarea"
            ? <textarea id={id} rows={3} value={value} placeholder={field.placeholder} aria-required={field.required} disabled={busy} onChange={event => onChange(event.target.value)}/>
            : field.type === "select"
              ? <select id={id} value={value} aria-required={field.required} disabled={busy} onChange={event => onChange(event.target.value)}>
                <option value="">{field.placeholder ?? "Выберите…"}</option>
                {(field.options ?? []).map(option => <option value={option} key={option}>{option}</option>)}
              </select>
              : <input id={id} type="text" value={value} placeholder={field.placeholder} aria-required={field.required} disabled={busy} onChange={event => onChange(event.target.value)}/>}
        </label>;
      })}
    </div>
    {error && <p className="ui-form-error" role="alert">{error}</p>}
    <footer className="ui-block-foot">
      <button type="submit" className="ui-block-submit" disabled={busy}>{block.submitLabel ?? "Отправить"}</button>
    </footer>
  </form>;
}
