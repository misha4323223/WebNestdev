import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { createConversation, deleteConversation, listConversations, type ConversationSummary } from "../../lib/project-api";
import { NestLoader } from "../../components/NestLoader";
import { conversationMemoryKey } from "../workspace/useWorkspace";
import { publicUserMessage } from "../../lib/agent-kickoff";

/**
 * Чаты проекта — не часть одного запуска, а навигация рабочей области: список живёт
 * рядом с вкладками, поэтому переписка открывается и из «Файлов», и из «Изменений».
 * Хук хранит список и счётчик для вкладок, модальное окно только показывает его.
 */
export function useChatSessions(projectId: string | null, conversationId: string | null) {
  const [sessions, setSessions] = useState<ConversationSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setSessionsError("");
      setSessions((await listConversations(projectId)).conversations);
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "Не удалось загрузить список чатов");
    }
  }, [projectId]);

  // Список и счётчик честны после запуска, переключения чата и перезагрузки.
  useEffect(() => { void reload() }, [reload, conversationId]);

  return { sessions, sessionsError, reload };
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export function ChatSessionsModal({ open, projectId, conversationId, sessions, sessionsError, reload, onClose, onOpenConversation }: {
  open: boolean;
  projectId: string;
  conversationId: string;
  sessions: ConversationSummary[] | null;
  sessionsError: string;
  reload: () => Promise<void>;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { if (open) setError(""); }, [open]);
  if (!open) return null;

  function openSession(id: string) {
    onClose();
    if (id !== conversationId) onOpenConversation(id);
  }

  /** Завершённый чат остаётся как есть: у проекта может быть несколько переписок. */
  async function startSession() {
    setBusy(true);
    setError("");
    try {
      const created = await createConversation(projectId);
      onClose();
      onOpenConversation(created.id);
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать сессию");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Удаление чата не трогает проект: файлы, настройки и остальные переписки остаются. Если
   * удалён открытый чат, рабочая область переходит к следующему, а когда других нет — сразу
   * создаёт новый, иначе панель осталась бы с идентификатором несуществующей сессии.
   */
  async function removeSession(session: ConversationSummary) {
    if (deleting) return;
    const label = session.label || session.title || "этот чат";
    if (!window.confirm(`Удалить чат «${label}»?\n\nПереписка и план этого чата будут удалены. Файлы проекта и остальные чаты останутся. Это действие нельзя отменить.`)) return;
    setDeleting(session.id);
    setError("");
    try {
      await deleteConversation(session.id);
      const remaining = (sessions ?? []).filter(item => item.id !== session.id);
      try {
        localStorage.removeItem("webnestdev.pendingStart." + session.id);
        if (session.id === conversationId) {
          localStorage.removeItem("webnestdev.conversationId");
          localStorage.removeItem(conversationMemoryKey(projectId));
        }
      } catch {}
      if (session.id === conversationId) {
        if (remaining[0]) {
          onOpenConversation(remaining[0].id);
          onClose();
        } else {
          const created = await createConversation(projectId);
          onOpenConversation(created.id);
          onClose();
        }
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить чат");
    } finally {
      setDeleting("");
    }
  }

  const notice = error || sessionsError;

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="modal sessions-modal" role="dialog" aria-modal="true" aria-label="Чаты проекта" onMouseDown={event => event.stopPropagation()}>
      <header className="modal-head">
        <div><span className="eyebrow">ИСТОРИЯ</span><h2>Чаты проекта</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть" title="Закрыть"><X size={16}/></button>
      </header>
      <div className="modal-body">
        {notice && <div className="session-error" role="alert">{notice}</div>}
        {sessions === null
          ? sessionsError ? null : <div className="modal-state"><NestLoader size={26}/><span>Загружаем историю…</span></div>
          : sessions.length === 0 ? <div className="modal-state">В проекте ещё нет сохранённых чатов.</div>
          : <ul className="session-list">{sessions.map(session => {
            // Название и превью чата приходят из сохранённых сообщений, а первое из них бывает
            // автозапуском с инструкциями агенту. Человеку показывается тот же очищенный текст,
            // что и в переписке: промт не должен всплывать даже в списке чатов.
            const label = publicUserMessage(session.label || session.title).text;
            const preview = session.preview ? publicUserMessage(session.preview).text : "";
            return <li key={session.id} className="session-row">
              <button className={"session-item" + (session.id === conversationId ? " active" : "")} onClick={() => openSession(session.id)} title={label}>
                <span className="session-item-head"><strong>{label}</strong><small>{formatSessionTime(session.updatedAt)}</small></span>
                {preview && <span className="session-item-preview">{preview}</span>}
                <span className="session-item-meta">{session.messageCount} сообщ.{session.id === conversationId ? " · открыт сейчас" : ""}</span>
              </button>
              <button
                className="session-delete"
                onClick={() => void removeSession(session)}
                disabled={Boolean(deleting)}
                title="Удалить чат"
                aria-label={"Удалить чат «" + label + "»"}
              >
                {deleting === session.id ? <NestLoader size={16}/> : <Trash2 size={13}/>}
              </button>
            </li>;
          })}</ul>}
      </div>
      <footer className="modal-foot">
        <p className="modal-lead">Чаты хранятся на сервере: история проекта открывается с любого устройства и переживает перезагрузку.</p>
        <button className="send-button" onClick={() => void startSession()} disabled={busy}><Plus size={14}/> Новая сессия</button>
      </footer>
    </section>
  </div>;
}
