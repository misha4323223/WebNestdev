import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { decryptSecret, encryptSecret } from "../storage/secret-crypto.js";
import { matchRecoveryCode } from "./totp.js";

/**
 * Аккаунты администраторов платформы.
 *
 * Это отдельные записи, а не пользователи панели: список `WEBNESTDEV_ADMIN_EMAILS` (platform/admin.ts)
 * отвечает на вопрос «кто может менять ключи платформы среди пользователей», а здесь — своя дверь в
 * админ-приложение, которая не зависит от пользовательских сессий и не даёт админу ни проекта, ни
 * песочницы. Совмещать их значило бы, что утёкшая пользовательская cookie открывает платформу.
 *
 * Пароль хранится как scrypt-хеш, TOTP-секрет — зашифрованным (`WEBNESTDEV_ENCRYPTION_KEY`), коды
 * восстановления — только хешами. Сессия — это случайный токен; в хранилище лежит его sha256, поэтому
 * копия базы не даёт войти (в отличие от сессии пользователя, где id и есть ключ).
 */

export type AdminUser = {
  id: string;
  email: string;
  passwordHash: string;
  /** Base32-секрет TOTP, расшифрованный; пустая строка — фактор ещё не подключён. */
  totpSecret: string;
  /** Когда фактор подтверждён кодом; пусто — подключение не закончено. */
  totpEnabledAt: string;
  /** sha256 одноразовых кодов восстановления. */
  recoveryHashes: string[];
  /** Номер последнего принятого шага TOTP: тот же код второй раз не сработает. */
  lastTotpStep: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminSession = {
  /** sha256 токена, а не сам токен. */
  id: string;
  adminId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
};

const scrypt = promisify(scryptCallback);
const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const adminDir = path.join(root, "admin");
const adminsFile = path.join(adminDir, "admins.json");
const sessionsFile = path.join(adminDir, "sessions.json");

export const ADMIN_EMAIL_TAKEN = "Администратор с таким email уже есть";

/** Абсолютный срок админ-сессии: рабочий день админки, а не 30 дней панели. */
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Бездействие: брошенная вкладка админки не должна оставаться входом на всю смену. */
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
/** Отметка активности пишется не чаще раза в минуту, а не на каждый запрос. */
const TOUCH_INTERVAL_MS = 60_000;

function positiveMs(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function adminSessionTtlMs() {
  return positiveMs(process.env.ADMIN_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS);
}
export function adminSessionIdleTtlMs() {
  return Math.min(adminSessionTtlMs(), positiveMs(process.env.ADMIN_SESSION_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS));
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(adminDir, { recursive: true });
  // Тот же режим, что у остальных файлов данных: читать их должен только владелец процесса.
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function normalizeEmail(email: string) {
  return (email ?? "").trim().toLowerCase();
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return salt + ":" + derived.toString("hex");
}

async function passwordMatches(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const known = Buffer.from(expected, "hex");
  return known.length === derived.length && timingSafeEqual(known, derived);
}

/**
 * Хеш-заглушка для случая «такого администратора нет».
 *
 * Без неё неизвестный email отвечал бы заметно быстрее верного: scrypt считался бы только для
 * существующей записи, и по времени ответа можно было бы перечислять администраторов.
 */
let dummyPasswordHash: Promise<string> | null = null;
function dummyHash() {
  dummyPasswordHash ??= hashPassword(randomBytes(18).toString("base64url"));
  return dummyPasswordHash;
}

// ─── Сериализация записи ─────────────────────────────────────────────────────

type StoredAdmin = Omit<AdminUser, "totpSecret"> & { totpSecret: string };

function toStored(admin: AdminUser): StoredAdmin {
  return { ...admin, totpSecret: admin.totpSecret ? encryptSecret(admin.totpSecret) : "" };
}

function fromStored(admin: StoredAdmin): AdminUser {
  let secret = "";
  if (admin.totpSecret) {
    try {
      secret = decryptSecret(admin.totpSecret);
    } catch {
      // Ключ шифрования сменился без ротации: фактор перестаёт работать, но аккаунт остаётся.
      // Войти можно будет после `npm run admin:reset-2fa` — так оператор видит причину, а не «код не подходит».
      secret = "";
    }
  }
  return { ...admin, totpSecret: secret };
}

type AdminRow = {
  id: string;
  email: string;
  password_hash: string;
  totp_secret: string;
  totp_enabled_at: string;
  recovery_hashes: string;
  last_totp_step: string;
  created_at: string;
  updated_at: string;
};

function fromRow(row: AdminRow): AdminUser {
  const step = Number(row.last_totp_step);
  return fromStored({
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret ?? "",
    totpEnabledAt: row.totp_enabled_at ?? "",
    recoveryHashes: parseHashes(row.recovery_hashes),
    lastTotpStep: Number.isFinite(step) && row.last_totp_step !== "" ? step : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseHashes(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === "string") : [];
  } catch {
    return [];
  }
}

// ─── Аккаунты ────────────────────────────────────────────────────────────────

export async function createAdmin(email: string, password: string): Promise<AdminUser> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Нужен email администратора");
  if (await findAdminByEmail(normalized)) throw new Error(ADMIN_EMAIL_TAKEN);
  const now = new Date().toISOString();
  const admin: AdminUser = {
    id: randomUUID(),
    email: normalized,
    passwordHash: await hashPassword(password),
    totpSecret: "",
    totpEnabledAt: "",
    recoveryHashes: [],
    lastTotpStep: null,
    createdAt: now,
    updatedAt: now,
  };
  if (isYdbEnabled()) {
    try {
      await ydbQuery()`
        INSERT INTO ${ydbQuery().identifier(getTable("admin_users"))}
          (id,email,password_hash,totp_secret,totp_enabled_at,recovery_hashes,last_totp_step,created_at,updated_at)
        VALUES (${admin.id},${admin.email},${admin.passwordHash},${""},${""},${"[]"},${""},${admin.createdAt},${admin.updatedAt})
      `;
    } catch (error) {
      // Гонка двух созданий: UNIQUE по email решает, кто первый.
      if (await findAdminByEmail(normalized)) throw new Error(ADMIN_EMAIL_TAKEN);
      throw error;
    }
    return admin;
  }
  const admins = await readJson<StoredAdmin[]>(adminsFile, []);
  admins.push(toStored(admin));
  await writeJson(adminsFile, admins);
  return admin;
}

export async function findAdminByEmail(email: string): Promise<AdminUser | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return getAdminBy("email", normalized);
}

export async function getAdmin(id: string): Promise<AdminUser | null> {
  return getAdminBy("id", id);
}

async function getAdminBy(field: "id" | "email", value: string): Promise<AdminUser | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<AdminRow>>`
      SELECT id,email,password_hash,totp_secret,totp_enabled_at,recovery_hashes,last_totp_step,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("admin_users"))}
      WHERE ${ydbQuery().identifier(field)} = ${value}
      LIMIT 1
    `;
    const row = rows?.[0];
    return row ? fromRow(row) : null;
  }
  const admins = await readJson<StoredAdmin[]>(adminsFile, []);
  const found = admins.find(item => item[field] === value);
  return found ? fromStored(found) : null;
}

