import type { SandboxConfig } from "./sandbox-manager.js";
import { getProject } from "./project-store.js";
import { dockerExec } from "./preview/docker-exec.js";
import { decideRuntimePreviewStart, liveRuntimePreviews } from "./preview/preview-limiter.js";
import { previewAppAnswers } from "./preview/app-http.js";
import { settlePreviewAddress } from "./preview/preview-address.js";
import { getPreview, removePreview, setPreview, touchPreview } from "./preview/preview-store.js";
import { recentPreviewLogs, startPreviewContainer } from "./preview/preview-runner.js";
import { previewModeSetting, startStaticPreview, staticAppAnswers, staticPreviewLogs, stopStaticPreview } from "./preview/static-preview.js";
import { PREVIEW_LABEL, type PreviewStatus } from "./preview/types.js";
import { clearPreviewSecrets } from "./secrets/preview-secrets.js";
import { recordStorageMutation } from "./account/storage-quota.js";

export type { PreviewState, PreviewStatus } from "./preview/types.js";

/**
 * Starts the preview the way the panel's button and the agent's verification do. The mode is
 * decided here: `static` builds the project and serves the output from the server process
 * (no container, no memory), `container` is the dev server with live reload, and `auto` — the
 * default — serves the build when the project has one and falls back to the dev server when
 * it does not (no build script, a failing build, or an output without index.html).
 */
