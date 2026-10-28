import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { hashAuditIp } from "../secrets/secret-audit.js";

/**
 * Журнал безопасности платформы: кто вошёл, кто не смог, что изменил.
 *
 * Отдельный от `secret-audit` журнал: тот отвечает на вопрос «кто трогал секреты проекта», а
 * этот — «что происходило со входом и платформой». Объединять их значило бы смешивать проектную
 * историю с админской и показывать владельцу проекта чужие события.
 *
 * В журнал не попадают значения ключей, пароли, TOTP-секреты и коды восстановления. Записываются
 * только действие, кто его совершил, над чем и безопасные подробности (имена ключей, счётчики).
 * Поэтому журнал можно читать в админке и хранить рядом с остальными данными.
 *
 * Запись best-effort: сбой журнала не должен отменять уже выполненный вход или сохранение ключей,
 * но и молчать о нём нельзя — ошибка уходит в лог сервера.
 */

export const AUDIT_ACTIONS = {
  "admin.login.failed": "Неудачный вход администратора",
  "admin.login.password": "Пароль администратора принят",
  "admin.login.success": "Вход администратора",
  "admin.login.recovery": "Вход администратора по коду восстановления",
  "admin.2fa.failed": "Неверный код второго фактора",
  "admin.2fa.enabled": "Второй фактор подключён",
  "admin.2fa.reissued": "Коды восстановления перевыпущены",
  "admin.logout.all": "Завершены все сеансы администратора",
  "platform.keys.updated": "Изменены ключи платформы",
  "billing.plans.updated": "Изменены тарифы и скидки",
  "project.deleted": "Удалён проект",
  "user.registered": "Зарегистрирован аккаунт",
  "user.login.failed": "Неудачный вход пользователя",
  "user.sessions.revoked": "Завершены все сеансы пользователя",
  // Действия администратора над аккаунтом: каждое меняет доступ или деньги, поэтому в журнале
  // должно быть видно и действие, и автор, а не только след в самой записи аккаунта.
  "user.blocked": "Аккаунт заблокирован администратором",
  "user.unblocked": "Блокировка аккаунта снята",
  "user.sessions.revoked.admin": "Сеансы пользователя завершены администратором",
  "user.plan.granted": "Тариф выдан без оплаты",
  "user.tokens.granted": "Начислены токены",
  // Статус обращения: по нему поддержка закрывает темы, и «кто закрыл» — часть разбора.
  "support.status": "Статус обращения изменён",
  // Рассылка: кто её отправил, кому писал тестовое письмо и кто остановил очередь. Отправка
  // сотни писем от имени платформы без записи «кто это сделал» — это то, что нельзя разобрать
  // постфактум, поэтому события рассылки идут в тот же журнал, что и ключи платформы.
  // Очистка Docker: событие нужно для того, чтобы удаление на хосте можно было сопоставить с
  // моментом, когда на сервере кончилось место, а не искать причину по интуиции.
  "infra.docker.pruned": "Очистка Docker",
  "mail.send": "Поставлена рассылка",
  "mail.stop": "Рассылка остановлена",
  "mail.test": "Отправлено тестовое письмо рассылки",
  "mail.test.failed": "Тестовое письмо рассылки не ушло",
  // Ответ поддержки: письмо уходит живому человеку от имени платформы, и «кто ответил и ушло ли»
  // должно читаться из журнала, а не зависеть от того, открыли ли переписку обращения.
  "support.reply": "Отправлен ответ на обращение",
  "support.reply.failed": "Ответ на обращение не ушёл",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export type AuditActorType = "admin" | "user" | "system";

export type AuditEntry = {
  id: string;
  at: string;
  action: AuditAction;
  actorType: AuditActorType;
  actorId: string;
  /** Email или телефон для чтения человеком; пусто у системных событий. */
  actorLabel: string;
  /** id объекта: проект, ключ, аккаунт. */
  target: string;
  /** Человекочитаемое имя объекта; в списках иначе виден только id. */
  targetLabel: string;
  /** Хеш адреса, не сам адрес: сравнить два события можно, восстановить адрес — нет. */
  ipHash: string;
  details: Record<string, string | number | boolean>;
};

export type AuditInput = Omit<AuditEntry, "id" | "at" | "ipHash" | "actorLabel" | "target" | "targetLabel" | "details"> & {
  actorLabel?: string;
  target?: string;
  targetLabel?: string;
  ip?: string;
  details?: Record<string, unknown>;
};

export type AuditQuery = {
  limit?: number;
  action?: string;
  actorId?: string;
  /** Сколько суток назад смотреть; 0 или отсутствие — без ограничения по времени. */
  days?: number;
};

const FILE_NAME = "security-audit.jsonl";
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_CHARS = 300;
const MAX_LABEL_CHARS = 200;
const MAX_ACTOR_ID_CHARS = 200;

function dataDirectory() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

export function auditJournalFile() {
  return path.join(dataDirectory(), FILE_NAME);
}

function cleanText(value: string | undefined, max = MAX_LABEL_CHARS) {
  return (value ?? "").trim().slice(0, max);
}

/**
 * Подробности — только простые значения. Так в журнал нельзя случайно положить объект с токеном
 * или телом запроса: всё, что не строка/число/булево, отбрасывается, а строки обрезаются.
 */
export function cleanAuditDetails(details: Record<string, unknown> | undefined) {
  const out: Record<string, string | number | boolean> = {};
  for (const [rawKey, value] of Object.entries(details ?? {})) {
    if (Object.keys(out).length >= MAX_DETAIL_KEYS) break;
    const key = rawKey.trim().slice(0, 60);
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_DETAIL_CHARS);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function entryFrom(input: AuditInput): AuditEntry {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    action: input.action,
    actorType: input.actorType,
    actorId: cleanText(input.actorId, MAX_ACTOR_ID_CHARS),
    actorLabel: cleanText(input.actorLabel),
    target: cleanText(input.target, MAX_ACTOR_ID_CHARS),
    targetLabel: cleanText(input.targetLabel),
    ipHash: hashAuditIp(input.ip),
    details: cleanAuditDetails(input.details),
  };
}

type AuditRow = {
  id: string;
  at: string;
  action: string;
  actor_type: string;
  actor_id: string;
  actor_label: string;
  target: string;
  target_label: string;
  ip_hash: string;
  details_json: string;
};

function parseDetails(raw: string | undefined) {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return cleanAuditDetails(parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {});
  } catch {
    return {};
  }
}

