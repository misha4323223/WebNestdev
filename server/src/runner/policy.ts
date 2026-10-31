import { realpath } from "node:fs/promises";
import path from "node:path";
import { sandboxHostRootDir, sandboxImage, sandboxRootDir } from "../sandbox/config.js";

/**
 * Docker is a root-level capability. The API builds the preview/job arguments, but a runner
 * must not become a generic Docker proxy: a compromised control plane (or a future bug that
 * passes user text into an argument) would otherwise be able to mount `/`, join `host`
 * networking or start a privileged container.
 *
 * The policy below accepts only the operations the preview and job code actually perform, and
 * only the hardened shape `dockerRunArgs` produces. It is intentionally strict: a new flag in
 * that file must be added here in the same change.
 */
export class RunnerPolicyError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "RunnerPolicyError";
  }
}

const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const NAME = /^wnd-[A-Za-z0-9][A-Za-z0-9_.-]{0,115}$/;
const LABEL_KEY = /^webnestdev\.[A-Za-z0-9_.-]{1,100}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

function reject(message: string): never {
  throw new RunnerPolicyError(message);
}

function assertContainer(value: string) {
  if (!CONTAINER_ID.test(value)) reject("Недопустимый идентификатор контейнера");
  return value;
}

function isPreviewNetwork(value: string) {
  const configured = (process.env.RUNNER_PREVIEW_NETWORK ?? process.env.PREVIEW_NETWORK ?? "").trim();
  if (configured) return value === configured;
  return /preview/i.test(value);
}

function assertNetwork(value: string) {
  if (value === "host" || value.startsWith("container:")) reject("Сеть host/container на runner запрещена");
  // `none` is the job network; `bridge` has no platform service and is harmless. Everything
  // else must be the preview network: a compromised control plane must not put project code
  // into the database/API network through a hand-built `docker run`.
  if (value === "none" || value === "bridge") return value;
  if (!NETWORK.test(value)) reject("Недопустимое имя Docker-сети");
  if (!isPreviewNetwork(value)) reject("Разрешены только сети none, bridge и предпросмотра");
  return value;
}

function assertPreviewNetwork(value: string) {
  if (value === "host" || value === "none" || value === "bridge" || value.startsWith("container:")) {
    reject("Сеть предпросмотра не может быть host, none, bridge или container");
  }
  if (!NETWORK.test(value)) reject("Недопустимое имя Docker-сети");
  if (!isPreviewNetwork(value)) reject("Разрешена только сеть предпросмотра");
  return value;
}

function assertInsideSharedWorkspace(source: string) {
  if (!path.isAbsolute(source)) reject("Источник монтирования должен быть абсолютным путём");
  const roots = [...new Set([sandboxRootDir(), sandboxHostRootDir()].map(value => path.resolve(value)))];
  const resolved = path.resolve(source);
  if (!roots.some(root => resolved === root || resolved.startsWith(root + path.sep))) {
    reject("Монтировать можно только каталог своего проекта");
  }
}

async function assertMount(value: string) {
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) reject("Некорректное описание монтирования");
  const [source, target, mode] = parts;
  assertInsideSharedWorkspace(source);
  if (target !== "/workspace" && !target.startsWith("/workspace/")) {
    reject("Монтирование разрешено только внутрь /workspace");
  }
  if (target.includes("/../") || target.endsWith("/..")) reject("Выход из /workspace запрещён");
  if (mode !== undefined && mode !== "ro" && mode !== "rw") reject("Режим монтирования должен быть ro или rw");

  // Docker resolves the source on the host. A symlink inside the project could otherwise turn
  // a harmless `-v ./project:/workspace` into `/etc`, so check the final path, not only its
  // lexical prefix.
  try {
    const real = await realpath(source);
    const roots = [...new Set([sandboxRootDir(), sandboxHostRootDir()].map(item => path.resolve(item)))];
    if (!roots.some(root => real === root || real.startsWith(root + path.sep))) {
      reject("Символическая ссылка ведёт за пределы каталога песочниц");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A missing mask source is a normal not-yet-created file only for a read-only mount. The
      // hardened path is created by the API before the command; refusing is safer than letting
      // Docker create an empty directory in its place.
      reject("Источник монтирования недоступен: " + (error instanceof Error ? error.message : String(error)));
    }
  }
}

