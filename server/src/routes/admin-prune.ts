import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { parseDockerDf, parseDockerSize, runDocker, summarizeDockerDf, type DockerDfRow } from "./admin-infra.js";
import { recordAudit } from "../security/audit-journal.js";

/**
 * Безопасная очистка Docker: кэш сборки и висячие образы.
 *
 * Маршрут умеет ровно это и не принимает «области» телом запроса. Остановленные контейнеры — это
 * песочницы проектов в холодном старте: их удаление превращает следующий запуск проекта в сборку с
 * нуля. В томах может лежать состояние проекта. Поэтому тело разбирается строгой схемой, и запрос
 * `{"scope":"volumes"}`, отправленный напрямую, получает `400`, а не «молча ничего не делает»:
 * иначе кнопка в админке выглядела бы умеющей больше, чем умеет.
 *
 * Команды запускаются массивом аргументов (`execFile`, без шелла), поэтому подставить свои
 * аргументы через тело запроса невозможно — набор команд не зависит от запроса вообще.
 *
 * Про `GET` отдельно: `/api/admin/infra` отдаёт `reclaimableBytes` как сумму **всех** строк
 * `docker system df`, то есть вместе с холодными песочницами и томами. Показывать её как «мусор к
 * удалению» нельзя, поэтому здесь считается только безопасная часть — кэш сборки и висячие образы.
 * Что останется (контейнеры и тома) приходит в `keep`: это не для удаления, а чтобы человек видел
 * цену нажатия.
 *
 * `GET` ничего не удаляет. `POST` запускается не чаще одного раза в 30 секунд и пишет событие в
 * журнал безопасности: удаление на сервере должно быть видно постфактум.
 */

const DOCKER_TIMEOUT_MS = 5_000;
const PRUNE_TIMEOUT_MS = 60_000;
const MIN_INTERVAL_MS = 30_000;

/** Набор команд не выбирается запросом: ровно эти две строки и ничего больше. */
export const PRUNE_COMMANDS = ["docker builder prune -a -f", "docker image prune -f"] as const;

type DockerRun = { code: number; stdout: string; stderr: string } | null;

export type PruneDeps = {
  /** Запуск docker. Вынесен в зависимость, чтобы маршрут проверялся без настоящего Docker. */
  docker: (args: string[], timeoutMs?: number) => Promise<DockerRun>;
  now: () => number;
};

const defaultDeps: PruneDeps = {
  docker: (args, timeoutMs = DOCKER_TIMEOUT_MS) => runDocker(args, timeoutMs),
  now: () => Date.now(),
};

function rowOf(rows: DockerDfRow[], type: string) {
  return rows.find(row => row.type.toLowerCase() === type.toLowerCase());
}

/** Безопасная часть: кэш сборки и висячие образы. */
export function pruneScope(rows: DockerDfRow[], dangling: { count: number; bytes: number }) {
  const builder = rowOf(rows, "Build Cache");
  // К освобождению относится именно `reclaimable`: `size` — это всё, что занимает кэш, и он
  // совпадает с `reclaimable` только когда весь кэш неиспользуемый.
  const builderCacheBytes = builder?.reclaimable ?? builder?.size ?? 0;
  return {
    builderCacheBytes,
    danglingImages: dangling,
    safeTotalBytes: builderCacheBytes + dangling.bytes,
  };
}

/** Что останется после очистки: холодные песочницы и тома. Не для удаления. */
export function pruneKeep(rows: DockerDfRow[], stoppedContainers: number) {
  const volumes = rowOf(rows, "Local Volumes");
  return {
    stoppedContainers,
    volumes: { count: volumes?.count ?? 0, bytes: volumes?.size ?? 0 },
  };
}

/**
 * «Total reclaimed space: 1.2GB» из вывода prune (`Total: 0B` у старых сборок). Нужен как запасной
 * источник, когда `docker system df` не разобран целиком: без него `freedBytes` пришлось бы
 * показывать нулём, хотя место освободилось.
 */
