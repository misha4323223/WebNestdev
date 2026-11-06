import type { FastifyInstance } from "fastify";
import { statfs } from "node:fs/promises";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { parseDockerDf, parseDockerSize, runDocker, summarizeDockerDf } from "./admin-infra.js";
import { recordAudit } from "../security/audit-journal.js";

/**
 * Релизы платформы: какие образы выкаток лежат на диске и что с ними можно сделать.
 *
 * Вопрос «в админке 12.5 ГБ, а я удалил зависший проект, и ничего не изменилось» здесь решается
 * честными числами. `df` показывает занятое **всем разделом**: образы, слои containerd, swap,
 * журналы и ОС. Один образ выкатки — это ~1.45 ГБ, поэтому удаление одного зависшего контейнера
 * меняет цифру на сотые доли гигабайта, а не на гигабайты. Чтобы это было видно, рядом со списком
 * отдаются `disk` (сколько занято разделом) и `docker` (сколько из этого Docker считает своим).
 *
 * Классификация — то же правило, что у уборки при выкатке (`enforce_image_limit` в
 * deploy/scripts/vm-deploy.sh): на репозиторий остаются `keep` последних версий, работающая не
 * удаляется никогда. Отличие только в подаче: выкатка действует сама, а здесь человек видит
 * причину для каждой версии.
 *
 *   active   — на этом образе работает контейнер; удалить нельзя;
 *   previous — версия в окне отката (`keep`), не работает; удалить можно, но откат станет
 *              `docker pull` из GHCR;
 *   stuck    — не работает, но её держат контейнеры (обычно зависшие `wnd-cmd-…`): место не
 *              освободится, пока их не снять; `containers=remove` снимает их вместе с образом;
 *   old      — сверх окна и ничего не держит: мусор, самое безопасное удаление.
 *
 * Удаление — только по одному образу, с явным подтверждением: «убрать всё» уже делает выкатка,
 * а кнопка «удалить всё» в панели стирала бы и версию откката.
 */

const INSPECT_TIMEOUT_MS = 15_000;
const DF_TIMEOUT_MS = 20_000;
const REMOVE_TIMEOUT_MS = 60_000;

/** Сколько версий образа на репозиторий считается окном откката. */
const DEFAULT_KEEP = 2;
const MAX_KEEP = 10;
/** Какой репозиторий считать нашим: имя образа платформы (`ghcr.io/…/webnestdev`). */
const DEFAULT_PATTERN = "webnestdev";

type DockerRun = { code: number; stdout: string; stderr: string } | null;

export type ReleaseDeps = {
  docker: (args: string[], timeoutMs?: number) => Promise<DockerRun>;
  now: () => number;
  /** Окружение, из которого читаются шаблон и окно откката: тесты подставляют свой объект. */
  env: NodeJS.ProcessEnv;
  /** Занятое разделом `/`. Подставное значение в тестах, настоящий statfs в бою. */
  disk: () => Promise<{ totalBytes: number; usedBytes: number; freeBytes: number } | null>;
};

/** Конфигурация из окружения: шаблон репозитория и размер окна откката. */
export function releaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const pattern = (env.PLATFORM_RELEASES_PATTERN ?? "").trim() || DEFAULT_PATTERN;
  const raw = Number(env.PLATFORM_RELEASES_KEEP ?? "");
  const keep = Number.isFinite(raw) && raw >= 1 ? Math.min(MAX_KEEP, Math.floor(raw)) : DEFAULT_KEEP;
  return { pattern, keep };
}

/**
 * Разбор `docker images --format '{{json .}}'`: по строке JSON, без разделителей. Это единственный
 * способ, который не ломается от версии CLI: в строке `CreatedAt` два пробела, а трактовка `\t`
 * в `--format` у разных сборок разная — на разделителе список версий молча стал бы пустым.
 */
export type ReleaseImageRow = {
  id: string;
  repo: string;
  tag: string;
  sizeText: string;
  createdAt: string;
  digest: string;
};

export type ReleaseContainerRow = {
  id: string;
  name: string;
  state: string;
  image: string;
  createdAt: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseImageLines(output: string): ReleaseImageRow[] {
  const rows: ReleaseImageRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      const id = text(value.ID);
      if (!id) continue;
      rows.push({
        id,
        repo: text(value.Repository),
        tag: text(value.Tag),
        sizeText: text(value.Size),
        createdAt: text(value.CreatedAt),
        digest: text(value.Digest),
      });
    } catch {
      // Одна нечитаемая строка не обнуляет список: остальные версии важнее.
    }
  }
  return rows;
}

