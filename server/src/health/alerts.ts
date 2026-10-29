/**
 * Аварийные письма платформы: диск, память, swap, ошибки архивации и устаревший бэкап.
 *
 * Почему письма, а не только админка: админку надо открыть, а проблема на диске или упавшая
 * архивация ждать не будет. Почта уже настроена для писем платформы (Yandex Cloud Postbox),
 * поэтому отдельный сервис уведомлений здесь не нужен. Если сервер лежит целиком, письмо
 * отправить некому — для этого нужен внешний монитор, он подключается отдельно.
 *
 * Защита от спама: письмо уходит при переходе проверки в «плохо», затем повторяется не чаще
 * `ALERT_REMINDER_HOURS` (по умолчанию 6 часов), и один раз при восстановлении. Пока письмо
 * не отправилось, состояние не меняется — следующий цикл попробует снова.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { diskStatus, memoryStatus } from "./host-metrics.js";
import { buildHealthChecks, HEALTH_THRESHOLDS, type HealthCheck } from "./thresholds.js";
import { archiveErrorsLastHour } from "../storage/archive-health.js";
import { objectStoreConfigFromEnv, s3ObjectStore } from "../storage/object-store.js";
import { readManifest } from "../storage/postgres-backup.js";
import { isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { sandboxRootDir } from "../sandbox/config.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import { sendMail } from "../mail/mailer.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REMINDER_HOURS = 6;
const EMAIL = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;

type AlertMail = { to: string; subject: string; text: string };
type ActiveAlert = { since: number; lastSentAt: number };

export type AlertCycleDeps = {
  checks: () => Promise<HealthCheck[]>;
  email: () => string | null;
  send: (mail: AlertMail) => Promise<unknown>;
  now: () => number;
  reminderMs: number;
  log: (message: string) => void;
};

const active = new Map<string, ActiveAlert>();

/**
 * Кому уходят аварийные письма.
 *
 * Явный `ALERT_EMAIL` (панель или переменная выкатки) важнее всего. Если его нет, письма идут
 * администратору платформы из `ADMIN_BOOTSTRAP_EMAIL`: у работающей платформы админ уже есть,
 * и молчать о переполненном диске только потому, что забыли отдельное поле, нельзя. Кривое
 * явное значение не подменяется адресом админа — иначе опечатка в панели выглядела бы как
 * «всё настроено», а письма уходили бы не туда.
 */
export function alertEmail(): string | null {
  const explicit = (getPlatformEnv("ALERT_EMAIL") ?? "").trim();
  if (explicit) return EMAIL.test(explicit) ? explicit : null;
  const admin = (getPlatformEnv("ADMIN_BOOTSTRAP_EMAIL") ?? "").trim();
  return admin && EMAIL.test(admin) ? admin : null;
}

/** Откуда взялся получатель — для лога запуска, без самого адреса. */
export function alertEmailSource(): "ALERT_EMAIL" | "ADMIN_BOOTSTRAP_EMAIL" | null {
  if (!alertEmail()) return null;
  return (getPlatformEnv("ALERT_EMAIL") ?? "").trim() ? "ALERT_EMAIL" : "ADMIN_BOOTSTRAP_EMAIL";
}

/** Где запомнен адрес, которому уже подтвердили канал. */
function recipientStateFile() {
  const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
  return path.join(root, "health", "alert-recipient.txt");
}

export type RecipientConfirmDeps = {
  email: () => string | null;
  send: (mail: AlertMail) => Promise<unknown>;
  stateFile: string;
  log: (message: string) => void;
};

/**
 * Одно письмо при смене получателя аварий.
 *
 * Настроенный канал — не то же самое, что работающий: адрес могли сохранить с опечаткой, а
 * Postbox — не принять письмо по этому домену. Поэтому при первом запуске и при каждой смене
 * адреса уходит подтверждение, а адрес запоминается только после успешной отправки. Повторные
 * перезапуски с тем же адресом молчат: иначе каждое обновление сервера слало бы письмо.
 * Ошибка отправки не пишет состояние — следующий старт попробует снова.
 */