export function reclaimedFromOutput(stdout: string): number | null {
  const line = /^total(?:\s+reclaimed\s+space)?:?\s*(.+)$/i;
  let total = 0;
  let found = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const match = line.exec(raw.trim());
    if (!match) continue;
    const bytes = parseDockerSize(match[1]);
    if (bytes === null) continue;
    found = true;
    total += bytes;
  }
  return found ? total : null;
}

type DfRead = { rows: DockerDfRow[] | null; reason: string };

function lastLine(output: string) {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "готово";
}

/** Строки `docker system df`; новый Docker отдаёт JSON, старый — таблицу (разбор общий). */
async function readDf(docker: PruneDeps["docker"]): Promise<DfRead> {
  const json = await docker(["system", "df", "--format", "{{json .}}"]);
  if (!json) return { rows: null, reason: "Docker недоступен" };
  const fromJson = json.code === 0 ? parseDockerDf(json.stdout) : [];
  if (fromJson.length) return { rows: fromJson, reason: "" };
  const plain = await docker(["system", "df"]);
  if (!plain) return { rows: null, reason: "Docker недоступен" };
  const fromPlain = plain.code === 0 ? parseDockerDf(plain.stdout) : [];
  if (fromPlain.length) return { rows: fromPlain, reason: "" };
  return { rows: null, reason: plain.stderr.trim() || json.stderr.trim() || "docker system df не ответил" };
}

/** Висячие образы: без тега, на них не ссылается ни один контейнер. */
async function danglingImages(docker: PruneDeps["docker"]): Promise<{ count: number; bytes: number } | null> {
  const list = await docker(["image", "ls", "--filter", "dangling=true", "--format", "{{json .}}"]);
  if (!list || list.code !== 0) return null;
  let count = 0;
  let bytes = 0;
  for (const line of list.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    count += 1;
    try {
      const value = JSON.parse(trimmed) as { Size?: unknown };
      bytes += typeof value.Size === "string" ? parseDockerSize(value.Size) ?? 0 : 0;
    } catch {
      // Одна нечитаемая строка не обнуляет итог: считаем то, что разобрали.
    }
  }
  return { count, bytes };
}

async function stoppedContainers(docker: PruneDeps["docker"]): Promise<number | null> {
  const list = await docker(["ps", "-aq", "--filter", "status=exited"]);
  if (!list || list.code !== 0) return null;
  return list.stdout.split(/\r?\n/).filter(line => line.trim()).length;
}

/** Строгая схема тела: лишнее поле — отказ, а не «проигнорирую». */
const pruneBody = z.strictObject({ confirm: z.literal(true) });