function splitFlag(arg: string): { name: string; value?: string } {
  if (!arg.startsWith("--")) return { name: arg };
  const index = arg.indexOf("=");
  return index < 0 ? { name: arg } : { name: arg.slice(0, index), value: arg.slice(index + 1) };
}

function assertRun(args: string[]) {
  const seen = new Set<string>();
  const mounts: string[] = [];
  let imageIndex = -1;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") reject("Разделитель -- в docker run запрещён");
    const flag = splitFlag(arg);
    if (flag.name === "-d" || flag.name === "--init" || flag.name === "--rm" || flag.name === "--read-only") {
      // `--read-only=false` / `--init=false` would otherwise mark the flag as seen while
      // disabling the hardening it stands for.
      if (flag.value !== undefined) reject("Флаг " + flag.name + " не принимает значение на runner");
      seen.add(flag.name);
      continue;
    }
    if (!flag.name.startsWith("-")) {
      imageIndex = index;
      break;
    }
    const value = flag.value ?? args[++index];
    if (value === undefined) reject("У флага " + flag.name + " нет значения");
    seen.add(flag.name);
    switch (flag.name) {
      case "--name":
        if (!NAME.test(value)) reject("Имя контейнера должно начинаться с wnd-");
        break;
      case "--label": {
        const separator = value.indexOf("=");
        if (separator <= 0) reject("Метка должна иметь вид key=value");
        const key = value.slice(0, separator);
        if (!LABEL_KEY.test(key)) reject("Разрешены только метки webnestdev.*");
        break;
      }
      case "--network":
        assertNetwork(value);
        break;
      case "--cap-drop":
        if (value !== "ALL") reject("Разрешён только --cap-drop ALL");
        break;
      case "--security-opt":
        if (value !== "no-new-privileges:true") reject("Разрешён только no-new-privileges:true");
        break;
      case "--cpus": {
        const cpus = Number(value);
        if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 16) reject("Недопустимый лимит CPU");
        break;
      }
      case "--memory":
        if (!/^[1-9][0-9]{0,5}[mMgG]$/.test(value)) reject("Недопустимый лимит памяти");
        break;
      case "--pids-limit": {
        const pids = Number(value);
        if (!Number.isInteger(pids) || pids < 16 || pids > 4_096) reject("Недопустимый лимит процессов");
        break;
      }
      case "--tmpfs":
        if (!/^\/tmp:rw,nosuid(?:,size=[1-9][0-9]{0,4}[mMgG]?)?$/.test(value)) {
          reject("Разрешён только tmpfs /tmp с nosuid");
        }
        break;
      case "--user":
        if (value !== "1000:1000") reject("Контейнер должен работать от uid 1000:1000");
        break;
      case "--runtime":
        if (value !== "runsc") reject("Разрешён только runtime runsc");
        break;
      case "-v":
      case "--volume":
        mounts.push(value);
        break;
      case "-w":
      case "--workdir":
        if (value !== "/workspace" && !value.startsWith("/workspace/")) {
          reject("Рабочий каталог должен быть внутри /workspace");
        }
        break;
      case "-e":
      case "--env": {
        const separator = value.indexOf("=");
        const key = separator < 0 ? value : value.slice(0, separator);
        if (!ENV_KEY.test(key)) reject("Недопустимое имя переменной окружения");
        break;
      }
      default:
        reject("Флаг " + flag.name + " не разрешён на runner");
    }
  }

  if (imageIndex < 0) reject("В docker run не найден образ");
  const image = args[imageIndex];
  if (image !== sandboxImage()) reject("Образ не совпадает с образом песочницы runner");
  if (!seen.has("--read-only")) reject("docker run должен быть с --read-only");
  if (!seen.has("--init")) reject("docker run должен быть с --init");
  const required = new Set(["--cap-drop", "--security-opt", "--user", "--cpus", "--memory", "--pids-limit", "--tmpfs"]);
  for (const flag of required) {
    if (!seen.has(flag)) reject("docker run должен содержать " + flag);
  }
  if (!seen.has("-e") && !seen.has("--env")) {
    reject("docker run должен содержать -e HOME=/tmp");
  }

  const command = args.slice(imageIndex + 1);
  if (command[0] !== "/bin/sh" && command[0] !== "sh") reject("Команда контейнера должна запускаться через /bin/sh");
  if (command[1] !== "-lc" && command[1] !== "-c") reject("Команда контейнера должна иметь вид -lc <script>");
  if (!command[2]) reject("Пустая команда контейнера");

  return mounts;
}

