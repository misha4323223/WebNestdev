import { getSandbox } from "../sandbox-manager.js";
import { resolveInsideSandbox } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";
import { registerTool } from "../tool-registry.js";

/**
 * Контейнерных команд в песочнице нет: проект уже выполняется в контейнере платформы, а `docker`
 * внутри него не установлен. Команда только зря занимает слот контейнера и шаг агента, поэтому
 * отказ отдаётся сразу и с объяснением, что использовать вместо неё.
 */
const CONTAINER_COMMANDS=new Set(["docker","docker-compose","podman","nerdctl","buildah"]);

export function containerCommandRefusal(command:string):{ok:false;exitCode:number;signal:null;stdout:string;stderr:string;truncated:false}|null{
  const first=command.trim().split(/\s+/)[0].replace(/^.*\//,"");
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
  description: "Execute a development command in the project's sandbox. Input: {command:string,cwd?:string}. Network is disabled by default. Docker and docker-compose are not available and are refused: the platform serves the Preview itself.",
  parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", description: "Одна команда оболочки, например `npm run build`" }, cwd: { type: "string", description: "Рабочий каталог внутри проекта; по умолчанию корень проекта" } } },
  execute: async (input, context) => {
    const value = input as { command?: string; cwd?: string };
    const command = value.command?.trim();
    if (!command) throw new Error("не указана команда");

    const refusal = containerCommandRefusal(command);
    if (refusal) return refusal;

    const sandbox = await getSandbox(context.projectId, context.userId);
    // Рабочий каталог — реальный путь: ссылка внутри проекта не должна уводить команду из него.
    const cwd = await resolveInsideSandbox(sandbox.root, sandbox.root + "/" + (value.cwd ?? ""));
    // Команда агента не должна прочитать `.env.local`: файл виден по пути, но пуст.
    return runInSandbox(sandbox, command, cwd, { signal: context.signal, maskSecretEnvFiles: true });
  },
});

registerTool({
  name: "npm.install",
  description: "Install the project's npm dependencies in the sandbox. This is the only tool that enables outbound network access for package installation. Input: {cwd?:string}. Use only when package.json exists.",
  parameters: { type: "object", additionalProperties: false, properties: { cwd: { type: "string", description: "Каталог с package.json внутри проекта; по умолчанию корень проекта" } } },
  execute: async (input, context) => {
    const value = input as { cwd?: string };
    const sandbox = await getSandbox(context.projectId, context.userId);
    const cwd = await resolveInsideSandbox(sandbox.root, sandbox.root + "/" + (value.cwd ?? ""));
    // `npm install` выполняет lifecycle-скрипты проекта; они тоже не должны видеть секреты.
    return runInSandbox(sandbox, "npm install --no-audit --no-fund", cwd, { network: "bridge", signal: context.signal, maskSecretEnvFiles: true });
  },
});