/**
 * Проверка пароля. Для несуществующего email всё равно считается scrypt, иначе время ответа
 * выдаёт, есть ли такой администратор.
 */
export async function verifyAdminPassword(email: string, password: string): Promise<AdminUser | null> {
  const admin = await findAdminByEmail(email);
  const stored = admin?.passwordHash ?? (await dummyHash());
  const ok = await passwordMatches(password, stored);
  return ok && admin ? admin : null;
}

async function updateAdmin(id: string, patch: Partial<AdminUser>): Promise<void> {
  const admin = await getAdmin(id);
  if (!admin) return;
  const next: AdminUser = { ...admin, ...patch, updatedAt: new Date().toISOString() };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("admin_users"))}
      SET password_hash = ${next.passwordHash},
          totp_secret = ${next.totpSecret ? encryptSecret(next.totpSecret) : ""},
          totp_enabled_at = ${next.totpEnabledAt},
          recovery_hashes = ${JSON.stringify(next.recoveryHashes)},
          last_totp_step = ${next.lastTotpStep === null ? "" : String(next.lastTotpStep)},
          updated_at = ${next.updatedAt}
      WHERE id = ${id}
    `;
    return;
  }
  const admins = await readJson<StoredAdmin[]>(adminsFile, []);
  const index = admins.findIndex(item => item.id === id);
  if (index < 0) return;
  admins[index] = toStored(next);
  await writeJson(adminsFile, admins);
}

/** Подключение фактора: секрет и коды восстановления записываются одной операцией. */
export async function enableAdminTotp(
  id: string,
  input: { secret: string; step: number; recoveryHashes: string[] },
  now = Date.now(),
): Promise<void> {
  await updateAdmin(id, {
    totpSecret: input.secret,
    totpEnabledAt: new Date(now).toISOString(),
    recoveryHashes: input.recoveryHashes,
    lastTotpStep: input.step,
  });
}

export async function setAdminRecoveryHashes(id: string, hashes: string[]): Promise<void> {
  await updateAdmin(id, { recoveryHashes: hashes });
}

/**
 * Новый пароль. Вызывается только из CLI: утёкший пароль не должен уметь сменить себя сам, а
 * забытый — не должен требовать правки базы руками. Фактор при этом сохраняется.
 */
export async function setAdminPassword(id: string, password: string): Promise<void> {
  await updateAdmin(id, { passwordHash: await hashPassword(password) });
}

export async function setAdminLastTotpStep(id: string, step: number): Promise<void> {
  await updateAdmin(id, { lastTotpStep: step });
}

/**
 * Одноразовый код восстановления: подошедший удаляется из списка, поэтому второй раз он не сработает.
 * Возвращает остаток кодов или null, если код не подошёл.
 */
export async function consumeAdminRecoveryCode(id: string, code: string): Promise<number | null> {
  const admin = await getAdmin(id);
  if (!admin || !admin.recoveryHashes.length) return null;
  const index = matchRecoveryCode(admin.recoveryHashes, code);
  if (index < 0) return null;
  const remaining = admin.recoveryHashes.filter((_, position) => position !== index);
  await updateAdmin(id, { recoveryHashes: remaining });
  return remaining.length;
}

/**
 * Сброс второго фактора. Вызывается только из CLI с доступом к серверу: через API сбросить фактор
 * значило бы, что украденный пароль сам себе снимает защиту.
 */
export async function resetAdminTotp(id: string): Promise<void> {
  await updateAdmin(id, { totpSecret: "", totpEnabledAt: "", recoveryHashes: [], lastTotpStep: null });
}

export async function listAdmins(): Promise<AdminUser[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<AdminRow>>`
      SELECT id,email,password_hash,totp_secret,totp_enabled_at,recovery_hashes,last_totp_step,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("admin_users"))}
      ORDER BY created_at
    `;
    return (rows ?? []).map(fromRow);
  }
  const admins = await readJson<StoredAdmin[]>(adminsFile, []);
  return admins.map(fromStored);
}

// ─── Сессии ──────────────────────────────────────────────────────────────────

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Токен сессии: клиент видит его один раз в ответе на вход, сервер хранит только хеш. */
export async function createAdminSession(adminId: string, now = Date.now()): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const iso = (value: number) => new Date(value).toISOString();
  const session: AdminSession = {
    id: hashToken(token),
    adminId,
    createdAt: iso(now),
    expiresAt: iso(now + adminSessionTtlMs()),
    lastSeenAt: iso(now),
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("admin_sessions"))}
        (id,admin_id,created_at,expires_at,last_seen_at)
      VALUES (${session.id},${session.adminId},${session.createdAt},${session.expiresAt},${session.lastSeenAt})
    `;
  } else {
    const sessions = await readJson<AdminSession[]>(sessionsFile, []);
    sessions.push(session);
    await writeJson(sessionsFile, sessions);
  }
  return { token, expiresAt: session.expiresAt };
}