export async function confirmAlertRecipient(overrides: Partial<RecipientConfirmDeps> = {}) {
  const deps: RecipientConfirmDeps = {
    email: alertEmail,
    send: mail => sendMail(mail),
    stateFile: recipientStateFile(),
    log: message => console.log("[alerts] " + message),
    ...overrides,
  };
  const email = deps.email();
  if (!email) return { sent: false as const, reason: "no-email" as const };
  let confirmed = "";
  try {
    confirmed = (await readFile(deps.stateFile, "utf8")).trim();
  } catch {
    // Файла ещё нет — это первый запуск с адресом, подтверждение нужно.
  }
  if (confirmed.toLowerCase() === email.toLowerCase()) return { sent: false as const, reason: "unchanged" as const };
  await deps.send({
    to: email,
    subject: "Аварийные уведомления платформы включены",
    text: [
      "Это подтверждение канала аварийных уведомлений.",
      "",
      "Письма будут приходить на этот адрес, когда диск, память или swap выйдут за пороги,",
      "архивация проектов начнёт падать или резервная копия базы окажется старше 30 часов.",
      "Пороги: диск 75%, память 85%, swap 50%.",
      "",
      "Подтверждение уходит только при смене адреса; при обычных перезапусках письма не будет.",
    ].join("\n"),
  });
  try {
    await mkdir(path.dirname(deps.stateFile), { recursive: true });
    await writeFile(deps.stateFile, email + "\n", "utf8");
  } catch (error) {
    // Не записали — следующий старт пришлёт ещё одно подтверждение. Это лучше, чем молчание.
    deps.log("получатель подтверждён, но адрес не запомнен: " + shortError(error));
  }
  deps.log("канал подтверждён письмом");
  return { sent: true as const, reason: "changed" as const };
}

function shortError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function currentDatabaseName(): Promise<string | null> {
  if (!isYdbEnabled()) return null;
  const [rows] = await withTimeout(
    ydbQuery()<Array<{ name: string }>>`SELECT current_database() AS name`,
    5_000,
    "база не ответила за 5 с",
  );
  return rows[0]?.name ?? null;
}

/**
 * Возраст последней копии. `null` означает «не знаю»: нет манифеста, не настроен S3 или база
 * не ответила. В любом из этих случаев проверка считается плохой — молчание о бэкапе опаснее
 * лишнего письма. Для JSON-хранилища проверка не применима.
 */
async function backupAgeHours(now: number): Promise<{ applicable: boolean; ageHours: number | null; detail?: string }> {
  if (!isYdbEnabled()) return { applicable: false, ageHours: null };
  let database: string | null;
  try {
    database = await currentDatabaseName();
  } catch (error) {
    return { applicable: true, ageHours: null, detail: "имя базы не прочитано: " + shortError(error) };
  }
  if (!database) return { applicable: true, ageHours: null, detail: "имя базы пустое" };

  let config: ReturnType<typeof objectStoreConfigFromEnv>;
  try {
    config = objectStoreConfigFromEnv();
  } catch (error) {
    return { applicable: true, ageHours: null, detail: "хранилище настроено не полностью: " + shortError(error) };
  }
  if (!config) return { applicable: true, ageHours: null, detail: "объектное хранилище не настроено" };

  try {
    const manifest = await withTimeout(
      readManifest(s3ObjectStore(config), database),
      10_000,
      "хранилище не ответило за 10 с",
    );
    const created = Date.parse(manifest.createdAt);
    if (!Number.isFinite(created)) return { applicable: true, ageHours: null, detail: "в манифесте нет корректной даты" };
    return { applicable: true, ageHours: Math.max(0, (now - created) / 3_600_000) };
  } catch (error) {
    return { applicable: true, ageHours: null, detail: "последняя копия не прочитана: " + shortError(error) };
  }
}