export async function startPreview(config: SandboxConfig) {
  try {
    return await startPreviewWithFallback(config);
  } catch (error) {

    // Причина отказа раньше жила только в ответе панели и в сообщении агенту, а тот, кто смотрит
    // логи контейнера сервера (`docker compose logs webnestdev-server`), видел один факт запуска
    // и не мог отличить отсутствующие зависимости от недоступного Docker.
    console.error("[preview] не удалось запустить предпросмотр: проект " + config.projectId + " — " + describeError(error));
    throw error;
  } finally {
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

async function startPreviewWithFallback(config: SandboxConfig) {
  const setting = previewModeSetting();
  if (setting !== "container") {
    const result = await startStaticPreview(config);
    if (result.ok) return result.status;
    // A host that requires static previews must not silently start a container, so the reason
    // is the answer there; every other mode falls back and carries the reason as a hint.
    if (setting === "static") throw new Error(result.reason);
    // Почему проект не удалось отдать статикой — тоже в лог: на маленькой ВМ поднятый контейнер
    // предпросмотра иначе выглядит случайностью, а не следствием непригодной сборки.
    console.log("[preview] проект " + config.projectId + ": статическая сборка не подошла (" + result.reason + ") — поднимаю dev-сервер");
    return startContainerPreview(config, result.reason);
  }
  return startContainerPreview(config);
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
 * The dev-server preview. A running one is reused instead of restarted: the dev server
 * watches the project files itself, so the agent's edits appear without another start.
 */
async function startContainerPreview(config: SandboxConfig, staticReason?: string) {
  const current = getPreview(config.projectId);
  if (current?.mode === "static") {
    // The mode changed, or the static start fell back: a listener must not be left behind.
    await stopStaticPreview(config.projectId);
    removePreview(config.projectId);
  } else if (current) {
    const status = await previewStatus(config.projectId);
    if (status.running) return status;
  }
  // A running dev server holds its memory until it is stopped, so this is the one preview kind
  // that has to be counted. A static preview is not: it is a listener, and the panel shows it
  // from the same process whatever this number says.
  const project = await getProject(config.projectId);
  const live = await Promise.all(
    liveRuntimePreviews().map(async state => ({
      projectId: state.projectId,
      lastUsedAt: state.lastUsedAt,
      userId: (await getProject(state.projectId))?.userId,
    })),
  );
  const decision = decideRuntimePreviewStart({ live, projectId: config.projectId, userId: project?.userId ?? "" });
  if (!decision.ok) throw new Error(decision.reason);
  if (decision.stopProjectId) await stopPreview(decision.stopProjectId);
  const status = await startPreviewContainer(config);
  if (!staticReason || !status.ready) return status;
  return { ...status, hint: "Статическая сборка недоступна (" + staticReason + "), работает dev-сервер." };
}

export async function stopPreview(projectId: string) {
  const current = getPreview(projectId);
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
  await dockerExec(["stop", current.containerId]);
  removePreview(projectId);
  await clearPreviewSecrets(projectId);
  return { stopped: true };
}

/**
 * Returns what the panel shows behind the preview: the dev-server output for a container
 * preview, the build output for a static one (nothing runs that could produce more).
 */
export async function previewLogs(projectId: string) {
  const current = getPreview(projectId);
  if (!current) return { running: false, logs: "" };

  if (current.mode === "static") {
    // Somebody is reading the logs, so the preview is in use.
    touchPreview(projectId);
    return { running: true, logs: staticPreviewLogs(projectId) };
  }

  const logs = await recentPreviewLogs(current.containerId);
  // Somebody is reading the logs, so the preview is in use.
  touchPreview(projectId);
  return { running: true, logs };
}

/**
 * The preview state lives in memory, so after a server restart every labelled preview
 * container is an orphan: nothing owns it, it keeps running with its resources, and the
 * next start would create a second one for the same project. Reaping on boot keeps that
 * bounded. Set PREVIEW_REAP_ON_START=0 when several server replicas share one Docker host.
 * Static previews live in this process, so a restart leaves nothing of them behind.
 */
export async function reapOrphanPreviews() {
  if (process.env.PREVIEW_REAP_ON_START === "0") return { stopped: 0 };
  const listed = await dockerExec(["ps", "-q", "--filter", "label=" + PREVIEW_LABEL]);
  const ids = listed.stdout.split("\n").map(value => value.trim()).filter(Boolean);
  for (const id of ids) await dockerExec(["stop", id], 30000);
  return { stopped: ids.length };
}

export async function previewStatus(projectId: string): Promise<PreviewStatus> {
  const current = getPreview(projectId);
  if (!current) return { running: false };

  // Nothing runs in a container for a static preview, so there is nothing to inspect: the
  // listener answers or it does not.
  if (current.mode === "static") {
    const ready = await staticAppAnswers(current.host, current.port);
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
    };
  }

  const inspect = await dockerExec([
    "inspect",
    "-f",
    "{{.State.Running}}",
    current.containerId,
  ]);

  if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
    removePreview(projectId);
    return { running: false };
  }

  // Every status read counts as use: the panel refreshes it, the logs tab polls it and the
  // agent's project.verify/browser.* checks go through it, as does every proxied request.
  touchPreview(projectId);

  // A dev server that is still compiling has not failed: the container is the truth here,
  // and `ready` says whether the app answers yet. Dropping the state on a slow first start
  // used to lose the container and leave it running with nothing left to stop it.
  const ready = await previewAppAnswers(current);
  // Приложение отвечает внутри контейнера, но не по адресу контейнера (обычно слушает только
  // петлю, а иногда — свой порт вместо запрошенного): адрес доводится до рабочего здесь же,
  // потому что статус читают и панель, и прокси, и агент. Медленный первый старт поэтому
  // лечится сам, без перезапуска предпросмотра вручную.
  //
  // Починка запускается и когда приложение ещё не ответило на порт из состояния: оно могло подняться
  // позже и на своём порту (dev-скрипт, который не принял флаги запуска), а подтверждения у адреса
  // всё ещё нет. Раньше шаг выполнялся только при `ready`, поэтому такой предпросмотр навсегда
  // оставался с портом, на котором ничего не слушает: приложение живо, а панель показывает пустой кадр.
  const settled = await settlePreviewAddress(current.execOnly?{...current,settled:false}:current, { appAnswers: ready });
  // Отметка о выполненной проверке — вместе с её результатом: следующий полный проход — не раньше,
  // чем через execRetryMs(), иначе каждый файл приложения платил бы за него заново.
  const stamped = settled.execOnly ? { ...settled, execOnlyCheckedAt: Date.now() } : settled;
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