export async function registerAdminPruneRoutes(app: FastifyInstance, overrides: Partial<PruneDeps> = {}) {
  const deps: PruneDeps = {
    docker: overrides.docker ?? defaultDeps.docker,
    now: overrides.now ?? defaultDeps.now,
  };
  // Отметка последнего запуска живёт в этом замыкании: состояние — на процесс, а не на модуль,
  // и повторная регистрация (тесты, встраивание в другой сервер) не делит чужой лимит.
  let lastRunAt = Number.NEGATIVE_INFINITY;

  const noRun = (generatedAt: string, reason: string) => ({
    generatedAt,
    // Нули здесь не выдают себя за измерение: рядом `canRun: false` и причина, по которой
    // приложение блокирует кнопку и ничего не отправляет.
    scope: { builderCacheBytes: 0, danglingImages: { count: 0, bytes: 0 }, safeTotalBytes: 0 },
    keep: { stoppedContainers: 0, volumes: { count: 0, bytes: 0 } },
    commands: [...PRUNE_COMMANDS],
    canRun: false,
    reason,
  });

  /**
   * Что освободит безопасная очистка и что останется. Только чтение, `no-store`, админ-токен.
   *
   * Все три пробы нужны вместе: без любой из них оценка безопасной части неполная, а неполную
   * нельзя показывать кнопкой «удалить». Поэтому отказ одной пробы — `canRun: false` с причиной,
   * а не уменьшенная сумма.
   */
  app.get("/api/admin/infra/prune", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const [df, dangling, stopped] = await Promise.all([
      readDf(deps.docker),
      danglingImages(deps.docker),
      stoppedContainers(deps.docker),
    ]);
    const generatedAt = new Date(deps.now()).toISOString();

    if (!df.rows) return noRun(generatedAt, df.reason || "Docker недоступен");
    if (!dangling) return noRun(generatedAt, "docker image ls не ответил — размер висячих образов неизвестен");
    if (stopped === null) return noRun(generatedAt, "docker ps не ответил — число холодных песочниц неизвестно");

    return {
      generatedAt,
      scope: pruneScope(df.rows, dangling),
      keep: pruneKeep(df.rows, stopped),
      commands: [...PRUNE_COMMANDS],
      canRun: true,
    };
  });

  app.post("/api/admin/infra/prune", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const parsed = pruneBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Нужно подтверждение: { confirm: true }" });
    }

    const now = deps.now();
    const sinceLast = now - lastRunAt;
    if (sinceLast < MIN_INTERVAL_MS) {
      reply.header("Retry-After", String(Math.ceil((MIN_INTERVAL_MS - sinceLast) / 1000)));
      return reply.code(429).send({ error: "Очистка уже запускалась только что — подождите полминуты" });
    }
    // Отметка ставится до команд: повтор после сбоя так же ждёт полминуты, иначе кнопка
    // превращается в способ долбить Docker, пока он болен.
    lastRunAt = now;

    const before = await readDf(deps.docker);
    const details: string[] = [];
    let reclaimed = 0;
    let reclaimedKnown = false;

    const steps = [
      { label: "builder prune", args: ["builder", "prune", "-a", "-f"] },
      // Без `-a`: удаляются только висячие образы, используемые остаются на месте.
      { label: "image prune", args: ["image", "prune", "-f"] },
    ];
    for (const step of steps) {
      const result = await deps.docker(step.args, PRUNE_TIMEOUT_MS);
      if (!result || result.code !== 0) {
        return reply.code(502).send({
          error: "docker " + step.label + " не отработал",
          details: result ? result.stderr.trim() || lastLine(result.stdout) : "Docker недоступен",
        });
      }
      const bytes = reclaimedFromOutput(result.stdout);
      if (bytes !== null) {
        reclaimed += bytes;
        reclaimedKnown = true;
      }
      details.push(step.label + ": " + lastLine(result.stdout));
    }

    const after = await readDf(deps.docker);
    const beforeBytes = before.rows ? summarizeDockerDf(before.rows).dockerBytes : null;
    const afterBytes = after.rows ? summarizeDockerDf(after.rows).dockerBytes : null;
    // Разница итогов честнее вывода команд: в ней видно и то, что освободил сам prune, и то, что
    // Docker успел занять за время уборки. Вывод команд — запасной источник, когда `df` не разобран.
    const freedBytes =
      beforeBytes !== null && afterBytes !== null
        ? Math.max(0, beforeBytes - afterBytes)
        : reclaimedKnown
          ? reclaimed
          : 0;
    const ranAt = new Date(deps.now()).toISOString();

    // Событие в журнале безопасности: удаление на сервере должно быть видно постфактум.
    await recordAudit({
      action: "infra.docker.pruned",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: { freedBytes, beforeBytes: beforeBytes ?? 0, afterBytes: afterBytes ?? 0, commands: PRUNE_COMMANDS.join("; ") },
    });

    return {
      ok: true,
      freedBytes,
      beforeBytes: beforeBytes ?? 0,
      afterBytes: afterBytes ?? 0,
      ranAt,
      details,
    };
  });
}