/** Собрать все проверки из фактических метрик хоста. */
export async function collectHealthChecks(now = Date.now()): Promise<HealthCheck[]> {
  const [disk, memory, backup] = await Promise.all([
    diskStatus(sandboxRootDir()),
    memoryStatus(),
    backupAgeHours(now),
  ]);

  const memoryUsedPercent =
    memory.totalMb > 0 && memory.availableMb !== null
      ? ((memory.totalMb - memory.availableMb) / memory.totalMb) * 100
      : null;
  const swapConfigured =
    memory.swapTotalMb !== null && memory.swapTotalMb > 0 && memory.swapFreeMb !== null;
  const swapUsedPercent = swapConfigured
    ? ((memory.swapTotalMb! - memory.swapFreeMb!) / memory.swapTotalMb!) * 100
    : null;

  return buildHealthChecks({
    diskUsedPercent: disk?.usedPercent ?? null,
    memoryUsedPercent,
    swapUsedPercent,
    swapConfigured,
    archiveErrorsLastHour: archiveErrorsLastHour(now),
    backupApplicable: backup.applicable,
    backupAgeHours: backup.ageHours,
    ...(backup.detail ? { backupDetail: backup.detail } : {}),
  });
}

function valueLabel(check: HealthCheck) {
  if (check.value === null) return "нет данных";
  if (check.unit === "percent") return check.value + "%";
  if (check.unit === "hours") return check.value + " ч";
  return String(check.value);
}

export function formatAlertMail(
  checks: HealthCheck[],
  now: number,
  recovered: HealthCheck[] = [],
): AlertMail {
  const bad = checks.filter(check => check.ok === false);
  const labels = bad.length ? bad.map(check => check.label) : recovered.map(check => check.label);
  const subject =
    "[nestdev.ru] " +
    (bad.length ? "Алерт: " + labels.join(", ") : "Восстановление: " + labels.join(", "));

  const lines = [
    "Проверка инфраструктуры — " +
      new Date(now).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) +
      " МСК",
    "",
  ];
  if (bad.length) {
    lines.push("Проблемы:");
    for (const check of bad) {
      lines.push(
        "- " + check.label + ": " + valueLabel(check) + " при пороге " + check.limit +
          (check.unit === "percent" ? "%" : check.unit === "hours" ? " ч" : "") +
          (check.detail ? " (" + check.detail + ")" : ""),
      );
    }
  }
  if (recovered.length) {
    if (bad.length) lines.push("");
    lines.push("Восстановилось:");
    for (const check of recovered) lines.push("- " + check.label + ": снова в норме");
  }
  const platform = (getPlatformEnv("PLATFORM_URL") ?? "").trim();
  lines.push("", "Админ-панель: " + (platform || "откройте панель платформы"));
  lines.push("Письмо отправлено автоматически; повтор — не чаще чем раз в " +
    Math.round(reminderMs() / 3_600_000) + " ч.");
  return { to: "", subject, text: lines.join("\n") };
}

function reminderMs() {
  const hours = Number(process.env.ALERT_REMINDER_HOURS ?? "");
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_REMINDER_HOURS) * 3_600_000;
}

/**
 * Один цикл. Возвращает `sent: false` и причину, когда письма нет: это нужно тестам и
 * диагностике, но не пользователю.
 */
