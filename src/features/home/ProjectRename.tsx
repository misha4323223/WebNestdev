import { useState } from "react";
import { Check, X } from "lucide-react";

/**
 * Inline rename form. Enter saves, Escape cancels, and an empty name keeps the
 * current one (the button stays disabled).
 */
export function ProjectRenameForm({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const value = draft.trim();
  return <form
    className="project-rename"
    onSubmit={event => { event.preventDefault(); if (value) onSubmit(value); }}
  >
    <input
      autoFocus
      value={draft}
      maxLength={120}
      placeholder="Название проекта"
      aria-label="Новое название проекта"
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === "Escape") onCancel(); }}
    />
    <div className="project-rename-actions">
      <button type="submit" className="icon-button" disabled={!value} title="Сохранить название" aria-label="Сохранить название"><Check size={14}/></button>
      <button type="button" className="icon-button" onClick={onCancel} title="Отмена" aria-label="Отменить переименование"><X size={14}/></button>
    </div>
  </form>;
}
