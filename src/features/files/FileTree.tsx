import { ChevronRight, Download, File, FileCode, FileImage, Folder, Pencil, Search, Trash2 } from "lucide-react";
import type { FileEntry } from "../../lib/types";
import { baseName, changeLabels, changedInside, isImageFile, isTextFile, type FileChangeState } from "./file-types";

export type TreeEntry = FileEntry & { path: string };

export function FileTree({
  currentPath,
  entries,
  openedPath,
  dirty,
  filter,
  onFilter,
  changes,
  onlyChanged,
  onOnlyChanged,
  onOpen,
  onParent,
  onRename,
  onDelete,
  onDownload,
  loading,
  disabled,
}: {
  currentPath: string;
  entries: TreeEntry[];
  openedPath?: string;
  dirty?: boolean;
  filter: string;
  onFilter: (value: string) => void;
  changes: Map<string, FileChangeState>;
  onlyChanged: boolean;
  onOnlyChanged: (value: boolean) => void;
  onOpen: (entry: TreeEntry) => void;
  onParent: () => void;
  onRename: (entry: TreeEntry) => void;
  onDelete: (entry: TreeEntry) => void;
  onDownload: (entry: TreeEntry) => void;
  loading: boolean;
  disabled?: boolean;
}) {
  const query = filter.trim().toLowerCase();
  const visible = entries.filter(entry => {
    const status = changes.get(entry.path);
    const changedInsideFolder = entry.type === "directory" && changedInside(entry.path, changes) > 0;
    if (onlyChanged && !status && !changedInsideFolder) return false;
    return !query || entry.type === "directory" || entry.name.toLowerCase().includes(query);
  });

  return <>
    <div className="file-tree-tools">
      <label className="file-filter">
        <Search size={12}/>
        <input
          value={filter}
          onChange={event => onFilter(event.target.value)}
          placeholder="Найти файл"
          aria-label="Найти файл в папке"
          title="Поиск по имени файла"
          spellCheck={false}
        />
      </label>
      {changes.size > 0 && <button
        type="button"
        className={"file-change-filter" + (onlyChanged ? " active" : "")}
        onClick={() => onOnlyChanged(!onlyChanged)}
        aria-pressed={onlyChanged}
        title={onlyChanged ? "Показать все файлы" : "Показать только изменённые агентом"}
      >{changes.size}</button>}
    </div>
    <div className="file-tree-list" role="list">
      {currentPath !== "." && <div className="file-row">
        <button className="file-item file-parent" onClick={onParent} title="На уровень выше">
          <ChevronRight size={14}/><span>..</span>
        </button>
      </div>}
      {visible.map(entry => {
        const status = changes.get(entry.path);
        const folderCount = entry.type === "directory" ? changedInside(entry.path, changes) : 0;
        const Icon = entry.type === "directory" ? Folder : isImageFile(entry.name) ? FileImage : isTextFile(entry.name) ? FileCode : File;
        return <div
          className={"file-row" + (openedPath === entry.path ? " selected" : "") + (status ? " is-changed" : "") + (folderCount ? " has-changes" : "")}
          key={entry.path}
          role="listitem"
        >
          <button
            className={"file-item " + (entry.type === "directory" ? "folder" : "file")}
            onClick={() => onOpen(entry)}
            title={entry.type === "directory" ? "Открыть папку" : "Открыть в редакторе"}
            aria-current={openedPath === entry.path ? true : undefined}
          >
            <Icon size={15}/>
            <span className="file-name">{entry.name}</span>
            {status && <i className={"file-change-mark " + status} title={changeLabels[status]} aria-label={changeLabels[status]}/>}
            {folderCount > 0 && <span className="file-change-count" title={"Изменённых файлов внутри: " + folderCount}>{folderCount}</span>}
            {dirty && openedPath === entry.path && <i className="file-dirty-dot" title="Есть несохранённые правки"/>}
            {entry.type === "directory" && <ChevronRight size={13} className="file-folder-arrow"/>}
          </button>
          <div className="file-actions">
            {entry.type === "file" && <button
              type="button"
              onClick={() => onDownload(entry)}
              disabled={disabled}
              title={"Скачать «" + entry.name + "»"}
              aria-label={"Скачать файл " + entry.name}
            ><Download size={12}/></button>}
            <button
              type="button"
              onClick={() => onRename(entry)}
              disabled={disabled}
              title={"Переименовать «" + baseName(entry.name) + "»"}
              aria-label={"Переименовать " + entry.name}
            ><Pencil size={12}/></button>
            <button
              type="button"
              className="danger"
              onClick={() => onDelete(entry)}
              disabled={disabled}
              title={"Удалить «" + entry.name + "»"}
              aria-label={"Удалить " + entry.name}
            ><Trash2 size={12}/></button>
          </div>
        </div>;
      })}
      {!visible.length && !loading && <div className="file-empty">{filter || onlyChanged ? "Ничего не нашлось" : "Папка пуста"}</div>}
    </div>
  </>;
}
