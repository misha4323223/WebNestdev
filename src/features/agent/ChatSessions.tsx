import { useCallback, useEffect, useState } from "react";
import { listConversations, type ConversationSummary } from "../../lib/project-api";

/**
 * Чаты проекта — не часть одного запуска, а навигация рабочей области: список живёт в
 * колонке слева, поэтому переписка открывается и из «Файлов», и из «Изменений».
 * Хук хранит список; колонка только показывает его.
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

  // Список честен после запуска, переключения чата и перезагрузки.
  useEffect(() => { void reload() }, [reload, conversationId]);

  return { sessions, sessionsError, reload };
}

/** Время строки чата: сегодня — часы, дальше — дата. */
export function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export type ChatGroupId = "pinned" | "today" | "yesterday" | "week" | "older";

export const CHAT_GROUP_LABELS: Record<ChatGroupId, string> = {
  pinned: "Закреплённые",
  today: "Сегодня",
  yesterday: "Вчера",
  week: "Предыдущие 7 дней",
  older: "Старше",
};

const GROUP_ORDER: ChatGroupId[] = ["pinned", "today", "yesterday", "week", "older"];

/**
 * Группа по дате последнего сообщения. Считаются календарные дни, а не часы: чат, открытый
 * вчера в 23:50, должен лежать во «Вчера», а не в «Сегодня» через десять минут.
 */
export function chatGroupOf(updatedAt: string): Exclude<ChatGroupId, "pinned"> {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "older";
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  return "older";
}

/**
 * Раскладка списка: закреплённые сверху, дальше свежие по датам. Внутри группы порядок
 * серверный (по времени последнего сообщения) — пересортировывать его незачем.
 */
export function groupChats(sessions: ConversationSummary[], pinned: string[]) {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const buckets = new Map<ChatGroupId, ConversationSummary[]>();
  const pinnedItems = pinned.map(id => byId.get(id)).filter((item): item is ConversationSummary => Boolean(item));
  if (pinnedItems.length) buckets.set("pinned", pinnedItems);
  for (const session of sessions) {
    if (pinned.includes(session.id)) continue;
    const id = chatGroupOf(session.updatedAt);
    buckets.set(id, [...(buckets.get(id) ?? []), session]);
  }
  return GROUP_ORDER
    .filter(id => buckets.has(id))
    .map(id => ({ id, items: buckets.get(id) ?? [] }));
}

/**
 * Закрепления — личная настройка браузера, а не свойство чата: они не влияют на работу агента
 * и не меняют проект, поэтому хранятся рядом с темой и плотностью, а не в базе.
 */
const pinnedKey = (projectId: string) => "webnestdev.pinnedChats." + projectId;

export function readPinnedChats(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(pinnedKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writePinnedChats(projectId: string, ids: string[]) {
  try { localStorage.setItem(pinnedKey(projectId), JSON.stringify(ids)) } catch {}
}
