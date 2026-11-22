import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeft, Check, ExternalLink, FileCode, Loader2, Pencil, Sparkles } from "lucide-react";
import { projectAssetUrl } from "../../lib/project-api";
import { baseName, isImageFile, isJsonFile } from "./file-types";
import { formatJsonText, nextEditorValue } from "./editor-aids";

export type OpenedFile = { path: string; content: string; binary: boolean };

/**
 * Редактор панели «Файлы». Он остаётся обычным textarea с номерами строк, но получает
 * автопомощь при наборе: отступ после Enter, закрытие скобок и кавычек, Tab и Shift+Tab.
 * Это не линтер и не подсказки языка — только то, что не требует тяжёлой библиотеки.
 */
export function FileEditor({
  projectId,
  opened,
  draft,
  dirty,
  saved,
  saving,
  onDraft,
  onSave,
  onRevert,
  onClose,
  onSavedChange,
}: {
  projectId: string;
  opened: OpenedFile;
  draft: string;
  dirty: boolean;
  saved: boolean;
  saving: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onClose: () => void;
  onSavedChange: (saved: boolean) => void;
}) {
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [formatError, setFormatError] = useState("");
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => draft.split("\n").length, [draft]);

  useEffect(() => {
    setCursor({ line: 1, column: 1 });
    setFormatError("");
    if (!opened.path || opened.binary) return;
    window.requestAnimationFrame(() => {
      const element = sourceRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(0, 0);
    });
  }, [opened.path, opened.binary]);

  function updateCursor(element: HTMLTextAreaElement) {
    const upto = element.value.slice(0, element.selectionStart ?? 0);
    const lastBreak = upto.lastIndexOf("\n");
    setCursor({ line: upto.split("\n").length, column: upto.length - lastBreak });
  }

  function applyEdit(edit: { value: string; start: number; end: number }, element: HTMLTextAreaElement) {
    onDraft(edit.value);
    onSavedChange(false);
    window.requestAnimationFrame(() => {
      element.setSelectionRange(edit.start, edit.end);
      updateCursor(element);
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const element = event.currentTarget;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const edit = nextEditorValue(draft, element.selectionStart ?? 0, element.selectionEnd ?? 0, event.key, event.shiftKey);
    if (!edit) return;
    event.preventDefault();
    applyEdit(edit, element);
  }

  function formatJson() {
    try {
      const next = formatJsonText(draft);
      onDraft(next);
      onSavedChange(false);
      setFormatError("");
    } catch (error) {
      setFormatError(error instanceof Error ? error.message : "JSON не разобрался");
    }
  }

  return <div className="file-editor">
    <div className="editor-head">
      <button className="editor-back" onClick={onClose} title="К списку файлов" aria-label="К списку файлов"><ArrowLeft size={13}/></button>
      <span className="editor-mode" title="Ctrl+S сохраняет"><Pencil size={11}/> Редактор</span>
      <span className="editor-path" title={opened.path}>{baseName(opened.path)}</span>
      {!opened.binary && <div className="editor-actions">
        {dirty ? <span className="editor-dirty">не сохранено</span>
          : saved ? <span className="editor-saved"><Check size={11}/> Сохранено</span> : null}
        {isJsonFile(opened.path) && <button
          type="button"
          className="editor-format"
          onClick={formatJson}
          title="Отформатировать JSON с отступами"
        ><Sparkles size={11}/> JSON</button>}
        {dirty && <button className="ghost-button editor-revert" onClick={onRevert} disabled={saving} title="Вернуть содержимое файла">Отменить</button>}
        <button className="editor-save" onClick={onSave} disabled={!dirty || saving} title="Сохранить (Ctrl+S)">
          {saving ? <><Loader2 size={11} className="spin"/> Сохраняем</> : "Сохранить"}
        </button>
      </div>}
    </div>
    {opened.binary
      ? isImageFile(opened.path)
        ? <div className="file-image">
            <img src={projectAssetUrl(projectId, opened.path)} alt={baseName(opened.path)} loading="lazy"/>
            <a href={projectAssetUrl(projectId, opened.path)} target="_blank" rel="noreferrer" title="Открыть изображение в новой вкладке">
              <ExternalLink size={12}/> Открыть в новой вкладке
            </a>
          </div>
        : <div className="file-placeholder"><FileCode size={20}/><span>Двоичный файл: только просмотр.</span></div>
      : <>
          <div className="file-editor-body">
            <div className="file-gutter" ref={gutterRef} aria-hidden="true">
              {Array.from({ length: Math.min(lines, 20000) }, (_, index) => <span key={index}>{index + 1}</span>)}
            </div>
            <textarea
              ref={sourceRef}
              className="file-source"
              value={draft}
              wrap="off"
              spellCheck={false}
              autoComplete="off"
              onChange={event => { onDraft(event.target.value); onSavedChange(false); updateCursor(event.target); }}
              onKeyDown={handleKeyDown}
              onKeyUp={event => updateCursor(event.currentTarget)}
              onClick={event => updateCursor(event.currentTarget)}
              onScroll={event => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop; }}
              aria-label={"Содержимое файла " + opened.path}
            />
          </div>
          <div className="file-statusbar">
            <span>Стр {cursor.line}, столб {cursor.column}</span>
            <span>{lines} {lines % 10 === 1 && lines % 100 !== 11 ? "строка" : lines % 10 >= 2 && lines % 10 <= 4 && (lines % 100 < 12 || lines % 100 > 14) ? "строки" : "строк"}</span>
            {formatError && <span className="file-format-error" title={formatError}>JSON не разобран</span>}
            <span className="file-status-note">Tab, Shift+Tab, Ctrl+S; скобки закрываются сами.</span>
          </div>
        </>}
  </div>;
}
