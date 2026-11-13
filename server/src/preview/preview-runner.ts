import type { SandboxConfig } from "../sandbox-manager.js";
import { sandboxImage, sandboxRuntime, sandboxRuntimeArgs, workspaceMountSource } from "../sandbox/config.js";
import { previewAppAnswers } from "./app-http.js";
import { dockerExec, missingContainer } from "./docker-exec.js";
import { addressOnNetworks, firstContainerAddress, previewNetworks } from "./preview-network.js";
import { settlePreviewAddress } from "./preview-address.js";
import { previewDepsForHost } from "./node-deps.js";
import { previewOwnerAddressForNode } from "./preview-owner.js";
import { resolveSandboxHost } from "../sandbox/host.js";
import { nodeId } from "../nodes/identity.js";
import { resolvePreviewCommand } from "./preview-command.js";
import { ensureProjectDependencies } from "./dependencies.js";
import { flushPreviewWrites, removePreview, setPreview } from "./preview-store.js";
import { PREVIEW_APP_PORT, PREVIEW_KIND_LABEL, PREVIEW_LABEL, type PreviewState } from "./types.js";
import { previewSecretMounts } from "../secrets/preview-secrets.js";
import { egressProxyEnv } from "../egress/config.js";
import { setPreviewStartProgress } from "./preview-start-progress.js";
import { dependencyCacheEnabled, dependencyCacheMountArgs, ensureDependencyCache } from "./dependency-cache.js";

const READY_ATTEMPTS=30;
const READY_DELAY_MS=500;

/**
 * Watcher environment for the preview container. Under runsc, changes made on the host side of the
 * bind mount produce no inotify event inside the container (gVisor), so Vite must poll; under runc
 * the native watcher is cheaper and stays enabled.
 */
export function previewWatchEnv(runtime: ReturnType<typeof sandboxRuntime> = sandboxRuntime()) {
  return runtime === "runsc" ? ["CHOKIDAR_USEPOLLING=1", "CHOKIDAR_INTERVAL=300"] : [];
}

export type StartPreviewProcessOptions = {
  /** Explicit shell command for the runtime process. */
  command: string;
  /** Hybrid adds a label and passes PORT/HOST; container keeps its existing dev flags. */
  mode: "container" | "hybrid";
  /** Expected application port inside the container. */
  port?: number;
  /** Save the intermediate container state and flush it to the shared registry. */
  persistState: boolean;
  /** Install dependencies before docker run. Hybrid usually does this before its build. */
  ensureDependencies: boolean;
  /** Non-secret environment values for hybrid backend. */
  env?: Record<string, string>;
};

export type StartedPreviewProcess = {
  containerId: string;
  host: string;
  port: number;
  containerPort?: number;
  ready: boolean;
  /** Container-shaped state used for settlement; callers map the fields they need. */
  state: PreviewState;
  logs?: string;
};

/**
 * Docker arguments for the runtime process. Kept pure and exported so the hybrid/container
 * contract can be checked without a Docker daemon: the backend must get the hybrid label and
 * PORT/HOST without the dev-server flags, while a container keeps its old command shape.
 */
