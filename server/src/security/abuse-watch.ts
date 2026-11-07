import { execFile } from "node:child_process";
import { blockUser } from "../account/restriction-store.js";
import { recordAudit } from "./audit-journal.js";
import { getProject } from "../project-store.js";

/**
 * Детектор майнинга и «тяжёлых» контейнеров.
 *
 * Майнинг на чужой машине стоит платформе денег и репутации (исходящий трафик уже закрыт сетью
 * 5.1, но CPU-нагрузка остаётся). Признак, который видно без содержимого трафика, — контейнер
 * проекта, который держит почти всё выделенное ему CPU дольше разумного времени. Сборка это
 * секунды-минуты, тесты — тоже; десять минут на 90% — не сборка.
 *
 * Реакция — ограничение аккаунта, а не молчаливое убийство: в журнал `security_audit` пишется
 * запись `security.abuse.blocked` с проектом и минутами нагрузки, у пользователя появляется
 * причина при входе (`blockedMessageFor`), администратор видит запись и снимает блокировку одной
 * кнопкой. Контейнеры нарушителя останавливаются: пока аккаунт заблокирован, его нагрузка не
 * должна продолжать жечь CPU.
 *
 * Выборка идёт через Docker-брокер (`docker ps`, `docker inspect`, `docker stats`), потому что
 * прямого доступа к `docker.sock` у сервера нет. Всё это только чтение; остановка контейнера —
 * уже решение политики, а не наблюдение.
 */

export type AbuseSample = { containerId: string; projectId: string | null; cpuPercent: number };
export type AbuseLimits = { cpuPercent: number; sustainedMs: number };
export type AbuseViolation = { projectId: string; since: number; containers: string[] };
export type WatchState = Map<string, { firstHighAt: number; containers: Set<string> }>;

export const DEFAULT_ABUSE_LIMITS: AbuseLimits = { cpuPercent: 90, sustainedMs: 10 * 60 * 1000 };

/** Лимиты из окружения: администратор может смягчить порог на слабой ВМ или ужесточить на сильной. */
export function abuseLimitsFromEnv(): AbuseLimits {
  const cpu = Number(process.env.ABUSE_CPU_PERCENT);
  const sustained = Number(process.env.ABUSE_SUSTAINED_MS);
  return {
    cpuPercent: Number.isFinite(cpu) && cpu > 0 && cpu <= 100 ? cpu : DEFAULT_ABUSE_LIMITS.cpuPercent,
    sustainedMs: Number.isFinite(sustained) && sustained >= 60_000 ? sustained : DEFAULT_ABUSE_LIMITS.sustainedMs,
  };
}

/**
 * Один шаг наблюдения без ввода-вывода: по сэмплам решает, кто уже перешёл порог.
 *
 * Ключ — проект, а не контейнер: агент запускает команду за командой, и каждая живёт секунды.
 * Считать «одна команда 10 минут» значило бы пропустить ровно тот случай, когда тяжёлая работа
 * перезапускается снова и снова. Контейнеры, которые сейчас выше порога, накапливаются в наборе —
 * их и остановит реакция.
 */
export function evaluateAbuse(
  state: WatchState,
  samples: AbuseSample[],
  now: number,
  limits: AbuseLimits = DEFAULT_ABUSE_LIMITS,
): { violations: AbuseViolation[]; state: WatchState } {
  const high = new Map<string, Set<string>>();
  for (const sample of samples) {
    if (!sample.projectId) continue;
    if (!(sample.cpuPercent >= limits.cpuPercent)) continue;
    const set = high.get(sample.projectId) ?? new Set<string>();
    set.add(sample.containerId);
    high.set(sample.projectId, set);
  }

  const violations: AbuseViolation[] = [];
  for (const [projectId, containers] of high) {
    const entry = state.get(projectId);
    if (!entry) {
      state.set(projectId, { firstHighAt: now, containers: new Set(containers) });
      continue;
    }
    for (const id of containers) entry.containers.add(id);
    if (now - entry.firstHighAt >= limits.sustainedMs) {
      violations.push({ projectId, since: entry.firstHighAt, containers: [...entry.containers] });
      state.delete(projectId);
    }
  }
  // Проект, который перестал грузить CPU, начинает отсчёт заново: одна короткая сборка не должна
  // приближать блокировку следующей.
  for (const projectId of [...state.keys()]) {
    if (!high.has(projectId)) state.delete(projectId);
  }
  return { violations, state };
}

