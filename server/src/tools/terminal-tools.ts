import { getSandbox } from "../sandbox-manager.js";
import { resolveInsideSandbox } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";
import { listSandboxJobs, startSandboxJob, stopSandboxJob, tailSandboxJob } from "../sandbox/jobs.js";
import { commandNeedsNetwork, isPackageInstall, networkHint, networkHintForLogs, NO_NETWORK_HINT, PACKAGE_INSTALL_HINT } from "../sandbox/network-hint.js";
import { registerTool } from "../tool-registry.js";

/**
 * Контейнерных команд в песочнице нет: проект уже выполняется в контейнере платформы, а `docker`
 * внутри него не установлен. Команда только зря занимает слот контейнера и шаг агента, поэтому
 * отказ отдаётся сразу и с объяснением, что использовать вместо неё.
 */
const CONTAINER_COMMANDS=new Set(["docker","docker-compose","podman","nerdctl","buildah"]);
/**
 * Системные пакеты в контейнер проекта не ставятся: он работает от uid 1000, корень файловой
 * системы read-only, а установленное исчезнет вместе с контейнером. Отказ сразу с причиной дешевле
 * пяти минут ожидания и повторных попыток агента.
 */
const SYSTEM_PACKAGE_COMMANDS=new Set(["apt","apt-get","aptitude","apk","yum","dnf","pacman","zypper"]);
/** Долгая команда в одном шаге: от секунды до получаса. */
const MAX_COMMAND_TIMEOUT_MS=30*60_000;

function commandTokens(command:string){
  // `sudo apt install` — тот же apt, только заведомо без root; отказ должен это узнавать.
  const tokens=command.trim().split(/\s+/);
  while(tokens.length&&/^(sudo|env|command|time|nice)$/.test(tokens[0])) tokens.shift();
  return tokens;
}