export function previewProcessArgs(input: {
  config: SandboxConfig;
  options: StartPreviewProcessOptions;
  image: string;
  network: string;
  secretMounts: string[];
}): string[] {
  const { config, options, image, network, secretMounts } = input;
  const appPort = options.port ?? PREVIEW_APP_PORT;
  const backendEnv = options.mode === "hybrid" ? options.env ?? {} : {};
  return [
    "run", "-d", "--init",
    // Предпросмотр — тоже код проекта. Рантайм тот же, что у команд агента: выключатель
    // SANDBOX_RUNTIME=docker возвращает обычный Docker и для предпросмотра.
    ...sandboxRuntimeArgs(),
    "--cpus", String(config.cpuLimit),
    "--memory", String(config.memoryMb) + "m",
    "--pids-limit", "128",
    // Предпросмотр — тоже пользовательский код: capabilities и setuid ему не нужны, а
    // отсутствие обоих флагов делало контейнер более мягкой целью, чем контейнер команд.
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,size=256m",
    "--user", "1000:1000",
    ...(network ? ["--network", network] : []),
    // The label is how a restarted server finds previews it no longer knows about.
    "--label", PREVIEW_LABEL + "=" + config.projectId,
    ...(options.mode === "hybrid" ? ["--label", PREVIEW_KIND_LABEL + "=hybrid"] : []),
    // Путь хоста, а не сервера: docker разбирает его до контейнера (см. sandbox/config.ts).
    "-v", workspaceMountSource(config) + ":/workspace",
    // Локальный `node_modules` ноды: установка и dev-сервер не пишут дерево пакетов в Gluster.
    ...dependencyCacheMountArgs(config),
    ...secretMounts,
    "-w", "/workspace",
    "-e", "HOME=/tmp",
    "-e", "CI=1",
    // The backend gets the same port contract as the dev server, but without the dev flags:
    // its script decides how to listen from PORT/HOST.
    ...(options.mode === "hybrid"
      ? [
        // Project-provided values first; PORT/HOST are the platform's contract and are not
        // duplicated if a project tries to redefine them in preview.backendEnv.
        ...Object.entries(backendEnv)
          .filter(([key]) => key !== "PORT" && key !== "HOST")
          .flatMap(([key, value]) => ["-e", key + "=" + value]),
        "-e", "PORT=" + appPort,
        "-e", "HOST=0.0.0.0",
      ]
      : []),
    // Egress-прокси (пункт 5.1): предпросмотр — тоже чужой код, запущенный у нас. Переменные
    // задаёт сервер, а не проект: `.env` приложения не должен переопределять путь наружу.
    // Без сети (network пуст) их не передаём: контейнер окажется в bridge, а прокси там нет.
    ...(network ? Object.entries(egressProxyEnv()).flatMap(([key, value]) => ["-e", key + "=" + value]) : []),
    // gVisor не пробрасывает inotify-события bind-mount'а из хоста в контейнер: Vite видел
    // изменения файлов только при старте и продолжал отдавать старый модуль, поэтому HMR
    // молчал. Polling читает stat самого файла и работает с любым mount; для runc оставляем
    // нативный watcher, чтобы не платить обходом дерева на каждом проекте.
    ...previewWatchEnv().flatMap(value => ["-e", value]),
    image, "/bin/sh", "-lc", options.command,
  ];
}

/**
 * Shared runtime launch for container preview and the backend of a hybrid preview. The two
 * modes use the same image, network, resource limits and address settlement; only the command,
 * labels and the state they persist differ. Keeping one path means a backend cannot quietly
 * get weaker isolation than a dev-server container.
 */
