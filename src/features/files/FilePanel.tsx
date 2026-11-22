import { Download, FilePlus2, FolderPlus, Loader2, RefreshCw, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { downloadProjectZip, getProjectFile, listProjectFiles, saveProjectFile } from "../../lib/project-api";
import {
  createProjectEntry,
  deleteProjectEntry,
  downloadProjectFile,
  renameProjectEntry,
  uploadProjectEntry,
} from "../../lib/project-files-api";
import { Hint } from "../../components/Hint";
import { FileTree, type TreeEntry } from "./FileTree";
import { FileEditor, type OpenedFile } from "./FileEditor";
import { FileEntryDialog, type FileDialogState } from "./FileEntryDialog";
import { useFileChanges } from "./useFileChanges";
import { fileFolder, isSecretEnvName } from "./file-types";
import { fileToBase64, MAX_UPLOAD_BYTES } from "./upload-utils";

function treeEntries(files: { name: string; type: "file" | "directory" }[], folder: string): TreeEntry[] {
  return files
    .filter(file => !isSecretEnvName(file.name))
    .map(file => ({ ...file, path: folder === "." ? file.name : folder + "/" + file.name }));
}

/**
 * Файлы проекта: дерево, прямое редактирование и операции с узлами. Панель не запускает агента —
 * программист сам создаёт папки, загружает материалы, переименовывает и удаляет файлы, а агент
 * видит те же изменения в следующем запуске.
 */
export function FilePanel({
  projectId,
  projectName,
  running,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  running?: boolean;
  onSaved?: () => void;
}) {
  const [currentPath, setCurrentPath] = useState(".");
  const [files, setFiles] = useState<TreeEntry[]>([]);
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState("");
  const [filter, setFilter] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [mobileFocus, setMobileFocus] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<FileDialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const lastChangeRevision = useRef(0);
  const changes = useFileChanges(projectId, Boolean(running));

  const dirty = Boolean(opened && !opened.binary && draft !== opened.content);

  /** Несохранённую правку нельзя потерять молча: уход из файла спрашивает подтверждение. */
  function keepDraft() {
    if (!dirty) return true;
    return window.confirm("Изменения в «" + (opened as OpenedFile).path + "» не сохранены. Продолжить без сохранения?");
  }

  async function load(target = currentPath, options: { keepOpen?: boolean; silent?: boolean; force?: boolean } = {}) {
    if (!options.force && !options.keepOpen && !keepDraft()) return;
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const data = await listProjectFiles(projectId, target);
      const folder = data.path || target;
      setCurrentPath(folder);
      setFiles(treeEntries(data.files, folder));
      if (!options.keepOpen) {
        setOpened(null);
        setDraft("");
        setSaved(false);
        setMobileFocus(false);
        setFilter("");
        setOnlyChanged(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось прочитать папку проекта");
    } finally {
      setLoading(false);
    }
  }

  // Смена проекта — другой набор файлов: старый черновик к нему не относится.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the project changes
  useEffect(() => {
    setOpened(null);
    setDraft("");
    setSaved(false);
    setMobileFocus(false);
    void load(".", { keepOpen: false, force: true });
  }, [projectId]);

  // Агент пишет файлы, пока человек смотрит панель: обновляем список без закрытия редактора,
  // но никогда поверх несохранённой правки.
  useEffect(() => {
    if (!changes.revision || changes.revision === lastChangeRevision.current) return;
    lastChangeRevision.current = changes.revision;
    if (dirty) return;
    let alive = true;
    void listProjectFiles(projectId, currentPath)
      .then(data => { if (alive) setFiles(treeEntries(data.files, data.path || currentPath)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [changes.revision, projectId, currentPath, dirty]);

  async function open(entry: TreeEntry) {
    if (entry.type === "directory") {
      await load(entry.path);
      return;
    }
    if (!keepDraft()) return;
    setError("");
    setNotice("");
    try {
      const file = await getProjectFile(projectId, entry.path);
      setOpened({ path: file.path, content: file.content, binary: file.binary === true });
      setDraft(file.content);
      setSaved(false);
      setMobileFocus(!file.binary);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось прочитать файл");
    }
  }

  async function save() {
    if (!opened || opened.binary || saving) return;
    setSaving(true);
    setError("");
    try {
      await saveProjectFile(projectId, opened.path, draft);
      setOpened({ ...opened, content: draft });
      setSaved(true);
      // Сохранение могло совпасть с правками агента: список перечитываем, черновик не трогаем.
      void load(currentPath, { keepOpen: true, silent: true });
      onSaved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось сохранить файл");
    } finally {
      setSaving(false);
    }
  }

  async function downloadZip() {
    if (downloading) return;
    setDownloading(true);
    setError("");
    try {
      await downloadProjectZip(projectId, projectName);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось скачать архив проекта");
    } finally {
      setDownloading(false);
    }
  }

  async function downloadFile(entry: TreeEntry) {
    setError("");
    try {
      await downloadProjectFile(projectId, entry.path);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось скачать файл");
    }
  }

  async function upload(filesToUpload: FileList | null) {
    if (!filesToUpload?.length) return;
    const list = [...filesToUpload];
    const tooBig = list.find(file => file.size > MAX_UPLOAD_BYTES);
    if (tooBig) {
      setError("«" + tooBig.name + "» больше " + Math.round(MAX_UPLOAD_BYTES / 1000) + " КБ: загрузите файл меньше.");
      return;
    }
    setError("");
    setNotice("");
    let uploaded = 0;
    const failures: string[] = [];
    try {
      for (const [index, file] of list.entries()) {
        setUploading(list.length === 1 ? file.name : (index + 1) + " из " + list.length);
        try {
          await uploadProjectEntry(projectId, {
            path: currentPath,
            name: file.name,
            data: await fileToBase64(file),
          });
          uploaded += 1;
        } catch (failure) {
          failures.push("«" + file.name + "»: " + (failure instanceof Error ? failure.message : String(failure)));
        }
      }
      if (uploaded) {
        await load(currentPath, { keepOpen: true, silent: true });
        setNotice(uploaded === 1 ? "Файл загружен в «" + (currentPath === "." ? "корень проекта" : currentPath) + "»." : "Загружено файлов: " + uploaded + ".");
        onSaved?.();
      }
      if (failures.length) setError(failures.join(" "));
    } finally {
      setUploading("");
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function confirmDialog(value: string) {
    if (!dialog || busy) return;
    setBusy(true);
    setError("");
    try {
      if (dialog.kind === "file" || dialog.kind === "directory") {
        const path = currentPath === "." ? value : currentPath + "/" + value;
        const created = await createProjectEntry(projectId, { path, type: dialog.kind });
        await load(currentPath, { keepOpen: true, silent: true });
        if (created.type === "file") {
          const file = await getProjectFile(projectId, created.path);
          setOpened({ path: file.path, content: file.content, binary: file.binary === true });
          setDraft(file.content);
          setSaved(false);
          setMobileFocus(true);
        }
        setNotice(created.type === "directory" ? "Папка создана." : "Файл создан.");
      } else if (dialog.kind === "rename") {
        const target = fileFolder(dialog.path) === "." ? value : fileFolder(dialog.path) + "/" + value;
        await renameProjectEntry(projectId, { from: dialog.path, to: target });
        if (opened && (opened.path === dialog.path || opened.path.startsWith(dialog.path + "/"))) {
          setOpened(null);
          setDraft("");
          setSaved(false);
          setMobileFocus(false);
        }
        await load(currentPath, { keepOpen: true, silent: true });
        setNotice("Переименовано в «" + value + "».");
      } else if (dialog.kind === "delete") {
        await deleteProjectEntry(projectId, dialog.path);
        if (opened && (opened.path === dialog.path || opened.path.startsWith(dialog.path + "/"))) {
          setOpened(null);
          setDraft("");
          setSaved(false);
          setMobileFocus(false);
        }
        await load(currentPath, { keepOpen: true, silent: true });
        setNotice("Удалено.");
      }
      setDialog(null);
      onSaved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось выполнить действие");
    } finally {
      setBusy(false);
    }
  }

  function leaveEditor() {
    if (!keepDraft()) return;
    setOpened(null);
    setDraft("");
    setSaved(false);
    setMobileFocus(false);
  }

  const parent = currentPath === "." ? null : currentPath.split("/").slice(0, -1).join("/") || ".";

  return <section className="files-panel">
    <div className="panel-title">
      <div>
        <span className="eyebrow">ФАЙЛЫ</span>
        <span className="panel-title-strong">
          <strong>{currentPath === "." ? "Корень проекта" : currentPath}</strong>
          <Hint label="Файлы проекта">Правьте файлы прямо здесь: Enter и Tab делают отступы, скобки закрываются сами, Ctrl+S сохраняет. Агент увидит изменения.</Hint>
        </span>
      </div>
      <div className="files-head-actions">
        <button className="ghost-button file-tool" onClick={() => setDialog({ kind: "file", folder: currentPath })} title="Создать файл в текущей папке">
          <FilePlus2 size={14}/><span>Файл</span>
        </button>
        <button className="ghost-button file-tool" onClick={() => setDialog({ kind: "directory", folder: currentPath })} title="Создать папку в текущей папке">
          <FolderPlus size={14}/><span>Папка</span>
        </button>
        <button className="ghost-button file-tool" onClick={() => uploadRef.current?.click()} disabled={Boolean(uploading)} title="Загрузить файлы в текущую папку">
          {uploading ? <Loader2 size={14} className="spin"/> : <Upload size={14}/>}<span>{uploading || "Загрузить"}</span>
        </button>
        <button className="ghost-button file-tool" onClick={() => void downloadZip()} disabled={downloading} title="Скачать проект архивом (.zip)" aria-label="Скачать проект архивом">
          {downloading ? <Loader2 size={14} className="spin"/> : <Download size={14}/>}<span>ZIP</span>
        </button>
        <button className="ghost-button file-tool" onClick={() => void load()} disabled={loading} title="Обновить список файлов" aria-label="Обновить список файлов">
          <RefreshCw size={14}/><span>Обновить</span>
        </button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          className="file-upload-input"
          onChange={event => void upload(event.target.files)}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
    </div>
    {error && <div className="file-error" role="alert">{error}</div>}
    {notice && <div className="file-notice" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Закрыть сообщение">×</button></div>}
    {changes.total > 0 && <div className="file-change-summary">
      <span><i className="file-change-mark modified"/>{changes.total} {changes.total === 1 ? "файл изменён" : "файлов изменено"} агентом</span>
      <button type="button" onClick={() => setOnlyChanged(!onlyChanged)}>{onlyChanged ? "Показать все" : "Только изменения"}</button>
    </div>}
    <div className={"file-browser" + (opened ? " has-file" : " is-browsing") + (mobileFocus ? " editing" : "")}>
      <div className="file-tree">
        <FileTree
          currentPath={currentPath}
          entries={files}
          openedPath={opened?.path}
          dirty={dirty}
          filter={filter}
          onFilter={setFilter}
          changes={changes.changes}
          onlyChanged={onlyChanged}
          onOnlyChanged={setOnlyChanged}
          onOpen={entry => void open(entry)}
          onParent={() => parent && void load(parent)}
          onRename={entry => setDialog({ kind: "rename", path: entry.path, directory: entry.type === "directory" })}
          onDelete={entry => setDialog({ kind: "delete", path: entry.path, directory: entry.type === "directory" })}
          onDownload={entry => void downloadFile(entry)}
          loading={loading}
          disabled={busy}
        />
      </div>
      <div className="file-editor-pane">
        {opened
          ? <FileEditor
              projectId={projectId}
              opened={opened}
              draft={draft}
              dirty={dirty}
              saved={saved}
              saving={saving}
              onDraft={setDraft}
              onSave={() => void save()}
              onRevert={() => { setDraft(opened.content); setSaved(false); }}
              onClose={leaveEditor}
              onSavedChange={setSaved}
            />
          : <div className="file-placeholder">
              <FilePlus2 size={20}/>
              <strong>Файлы проекта</strong>
              <span>Выберите файл слева или создайте новый. Текст сохраняется в проект без агента, а изменения видны в «Изменениях».</span>
            </div>}
      </div>
    </div>
    {dialog && <FileEntryDialog state={dialog} busy={busy} onClose={() => setDialog(null)} onConfirm={value => void confirmDialog(value)}/>}
  </section>;
}