export async function runAlertCycle(overrides: Partial<AlertCycleDeps> = {}): Promise<{
  sent: boolean;
  reason?: "ok" | "no-email" | "cooldown" | "send-failed" | "collect-failed";
  checks?: HealthCheck[];
}> {
  const deps: AlertCycleDeps = {
    checks: () => collectHealthChecks(),
    email: alertEmail,
    send: mail => sendMail(mail),
    now: Date.now,
    reminderMs: reminderMs(),
    log: message => console.warn("[alerts] " + message),
    ...overrides,
  };
  const now = deps.now();
  let checks: HealthCheck[];
  try {
    checks = await deps.checks();
  } catch (error) {
    deps.log("проверка не собрана: " + shortError(error));
    return { sent: false, reason: "collect-failed" };
  }

  const bad = checks.filter(check => check.ok === false);
  const badIds = new Set(bad.map(check => check.id));
  const recovered = checks.filter(check => check.ok === true && active.has(check.id));
  const newlyBad = bad.filter(check => !active.has(check.id));
  const reminders = bad.filter(check => {
    const state = active.get(check.id);
    return Boolean(state && now - state.lastSentAt >= deps.reminderMs);
  });

  if (!bad.length && !recovered.length) return { sent: false, reason: "ok", checks };
  if (!newlyBad.length && !reminders.length && !recovered.length) return { sent: false, reason: "cooldown", checks };

  const email = deps.email();
  if (!email) return { sent: false, reason: "no-email", checks };

  const mail = formatAlertMail(checks, now, recovered);
  mail.to = email;
  try {
    await deps.send(mail);
  } catch (error) {
    deps.log("письмо не отправлено: " + shortError(error));
    return { sent: false, reason: "send-failed", checks };
  }

  for (const check of bad) {
    const previous = active.get(check.id);
    active.set(check.id, { since: previous?.since ?? now, lastSentAt: now });
  }
  for (const check of recovered) {
    if (!badIds.has(check.id)) active.delete(check.id);
  }
  // ID из recovered всегда входят в checks; отдельная уборка не нужна, но оставлена явной:
  // если проверка исчезла из набора, её старая тревога не должна висеть вечно.
  for (const id of [...active.keys()]) {
    if (!checks.some(check => check.id === id)) active.delete(id);
  }
  return { sent: true, checks };
}

/** Сбросить состояние между тестами. */
export function resetAlerts() {
  active.clear();
}

export function alertCheckIntervalMs() {
  const raw = Number(process.env.ALERT_CHECK_INTERVAL_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}

/** Запуск планировщика. Ошибка одного цикла не должна убивать следующие. */
export function startAlertScheduler(): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void runAlertCycle().catch(error => console.warn("[alerts] цикл упал: " + shortError(error)));
  };
  // Подтверждение канала — раньше первой проверки и отдельным таймером: иначе при смене адреса
  // вместе с реальной аварией ушли бы два письма подряд.
  const confirm = setTimeout(() => {
    if (stopped) return;
    void confirmAlertRecipient().catch(error =>
      console.warn("[alerts] подтверждение получателя не отправлено: " + shortError(error)),
    );
  }, 10_000);
  confirm.unref();
  // Первое письмо не в момент старта: сервер ещё поднимается, метрики могут быть не готовы.
  const first = setTimeout(tick, 30_000);
  first.unref();
  const timer = setInterval(tick, alertCheckIntervalMs());
  timer.unref();
  const email = alertEmail();
  const source = alertEmailSource();
  console.log(
    "[alerts] проверка каждые " + Math.round(alertCheckIntervalMs() / 60_000) + " мин; " +
      (email
        ? "письма включены, получатель — " +
          (source === "ADMIN_BOOTSTRAP_EMAIL" ? "адрес администратора (ALERT_EMAIL не задан)" : "ALERT_EMAIL")
        : "ALERT_EMAIL и ADMIN_BOOTSTRAP_EMAIL не заданы — письма выключены") +
      "; пороги: диск " + HEALTH_THRESHOLDS.diskUsedPercent + "%, память " +
      HEALTH_THRESHOLDS.memoryUsedPercent + "%, swap " + HEALTH_THRESHOLDS.swapUsedPercent + "%",
  );
  return () => {
    stopped = true;
    clearTimeout(confirm);
    clearTimeout(first);
    clearInterval(timer);
  };
}