async function touchAdminSession(id: string, now: number) {
  const stamp = new Date(now).toISOString();
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("admin_sessions"))}
      SET last_seen_at = ${stamp}
      WHERE id = ${id}
    `;
    return;
  }
  const sessions = await readJson<AdminSession[]>(sessionsFile, []);
  const index = sessions.findIndex(item => item.id === id);
  if (index < 0) return;
  sessions[index] = { ...sessions[index], lastSeenAt: stamp };
  await writeJson(sessionsFile, sessions);
}

/**
 * Проверка токена: срок, бездействие и существование администратора. Отметка активности обновляется
 * не чаще раза в минуту — иначе каждое чтение админки писало бы в базу.
 */
export async function getAdminSession(token: string, now = Date.now()): Promise<{ admin: AdminUser; expiresAt: string } | null> {
  const value = (token ?? "").trim();
  if (!value || value.length > 200) return null;
  const id = hashToken(value);
  let session: AdminSession | null = null;
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ admin_id: string; expires_at: string; last_seen_at: string }>>`
      SELECT admin_id,expires_at,last_seen_at
      FROM ${ydbQuery().identifier(getTable("admin_sessions"))}
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = rows?.[0];
    if (row) session = { id, adminId: row.admin_id, createdAt: "", expiresAt: row.expires_at, lastSeenAt: row.last_seen_at ?? "" };
  } else {
    const sessions = await readJson<AdminSession[]>(sessionsFile, []);
    session = sessions.find(item => item.id === id) ?? null;
  }
  if (!session) return null;

  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    await deleteAdminSessionById(id);
    return null;
  }
  const lastSeen = Date.parse(session.lastSeenAt);
  if (Number.isFinite(lastSeen) && lastSeen + adminSessionIdleTtlMs() <= now) {
    await deleteAdminSessionById(id);
    return null;
  }
  if (!Number.isFinite(lastSeen) || now - lastSeen >= TOUCH_INTERVAL_MS) await touchAdminSession(id, now);

  const admin = await getAdmin(session.adminId);
  // Админ мог быть удалён, пока сессия жива: токен без аккаунта — не вход.
  return admin ? { admin, expiresAt: session.expiresAt } : null;
}

