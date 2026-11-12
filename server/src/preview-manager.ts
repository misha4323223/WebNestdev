import type { SandboxConfig } from "./sandbox-manager.js";
import { getProject } from "./project-store.js";
import { dockerExec, dockerForNode } from "./preview/docker-exec.js";
import { resolveSandboxHost } from "./sandbox/host.js";
import { previewDepsForHost } from "./preview/node-deps.js";
import { isLocalPreviewOwner } from "./preview/preview-owner.js";
import { nodeId } from "./nodes/identity.js";
import { listNodes } from "./nodes/node-store.js";
import { decideRuntimePreviewStart, perUserPreviewLimit, runtimePreviewLimit } from "./preview/preview-limiter.js";
import { clearPreviewReservation, reservePreviewStart } from "./preview/preview-reservation.js";
import { previewAppAnswers } from "./preview/app-http.js";
import { settlePreviewAddress } from "./preview/preview-address.js";
import { flushPreviewWrites, hydratePreview, listPreviewsAcrossReplicas, removePreview, setPreview, touchPreview } from "./preview/preview-store.js";
import { listSharedPreviews, sharedPreviewRegistryEnabled } from "./preview/preview-registry.js";
import { startPreviewContainer, previewLogsOf, removePreviewContainer } from "./preview/preview-runner.js";
import { adoptRunningPreview } from "./preview/preview-adopt.js";
import { previewModeSetting, recoverLocalStaticPreview, startStaticPreview, staticAppAnswers, staticPreviewLogs, stopStaticPreview } from "./preview/static-preview.js";
import { readHybridConfig } from "./preview/hybrid-config.js";
import { detectAndSaveHybridProfile } from "./preview/hybrid-detect.js";
import { hybridBackendLogs, hybridPreviewLogs, hybridPreviewStatus, recoverLocalHybridPreview, startHybridPreview, stopHybridPreview } from "./preview/hybrid-preview.js";
import { recordPreviewStart } from "./preview/preview-metrics.js";
import { PREVIEW_LABEL, type PreviewStatus } from "./preview/types.js";
import { clearPreviewSecrets } from "./secrets/preview-secrets.js";
import { recordStorageMutation } from "./account/storage-quota.js";

export type { PreviewState, PreviewStatus } from "./preview/types.js";

/** Test seam for the mode/fallback decision: no Docker or real package build is needed. */
export type PreviewStartDeps = {
  readHybridConfig: typeof readHybridConfig;
  detectHybrid: typeof detectAndSaveHybridProfile;
  startHybrid: typeof startHybridPreview;
  startStatic: typeof startStaticPreview;
  startContainer: (config: SandboxConfig, staticReason?: string) => Promise<PreviewStatus>;
};

const defaultPreviewStartDeps: PreviewStartDeps = {
  readHybridConfig,
  detectHybrid: detectAndSaveHybridProfile,
  startHybrid: startHybridPreview,
  startStatic: startStaticPreview,
  startContainer: startContainerPreview,
};

let previewStartDeps: PreviewStartDeps = defaultPreviewStartDeps;

export function setPreviewStartDepsForTests(overrides: Partial<PreviewStartDeps> | null): void {
  previewStartDeps = { ...defaultPreviewStartDeps, ...(overrides ?? {}) };
}

/**
 * Starts the preview the way the panel's button and the agent's verification do. The mode is
 * decided here: `static` builds the project and serves the output from the server process
 * (no container, no memory), `container` is the dev server with live reload, and `auto` — the
 * default — serves the build when the project has one and falls back to the dev server when
 * it does not (no build script, a failing build, or an output without index.html).
 */
export async function startPreview(config: SandboxConfig) {
  const startedAt = Date.now();
  let ok = false;
  try {
    const status = await startPreviewWithFallback(config);
    ok = true;
    return status;
  } catch (error) {

    // Причина отказа раньше жила только в ответе панели и в сообщении агенту, а тот, кто смотрит
    // логи контейнера сервера (`docker compose logs webnestdev-server`), видел один факт запуска
    // и не мог отличить отсутствующие зависимости от недоступного Docker.
    console.error("[preview] не удалось запустить предпросмотр: проект " + config.projectId + " — " + describeError(error));
    throw error;
  } finally {
    recordPreviewStart(config.node ?? nodeId(), Date.now() - startedAt, ok);
    // Запуск предпросмотра — это ещё и запись: он ставит зависимости и собирает `dist`.
    // Счётчик квоты обязан увидеть это сразу, иначе пользователь видит старый размер, хотя
    // `node_modules` уже лежит на диске. Замер идёт в фоне и не задерживает ответ панели.
    void recordPreviewSize(config.projectId);
  }
}