/** `"12.34%"` → 12.34; мусор и пустая строка — 0. */
export function parseCpuPercent(value: string): number {
  const parsed = Number(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Одна строка `docker ps --format '{{json .}}'`: id контейнера и метка проекта, если она есть. */
export function parseDockerPsLine(line: string): { id: string; projectId: string | null } | null {
  try {
    const parsed = JSON.parse(line) as { ID?: unknown; Labels?: unknown };
    const id = typeof parsed.ID === "string" ? parsed.ID : "";
    if (!id) return null;
    const labels = typeof parsed.Labels === "string" ? parsed.Labels : "";
    const match = labels.split(",").find(label => label.startsWith("webnestdev.project="));
    return { id, projectId: match ? match.slice("webnestdev.project=".length) || null : null };
  } catch {
    return null;
  }
}

/** `docker inspect --format '{{json .Config.Env}}'` → проект из переменной контейнера. */
export function projectFromEnvJson(raw: string): string | null {
  try {
    const env = JSON.parse(raw) as unknown;
    if (!Array.isArray(env)) return null;
    const entry = env.find(value => typeof value === "string" && value.startsWith("WEBNESTDEV_PROJECT_ID="));
    if (typeof entry !== "string") return null;
    const projectId = entry.slice("WEBNESTDEV_PROJECT_ID=".length).trim();
    return projectId || null;
  } catch {
    return null;
  }
}

/** Пары `id cpu%` из `docker stats --no-stream --no-trunc`. */
export function parseStatsLines(raw: string): Array<{ id: string; cpuPercent: number }> {
  const out: Array<{ id: string; cpuPercent: number }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    const id = space > 0 ? trimmed.slice(0, space) : trimmed;
    const cpu = space > 0 ? parseCpuPercent(trimmed.slice(space + 1)) : 0;
    if (id) out.push({ id, cpuPercent: cpu });
  }
  return out;
}

export type DockerRunner = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string } | null>;

/**
 * Docker CLI в контейнере сервера: `DOCKER_HOST` смотрит на сокет брокера, поэтому каждый вызов
 * проходит политику брокера. `ENOENT` (CLI нет) — `null`, наблюдение просто выключается.
 */
