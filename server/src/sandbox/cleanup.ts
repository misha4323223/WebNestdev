import { sandboxHost, type SandboxHost } from "./host.js";
import { cleanupSandboxJobs } from "./jobs.js";

/**
 * Уборка зависших контейнеров песочниц.
 *
 * Каждая команда агента — отдельный контейнер (`wnd-cmd-…`), и обычно его удаляет тот же процесс,
 * который запустил: `--rm`, а при отмене — явный `docker rm`. Но если процесс убит (перезапуск
 * API, падение ВМ, отменённая команда), контейнер остаётся жить своей жизнью:
 *
 * - в состоянии `created` — когда `docker run` не доехал до старта. Такой контейнер ничего не
 *   делает, но держит слой образа, и `docker rmi` его не тронет: **одна такая запись — это
 *   лишняя полуторагигабайтная версия в `docker images`** и «можно освободить 2.5 ГБ», которые
 *   уборка выкатки не может забрать;
 * - в состоянии `exited` — когда контейнер отработал, а убрать его стало некому;
 * - в состоянии `dead` — когда Docker не смог его удалить сам.
 *
 * Задания (`wnd-job-…`) помечены отдельной меткой: живое задание принадлежит агенту, и снимать его
 * по возрасту нельзя — поэтому статус `running` не трогается никогда, а сирот заданий убирает
 * стартовая уборка (jobs.ts), как и раньше.
 *
 * Порог по возрасту — обязательная часть: без него гонка с самим собой. Между `docker run` и
 * стартом контейнера есть окно, и уборка по одному лишь статусу `created` убивала бы команду,
 * которая как раз запускается.
 */

export type StuckLimits = {
  /** `created` — контейнер, который так и не стартовал. */
  createdMs: number;
  /** `exited` — контейнер, которому некому было сделать `rm`. */
  exitedMs: number;
  /** `dead` — Docker уже не смог его удалить; ждать нечего. */
  deadMs: number;
};

const DEFAULT_LIMITS: StuckLimits = { createdMs: 5 * 60_000, exitedMs: 15 * 60_000, deadMs: 60_000 };

function minutes(value: string | undefined, fallback: number): number {
  const text = (value ?? "").trim();
  // Не задано — умолчание. Без этой проверки `Number("")` даёт 0, и уборка выключалась бы сама
  // собой на любом хосте, где переменная просто не прописана.
  if (!text) return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) * 60_000 : fallback;
}

/**
 * Пороги из окружения (в минутах, как их удобно задавать в `.env`):
 * `SANDBOX_STUCK_CREATED_MINUTES`, `SANDBOX_STUCK_EXITED_MINUTES`, `SANDBOX_STUCK_DEAD_MINUTES`.
 */
export function stuckLimits(env: NodeJS.ProcessEnv = process.env): StuckLimits {
  return {
    createdMs: minutes(env.SANDBOX_STUCK_CREATED_MINUTES, DEFAULT_LIMITS.createdMs),
    exitedMs: minutes(env.SANDBOX_STUCK_EXITED_MINUTES, DEFAULT_LIMITS.exitedMs),
    deadMs: minutes(env.SANDBOX_STUCK_DEAD_MINUTES, DEFAULT_LIMITS.deadMs),
  };
}

/** Как часто проходит уборка; `SANDBOX_REAP_INTERVAL_MINUTES=0` выключает периодический проход. */
export function reapIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const text = (env.SANDBOX_REAP_INTERVAL_MINUTES ?? "").trim();
  if (!text) return 10 * 60_000;
  const parsed = Number(text);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed) * 60_000;
  return 10 * 60_000;
}

/**
 * Контейнеры, которые убирает проход: только наши (`wnd-cmd-…`, `wnd-job-…`) и только те, что
 * уже не работают. Предпросмотры сюда не попадают: у них своя жизнь (`wnd-preview` не входит в
 * список префиксов) и своя уборка по простою.
 */