export async function deleteAdminSession(token: string): Promise<void> {
  const value = (token ?? "").trim();
  if (!value) return;
  await deleteAdminSessionById(hashToken(value));
}

async function deleteAdminSessionById(id: string): Promise<void> {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("admin_sessions"))} WHERE id = ${id}`;
    return;
  }
  const sessions = await readJson<AdminSession[]>(sessionsFile, []);
  await writeJson(sessionsFile, sessions.filter(item => item.id !== id));
}

/** «Выйти везде» и сброс фактора: все прочие входы закрываются. Возвращает число отозванных. */
export async function deleteAdminSessions(adminId: string): Promise<number> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ id: string }>>`
      DELETE FROM ${ydbQuery().identifier(getTable("admin_sessions"))}
      WHERE admin_id = ${adminId}
      RETURNING id
    `;
    return rows?.length ?? 0;
  }
  const sessions = await readJson<AdminSession[]>(sessionsFile, []);
  const kept = sessions.filter(item => item.adminId !== adminId);
  await writeJson(sessionsFile, kept);
  return sessions.length - kept.length;
}

/** Токен из `Authorization: Bearer …`. Cookie здесь не принимается сознательно: это не даёт CSRF. */
export function bearerToken(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] ?? "" : header ?? "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(raw.trim());
  return match ? match[1] : "";
}