export function dockerCliRunner(args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string } | null> {
  return new Promise(resolve => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Чтение состояния контейнеров через Docker CLI (в бою он говорит с брокером, а не с демоном). */
export function createDockerObserver(run: DockerRunner) {
  return async (): Promise<AbuseSample[]> => {
    const listed = await run(["ps", "--format", "{{json .}}", "--filter", "label=webnestdev.managed"], 15_000);
    if (!listed || listed.code !== 0) return [];
    const containers = listed.stdout
      .split("\n")
      .map(parseDockerPsLine)
      .filter((entry): entry is { id: string; projectId: string | null } => entry !== null);
    if (!containers.length) return [];

    const projects = new Map<string, string | null>(containers.map(entry => [entry.id, entry.projectId]));
    // Метка проекта есть у заданий и предпросмотров; у команд агента её нет (контейнер одноразовый),
    // поэтому для таких контейнеров проект читается из переменной окружения — один inspect на
    // контейнер, и только пока он жив.
    await Promise.all(
      containers
        .filter(entry => !entry.projectId)
        .map(async entry => {
          const inspected = await run(["inspect", "--format", "{{json .Config.Env}}", entry.id], 10_000);
          if (!inspected || inspected.code !== 0) return;
          const projectId = projectFromEnvJson(inspected.stdout);
          if (projectId) projects.set(entry.id, projectId);
        }),
    );

    const stats = await run(
      ["stats", "--no-stream", "--no-trunc", "--format", "{{.ID}} {{.CPUPerc}}", ...containers.map(entry => entry.id)],
      20_000,
    );
    if (!stats || stats.code !== 0) return [];
    const samples: AbuseSample[] = [];
    for (const row of parseStatsLines(stats.stdout)) {
      // Короткий id из stats сопоставляется с полным из ps по префиксу: формат вывода зависит от
      // версии CLI, и требовать точного совпадения значило бы терять все замеры после обновления.
      const id = containers.find(entry => entry.id === row.id)?.id ??
        containers.find(entry => entry.id.startsWith(row.id) || row.id.startsWith(entry.id))?.id;
      if (!id) continue;
      samples.push({ containerId: id, projectId: projects.get(id) ?? null, cpuPercent: row.cpuPercent });
    }
    return samples;
  };
}

export type AbuseProjectOwner = { userId: string; email: string; name: string };

export type AbuseWatchDeps = {
  observe: () => Promise<AbuseSample[]>;
  /** Владелец и название проекта: название попадает в причину блокировки, а не только в лог. */
  ownerOf: (projectId: string) => Promise<AbuseProjectOwner | null>;
  block: (input: { userId: string; email: string; reason: string }) => Promise<void>;
  stop: (containerId: string) => Promise<void>;
  audit: (entry: { userId: string; email: string; projectId: string; minutes: number }) => Promise<void>;
  now?: () => number;
  limits?: AbuseLimits;
  log?: (line: string) => void;
};

export function abuseReason(projectId: string, projectName: string, minutes: number): string {
  return (
    "контейнер проекта «" + projectName + "» (" + projectId + ") держал загрузку CPU почти постоянно " +
    minutes + " мин — это похоже на майнинг или другую работу, не связанную с разработкой. " +
    "Напишите в поддержку — разберёмся и снимем ограничение."
  );
}

/**
 * Один тик: снять сэмплы, найти нарушителей, заблокировать и остановить их контейнеры.
 * Возвращает нарушения — их печатает вызывающий (и по ним же пишется лог выкатки).
 */
export function createAbuseWatch(deps: AbuseWatchDeps) {
  const state = new Map<string, { firstHighAt: number; containers: Set<string> }>();
  let running = false;
  return {
    async tick(): Promise<AbuseViolation[]> {
      if (running) return [];
      running = true;
      try {
        const now = (deps.now ?? Date.now)();
        const limits = deps.limits ?? abuseLimitsFromEnv();
        const samples = await deps.observe();
        const { violations } = evaluateAbuse(state, samples, now, limits);
        for (const violation of violations) {
          const owner = await deps.ownerOf(violation.projectId).catch(() => null);
          if (!owner) {
            deps.log?.("[abuse] проект " + violation.projectId + " перегружен, но владелец не найден — пропуск");
            continue;
          }
          const minutes = Math.max(1, Math.round((now - violation.since) / 60_000));
          const name = owner.name || violation.projectId;
          await deps.block({ userId: owner.userId, email: owner.email, reason: abuseReason(violation.projectId, name, minutes) });
          await deps.audit({
            userId: owner.userId,
            email: owner.email,
            projectId: violation.projectId,
            minutes,
          });
          for (const containerId of violation.containers) {
            await deps.stop(containerId).catch(() => undefined);
          }
          deps.log?.(
            "[abuse] аккаунт " + owner.email + " заблокирован: проект " + violation.projectId +
              " держал CPU ≥ " + limits.cpuPercent + "% " + minutes + " мин",
          );
        }
        return violations;
      } finally {
        running = false;
      }
    },
  };
}

/** Боевая сборка: брокер, ограничения аккаунта и журнал. Вызывается из `index.ts` по таймеру. */
export function productionAbuseWatch(run: DockerRunner) {
  const observer = createDockerObserver(run);
  return createAbuseWatch({
    observe: observer,
    ownerOf: async projectId => {
      const project = await getProject(projectId);
      return project ? { userId: project.userId, email: project.userId, name: project.name } : null;
    },
    block: async ({ userId, reason }) => {
      await blockUser({ userId, reason, adminId: "system", adminLabel: "автоматическая проверка нагрузки" });
    },
    stop: async containerId => {
      await run(["stop", "-t", "5", containerId], 30_000);
    },
    audit: async ({ userId, email, projectId, minutes }) => {
      await recordAudit({
        action: "security.abuse.blocked",
        actorType: "system",
        actorId: "abuse-watch",
        actorLabel: "автоматическая проверка нагрузки",
        target: userId,
        targetLabel: email,
        details: { projectId, minutes },
      });
    },
    log: line => console.warn(line),
  });
}