function fromRow(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    action: row.action as AuditAction,
    actorType: (row.actor_type as AuditActorType) ?? "system",
    actorId: row.actor_id ?? "",
    actorLabel: row.actor_label ?? "",
    target: row.target ?? "",
    targetLabel: row.target_label ?? "",
    ipHash: row.ip_hash ?? "",
    details: parseDetails(row.details_json),
  };
}

/** Запись события. Никогда не бросает: вызывающий не должен терять вход из-за журнала. */
export async function recordAudit(input: AuditInput): Promise<{ ok: boolean; error?: string }> {
  const entry = entryFrom(input);
  try {
    if (isYdbEnabled()) {
      await ydbQuery()`
        INSERT INTO ${ydbQuery().identifier(getTable("security_audit"))}
          (id, at, action, actor_type, actor_id, actor_label, target, target_label, ip_hash, details_json)
        VALUES (${entry.id}, ${entry.at}, ${entry.action}, ${entry.actorType}, ${entry.actorId},
                ${entry.actorLabel}, ${entry.target}, ${entry.targetLabel}, ${entry.ipHash},
                ${JSON.stringify(entry.details)})
      `;
    } else {
      const file = auditJournalFile();
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await appendFile(file, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
    }
    return { ok: true };
  } catch (error) {
    console.error("[audit] не удалось записать событие безопасности", entry.action, error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Последние события, новые сверху. Фильтры необязательны и не меняют форму ответа. */
export async function listAudit(query: AuditQuery = {}): Promise<AuditEntry[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
  const action = query.action?.trim() || null;
  const actorId = query.actorId?.trim() || null;
  const days = Number.isFinite(query.days) && (query.days ?? 0) > 0 ? Math.min(365, Math.floor(query.days as number)) : 0;
  const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

  if (isYdbEnabled()) {
    // Фильтры передаются параметрами, поэтому имена таблиц и колонок остаются статическими.
    // `$1::text IS NULL` — «фильтра нет»; так один запрос покрывает все комбинации.
    const [rows] = await ydbQuery()<Array<AuditRow>>`
      SELECT id, at, action, actor_type, actor_id, actor_label, target, target_label, ip_hash, details_json
      FROM ${ydbQuery().identifier(getTable("security_audit"))}
      WHERE (${action}::text IS NULL OR action = ${action})
        AND (${actorId}::text IS NULL OR actor_id = ${actorId})
        AND (${since}::text IS NULL OR at >= ${since})
      ORDER BY at DESC
      LIMIT ${limit}
    `;
    return (rows ?? []).map(fromRow);
  }

  let raw: string;
  try {
    raw = await readFile(auditJournalFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as AuditEntry;
      const entry = { ...parsed, details: cleanAuditDetails(parsed.details as Record<string, unknown> | undefined) };
      if (action && entry.action !== action) continue;
      if (actorId && entry.actorId !== actorId) continue;
      if (since && entry.at < since) continue;
      entries.push(entry);
    } catch {
      // Повреждённая строка не должна скрывать остальные события.
    }
  }
  return entries.slice(-limit).reverse();
}