async function recordPreviewSize(projectId: string) {
  try {
    const project = await getProject(projectId);
    // force: установка и сборка могли занять минуты, а кеш замера живёт 15 секунд — иначе
    // после предпросмотра остался бы размер, снятый до `npm install`.
    if (project) await recordStorageMutation(projectId, project.userId, { heavy: true });
  } catch (error) {
    console.warn("[storage] не удалось обновить размер после предпросмотра: " + describeError(error));
  }
}

export async function startPreviewWithFallback(config: SandboxConfig) {
  const setting = previewModeSetting();
  let hybrid = await previewStartDeps.readHybridConfig(config.root);

  // The explicit package contract comes first. When it is absent — or a local profile became
  // stale — the server applies the same conservative detector the agent would use and saves
  // only `.webnestdev/preview.json`. A generic dev/start script is never enough; the detector
  // needs a build, a static frontend, a dedicated backend script and real backend path evidence.
  // Static and container modes are host decisions and must not get a new hybrid profile behind
  // their back.
  if ((hybrid.kind === "absent" || hybrid.kind === "invalid") && setting !== "static" && setting !== "container") {
    try {
      const detected = await previewStartDeps.detectHybrid(config.root);
      if (detected.kind === "configured") hybrid = { kind: "configured", config: detected.config };
    } catch (error) {
      // Detection is an optimization, not a reason to lose the ordinary preview: a read error
      // in a huge project must fall through to static/container, not fail the start.
      console.warn("[preview] проект " + config.projectId + ": auto-определение hybrid пропущено — " + describeError(error));
    }
  }

  if (hybrid.kind === "invalid" && setting === "hybrid") throw new Error(hybrid.reason);
  if (hybrid.kind === "configured" && setting !== "static" && setting !== "container") {
    const result = await previewStartDeps.startHybrid(config);
    if (result.ok) return result.status;
    if (setting === "hybrid") throw new Error(result.reason);
    // A broken hybrid must not leave a backend behind; startHybridPreview cleans it up before
    // returning. The ordinary container preview remains the safe fallback for node-runtime apps.
    console.log("[preview] проект " + config.projectId + ": hybrid не подошёл (" + result.reason + ") — поднимаю dev-сервер");
    return previewStartDeps.startContainer(config, "hybrid не подошёл: " + result.reason);
  }
  if (setting === "hybrid") {
    throw new Error("Для PREVIEW_MODE=hybrid проект должен объявить preview.mode=\"hybrid\" в package.json или иметь уверенный hybrid-профиль в .webnestdev/preview.json.");
  }

  if (setting !== "container") {
    const result = await previewStartDeps.startStatic(config);
    if (result.ok) return result.status;
    // A host that requires static previews must not silently start a container, so the reason
    // is the answer there; every other mode falls back and carries the reason as a hint.
    if (setting === "static") throw new Error(result.reason);
    // Почему проект не удалось отдать статикой — тоже в лог: на маленькой ВМ поднятый контейнер
    // предпросмотра иначе выглядит случайностью, а не следствием непригодной сборки.
    console.log("[preview] проект " + config.projectId + ": статическая сборка не подошла (" + result.reason + ") — поднимаю dev-сервер");
    return previewStartDeps.startContainer(config, result.reason);
  }
  return previewStartDeps.startContainer(config);
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Подсказка для панели, когда приложение отдаётся через `docker exec`. Молчать об этом нельзя:
 * предпросмотр работает, но медленнее и без горячей перезагрузки, и причину видно только здесь.
 */
const EXEC_ONLY_HINT="Предпросмотр отдаётся панели через docker exec: адрес контейнера серверу недоступен (Docker изолирует сети контейнеров). Приложение видно, но медленнее и без горячей перезагрузки — подключите контейнер к сети сервера или задайте PREVIEW_NETWORK, и прямой адрес вернётся сам.";

/**
 * Как часто перепроверять недоступный адрес заново; `0` — на каждом чтении статуса.
 * Пустое значение — это «не задано», а не ноль: `Number("")` дало бы 0 и вернуло бы полную проверку
 * на каждый файл приложения (переменная может прийти из compose пустой строкой).
 */
function execRetryMs(){
  const value=process.env.PREVIEW_EXEC_RETRY_MS?.trim();
  if(!value)return 60_000;
  const raw=Number(value);
  return Number.isFinite(raw)&&raw>=0?Math.floor(raw):60_000;
}

/**
 * Как часто повторять полную проверку адреса, пока он не подтверждён; `0` — на каждом чтении.
 *
 * Полная проверка — это `docker inspect`, запрос внутрь контейнера и до двух попыток починить адрес
 * (`preview-address.ts`). Пока адрес не отвечает, каждый такой проход занимает десятки секунд, а
 * прокси читает статус на КАЖДЫЙ файл приложения: страница из десятка модулей не показывалась
 * вообще, и в панели это выглядело белым кадром, а не медленным предпросмотром. Между проверками
 * отдаётся последний известный ответ — его возраст виден в `checkedAt`.
 */
function addressRetryMs(){
  const value=process.env.PREVIEW_ADDRESS_RETRY_MS?.trim();
  if(!value)return 10_000;
  const raw=Number(value);
  return Number.isFinite(raw)&&raw>=0?Math.floor(raw):10_000;
}

/**
 * The dev-server preview. A running one is reused instead of restarted: the dev server
 * watches the project files itself, so the agent's edits appear without another start.
 */
async function startContainerPreview(config: SandboxConfig, staticReason?: string) {
  let current = await hydratePreview(config.projectId);
  if (current?.mode === "static") {
    // The mode changed, or the static start fell back: a listener must not be left behind.
    await stopStaticPreview(config.projectId);
    removePreview(config.projectId);
    current = undefined;
  } else if (current?.mode === "hybrid") {
    // A failed hybrid must not be adopted as a dev-server container. Its listener is in this
    // process, and the backend has a different contract, so stop both before the fallback.
    await stopHybridPreview(config.projectId);
    current = undefined;
  } else if (current) {
    const status = await previewStatus(config.projectId);
    if (status.running) return status;
    current = undefined;
  }
  // Прерванный старт мог оставить работающий контейнер без строки состояния. Принять его
  // дешевле и честнее, чем поднимать второй: приложение уже отвечает, а бронь от старого
  // запуска иначе отвечала бы «уже запускается» до истечения TTL.
  if (!current) {
    const adopted = await adoptRunningPreview(config);
    if (adopted) {
      await clearPreviewReservation(config.projectId);
      const status = await previewStatus(config.projectId);
      if (status.running) return status;
    }
  }
  // A running dev server holds its memory until it is stopped, so this is the one preview kind
  // that has to be counted. A static preview is not: it is a listener, and the panel shows it
  // from the same process whatever this number says.
  const project = await getProject(config.projectId);
  const userId = project?.userId ?? "";
  // В общей схеме проверка и старт должны быть одним шагом: между чтением реестра и появлением
  // новой строки проходит установка зависимостей, и две реплики иначе обе проходят лимит.
  // Бронь живёт в PostgreSQL и снимается после записи состояния; в JSON-режиме остаётся
  // прежняя локальная проверка.
  const reserved = await reservePreviewStart({
    projectId: config.projectId,
    userId,
    node: config.node,
    perUser: perUserPreviewLimit(),
    hostLimit: runtimePreviewLimit(),
  });
  if (reserved.kind === "busy") throw new Error(reserved.reason);

  let stopProjectIds: string[];
  if (reserved.kind === "disabled") {
    // Считаем по общему реестру, а не по локальной карте: иначе вторая реплика видит только
    // свои предпросмотры и разрешает аккаунту второй контейнер. Владелец обычно уже записан
    // вместе с состоянием; `getProject` остаётся только для старых строк без owner_user_id.
    const shared = (await listPreviewsAcrossReplicas()).filter(state => state.mode === "container" || state.mode === "hybrid");
    const live = await Promise.all(
      shared.map(async state => ({
        projectId: state.projectId,
        lastUsedAt: state.lastUsedAt,
        node: state.node,
        userId: state.ownerUserId || (await getProject(state.projectId))?.userId || "",
      })),
    );
    const decision = decideRuntimePreviewStart({
      live,
      projectId: config.projectId,
      userId,
      node: config.node ?? nodeId(),
    });
    if (!decision.ok) throw new Error(decision.reason);
    stopProjectIds = decision.stopProjectId ? [decision.stopProjectId] : [];
  } else {
    stopProjectIds = reserved.stopProjectIds;
  }

  try {
    for (const projectId of stopProjectIds) await stopPreview(projectId);
    const status = await startPreviewContainer(config);
    // Снимаем бронь только после того, как строка preview действительно ушла в общий реестр:
    // иначе следующая реплика в это окно увидит пустой реестр и запустит второй контейнер.
    if (reserved.kind === "acquired") await flushPreviewWrites(config.projectId);
    if (!staticReason || !status.ready) return status;
    return { ...status, hint: "Статическая сборка недоступна (" + staticReason + "), работает dev-сервер." };
  } finally {
    if (reserved.kind === "acquired") await reserved.reservation.release();
  }
}

/**
 * Heartbeat панели по preview, которое могло быть начато на другой реплике. Сначала поднимаем
 * состояние из общего реестра, затем продлеваем его локальную и общую отметку.
 */
export async function touchPreviewAnywhere(projectId: string) {
  const current = await hydratePreview(projectId);
  if (!current) return false;
  return touchPreview(projectId);
}

export async function stopPreview(projectId: string) {
  // Остановка закрывает и незавершённый старт: иначе бронь переживёт контейнер и следующий
  // запуск снова упрётся в «уже запускается».
  await clearPreviewReservation(projectId);
  const current = await hydratePreview(projectId);
  if (!current) {
    // Остановка могла прийти после падения запуска: временный env-файл всё равно убираем.
    await clearPreviewSecrets(projectId);
    return { stopped: false };
  }
  if (current.mode === "static") {
    await stopStaticPreview(projectId);
    removePreview(projectId);
    await clearPreviewSecrets(projectId);
    return { stopped: true };
  }
  if (current.mode === "hybrid") {
    await stopHybridPreview(projectId);
    return { stopped: true };
  }
  await removePreviewContainer(current.containerId,current.node);
  removePreview(projectId);
  await clearPreviewSecrets(projectId);
  return { stopped: true };
}

/**
 * Returns what the panel shows behind the preview: the dev-server output for a container
 * preview, the build output for a static one (nothing runs that could produce more).
 */
export async function previewLogs(projectId: string) {
  const current = await hydratePreview(projectId);
  if (!current) return { running: false, logs: "" };

  if (current.mode === "static") {
    // Somebody is reading the logs, so the preview is in use.
    touchPreview(projectId);
    return { running: true, logs: staticPreviewLogs(projectId) };
  }

  if (current.mode === "hybrid") {
    touchPreview(projectId);
    const backend = await hybridBackendLogs(projectId);
    if (backend.missing) {
      await stopHybridPreview(projectId);
      return { running: false, logs: "" };
    }
    return {
      running: true,
      logs: [hybridPreviewLogs(projectId), backend.logs].filter(Boolean).join("\n\n"),
    };
  }

  const result = await previewLogsOf(current.containerId,dockerForNode(current.node));
  // Логи читает панель каждые четыре секунды, и у контейнера, который убрали извне, она видела
  // вместо вывода приложения ответ Docker «No such container». Такой предпросмотр уже не запущен:
  // состояние снимается здесь же, и следующий запуск поднимает новый контейнер.
  if (result.missing) {
    removePreview(projectId);
    await clearPreviewSecrets(projectId);
    return { running: false, logs: "" };
  }
  // Somebody is reading the logs, so the preview is in use.
  touchPreview(projectId);
  return { running: true, logs: result.logs };
}

/**
 * Оставляет только те контейнеры, на которые не претендует живая строка общего реестра.
 * В JSON-режиме реестра нет, и поведение прежнее: всё с меткой — сирота этого процесса.
 */
/**
 * IDs контейнеров предпросмотра на узле. `--no-trunc` обязателен: без него Docker отдаёт короткие
 * 12-символьные ID, а в общем реестре хранится полный ID. Сравнение короткого с полным не
 * совпадает никогда, и уборщик при старте API удалял живые предпросмотры как осиротевшие.
 */
export async function listPreviewContainerIds(
  docker: (args: string[]) => Promise<{ code: number; stdout: string }>,
) {
  const listed = await docker(["ps", "-aq", "--no-trunc", "--filter", "label=" + PREVIEW_LABEL]);
  return listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : [];
}

async function orphanPreviewIds(ids: string[]) {
  // В общей схеме живой preview принадлежит не этому процессу. Удалять все контейнеры с меткой
  // при старте API нельзя: перезапуск второй реплики уносил бы preview первой. Поэтому
  // оставляем всё, на что есть непросроченная строка реестра.
  if (!sharedPreviewRegistryEnabled()) return ids;
  const live = new Set((await listSharedPreviews()).map(state => state.containerId).filter(Boolean));
  return ids.filter(id => !live.has(id));
}

/**
 * The preview state used to live only in memory, so after a server restart every labelled
 * preview container was an orphan. Now the shared registry tells which ones belong to another
 * live replica; only the rest are removed. Set PREVIEW_REAP_ON_START=0 to disable even that.
 * Static previews live in this process, so a restart leaves nothing of them behind.
 */
export async function reapOrphanPreviews() {
  if (process.env.PREVIEW_REAP_ON_START === "0") return { stopped: 0 };
  // Все контейнеры с меткой, а не только работающие: предпросмотр запускается без `--rm`, и
  // упавший остаётся остановленным — на диске он тоже никому не нужен.
  const ids = await orphanPreviewIds(await listPreviewContainerIds(dockerExec));
  for (const id of ids) await removePreviewContainer(id);
  return { stopped: ids.length };
}

/**
 * Remove preview containers left on remote runners by an API restart. The runner's own boot
 * reap covers a runner restart; this covers the API restart while runners stay up. The shared
 * registry protects previews owned by another live replica; `PREVIEW_REAP_ON_START=0` remains
 * the escape hatch when the registry itself is unavailable during a rollout.
 */
export async function reapRemotePreviews() {
  if (process.env.PREVIEW_REAP_ON_START === "0") return { stopped: 0 };
  const local = nodeId();
  const nodes = (await listNodes()).filter(node => node.id !== local && node.address.trim());
  let stopped = 0;
  for (const node of nodes) {
    try {
      const host = await resolveSandboxHost(node.id);
      const ids = await orphanPreviewIds(await listPreviewContainerIds(args => host.docker(args)));
      if (ids.length) {
        await host.docker(["rm", "-f", ...ids]);
        stopped += ids.length;
      }
    } catch (error) {
      console.warn("[preview] уборка на узле " + node.id + " пропущена: " + describeError(error));
    }
  }
  return { stopped };
}

export async function previewStatus(projectId: string): Promise<PreviewStatus> {
  const current = await hydratePreview(projectId);
  if (!current) {
    // A listener in this process is the truth even when its registry row was lost. Without this
    // recovery preview.start could return successfully, then a browser check read no row and
    // reported "Preview is not running" while the app was still listening on loopback.
    let recovered = await recoverLocalStaticPreview(projectId);
    if (!recovered) recovered = await recoverLocalHybridPreview(projectId);
    if (recovered) return recovered;
    return { running: false };
  }

  if (current.mode === "hybrid") return hybridPreviewStatus(projectId);

  // Nothing runs in a container for a static preview, so there is nothing to inspect: the
  // listener answers or it does not.
  if (current.mode === "static") {
    // На чужой реплике слушателя нет: проверять 127.0.0.1 бессмысленно. Дверь всё равно
    // проксирует запрос на owner_address, поэтому статус берётся из общего реестра.
    const local = isLocalPreviewOwner(current.ownerAddress);
    const ready = local ? await staticAppAnswers(current.host, current.port) : current.ready !== false;
    touchPreview(projectId);
    return {
      running: true,
      ready,
      // Готовность статического предпросмотра — это ответ на запрос самого сервера, поэтому
      // подтверждённый адрес и готовность здесь одно и то же.
      settled: ready,
      mode: "static",
      port: current.port,
      host: current.host,
      containerId: current.containerId,
      startedAt: current.startedAt,
      ...(current.ownerAddress ? { ownerAddress: current.ownerAddress } : {}),
      ...(ready
        ? {}
        : { hint: "Статическая сборка не отвечает — запустите предпросмотр заново." }),
    };
  }

  // Деградировавший предпросмотр (панель отдаётся через `docker exec`, потому что адрес контейнера
  // серверу недоступен): полная проверка адреса — это `docker inspect`, запрос внутрь контейнера и
  // попытки починить адрес заново, а статус читается на КАЖДЫЙ файл приложения, поэтому повторяют её
  // по времени, а не на каждом чтении. Приложение при этом отвечает (иначе прокси не поставил бы
  // эту пометку), а прямой адрес вернётся сам, как только заработает.
  if(current.execOnly&&Date.now()-(current.execOnlyCheckedAt??0)<execRetryMs()){
    touchPreview(projectId);
    return {
      running: true,
      ready: true,
      settled: Boolean(current.settled),
      viaExec: true,
      mode: "container",
      port: current.port,
      host: current.host,
      containerId: current.containerId,
      startedAt: current.startedAt,
      ...(current.node?{node:current.node}:{}),
      ...(current.containerPort?{containerPort:current.containerPort}:{}),
      ...(current.ownerAddress?{ownerAddress:current.ownerAddress}:{}),
      hint: EXEC_ONLY_HINT,
    };
  }

  // Подтверждённый адрес не перепроверяется через контейнер на каждом чтении статуса. Прокси читает
  // статус на КАЖДЫЙ файл приложения, а `docker exec` стоит сотни миллисекунд, поэтому каждая загрузка
  // модуля через панель (в отличие от прямого адреса, которым пользуется Chromium) платила лишний
  // раунд — а при десятках файлов это и есть «панель не показывает приложение». Живость
  // подтверждённого адреса проверяет сам прокси настоящим запросом: отказ снимает подтверждение
  // (unsettlePreview), и следующее чтение статуса проверяет контейнер как раньше.
  //
  // Деградировавший предпросмотр (панель идёт через `docker exec`) — исключение: он проверяется
  // целиком, но не чаще execRetryMs() (см. ветку выше), иначе сеть не была бы проверена ещё раз,
  // а панель осталась бы на медленном пути навсегда.
  if(current.settled&&!current.execOnly){
    touchPreview(projectId);
    return {
      running: true,
      ready: true,
      settled: true,
      mode: "container",
      port: current.port,
      host: current.host,
      containerId: current.containerId,
      startedAt: current.startedAt,
      ...(current.node?{node:current.node}:{}),
      ...(current.containerPort?{containerPort:current.containerPort}:{}),
      ...(current.ownerAddress?{ownerAddress:current.ownerAddress}:{}),
    };
  }

  // Неподтверждённый адрес: последний полный проход не повторяется на каждом чтении статуса
  // (см. addressRetryMs). Ответ — то, что уже известно из предыдущего прохода: контейнер жив,
  // адрес пока не подтверждён. Иначе каждый файл приложения платил бы десятки секунд за проверку,
  // которая ещё не может ничего изменить, и кадр панели оставался бы пустым.
  if(current.checkedAt&&Date.now()-current.checkedAt<addressRetryMs()){
    touchPreview(projectId);
    return {
      running: true,
      ready: Boolean(current.ready),
      settled: false,
      mode: "container",
      port: current.port,
      host: current.host,
      containerId: current.containerId,
      startedAt: current.startedAt,
      ...(current.node?{node:current.node}:{}),
      ...(current.containerPort?{containerPort:current.containerPort}:{}),
      ...(current.ownerAddress?{ownerAddress:current.ownerAddress}:{}),
      hint: current.ready
        ? "Приложение отвечает внутри контейнера, но недоступно по адресу контейнера: платформа пробует подключить его к сети сервера и пробросить порт — обновите статус; если подсказка осталась, задайте PREVIEW_NETWORK."
        : "Приложение ещё запускается: первый старт dev-сервера занимает несколько секунд.",
    };
  }

  const host=await resolveSandboxHost(current.node||nodeId());
  const docker=(args:string[],timeoutMs?:number)=>host.docker(args,timeoutMs);
  const inspect = await docker([
    "inspect",
    "-f",
    "{{.State.Running}}",
    current.containerId,
  ]);

  if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
    removePreview(projectId);
    // Контейнер мог не исчезнуть, а завершиться: без `--rm` он остаётся на хосте, и убрать его
    // больше некому — следующий запуск создал бы рядом новый.
    await removePreviewContainer(current.containerId,current.node);
    return { running: false };
  }

  // Every status read counts as use: the panel refreshes it, the logs tab polls it and the
  // agent's project.verify/browser.* checks go through it, as does every proxied request.
  touchPreview(projectId);

  // A dev server that is still compiling has not failed: the container is the truth here,
  // and `ready` says whether the app answers yet. Dropping the state on a slow first start
  // used to lose the container and leave it running with nothing left to stop it.
  const ready = await previewAppAnswers(current,docker);
  // Приложение отвечает внутри контейнера, но не по адресу контейнера (обычно слушает только
  // петлю, а иногда — свой порт вместо запрошенного): адрес доводится до рабочего здесь же,
  // потому что статус читают и панель, и прокси, и агент. Медленный первый старт поэтому
  // лечится сам, без перезапуска предпросмотра вручную.
  //
  // Починка запускается и когда приложение ещё не ответило на порт из состояния: оно могло подняться
  // позже и на своём порту (dev-скрипт, который не принял флаги запуска), а подтверждения у адреса
  // всё ещё нет. Раньше шаг выполнялся только при `ready`, поэтому такой предпросмотр навсегда
  // оставался с портом, на котором ничего не слушает: приложение живо, а панель показывает пустой кадр.
  const settled = await settlePreviewAddress(current.execOnly?{...current,settled:false}:current, { appAnswers: ready, deps: previewDepsForHost(host) });
  // Отметка о выполненной проверке — вместе с её результатом: следующий полный проход — не раньше,
  // чем через execRetryMs(), иначе каждый файл приложения платил бы за него заново.
  const stamped = { ...settled, ready, checkedAt: Date.now(), ...(settled.execOnly ? { execOnlyCheckedAt: Date.now() } : {}) };
  if (stamped !== current) setPreview(stamped);
  // Адрес подтверждён — значит до приложения доходит сам сервер, а вместе с ним панель, прокси и
  // Chromium. Это отдельный факт от «приложение живо»: без него «предпросмотр запущен» и белый
  // экран в панели приходилось разбирать по логам контейнера.
  const confirmed = Boolean(settled.settled);

  return {
    running: true,
    ready,
    settled: confirmed,
    mode: "container",
    port: settled.port,
    host: settled.host,
    containerId: current.containerId,
    startedAt: current.startedAt,
    ...(settled.node?{node:settled.node}:{}),
    ...(settled.containerPort?{containerPort:settled.containerPort}:{}),
    ...(settled.ownerAddress?{ownerAddress:settled.ownerAddress}:{}),
    // Адрес контейнера не отвечает, но приложение живо внутри: панель отдаётся через `docker exec`
    // (см. preview/exec-proxy.ts), поэтому кадр не пустой — и об этом честно сказано пользователю.
    ...(settled.execOnly
      ? { viaExec: true, hint: EXEC_ONLY_HINT }
      : ready
        ? confirmed
          ? {}
          : { hint: "Приложение отвечает внутри контейнера, но недоступно по адресу контейнера: платформа пробует подключить его к сети сервера и пробросить порт — обновите статус; если подсказка осталась, задайте PREVIEW_NETWORK." }
        : { hint: "Приложение ещё запускается: первый старт dev-сервера занимает несколько секунд." }),
  };
}