export function isSandboxWorkerName(name: string): boolean {
  return /^wnd-(cmd|job)-[A-Za-z0-9_.-]{1,110}$/.test(name.replace(/^\//, ""));
}

export type StuckCandidate = { id: string; name: string; state: string; ageMs: number };

export function shouldReap(candidate: StuckCandidate, limits: StuckLimits = DEFAULT_LIMITS): boolean {
  if (!isSandboxWorkerName(candidate.name)) return false;
  if (!Number.isFinite(candidate.ageMs) || candidate.ageMs < 0) return false;
  switch (candidate.state.trim().toLowerCase()) {
    case "created":
      return candidate.ageMs >= limits.createdMs;
    case "exited":
      return candidate.ageMs >= limits.exitedMs;
    case "dead":
      return candidate.ageMs >= limits.deadMs;
    default:
      // `running`, `paused`, `restarting` — чужая работа; один проход не имеет права её прервать.
      return false;
  }
}

/**
 * Время Docker в RFC3339 с наносекундами (`2026-11-06T19:55:34.123456789Z`). `Date.parse` не
 * обязан понимать больше трёх знаков дробной части, поэтому она усекается, а не отбрасывается
 * вместе со временем.
 */
export function parseDockerTime(value: string): number {
  const text = (value ?? "").trim();
  if (!text) return Number.NaN;
  return Date.parse(text.replace(/\.(\d{3})\d*/, ".$1"));
}

export type RemovedStuck = { id: string; name: string; state: string; ageMinutes: number };

export type ReapDeps = {
  docker?: SandboxHost["docker"];
  limits?: StuckLimits;
  now?: () => number;
  /** Сколько контейнеров проверять максимум: `inspect` стоит вызова на каждого кандидата. */
  maxCandidates?: number;
};

export type ReapResult = { removed: RemovedStuck[]; examined: number; failed: number };

/**
 * Один проход уборки. Ошибки Docker не пробрасываются: это обслуживание, и его отказ не должен
 * ронять ни старт сервера, ни таймер — иначе одна недоступная команда `docker` останавливала бы
 * уборку до следующего перезапуска.
 */
export async function reapStuckSandboxContainers(deps: ReapDeps = {}): Promise<ReapResult> {
  const docker = deps.docker ?? ((args: string[], timeoutMs?: number) => sandboxHost().docker(args, timeoutMs));
  const limits = deps.limits ?? stuckLimits();
  const now = deps.now ?? (() => Date.now());
  const maxCandidates = deps.maxCandidates ?? 50;
  const listed = await docker(["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.State}}"], 10_000).catch(() => null);
  if (!listed || listed.code !== 0) return { removed: [], examined: 0, failed: 0 };

  const candidates: { id: string; name: string; state: string }[] = [];
  for (const line of listed.stdout.split(/\r?\n/)) {
    const [id, name, state] = line.split("\t").map(part => (part ?? "").trim());
    if (!id || !name || !state) continue;
    if (!isSandboxWorkerName(name)) continue;
    const normalized = state.toLowerCase();
    if (normalized !== "created" && normalized !== "exited" && normalized !== "dead") continue;
    candidates.push({ id, name, state: normalized });
  }

  const removed: RemovedStuck[] = [];
  let examined = 0;
  let failed = 0;
  for (const candidate of candidates.slice(0, maxCandidates)) {
    examined += 1;
    const created = await docker(["inspect", "-f", "{{.Created}}", candidate.id], 5_000).catch(() => null);
    // Не смогли прочитать время — не убираем: возраст здесь единственная защита от гонки с
    // запуском, и «неизвестно» не значит «старый».
    if (!created || created.code !== 0) {
      failed += 1;
      continue;
    }
    const ageMs = now() - parseDockerTime(created.stdout);
    if (!shouldReap({ ...candidate, ageMs }, limits)) continue;
    const result = await docker(["rm", "-f", candidate.id], 15_000).catch(() => null);
    if (result && result.code === 0) {
      removed.push({ id: candidate.id, name: candidate.name, state: candidate.state, ageMinutes: Math.max(0, Math.round(ageMs / 60_000)) });
    } else {
      failed += 1;
    }
  }
  return { removed, examined, failed };
}

export type MaintenanceLog = (message: string, extra?: Record<string, unknown>) => void;

/**
 * Сторож песочниц: уборка на старте (осиротевшие задания) и дальше раз в
 * `SANDBOX_REAP_INTERVAL_MINUTES`. Возвращает функцию остановки — её зовут при штатном
 * завершении, чтобы таймер не держал процесс.
 */
export function startSandboxMaintenance(
  log: MaintenanceLog = () => undefined,
  options: { intervalMs?: number; deps?: ReapDeps; reapJobs?: boolean } = {},
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const reap = async (reason: string) => {
    const result = await reapStuckSandboxContainers(options.deps).catch(error => {
      log("[sandbox] уборка зависших контейнеров не удалась: " + (error instanceof Error ? error.message : String(error)));
      return null;
    });
    if (!result) return;
    if (result.removed.length) {
      log("[sandbox] убраны зависшие контейнеры (" + reason + "): " + String(result.removed.length), {
        removed: result.removed,
      });
    }
  };

  void (async () => {
    // Задания прошлого запуска принадлежат контейнерам, а не процессу: читать их больше некому.
    // Только на старте — периодический проход живые задания не трогает.
    if (options.reapJobs !== false) {
      const jobs = await cleanupSandboxJobs().catch(() => ({ removed: 0 }));
      if (jobs.removed) log("[sandbox] убраны задания прошлого запуска: " + String(jobs.removed));
    }
    await reap("старт");
  })();

  const intervalMs = options.intervalMs ?? reapIntervalMs();
  if (intervalMs > 0 && !stopped) {
    timer = setInterval(() => {
      void reap("по расписанию");
    }, intervalMs);
    timer.unref();
  }
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
}