export function parseContainerLines(output: string): ReleaseContainerRow[] {
  const rows: ReleaseContainerRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      const id = text(value.ID);
      if (!id) continue;
      rows.push({
        id,
        name: text(value.Names),
        state: text(value.State),
        image: text(value.Image),
        createdAt: text(value.CreatedAt),
      });
    } catch {
      // См. выше: битая строка не отменяет остальные контейнеры.
    }
  }
  return rows;
}

/**
 * `docker images` печатает `2026-11-06 21:33:25 +0300 MSK`: `Date.parse` на такой строке молчит
 * из-за имени зоны, поэтому время собирается вручную. Неизвестное время — `null`, а не «сейчас»:
 * от него зависит, какая версия считается новой.
 */
export function parseDockerDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}:?\d{2})?/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const offset = zone ? (zone.length === 5 ? zone.slice(0, 3) + ":" + zone.slice(3) : zone) : "Z";
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function shortImageId(id: string) {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

/** `ghcr.io/x/webnestdev:sha-abc` → `ghcr.io/x/webnestdev`; digest отбрасывается. */
export function refRepository(ref: string) {
  const withoutDigest = ref.split("@")[0] ?? "";
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

export type ReleaseStatus = "active" | "previous" | "stuck" | "old";

export type ReleaseHolder = {
  id: string;
  shortId: string;
  name: string;
  state: string;
  createdAt: string | null;
  /** Снять такой контейнер сервер имеет право (`wnd-…`); остальное — чужие контейнеры. */
  removable: boolean;
};

export type AdminRelease = {
  id: string;
  shortId: string;
  tags: string[];
  repo: string;
  /** SHA выкатки из тега `sha-…` — то, что показывается как версия. */
  buildSha: string | null;
  createdAt: string | null;
  ageDays: number | null;
  sizeBytes: number;
  sizeText: string;
  status: ReleaseStatus;
  /** Версия в окне откката: её не удаляет автоматическая уборка. */
  kept: boolean;
  /** 1 — самая новая версия репозитория. */
  rank: number;
  activeContainers: ReleaseHolder[];
  holders: ReleaseHolder[];
  canDelete: boolean;
  /** Почему удалить нельзя или что удаление будет значить. `null` — обычное старое удаление. */
  reason: string | null;
};

export type ReleaseSummary = {
  count: number;
  totalBytes: number;
  activeBytes: number;
  rollbackBytes: number;
  /** Освободится обычным удалением (не работает и ничего не держит). */
  deletableBytes: number;
  /** Держат контейнеры: сначала их снятие, потом образ. */
  stuckBytes: number;
  oldest: { shortId: string; createdAt: string | null } | null;
};

export type ReleaseInventory = {
  releases: AdminRelease[];
  summary: ReleaseSummary;
};

export type BuildInventoryInput = {
  images: ReleaseImageRow[];
  containers: ReleaseContainerRow[];
  keep: number;
  pattern: string;
  nowMs: number;
};

function holderOf(container: ReleaseContainerRow): ReleaseHolder {
  const created = parseDockerDate(container.createdAt);
  return {
    id: container.id,
    shortId: container.id.replace(/^sha256:/, "").slice(0, 12),
    name: container.name,
    state: container.state,
    createdAt: created === null ? null : new Date(created).toISOString(),
    removable: container.name.startsWith("wnd-"),
  };
}

/**
 * Какой образ у контейнера. Docker хранит в `.Image` то, что передали при создании: чаще всего
 * тег (`…:sha-abc`), иногда полный ID. Тег мог уже переехать на новый образ, поэтому порядок
 * строгий: сначала точное совпадение тега, потом ID, и только потом префикс короткого ID.
 */
export function imageForContainer(
  containerImage: string,
  releases: Array<{ id: string; tags: string[]; repo: string }>,
): string | null {
  const ref = containerImage.trim();
  if (!ref) return null;
  for (const release of releases) if (release.tags.includes(ref)) return release.id;
  const repo = refRepository(ref);
  const noTag = repo === ref;
  if (noTag) {
    for (const release of releases) if (release.tags.some(tag => refRepository(tag) === repo)) return release.id;
  }
  const bare = ref.replace(/^sha256:/, "");
  if (/^[0-9a-f]{7,64}$/i.test(bare)) {
    const found = releases.find(release => release.id.replace(/^sha256:/, "").startsWith(bare.slice(0, 12)));
    if (found) return found.id;
  }
  return null;
}

/**
 * Список релизов и их состояние. Чистая функция: тесты подают строки Docker и не трогают машину.
 *
 * Дедупликация по ID обязательна: один образ может быть с двумя тегами (`latest` и `sha-…`), и в
 * листинге это две строки. Без неё версия заняла бы два места в окне откката и «двух последних»
 * оказалось бы меньше.
 */
export function buildReleaseInventory(input: BuildInventoryInput): ReleaseInventory {
  const grouped = new Map<string, { rows: ReleaseImageRow[]; tags: string[] }>();
  for (const row of input.images) {
    if (!row.repo || row.repo === "<none>") continue;
    const ours = row.repo.includes(input.pattern) || /^sha-[0-9a-f]{7,}$/i.test(row.tag);
    if (!ours) continue;
    const entry = grouped.get(row.id) ?? { rows: [], tags: [] };
    entry.rows.push(row);
    if (row.tag && row.tag !== "<none>") {
      const tag = `${row.repo}:${row.tag}`;
      if (!entry.tags.includes(tag)) entry.tags.push(tag);
    }
    grouped.set(row.id, entry);
  }

  const drafts = [...grouped.entries()].map(([id, entry]) => {
    const row = entry.rows[0];
    const sizeBytes = parseDockerSize(row.sizeText) ?? 0;
    const created = parseDockerDate(row.createdAt);
    const buildSha = entry.rows
      .map(item => /^sha-([0-9a-f]{7,})$/i.exec(item.tag)?.[1] ?? null)
      .find(value => value !== null) ?? null;
    return {
      id,
      shortId: shortImageId(id),
      tags: entry.tags,
      repo: row.repo,
      buildSha,
      createdAt: created === null ? null : new Date(created).toISOString(),
      createdMs: created ?? 0,
      ageDays: created === null ? null : Math.max(0, Math.floor((input.nowMs - created) / 86_400_000)),
      sizeBytes,
      sizeText: row.sizeText,
    };
  });

  // Свежие сверху: окно откката — это `keep` первых версий каждого репозитория.
  drafts.sort((left, right) => right.createdMs - left.createdMs || left.shortId.localeCompare(right.shortId));

  const rankByRepo = new Map<string, number>();
  const releases: AdminRelease[] = [];
  for (const draft of drafts) {
    const rank = (rankByRepo.get(draft.repo) ?? 0) + 1;
    rankByRepo.set(draft.repo, rank);
    const holders = input.containers
      .filter(container => imageForContainer(container.image, [draft]) === draft.id)
      .map(holderOf);
    const activeContainers = holders.filter(holder => holder.state === "running");
    const kept = rank <= input.keep;

    let status: ReleaseStatus;
    if (activeContainers.length) status = "active";
    else if (holders.length) status = "stuck";
    else if (kept) status = "previous";
    else status = "old";

    const foreign = holders.filter(holder => !holder.removable && holder.state !== "running");
    let canDelete = status !== "active" && foreign.length === 0;
    let reason: string | null = null;
    if (status === "active") {
      reason = "образ работает: " + activeContainers.map(holder => holder.name).join(", ");
    } else if (foreign.length) {
      reason = "образ держат контейнеры платформы не из этой: " + foreign.map(holder => holder.name).join(", ");
      canDelete = false;
    } else if (status === "stuck") {
      reason = "держат контейнеры: " + holders.map(holder => `${holder.name} (${holder.state})`).join(", ");
    } else if (status === "previous") {
      reason = "окно откката: после удаления откат начнётся с загрузки образа из GHCR";
    }

    releases.push({
      id: draft.id,
      shortId: draft.shortId,
      tags: draft.tags,
      repo: draft.repo,
      buildSha: draft.buildSha,
      createdAt: draft.createdAt,
      ageDays: draft.ageDays,
      sizeBytes: draft.sizeBytes,
      sizeText: draft.sizeText,
      status,
      kept,
      rank,
      activeContainers,
      holders,
      canDelete,
      reason,
    });
  }

  const summary: ReleaseSummary = {
    count: releases.length,
    totalBytes: releases.reduce((sum, release) => sum + release.sizeBytes, 0),
    activeBytes: releases.filter(r => r.status === "active").reduce((sum, r) => sum + r.sizeBytes, 0),
    rollbackBytes: releases.filter(r => r.status === "previous").reduce((sum, r) => sum + r.sizeBytes, 0),
    deletableBytes: releases
      .filter(r => r.status === "old" || r.status === "previous")
      .reduce((sum, r) => sum + r.sizeBytes, 0),
    stuckBytes: releases.filter(r => r.status === "stuck").reduce((sum, r) => sum + r.sizeBytes, 0),
    oldest: releases.length
      ? { shortId: releases[releases.length - 1].shortId, createdAt: releases[releases.length - 1].createdAt }
      : null,
  };
  return { releases, summary };
}

async function readImages(deps: ReleaseDeps) {
  const result = await deps.docker(["images", "--no-trunc", "--format", "{{json .}}"]);
  if (!result || result.code !== 0) return null;
  return parseImageLines(result.stdout);
}

async function readContainers(deps: ReleaseDeps) {
  const result = await deps.docker(["ps", "-a", "--format", "{{json .}}"]);
  if (!result || result.code !== 0) return null;
  return parseContainerLines(result.stdout);
}

/** Строки `docker system df` (новый Docker — JSON, старый — таблица; разбор общий). */
async function readDockerSummary(deps: ReleaseDeps) {
  const json = await deps.docker(["system", "df", "--format", "{{json .}}"], DF_TIMEOUT_MS);
  if (!json) return null;
  const rows = json.code === 0 ? parseDockerDf(json.stdout) : [];
  if (rows.length) return summarizeDockerDf(rows);
  const plain = await deps.docker(["system", "df"], DF_TIMEOUT_MS);
  if (!plain || plain.code !== 0) return null;
  const fromPlain = parseDockerDf(plain.stdout);
  return fromPlain.length ? summarizeDockerDf(fromPlain) : null;
}

async function collect(deps: ReleaseDeps, env: NodeJS.ProcessEnv = process.env) {
  const config = releaseConfig(env);
  const nowMs = deps.now();
  const [images, containers, docker, disk] = await Promise.all([
    readImages(deps),
    readContainers(deps),
    readDockerSummary(deps),
    deps.disk(),
  ]);
  const generatedAt = new Date(nowMs).toISOString();
  if (!images) {
    return {
      generatedAt,
      pattern: config.pattern,
      keep: config.keep,
      disk,
      docker,
      releases: [] as AdminRelease[],
      summary: buildReleaseInventory({ images: [], containers: [], keep: config.keep, pattern: config.pattern, nowMs }).summary,
      /** Ложь без живого Docker: в панели видно, что это не «версий нет», а «не прочитали». */
      available: false,
      reason: "docker images не ответил — список релизов неизвестен",
    };
  }
  const inventory = buildReleaseInventory({
    images,
    containers: containers ?? [],
    keep: config.keep,
    pattern: config.pattern,
    nowMs,
  });
  return {
    generatedAt,
    pattern: config.pattern,
    keep: config.keep,
    disk,
    docker,
    releases: inventory.releases,
    summary: inventory.summary,
    available: true,
    reason: containers ? null : "docker ps не ответил — какая версия работает, определить нельзя",
  };
}

const defaultDeps: ReleaseDeps = {
  docker: (args, timeoutMs = INSPECT_TIMEOUT_MS) => runDocker(args, timeoutMs),
  now: () => Date.now(),
  env: process.env,
  disk: async () => {
    try {
      const info = await statfs("/");
      const blockSize = Number(info.bsize);
      const totalBytes = Number(info.blocks) * blockSize;
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
      const usedBytes = Math.max(0, (Number(info.blocks) - Number(info.bfree)) * blockSize);
      const freeBytes = Math.max(0, Number(info.bavail) * blockSize);
      return { totalBytes, usedBytes, freeBytes };
    } catch {
      return null;
    }
  },
};

/** Подтверждение и режим снятия контейнеров — только строкой запроса: DELETE с телом поддерживают не все клиенты. */
export type ReleaseQuery = { confirm?: string; containers?: string };

export function releaseQueryError(query: ReleaseQuery): string | null {
  if (query.confirm !== "1" && query.confirm !== "true") return "Нужно подтверждение: ?confirm=1";
  const containers = query.containers ?? "keep";
  if (containers !== "keep" && containers !== "remove") return "containers принимает keep или remove";
  return null;
}

export async function registerAdminReleasesRoutes(app: FastifyInstance, overrides: Partial<ReleaseDeps> = {}) {
  const deps: ReleaseDeps = {
    docker: overrides.docker ?? defaultDeps.docker,
    now: overrides.now ?? defaultDeps.now,
    env: overrides.env ?? defaultDeps.env,
    disk: overrides.disk ?? defaultDeps.disk,
  };

  /** Список версий, их состояние и из чего складывается занятое место. Только чтение. */
  app.get("/api/admin/releases", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return collect(deps, deps.env);
  });

  /**
   * Удалить одну версию. Активную не удаляет никогда — это остановка сайта; держащие контейнеры
   * снимаются только по явному `containers=remove` и только свои (`wnd-…`).
   */
  app.delete("/api/admin/releases/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const query = (request.query ?? {}) as ReleaseQuery;
    const queryError = releaseQueryError(query);
    if (queryError) return reply.code(400).send({ error: queryError });

    const wanted = String((request.params as { id?: string }).id ?? "").trim();
    const before = await collect(deps, deps.env);
    if (!before.available) {
      return reply.code(502).send({ error: "Docker недоступен", details: before.reason });
    }

    const release =
      before.releases.find(item => item.id === wanted) ??
      before.releases.find(item => item.shortId === wanted) ??
      before.releases.find(item => item.tags.includes(wanted));
    if (!release) {
      return reply.code(404).send({ error: "Такой версии нет на диске", id: wanted });
    }
    if (release.status === "active") {
      return reply.code(409).send({
        error: "Версия работает — удалять её нельзя",
        release,
        activeContainers: release.activeContainers,
      });
    }
    const foreign = release.holders.filter(holder => !holder.removable);
    if (foreign.length) {
      return reply.code(409).send({
        error: "Версию держат контейнеры не платформы — удаление остановилось",
        release,
        holders: foreign,
      });
    }
    if (release.holders.length && (query.containers ?? "keep") !== "remove") {
      return reply.code(409).send({
        error: "Версию держат контейнеры: повторите с containers=remove, чтобы снять их вместе с образом",
        release,
        holders: release.holders,
      });
    }

    const dfBefore = await readDockerSummary(deps);
    const removedContainers: string[] = [];
    const failedContainers: string[] = [];
    for (const holder of release.holders) {
      const result = await deps.docker(["rm", "-f", holder.id], REMOVE_TIMEOUT_MS);
      if (result && result.code === 0) removedContainers.push(holder.name);
      else failedContainers.push(holder.name);
    }
    if (failedContainers.length) {
      return reply.code(409).send({
        error: "Не удалось снять контейнеры, которые держат версию",
        release,
        failedContainers,
        details: "контейнеры могли быть созданы не платформой или Docker не ответил",
      });
    }

    const removed = await deps.docker(["rmi", release.id], REMOVE_TIMEOUT_MS);
    if (!removed || removed.code !== 0) {
      const details = removed ? removed.stderr.trim() || removed.stdout.trim() : "Docker недоступен";
      return reply.code(409).send({
        error: "Docker не удалил образ",
        release,
        details: details || "причина не сообщена",
      });
    }

    const after = await collect(deps, deps.env);
    const dfAfter = after.docker;
    const freedBytes =
      dfBefore && dfAfter && dfBefore.dockerBytes !== null && dfAfter.dockerBytes !== null
        ? Math.max(0, dfBefore.dockerBytes - dfAfter.dockerBytes)
        : null;

    await recordAudit({
      action: "infra.release.deleted",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: {
        id: release.id,
        buildSha: release.buildSha ?? "",
        tags: release.tags.join(", "),
        status: release.status,
        freedBytes: freedBytes ?? 0,
        removedContainers: removedContainers.join(", "),
      },
    });

    return {
      ok: true,
      deleted: release,
      removedContainers,
      freedBytes,
      releases: after.releases,
      summary: after.summary,
      disk: after.disk,
      docker: after.docker,
    };
  });
}
