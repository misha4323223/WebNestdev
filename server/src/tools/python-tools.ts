import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { getSandbox } from "../sandbox-manager.js";
import { resolveInsideSandbox } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";
import { buildPipInstallCommand } from "./python-command.js";

/**
 * Python-зависимости проекта — исключение из правила «в песочнице нет сети», такое же, как
 * `npm.install`: контейнер получает сеть только на время установки, а результат остаётся в
 * проекте. Пакеты ставятся в `.python` рядом с проектом, а не в системный Python: контейнер
 * работает от uid 1000, системный site-packages ему недоступен, и образ может быть read-only.
 *
 * Агент запускает код с `PYTHONPATH=.python` — это написано в описании инструмента, потому что
 * без переменной установленные пакеты не видны, а ошибка выглядит как «пакет не установился».
 */

const MAX_PACKAGES = 30;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+!-]*(?:\[[A-Za-z0-9,._-]+\])?(?:[<>=!~]=?[A-Za-z0-9.*+!,-]+)?(?:@[A-Za-z0-9._:/-]+)?$/;
const DEFAULT_TIMEOUT_MS = 300_000;

const schema = z.object({
  cwd: z.string().max(300).optional(),
  packages: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_PACKAGES).optional(),
  upgrade: z.boolean().optional(),
});

function installTimeoutMs() {
  const configured = Number(process.env.PIP_INSTALL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 30_000
    ? Math.min(600_000, Math.round(configured))
    : DEFAULT_TIMEOUT_MS;
}

/** Понятная причина вместо голого лога pip: образ, права и отсутствие requirements. */
function explainFailure(result: { stdout: string; stderr: string }, hasRequirements: boolean) {
  const text = result.stdout + "\n" + result.stderr;
  if (/No module named pip|pip: not found|python3: not found|executable file not found/i.test(text)) {
    return (
      "В образе песочницы нет Python/pip. Установите python3 и pip в образ проекта (Dockerfile) " +
      "или не ставьте Python-зависимости: платформа не может добавить системный Python в чужой контейнер."
    );
  }
  if (/externally-managed-environment/i.test(text)) {
    return "Системный Python защищён PEP 668: повторная попытка выполняется с --break-system-packages и --target .python.";
  }
  if (/Read-only file system|Permission denied|EACCES/i.test(text)) {
    return "Запись в каталог проекта запрещена: проверьте, что .python создаётся внутри проекта, а не в системном каталоге.";
  }
  if (/Could not find a version|No matching distribution|ERROR: No matching/i.test(text)) {
    return "Пакет не найден в индексе или несовместим с версией Python в образе. Проверьте имя и версию пакета.";
  }
  if (!hasRequirements && /requirements\.txt/i.test(text)) {
    return "В каталоге нет requirements.txt: передайте packages списком или создайте файл зависимостей.";
  }
  return undefined;
}

registerTool({
  name: "pip.install",
  description:
    "Install Python dependencies for the project with pip, with outbound network enabled for this one command. " +
    "Input: {cwd?:string, packages?:string[], upgrade?:boolean}. Without packages it installs from requirements.txt in cwd. " +
    "Packages go into .python inside the project (pip --target), because the container has no writable system Python: " +
    "run Python code with PYTHONPATH=.python (for example `PYTHONPATH=.python python3 app.py`). " +
    "Use it when requirements.txt exists or the task needs a Python library; do not use terminal.exec for pip install, it has no network. " +
    "System packages (apt apk yum) cannot be installed in the container at all — they need a custom image, so do not promise them to the user. " +
    "The exit code and the tail of the output are returned; a failed install is not retried automatically.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string", description: "Project directory with requirements.txt; default project root." },
      packages: {
        type: "array",
        maxItems: MAX_PACKAGES,
        items: { type: "string" },
        description: "Package specs, e.g. [\"requests==2.32.3\", \"pandas\"]. Omit to install requirements.txt.",
      },
      upgrade: { type: "boolean", description: "Pass --upgrade to pip." },
    },
  },
  execute: async (input, context) => {
    const parsed = schema.parse(input ?? {});
    const packages = parsed.packages ?? [];
    for (const name of packages) {
      if (!PACKAGE_NAME.test(name) || name.startsWith("-")) {
        throw new Error("Некорректное имя пакета: " + name.slice(0, 80) + ". Передайте имя и версию, например requests==2.32.3");
      }
    }

    const sandbox = await getSandbox(context.projectId, context.userId);
    const cwd = await resolveInsideSandbox(sandbox.root, sandbox.root + "/" + (parsed.cwd ?? ""));
    const hasRequirements = await lstat(path.join(cwd, "requirements.txt"))
      .then(info => info.isFile())
      .catch(() => false);
    if (!packages.length && !hasRequirements) {
      throw new Error(
        "В каталоге " +
          (parsed.cwd || ".") +
          " нет requirements.txt. Передайте packages списком (например, [\"requests\"]) или создайте requirements.txt.",
      );
    }

    const pipCommand = (extraFlags: string[] = []) =>
      buildPipInstallCommand({ packages, ...(parsed.upgrade ? { upgrade: true } : {}), extraFlags });
    const command = pipCommand();

    let result = await runInSandbox(sandbox, command, cwd, {
      network: "bridge",
      signal: context.signal,
      maskSecretEnvFiles: true,
      timeoutMs: installTimeoutMs(),
    });
    let bootstrapped = false;
    // В образе может быть Python без pip (так бывает у slim-образов и у node:*-bookworm).
    // ensurepip берёт pip из комплекта Python и не требует сети; после него повторяем установку.
    if (result.exitCode !== 0 && /No module named pip/i.test(result.stdout + result.stderr)) {
      const bootstrap = await runInSandbox(sandbox, "python3 -m ensurepip --user", cwd, {
        signal: context.signal,
        maskSecretEnvFiles: true,
        timeoutMs: 60_000,
      });
      if (bootstrap.exitCode === 0) {
        bootstrapped = true;
        result = await runInSandbox(sandbox, command, cwd, {
          network: "bridge",
          signal: context.signal,
          maskSecretEnvFiles: true,
          timeoutMs: installTimeoutMs(),
        });
      }
    }
    // PEP 668 встречается в образах с системным Python; повтор с флагом — единственный способ
    // поставить пакет в .python, не меняя образ. Повторяем только на этой конкретной ошибке.
    if (result.exitCode !== 0 && /externally-managed-environment/i.test(result.stdout + result.stderr)) {
      result = await runInSandbox(sandbox, pipCommand(["--break-system-packages"]), cwd, {
        network: "bridge",
        signal: context.signal,
        maskSecretEnvFiles: true,
        timeoutMs: installTimeoutMs(),
      });
    }

    const hint = result.exitCode === 0 ? undefined : explainFailure(result, hasRequirements);
    return {
      ...result,
      target: ".python",
      packages: packages.length ? packages : ["requirements.txt"],
      ...(bootstrapped ? { bootstrap: "pip установлен через python3 -m ensurepip --user" } : {}),
      ...(result.exitCode === 0
        ? { note: "Пакеты установлены в .python. Запускайте Python с PYTHONPATH=.python, иначе интерпретатор их не увидит." }
        : hint
          ? { hint }
          : {}),
    };
  },
});
