import { reconcileStorage, type ReconcileResult } from "./storage-quota.js";

/**
 * Сверка хранилища по расписанию.
 *
 * Счётчик обновляется при записи агентом, но не после загрузки файлов, импорта с GitHub,
 * установки зависимостей предпросмотром или удаления проекта. Раз в сутки (и один раз после
 * старта) платформа проходит по проектам и приводит числа к реальности. Работает только одна
 * реплика: в PostgreSQL сверка берёт advisory-лок, в файловом режиме — флаг процесса.
 *
 * Все значения настраиваются переменными окружения, потому что расписание зависит от размера
 * ВМ: на маленькой машине обход стоит дорого, на большой его можно делать чаще.
 */

const DEFAULT_START_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Меньше суточного интервала: иначе проход, начавшийся на несколько секунд раньше срока,
// пропускал бы все проекты как «свежие» и мерил бы их только через сутки.
const DEFAULT_DAILY_STALE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_STARTUP_STALE_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;

let running = false;
let started = false;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function describe(result: ReconcileResult) {
  if (!result.ok) return result.reason === "locked" ? "уже выполняется другой репликой" : (result.error ?? result.reason);
  return [
    "проектов " + result.projects,
    "измерено " + result.measured,
    "пропущено " + result.skipped,
    "удалено строк " + result.orphans,
    "итого " + (result.usedBytes / 1024 / 1024).toFixed(1) + " МБ",
    "за " + result.durationMs + " мс",
  ].join(", ");
}

async function run(reason: "startup" | "daily") {
  if (running) return;
  running = true;
  try {
    const staleMs = reason === "startup"
      ? envMs("STORAGE_RECONCILE_STARTUP_STALE_MS", DEFAULT_STARTUP_STALE_MS)
      : envMs("STORAGE_RECONCILE_STALE_MS", DEFAULT_DAILY_STALE_MS);
    const result = await reconcileStorage({ reason, staleMs });
    if (result.ok) console.log("[storage] сверка (" + reason + "): " + describe(result));
    else if (result.reason !== "locked") console.warn("[storage] сверка (" + reason + ") не выполнена: " + describe(result));
  } catch (error) {
    console.warn("[storage] сверка (" + reason + ") упала: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    running = false;
  }
}

/**
 * Запускает расписание и возвращает функцию остановки. Повторный вызов ничего не делает:
 * расписание одно на процесс, как и очередь записи размеров.
 */
export function startStorageReconcileScheduler(): () => void {
  if (started) return () => {};
  started = true;
  if (process.env.STORAGE_RECONCILE_DISABLED === "1") {
    console.log("[storage] сверка отключена (STORAGE_RECONCILE_DISABLED=1)");
    return () => { started = false; };
  }
  const startDelayMs = envMs("STORAGE_RECONCILE_START_DELAY_MS", DEFAULT_START_DELAY_MS);
  const intervalMs = Math.max(MIN_INTERVAL_MS, envMs("STORAGE_RECONCILE_INTERVAL_MS", DEFAULT_INTERVAL_MS));
  const startupTimer = setTimeout(() => void run("startup"), startDelayMs);
  startupTimer.unref();
  const dailyTimer = setInterval(() => void run("daily"), intervalMs);
  dailyTimer.unref();
  console.log(
    "[storage] сверка хранилища: первая через " + Math.round(startDelayMs / 1000) + " с, далее раз в " +
    Math.round(intervalMs / 3_600_000) + " ч",
  );
  return () => {
    clearTimeout(startupTimer);
    clearInterval(dailyTimer);
    started = false;
  };
}