export async function startPreviewProcess(config: SandboxConfig, options: StartPreviewProcessOptions): Promise<StartedPreviewProcess> {
  // A project created by the agent has no `node_modules`; without this the command fails on a
  // missing binary. Hybrid runs this before its build as well, but the second call is cheap.
  const dependencies = options.ensureDependencies
    ? await ensureProjectDependencies(config)
    : { ok: true as const, installed: false, log: "" };
  if (!dependencies.ok) throw new Error(dependencies.reason);
  setPreviewStartProgress(
    config.projectId,
    "starting",
    options.mode === "hybrid" ? "Запускаем backend…" : "Запускаем контейнер предпросмотра…",
  );
  const image = sandboxImage();
  // The preview belongs to the project's node. Resolve it before any Docker call: a missing
  // runner must be a clear error, not a container silently started on the API machine.
  const host = await resolveSandboxHost(config.node || nodeId());
  if (dependencyCacheEnabled()) await ensureDependencyCache(host, config.projectId);
  const docker = (args: string[], timeoutMs?: number) => host.docker(args, timeoutMs);
  const networks = host.networks ? await host.networks() : await previewNetworks(docker);
  const network = networks.preview;
  // Секреты приходят из зашифрованного хранилища как read-only файлы поверх `/workspace`.
  // В рабочей области их нет: агент и файловый API не видят ни значения, ни файла.
  const secrets = await previewSecretMounts(config);
  let result;
  try {
    result = await docker(previewProcessArgs({
      config,
      options,
      image,
      network,
      secretMounts: secrets.mounts,
    }),
    // На загруженном хосте старт контейнера вместе с созданием слоя может занять больше 15 с:
    // рядом идёт npm install или сборка другого проекта. Предел больше только у этого шага;
    // inspect и logs остаются короткими, чтобы зависший демон не держал панель.
    60_000);
  } catch (error) {
    await secrets.cleanup();
    throw error;
  }
  const appPort = options.port ?? PREVIEW_APP_PORT;
  if (result.code !== 0) {
    await secrets.cleanup();
    throw new Error(result.stderr || "Не удалось запустить контейнер предпросмотра");
  }
  const containerId = result.stdout.trim();
  // Адрес берётся именно на той сети, куда контейнер поставлен: у контейнера может быть несколько
  // интерфейсов, и адрес не с той сети серверу недоступен (см. preview-network.ts).
  const containerAddress = (network ? await addressOnNetworks(containerId, [network], docker) : "") || await firstContainerAddress(containerId, docker);
  if (!containerAddress) {
    await removePreviewContainer(containerId, config.node);
    await secrets.cleanup();
    throw new Error("Адрес контейнера предпросмотра не назначен");
  }
  const now = Date.now();
  // The door of the container's node can serve a preview after an API move; hybrid overwrites
  // this with the API process's own door because its listener lives there.
  const ownerAddress = await previewOwnerAddressForNode(config.node);
  setPreviewStartProgress(
    config.projectId,
    "waiting",
    options.mode === "hybrid" ? "Ждём ответа backend…" : "Ждём ответа приложения…",
  );
  const state: PreviewState = {
    mode: "container",
    containerId,
    projectId: config.projectId,
    ownerUserId: config.userId,
    node: config.node,
    host: containerAddress,
    port: appPort,
    startedAt: now,
    lastUsedAt: now,
    ...(ownerAddress ? { ownerAddress } : {}),
  };
  if (options.persistState) {
    setPreview(state);
    // Строка должна быть в общем реестре уже сейчас, а не только после проверки готовности.
    // Если ожидание ответа приложения будет прервано, следующая реплика всё равно увидит
    // контейнер и сможет отдать его статус и логи вместо вечной брони.
    await flushPreviewWrites(config.projectId);
  }
  let ready: boolean;
  let settled: PreviewState;
  try {
    ready = await waitForApp(state, docker);
    // Приложение решает, где слушать: оно могло не принять флаги запуска (тогда порт берётся из
    // /proc/net/tcp) или слушать только петлю контейнера (тогда поднимается проброс), иначе
    // предпросмотр выглядел бы работающим, а панель, агент и Chromium не доходили до него.
    settled = await settlePreviewAddress(state, { deps: previewDepsForHost(host), appAnswers: ready });
  } catch (error) {
    // Неудачный запуск не должен оставлять ни открытый env-файл на хосте, ни контейнер: без `--rm`
    // он остался бы остановленным и занимал место до следующей уборки. Строку общего реестра
    // тоже убираем: иначе вторая реплика до TTL считала бы упавший preview живым.
    await removePreviewContainer(containerId, config.node);
    if (options.persistState) removePreview(config.projectId);
    await secrets.cleanup();
    throw error;
  }
  if (options.persistState) {
    // Вместе с адресом сохраняется ответ проверки готовности и её время: панель читает статус на
    // каждый файл приложения, и первый же её запрос не должен заново ждать полную проверку
    // (см. preview-manager.ts, addressRetryMs).
    setPreview({ ...settled, ready, checkedAt: Date.now() });
  }
  // A dev server that has not answered yet is not a failure: npm may still be installing
  // or Vite may still be compiling. The state stays, the diagnostics come along, and the
  // next status check turns ready into the real answer.
  // Лог установки — единственное место, где видно, почему первый запуск занял минуту, а также
  // причина отказа, если dev-сервер так и не ответил.
  return {
    containerId,
    host: settled.host,
    port: settled.port,
    ...(settled.containerPort !== undefined ? { containerPort: settled.containerPort } : {}),
    ready,
    state: settled,
    ...(ready ? {} : { logs: [dependencies.log, await recentPreviewLogs(containerId, docker)].filter(Boolean).join("\n\n") }),
  };
}