export async function assertDockerArgsAllowed(args: string[]): Promise<void> {
  const head = args[0];
  if (!head) reject("Пустая команда Docker");
  if (head === "run") {
    const mounts = assertRun(args);
    for (const mount of mounts) await assertMount(mount);
    return;
  }
  if (head === "rm") {
    if (args.length < 3 || args[1] !== "-f") reject("Разрешено только docker rm -f <container>");
    for (const value of args.slice(2)) assertContainer(value);
    return;
  }
  if (head === "logs") {
    if (args.length !== 4 || args[1] !== "--tail") reject("Разрешено только docker logs --tail <n> <container>");
    if (!/^[1-9][0-9]{0,4}$/.test(args[2])) reject("Недопустимый хвост логов");
    assertContainer(args[3]);
    return;
  }
  if (head === "inspect") {
    if (args.length !== 4 || (args[1] !== "-f" && args[1] !== "--format")) {
      reject("Разрешено только docker inspect -f <template> <container>");
    }
    if (args[2].length > 4_000) reject("Шаблон inspect слишком длинный");
    assertContainer(args[3]);
    return;
  }
  if (head === "ps") {
    if (args.length !== 4 || args[1] !== "-aq" || args[2] !== "--filter" ||
        !/^label=webnestdev\.[A-Za-z0-9_.=-]+$/.test(args[3])) {
      reject("Разрешён только docker ps -aq --filter label=webnestdev.*");
    }
    return;
  }
  if (head === "network") {
    if (args[1] === "ls" && args.length === 4 && args[2] === "--format" && args[3] === "{{.Name}}") return;
    if (args[1] === "inspect" && args.length === 5 && (args[2] === "-f" || args[2] === "--format")) {
      if (args[3].length > 4_000) reject("Шаблон inspect сети слишком длинный");
      assertPreviewNetwork(args[4]);
      return;
    }
    if (args[1] === "connect" && args.length === 4) {
      assertPreviewNetwork(args[2]);
      assertContainer(args[3]);
      return;
    }
    reject("Операция docker network не разрешена на runner");
  }
  if (head === "exec") {
    let index = 1;
    if (args[index] === "-d") index++;
    const container = args[index++];
    if (!container) reject("В docker exec не указан контейнер");
    assertContainer(container);
    const tool = args[index++];
    if (tool !== "node" && tool !== "sh") reject("В контейнере разрешены только node и sh");
    const flag = args[index++];
    if (flag !== "-e" && flag !== "-c" && flag !== "-lc") reject("Разрешён только запуск node -e или sh -c");
    if (!args[index]) reject("Пустой скрипт docker exec");
    if (args.length !== index + 1) reject("Лишние аргументы docker exec");
    return;
  }
  if (head === "version" && (args.length === 1 || (args.length === 3 && args[1] === "--format"))) return;
  reject("Операция docker " + head + " не разрешена на runner");
}

/** Validate only the mounts before a command; `runDockerSandbox` adds the rest of the flags. */
export async function assertExtraMountsAllowed(mounts: string[] | undefined): Promise<void> {
  for (const mount of mounts ?? []) await assertMount(mount);
}
