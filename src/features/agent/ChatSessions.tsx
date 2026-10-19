import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { createConversation, listConversations, type ConversationSummary } from "../../lib/project-api";
import { NestLoader } from "../../components/NestLoader";

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

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="modal sessions-modal" role="dialog" aria-modal="true" aria-label="Чаты проекта" onMouseDown={event => event.stopPropagation()}>
      <header className="modal-head">
        <div><span className="eyebrow">ИСТОРИЯ</span><h2>Чаты проекта</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={16}/></button>
      </header>
      <div className="modal-body">
        {sessionsError || error ? <div className="modal-state">{sessionsError || error}</div>
          : sessions === null ? <div className="modal-state"><NestLoader size={26}/><span>Загружаем историю…</span></div>
          : sessions.length === 0 ? <div className="modal-state">В проекте ещё нет сохранённых чатов.</div>
          : <ul className="session-list">{sessions.map(session => <li key={session.id}>
            <button className={"session-item" + (session.id === conversationId ? " active" : "")} onClick={() => openSession(session.id)} title={session.label}>
              <span className="session-item-head"><strong>{session.label}</strong><small>{formatSessionTime(session.updatedAt)}</small></span>
              {session.preview && <span className="session-item-preview">{session.preview}</span>}
              <span className="session-item-meta">{session.messageCount} сообщ.{session.id === conversationId ? " · открыт сейчас" : ""}</span>
            </button>
          </li>)}</ul>}
      </div>
      <footer className="modal-foot">
        <p className="modal-lead">Чаты хранятся на сервере: история проекта открывается с любого устройства и переживает перезагрузку.</p>
        <button className="send-button" onClick={() => void startSession()} disabled={busy}><Plus size={14}/> Новая сессия</button>
      </footer>
    </section>
  </div>;
}
