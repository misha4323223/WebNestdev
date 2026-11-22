import { useEffect, useRef, useState, type FormEvent } from "react";
import { FolderPlus, FilePlus2, Pencil, Trash2, X } from "lucide-react";
import { baseName } from "./file-types";

export type FileDialogState =
  | { kind: "file" | "directory"; folder: string }
  | { kind: "rename"; path: string; directory: boolean }
  | { kind: "delete"; path: string; directory: boolean };

/** Одно окно на создание, переименование и удаление: действия отличаются только полями. */
export function FileEntryDialog({
  state,
  busy,
  onClose,
  onConfirm,
}: {
  state: FileDialogState;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
}) {
  const [name, setName] = useState(state.kind === "rename" ? baseName(state.path) : "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setName(state.kind === "rename" ? baseName(state.path) : "");
    if (state.kind !== "delete") window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [state]);

  const deleting = state.kind === "delete";
  const renaming = state.kind === "rename";
  const title = deleting ? "Удалить" : renaming ? "Переименовать" : state.kind === "directory" ? "Новая папка" : "Новый файл";
  const Icon = deleting ? Trash2 : renaming ? Pencil : state.kind === "directory" ? FolderPlus : FilePlus2;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!deleting) {
      const value = name.trim();
      if (!value) return;
      if (renaming && (value.includes("/") || value === "." || value === "..")) return;
      onConfirm(value);
      return;
    }
    onConfirm("");
  }

  return <div
    className="file-dialog-backdrop"
    role="presentation"
    onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
    onKeyDown={event => { if (event.key === "Escape" && !busy) onClose(); }}
  >
    <form className={"file-dialog" + (deleting ? " danger" : "")} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="file-dialog-title">
      <div className="file-dialog-head">
        <span className="file-dialog-icon"><Icon size={16}/></span>
        <div>
          <strong id="file-dialog-title">{title}</strong>
          <small>{deleting
            ? state.path
            : renaming
              ? "Новое имя в той же папке"
              : "Папка: " + (state.folder === "." ? "корень проекта" : state.folder)}</small>
        </div>
        <button type="button" className="file-dialog-close" onClick={onClose} disabled={busy} aria-label="Закрыть"><X size={14}/></button>
      </div>
      {deleting
        ? <p className="file-dialog-note">
            {state.directory
              ? "Папка будет удалена вместе со всем содержимым. Отменить это действие нельзя."
              : "Файл будет удалён из проекта. Отменить это действие нельзя."}
          </p>
        : <label className="file-dialog-field">
            <span>{state.kind === "directory" ? "Имя папки" : "Имя файла"}</span>
            <input
              ref={inputRef}
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={state.kind === "directory" ? "components" : "index.tsx"}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </label>}
      <div className="file-dialog-actions">
        <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Отмена</button>
        <button type="submit" className={deleting ? "file-dialog-confirm danger" : "file-dialog-confirm"} disabled={busy || (!deleting && !name.trim())}>
          {busy ? "…" : deleting ? "Удалить" : renaming ? "Переименовать" : "Создать"}
        </button>
      </div>
    </form>
  </div>;
}