export async function startPreviewContainer(config: SandboxConfig) {
  const command = await resolvePreviewCommand(config);
  const started = await startPreviewProcess(config, {
    command,
    mode: "container",
    persistState: true,
    ensureDependencies: true,
  });
  return {
    ...started.state,
    running: true as const,
    ready: started.ready,
    ...(started.ready ? {} : { logs: started.logs }),
  };
}

/**
 * Bounded wait: the dev server answers in a second or two, a cold npm install takes longer.
 */
async function waitForApp(state: PreviewState, docker: typeof dockerExec = dockerExec) {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    // Код выхода читается вместе с признаком работы: упавший процесс объясняет отказ точнее, чем
    // отсутствие ответа на порту.
    const inspect = await docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", state.containerId]);
    const [isRunning, exitCode] = inspect.stdout.trim().split(/\s+/);
    if (inspect.code !== 0) {
      if (missingContainer(inspect)) throw new Error(containerVanishedMessage(state.containerId));
      throw new Error(inspect.stderr.trim() || "Не удалось проверить контейнер предпросмотра");
    }
    if (isRunning !== "true") {
      // Причина отказа — это вывод самого dev-сервера: без `--rm` контейнер остаётся, и `docker logs`
      // возвращает текст настоящей ошибки (не установлены зависимости, занят порт, синтаксис).
      const logs = await recentPreviewLogs(state.containerId, docker);
      if (logs) throw new Error(logs);
      throw new Error("Процесс предпросмотра завершился при запуске" + (exitCode && exitCode !== "0" ? " (код выхода " + exitCode + ")" : "") + ": вывода нет, проверьте команду запуска в package.json.");
    }
    if (await previewAppAnswers(state, docker)) return true;
    await new Promise(resolve => setTimeout(resolve, READY_DELAY_MS));
  }
  return false;
}

/**
 * Сообщение вместо английского ответа Docker. Контейнер без `--rm` так исчезнуть не может сам, значит
 * его убрали извне (уборка на хосте, `docker system prune`, перенос на другую машину).
 */
export function containerVanishedMessage(containerId: string) {
  return "Контейнер предпросмотра исчез во время запуска: Docker больше не знает контейнер " + containerId.slice(0, 12) +
    ". Запустите предпросмотр ещё раз — если это повторяется, проверьте на хосте `docker events` и свободное место на диске.";
}

/**
 * Вывод контейнера вместе с ответом «контейнера уже нет»: вызывающий по нему снимает состояние
 * предпросмотра, а не показывает пользователю текст ошибки Docker.
 */
export async function previewLogsOf(containerId: string, docker: typeof dockerExec = dockerExec): Promise<{ logs: string; missing: boolean }> {
  const result = await docker(["logs", "--tail", "120", containerId]);
  if (missingContainer(result)) return { logs: "", missing: true };
  const logs = [result.stdout, result.stderr].map(value => value.replace(/\r/g, "").trim()).filter(Boolean).join("\n");
  return { logs, missing: false };
}

export async function recentPreviewLogs(containerId: string, docker: typeof dockerExec = dockerExec) {
  return (await previewLogsOf(containerId, docker)).logs;
}

/**
 * Убирает контейнер предпросмотра с хоста. Ответ не проверяется: контейнера могло уже не быть, а
 * остановка предпросмотра не должна из-за этого падать.
 */
export async function removePreviewContainer(containerId: string, node?: string) {
  let run: (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  if (node) {
    try {
      const host = await resolveSandboxHost(node);
      run = (args, timeoutMs) => host.docker(args, timeoutMs);
    } catch { return false }
  } else run = dockerExec;
  const result = await run(["rm", "-f", containerId]).catch(() => null);
  return Boolean(result && result.code === 0);
}
