import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { runInSandbox } from "../sandbox-worker.js";
import { pullFromGithub } from "../changes/changes-service.js";
import { GIT_AUTHOR } from "../changes/git-repo.js";
import { registerTool } from "../tool-registry.js";
import { isSecretProjectPath } from "../secrets/secret-paths.js";
import { findSecretEnvFiles } from "../sandbox/secret-mask.js";

/**
 * Отсутствие git в образе песочницы — не состояние репозитория, а ответ оболочки
 * (`/bin/sh: 1: git: not found`, код 127). Возвращать его агенту как результат `git status` значит
 * отправить его искать причину в проекте, поэтому такой ответ превращается в шаг, который можно
 * сделать: имя переменной и образ, в котором git есть.
 */
export function gitBinaryMissing(result: { ok: boolean; exitCode: number | null; stderr: string }) {
  if (result.ok) return false;
  return /git: (not found|command not found)/i.test(result.stderr)
    || (result.exitCode === 127 && /\bgit\b/i.test(result.stderr));
}

export const GIT_MISSING_MESSAGE =
  "В образе песочницы нет git: SANDBOX_IMAGE указывает на сборку без него. Задайте образ с git " +
  "(например SANDBOX_IMAGE=node:22-bookworm в docker-compose.yml) и перезапустите контейнер сервера. " +
  "История проекта при этом цела — панель «Изменения» работает с ней отдельно от контейнера.";

function assertGitAvailable<T extends { ok: boolean; exitCode: number | null; stderr: string }>(result: T): T {
  if (gitBinaryMissing(result)) throw new Error(GIT_MISSING_MESSAGE);
  return result;
}

async function git(
  context: { projectId: string; userId: string; signal?: AbortSignal },
  command: string,
  options: { maskSecretEnvFiles?: boolean } = {},
) {
  const sandbox = await getSandbox(context.projectId, context.userId);
  return assertGitAvailable(await runInSandbox(sandbox, "git " + command, sandbox.root, {
    signal: context.signal,
    ...options,
  }));
}

/**
 * `git diff` читает содержимое отслеживаемых файлов. Если `.env.local` когда-то попал в
 * репозиторий, маска рабочего файла не поможет: diff покажет старую версию из индекса. Поэтому
 * блоки diff с секретным путём выбрасываются из вывода целиком, а не редактируются.
 */
export function redactSecretEnvDiff(output: string) {
  return output
    .split(/(?=^diff --git )/m)
    .filter((block) => {
      if (!block.startsWith("diff --git ")) return true;
      const header = block.split("\n", 1)[0];
      const separator = header.lastIndexOf(" b/");
      if (separator < 0) return true;
      const target = header.slice(separator + 3).replace(/^"|"$/g, "");
      return !isSecretProjectPath(target);
    })
    .join("");
}

/** Git pathspec для исключения секретного файла из `git add`, даже если путь пришёл из `.`. */
export function secretPathspecExclusions(paths: string[]) {
  return paths.map((projectPath) => ":(exclude,literal)" + projectPath);
}

/** Строки `git status` с секретным путём не нужны агенту даже как имя файла. */
export function filterSecretStatus(output: string) {
  return output
    .split("\n")
    .filter((line) => {
      if (!line.trim() || line.startsWith("##")) return true;
      const value = line.slice(2).trim();
      const target = value.includes(" -> ") ? value.split(" -> ").pop() ?? value : value;
      return !isSecretProjectPath(target.replace(/^"|"$/g, ""));
    })
    .join("\n");
}

registerTool({
  name: "git.status",
  description: "Show Git working tree status for the project.",
  execute: async (_input, context) => {
    const result = await git(context, "status --short --branch", { maskSecretEnvFiles: true });
    return { ...result, stdout: filterSecretStatus(result.stdout) };
  },
});

registerTool({
  name: "git.diff",
  description: "Show unstaged Git diff for the project.",
  execute: async (_input, context) => {
    // Здесь маска не используется: у отслеживаемого `.env.local` она превратила бы diff в
    // удаление всех строк, то есть выдала бы секрет. Вывод фильтруется по путям.
    const result = await git(context, "diff --no-ext-diff");
    return { ...result, stdout: redactSecretEnvDiff(result.stdout) };
  },
});

registerTool({
  name: "git.log",
  description: "Show recent Git commits.",
  execute: async (_input, context) => {
    return git(context, "log --oneline -20", { maskSecretEnvFiles: true });
  },
});

registerTool({
  name: "git.branch",
  description: "List local Git branches.",
  execute: async (_input, context) => {
    return git(context, "branch --list", { maskSecretEnvFiles: true });
  },
});