function commandHead(command:string){
  const tokens=commandTokens(command);
  return (tokens[0]??"").replace(/^.*\//,"");
}

/**
 * Произвольный клон остаётся запрещён: репозиторий подключается через панель, и токен выдаёт
 * платформа. Без сети `git clone` всё равно не сработает, но отказ должен назвать правильный путь,
 * а не оставить агента ждать таймаут.
 */
function gitCloneRefusal(command:string){
  const tokens=commandTokens(command);
  if(tokens[0]?.replace(/^.*\//,"")!=="git")return null;
  if(!tokens.slice(1,4).includes("clone"))return null;
  return {
    ok:false as const,
    exitCode:1,
    signal:null,
    stdout:"",
    stderr:"Произвольный git clone в песочнице запрещён: подключите репозиторий через панель (GitHub, GitLab, GitVerse и другие поддерживаемые сервисы), и платформа склонирует его сама с нужным токеном. Клонировать чужой URL вручную нельзя — это правило платформы, а не ошибка проекта. Уже подключённый репозиторий обновляется инструментом git.pull.",
    truncated:false as const,
  };
}

export function containerCommandRefusal(command:string):{ok:false;exitCode:number;signal:null;stdout:string;stderr:string;truncated:false}|null{
  const first=commandHead(command);
  const clone=gitCloneRefusal(command);
  if(clone)return clone;
  if(SYSTEM_PACKAGE_COMMANDS.has(first)){
    return {
      ok:false,
      exitCode:127,
      signal:null,
      stdout:"",
      stderr:"Системные пакеты (apt/apk/yum) в песочнице не устанавливаются: контейнер работает от uid 1000, корень файловой системы только для чтения, и установленное исчезнет вместе с контейнером. Это ограничение образа, а не проекта. Python-зависимости ставятся в проект через pip.install (в .python), Node-зависимости — через npm.install. Если нужен системный пакет (например, libpq или ffmpeg), его добавляют в Dockerfile образа платформы — скажите об этом пользователю, а не имитируйте установку.",
      truncated:false,
    };
  }
  if(!CONTAINER_COMMANDS.has(first))return null;
  return {
    ok:false,
    exitCode:127,
    signal:null,
    stdout:"",
    stderr:"Docker в песочнице проекта недоступен: терминал агента выполняется внутри контейнера платформы, и docker/docker-compose там нет. Не запускайте контейнеры: предпросмотр платформа поднимает сама (preview.start), проверять нужно через project.verify и browser.runtime. Файл Dockerfile можно создавать и править как часть проекта, но собирать его не нужно.",
    truncated:false,
  };
}

registerTool({
  name: "terminal.exec",
  description:
    "Execute a development command in the project's sandbox and wait for it. Input: {command:string,cwd?:string,timeoutMs?:number}. " +
    "Outbound network is OFF: package installation and downloads (`npm install`, `npx`, `curl`, `git fetch`) fail or wait until the timeout — that is the sandbox, not a project defect; install Node dependencies with npm.install, Python dependencies with pip.install, call an external API with net.request, download a file into the project with net.download, and start the app with preview.start. " +
    "Docker and docker-compose are not available and are refused: the platform serves the Preview itself. System packages (apt/apk/yum) are refused too: they need a custom image. " +
    "Expo/EAS commands also need the network and the Expo token: do not run `npx eas` here — use expo.status/expo.setup/expo.build/expo.build_status. " +
    "timeoutMs extends the default limit up to 30 minutes for a build or a test suite, but the step still waits for the command: for anything that may run longer than a few minutes, start it with terminal.start and read its output with terminal.tail instead.",
  parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", description: "Одна команда оболочки, например `npm run build`" }, cwd: { type: "string", description: "Рабочий каталог внутри проекта; по умолчанию корень проекта" }, timeoutMs: { type: "number", description: "Предел выполнения в миллисекундах, от 1000 до 1800000; по умолчанию лимит песочницы" } } },
  execute: async (input, context) => {
    const value = input as { command?: string; cwd?: string; timeoutMs?: number };
    const command = value.command?.trim();
    if (!command) throw new Error("не указана команда");

    const refusal = containerCommandRefusal(command);
    if (refusal) return refusal;

    const requestedTimeout = typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
      ? Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, Math.round(value.timeoutMs)))
      : undefined;
    const sandbox = await getSandbox(context.projectId, context.userId);
    // Рабочий каталог — реальный путь: ссылка внутри проекта не должна уводить команду из него.
    const cwd = await resolveInsideSandbox(sandbox.root, sandbox.root + "/" + (value.cwd ?? ""));
    // Команда агента не должна прочитать `.env.local`: файл виден по пути, но пуст.
    let result: Awaited<ReturnType<typeof runInSandbox>>;
    try {
      result = await runInSandbox(sandbox, command, cwd, {
        signal: context.signal,
        maskSecretEnvFiles: true,
        ...(requestedTimeout === undefined ? {} : { timeoutMs: requestedTimeout }),
      });
    } catch (error) {
      // Главный симптом выключенной сети — не отказ, а исчерпанный таймаут: установка «висит».
      // Без объяснения агент повторяет её и тратит ещё один срок.
      const hint = isPackageInstall(command) ? PACKAGE_INSTALL_HINT : commandNeedsNetwork(command) ? NO_NETWORK_HINT : undefined;
      if (!hint) throw error;
      throw new Error((error instanceof Error ? error.message : String(error)) + "\n\n" + hint);
    }
    // Сеть в этом контейнере выключена. Отказ из-за неё выглядит как зависшая установка,
    // поэтому причина называется в самом результате — вместе с инструментом, которым её решают.
    const hint = networkHint(command, result);
    return hint ? { ...result, hint } : result;
  },
});

const JOB_NO_ARGUMENTS = { type: "object", additionalProperties: false, properties: {} };

registerTool({
  name: "terminal.start",
  description:
    "Start a long-running development command in the project's sandbox in the background and return a jobId immediately. Input: {command:string,cwd?:string}. " +
    "Use it for a build, a test suite or a dev task that may take many minutes, instead of blocking a step with terminal.exec. " +
    "The command runs in the same isolated container (no network, no Docker, secret env files masked) and does not survive a server restart. " +
    "There is no outbound network in a background job either: it is for builds and tests that need no downloads, while packages must be installed first with npm.install. " +
    "Read its output with terminal.tail {jobId}; stop it with terminal.stop. At most two jobs per project and four per host run at once.",
  parameters: { type: "object", additionalProperties: false, required: ["command"], properties: {
    command: { type: "string", description: "Одна команда оболочки, например `npm test`" },
    cwd: { type: "string", description: "Рабочий каталог внутри проекта; по умолчанию корень проекта" },
  } },
  execute: async (input, context) => {
    const value = (input ?? {}) as { command?: unknown; cwd?: unknown };
    const command = typeof value.command === "string" ? value.command.trim() : "";
    if (!command) throw new Error("не указана команда");
    const refusal = containerCommandRefusal(command);
    if (refusal) return refusal;
    const sandbox = await getSandbox(context.projectId, context.userId);
    const cwd = await resolveInsideSandbox(sandbox.root, sandbox.root + "/" + (typeof value.cwd === "string" ? value.cwd : ""));
    const started = await startSandboxJob(sandbox, context.userId, command, cwd, context.signal);
    // Установка в фоне не начнётся вовсе: сеть у задания та же, что у терминала. Сказать об этом
    // сразу дешевле, чем ждать пустой лог и повторять запуск.
    return isPackageInstall(command) ? { ...started, hint: PACKAGE_INSTALL_HINT } : started;
  },
});

registerTool({
  name: "terminal.tail",
  description:
    "Read the tail of a job started with terminal.start. Input: {jobId:string,lines?:number (1–400, default 120),grep?:string (case-insensitive filter)}. " +
    "Returns running/done, the exit code when finished, and the last lines of stdout+stderr. A finished job is read once: repeat it after terminal.start, not after terminal.tail.",
  parameters: { type: "object", additionalProperties: false, required: ["jobId"], properties: {
    jobId: { type: "string", description: "Идентификатор из terminal.start" },
    lines: { type: "number", description: "Сколько последних строк вернуть: от 1 до 400, по умолчанию 120" },
    grep: { type: "string", description: "Оставить только строки, содержащие это слово (без учёта регистра)" },
  } },
  execute: async (input, context) => {
    const value = (input ?? {}) as { jobId?: unknown; lines?: unknown; grep?: unknown };
    const jobId = typeof value.jobId === "string" ? value.jobId.trim() : "";
    if (!jobId) throw new Error("не указан jobId");
    await getSandbox(context.projectId, context.userId);
    const lines = typeof value.lines === "number" && Number.isFinite(value.lines) ? value.lines : 120;
    const grep = typeof value.grep === "string" ? value.grep.trim().slice(0, 200) : "";
    const tail = await tailSandboxJob(context.projectId, context.userId, jobId, lines, grep);
    // Задание выполняется без сети: если в логе видно ENOTFOUND/EAI_AGAIN, это не ошибка проекта.
    const hint = networkHintForLogs(tail.logs);
    return hint ? { ...tail, hint } : tail;
  },
});

registerTool({
  name: "terminal.stop",
  description: "Stop a job started with terminal.start and remove its container. Input: {jobId:string}.",
  parameters: { type: "object", additionalProperties: false, required: ["jobId"], properties: {
    jobId: { type: "string", description: "Идентификатор из terminal.start" },
  } },
  execute: async (input, context) => {
    const value = (input ?? {}) as { jobId?: unknown };
    const jobId = typeof value.jobId === "string" ? value.jobId.trim() : "";
    if (!jobId) throw new Error("не указан jobId");
    await getSandbox(context.projectId, context.userId);
    return stopSandboxJob(context.projectId, context.userId, jobId);
  },
});

registerTool({
  name: "terminal.jobs",
  description: "List the long-running jobs of this project that were started with terminal.start and are still registered.",
  parameters: JOB_NO_ARGUMENTS,
  execute: async (_input, context) => {
    await getSandbox(context.projectId, context.userId);
    const running = listSandboxJobs(context.projectId);
    return {
      jobs: running,
      note: running.length
        ? "Это задания текущего процесса сервера. Вывод читается через terminal.tail, остановка — terminal.stop."
        : "Долгих заданий нет. Запустить одно можно через terminal.start.",
    };
  },
});

registerTool({
  name: "npm.install",
  description: "Install the project's npm dependencies in the sandbox. This is the only tool that enables outbound network access for package installation. Input: {cwd?:string}. Use only when package.json exists. Use it whenever an `npm install` in the terminal failed or timed out with ENOTFOUND/EAI_AGAIN, and before preview.start on a project without node_modules.",
  parameters: { type: "object", additionalProperties: false, properties: { cwd: { type: "string", description: "Каталог с package.json внутри проекта; по умолчанию корень проекта" } } },
  execute: async (input, context) => {
    const value = input as { cwd?: string };
    const sandbox = await getSandbox(context.projectId, context.userId);
    const cwd = await resolveInsideSandbox(sandbox.root, sandbox.root + "/" + (value.cwd ?? ""));
    // `npm install` выполняет lifecycle-скрипты проекта; они тоже не должны видеть секреты.
    return runInSandbox(sandbox, "npm install --no-audit --no-fund", cwd, { network: "bridge", signal: context.signal, maskSecretEnvFiles: true });
  },
});