/**
 * Выгрузка идёт не из песочницы: у контейнера нет ни сети (`SANDBOX_NETWORK=none`), ни токена,
 * поэтому `git pull` в терминале агента не мог дойти до репозитория в принципе. Здесь работает тот
 * же путь, что у кнопки «Выгрузить» в панели «Изменения»: isomorphic-git в процессе сервера, с
 * токеном подключения и проверкой fast-forward — работа агента без отправки не перезаписывается.
 */
registerTool({
  name: "git.pull",
  description:
    "Pull the project's connected repository branch into the workspace (fast-forward only: refuses when local commits were not pushed yet).",
  execute: async (_input, context) => {
    const outcome = await pullFromGithub(context.projectId, context.userId);
    if (!outcome.pulled) throw new Error(outcome.error ?? "Не удалось выгрузить изменения из репозитория");
    return { ok: true, branch: outcome.branch, sha: outcome.sha ?? null, changed: outcome.changed ?? 0 };
  },
});

registerTool({
  name: "git.add",
  description: "Stage project paths. Input: {paths:string[]}.",
  execute: async (input, context) => {
    const value = input as { paths?: string[] };
    if (!value.paths?.length) throw new Error("не указаны пути");

    const sandbox = await getSandbox(context.projectId, context.userId);
    const safe = value.paths.map((projectPath) =>
      assertInsideSandbox(
        sandbox.root,
        pathJoin(sandbox.root, projectPath),
      ).slice(sandbox.root.length + 1),
    );
    const secret = safe.find((projectPath) => isSecretProjectPath(projectPath));
    if (secret) {
      throw new Error(
        "Файл " + secret + " содержит секреты проекта и не добавляется в git. " +
        "Добавьте его в .gitignore (или .git/info/exclude), а в репозиторий коммитьте .env.example.",
      );
    }
    // `git add .` не должен захватить пустые placeholder-файлы, которые предпросмотр
    // оставляет под read-only mount. Исключения строятся по реальному дереву, поэтому
    // `.env.example` остаётся обычным файлом, а все варианты окружения — вне индекса.
    const exclusions = secretPathspecExclusions(await findSecretEnvFiles(sandbox.root));
    const quoted = [...safe, ...exclusions]
      .map((projectPath) => "'" + projectPath.replaceAll("'", "'\\''") + "'")
      .join(" ");

    return assertGitAvailable(await runInSandbox(sandbox, "git add -- " + quoted, sandbox.root, { signal: context.signal, maskSecretEnvFiles: true }));
  },
});

registerTool({
  name: "git.commit",
  description: "Create a Git commit. Input: {message:string}.",
  execute: async (input, context) => {
    const value = input as { message?: string };
    const message = value.message?.trim();
    if (!message) throw new Error("не указано сообщение коммита");

    const sandbox = await getSandbox(context.projectId, context.userId);
    // Проверка индекса до коммита: `git.add` секрет уже не примет, но файл мог оказаться в
    // индексе раньше (импортированный репозиторий, ручная команда). Коммит с ним — это утечка
    // в историю, из которой значение уже не убрать одним удалением файла.
    const staged = await runInSandbox(
      sandbox,
      "git diff --cached --name-only --diff-filter=ACMR",
      sandbox.root,
      { signal: context.signal, maskSecretEnvFiles: true },
    );
    if (staged.ok) {
      const secret = staged.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .find((projectPath) => isSecretProjectPath(projectPath));
      if (secret) {
        throw new Error(
          "В индексе git лежит секретный файл " + secret + ". Уберите его из индекса " +
          "(`git reset HEAD -- " + secret + "`), проверьте .gitignore и повторите коммит.",
        );
      }
    }

    const quoted = message.replaceAll("'", "'\\''");
    // У репозитория проекта нет `user.name`/`user.email`: коммиты платформы ставятся с явным
    // автором через isomorphic-git, а CLI без него отвечает «Author identity unknown». Тот же
    // автор, что у контрольных точек, — только для коммита агента, настройки проекта не трогаются.
    const identity = "-c user.name='" + GIT_AUTHOR.name + "' -c user.email='" + GIT_AUTHOR.email + "'";
    return assertGitAvailable(await runInSandbox(
      sandbox,
      "git " + identity + " commit -m '" + quoted + "'",
      sandbox.root,
      { signal: context.signal, maskSecretEnvFiles: true },
    ));
  },
});

function pathJoin(root: string, relative: string) {
  return root + "/" + relative;
}
