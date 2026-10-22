import { getGitHubConnection } from "../github/github-connection-store.js";
import { getGitLabConnection } from "../gitlab/gitlab-connection-store.js";
import { repoToken } from "../repos/tokens.js";
import { createGitHubRepository } from "../github/github-api.js";
import { getProject, linkProjectGithub, type RepositoryProvider } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import type { SandboxConfig } from "../sandbox-manager.js";
import {
  addRemote,
  createCheckpoint,
  currentBranch,
  hasCommits,
  hasRepo,
  initRepo,
  listBranches,
  listCheckpoints,
  pullBranch,
  pushBranch,
  readPushState,
  restoreCheckpoint,
  switchBranch,
} from "./git-repo.js";
import type { Checkpoint, ChangesOverview } from "./types.js";

/**
 * Один проект — одна очередь git-операций. Запуск агента, откат и повторная отправка могут
 * прийти одновременно (пользователь нажал «Вернуть» в конце задачи), а два коммита в одном
 * рабочем дереве — это испорченный индекс, поэтому операции сериализуются, а не ускоряются.
 */
const locks = new Map<string, Promise<unknown>>();

async function withProjectLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(projectId, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(projectId) === current) locks.delete(projectId);
  }
}

type Repository = {
  sandbox: SandboxConfig;
  branch: string;
  provider: RepositoryProvider;
  username: string;
  remoteUrl: string | null;
  commitUrl?: (sha: string) => string;
};

/** Старые проекты без поля provider — это GitHub; остальные провайдеры появились позже. */
function providerOf(value?: string): RepositoryProvider {
  return value === "gitlab" || value === "gitverse" || value === "sourcecraft" ? value : "github";
}

async function repositoryFor(projectId: string, userId: string): Promise<Repository> {
  const project = await getProject(projectId);
  if (!project || project.userId !== userId) throw new Error("Проект не найден");
  const sandbox = await getSandbox(projectId, userId);
  const repository = project.github;
  const provider = providerOf(repository?.provider);
  const branch = repository?.defaultBranch?.trim() || "main";
  const remoteUrl = repository
    ? repository.cloneUrl || (provider === "github"
      ? repository.url || "https://github.com/" + repository.fullName
      : repository.url.replace(/\/\.git$|\.git$/, "") + ".git")
    : null;
  return {
    sandbox,
    branch,
    provider,
    // GitHub ждёт x-access-token, GitLab/GitVerse/SourceCraft — oauth2 с токеном в пароле.
    username: provider === "github" ? "x-access-token" : "oauth2",
    remoteUrl,
    ...(repository?.fullName ? {
      commitUrl: (sha: string) => provider === "github"
        ? "https://github.com/" + repository.fullName + "/commit/" + sha
        : repository.url.replace(/\/$/, "") + (provider === "gitlab" ? "/-/commit/" : "/commit/") + sha,
    } : {}),
  };
}

async function tokenFor(userId: string, provider: RepositoryProvider = "github") {
  try {
    if (provider === "github") return (await getGitHubConnection(userId))?.accessToken ?? null;
    if (provider === "gitlab") return (await getGitLabConnection(userId))?.accessToken ?? null;
    return await repoToken(userId, provider);
  } catch (error) {
    console.error("[changes] не удалось прочитать подключение " + provider, error);
    return null;
  }
}

async function ensureRepo(repository: Repository, userId: string) {
  const root = repository.sandbox.root;
  // Уже созданный, но пустой репозиторий — это неудавшаяся попытка поставить историю на
  // GitHub (сеть, токен). Пока коммитов нет, попытку можно повторить: иначе первая же
  // задача создала бы локальную историю, и отправка навсегда осталась бы non-fast-forward.
  if (await hasRepo(root) && (!repository.remoteUrl || await hasCommits(root))) {
    return { warning: undefined as string | undefined };
  }
  const token = repository.remoteUrl ? await tokenFor(userId, repository.provider) : null;
  const result = await initRepo(root, {
    branch: repository.branch,
    remoteUrl: repository.remoteUrl,
    token,
    username: repository.username,
  });
  if (result.warning) console.warn("[changes] проект " + repository.sandbox.projectId + ": " + result.warning);
  return { warning: result.warning };
}

/** Отправка ограничена по времени: панель не должна ждать недоступный GitHub минутами. */
async function pushWithTimeout(repository: Repository, userId: string) {
  const token = repository.remoteUrl ? await tokenFor(userId, repository.provider) : null;
  const branch = await currentBranch(repository.sandbox.root, repository.branch);
  const configuredTimeout = Number(process.env.CHANGES_PUSH_TIMEOUT_MS ?? 20_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pushBranch(repository.sandbox.root, { branch, token, username: repository.username }),
      new Promise<{ pushed: boolean; branch: string; at: string; error: string }>(resolve => {
        timer = setTimeout(() => resolve({
          pushed: false,
          branch,
          at: new Date().toISOString(),
          error: "Репозиторий не ответил за отведённое время: изменения сохранены в проекте, отправьте их позже.",
        }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withLink(checkpoint: Checkpoint, repository: Repository): Checkpoint {
  if (!repository.commitUrl) return checkpoint;
  return { ...checkpoint, url: repository.commitUrl(checkpoint.sha) };
}

/**
 * Итог задачи: коммит в историю проекта. В историю попадает проверенное состояние, а не
 * промежуточная правка — вызов идёт после того, как сборка, предпросмотр и браузерная
 * проверка прошли.
 *
 * Пуш здесь намеренно не делается. Отправка на GitHub — действие с последствиями для
 * чужого репозитория, поэтому его запускает только сам пользователь кнопкой «Отправить
 * на GitHub»: агент не должен отправлять коммиты по своей инициативе.
 */
export async function finalizeRunChanges(options: {
  projectId: string;
  userId: string;
  runId: string;
  conversationId?: string;
  title: string;
}): Promise<{ checkpoint: Checkpoint; branch: string } | null> {
  return withProjectLock(options.projectId, async () => {
    const repository = await repositoryFor(options.projectId, options.userId);
    await ensureRepo(repository, options.userId);
    const branch = await currentBranch(repository.sandbox.root, repository.branch);
    const checkpoint = await createCheckpoint(repository.sandbox.root, {
      branch,
      subject: options.title,
      kind: "task",
      runId: options.runId,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    });
    if (!checkpoint) return null;
    return { checkpoint: withLink(checkpoint, repository), branch };
  });
}

export async function changesOverview(projectId: string, userId: string): Promise<ChangesOverview> {
  const repository = await repositoryFor(projectId, userId);
  if (!await hasRepo(repository.sandbox.root)) {
    return {
      initialized: false,
      repository: {
        provider: repository.provider,
        connected: Boolean(repository.remoteUrl),
        branch: repository.branch,
        remoteUrl: repository.remoteUrl,
        lastPushAt: null,
        lastPushError: null,
      },
      checkpoints: [],
    };
  }
  const branch = await currentBranch(repository.sandbox.root, repository.branch);
  const [checkpoints, pushState] = await Promise.all([
    listCheckpoints(repository.sandbox.root, { branch }),
    readPushState(repository.sandbox.root),
  ]);
  return {
    initialized: true,
    repository: {
      provider: repository.provider,
      connected: Boolean(repository.remoteUrl),
      branch,
      remoteUrl: repository.remoteUrl,
      lastPushAt: pushState?.lastPushAt ?? null,
      lastPushError: pushState?.lastPushError ?? null,
    },
    // Коммит, пришедший из GitHub, уже лежит там — он не «не отправлен», просто появился не
    // через задачу агента. Свой первый коммит (без трейлера) мы так не помечаем: он мог не
    // уйти, если создание репозитория закончилось без отправки.
    checkpoints: checkpoints.map(checkpoint => withLink({
      ...checkpoint,
      pushed: checkpoint.pushed || (!/^NestDev-Kind:/m.test(checkpoint.message) && Boolean(repository.remoteUrl)),
    }, repository)),
  };
}

/**
 * Откат к точке. Файлы проекта возвращаются к её состоянию, сверху создаётся коммит отката.
 * На GitHub ничего не уходит: отправку пользователь запускает сам, когда убедился в результате.
 */
export async function rollbackToCheckpoint(projectId: string, userId: string, sha: string) {
  return withProjectLock(projectId, async () => {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("Неверный идентификатор точки");
    const repository = await repositoryFor(projectId, userId);
    if (!await hasRepo(repository.sandbox.root)) throw new Error("В проекте ещё нет истории изменений");
    await ensureRepo(repository, userId);
    const branch = await currentBranch(repository.sandbox.root, repository.branch);
    const overview = await listCheckpoints(repository.sandbox.root, { branch });
    const target = overview.find(item => item.sha === sha || item.sha.startsWith(sha));
    if (!target) throw new Error("Точка не найдена в истории этого проекта");
    const checkpoint = await restoreCheckpoint(repository.sandbox.root, {
      sha: target.sha,
      branch,
      subject: "Откат к " + target.shortSha + ": " + target.subject,
    });
    return { checkpoint: withLink(checkpoint, repository), branch, pushed: false as const };
  });
}

/**
 * Имя репозитория из названия проекта. GitHub принимает латиницу, цифры, точку, дефис и
 * подчёркивание, а проекты называют по-русски, поэтому кириллица транслитерируется, а всё
 * остальное становится дефисами.
 */
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

export function repositoryNameFromProject(value: string) {
  const latin = value.toLowerCase().split("").map(char => TRANSLIT[char] ?? char).join("");
  const slug = latin.replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").replace(/-{2,}/g, "-").slice(0, 90);
  return slug || "webnestdev-project";
}

/**
 * Создаёт репозиторий на GitHub для проекта, созданного в приложении, и отправляет туда
 * текущее состояние. Импортированным проектам это не нужно: у них репозиторий уже есть.
 */
export async function createRepositoryForProject(projectId: string, userId: string, requestedName?: string) {
  return withProjectLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project || project.userId !== userId) throw new Error("Проект не найден");
    if (project.github) throw new Error("Проект уже связан с «" + project.github.fullName + "»");
    const name = repositoryNameFromProject(requestedName?.trim() || project.name);
    const created = await createGitHubRepository(userId, { name, private: true }) as {
      name: string;
      full_name: string;
      html_url: string;
      default_branch: string;
      owner: { login: string };
    };
    const linked = await linkProjectGithub(projectId, userId, {
      owner: created.owner.login,
      name: created.name,
      fullName: created.full_name,
      defaultBranch: created.default_branch || "main",
      url: created.html_url,
    });
    if (!linked) throw new Error("Проект не найден");

    const repository = await repositoryFor(projectId, userId);
    if (!await hasRepo(repository.sandbox.root)) {
      await initRepo(repository.sandbox.root, { branch: repository.branch });
    }
    if (repository.remoteUrl) await addRemote(repository.sandbox.root, repository.remoteUrl);
    if (!await hasCommits(repository.sandbox.root)) {
      // Пустой репозиторий GitHub принимает первый коммит как обычную ветку
      // (`main`), поэтому начальное состояние проекта становится этой веткой.
      await createCheckpoint(repository.sandbox.root, {
        branch: repository.branch,
        subject: "Начальное состояние проекта",
        kind: "imported",
      });
    }
    if (!await hasCommits(repository.sandbox.root)) throw new Error("В проекте пока нет файлов — отправлять нечего");
    const outcome = await pushWithTimeout(repository, userId);
    return {
      repository: linked.github ?? null,
      pushed: outcome.pushed,
      branch: outcome.branch,
      ...(outcome.error ? { pushError: outcome.error } : {}),
      overview: await changesOverview(projectId, userId),
    };
  });
}

/**
 * Выгрузка из GitHub: забирает ветку в проект, когда отправлять было нечего. Панель показывает
 * результат и обновлённую историю — выгруженные коммиты становятся точками, к которым можно
 * вернуться, как и своим.
 */
export async function pullFromGithub(projectId: string, userId: string, options: { discardLocal?: boolean } = {}) {
  return withProjectLock(projectId, async () => {
    const repository = await repositoryFor(projectId, userId);
    if (!repository.remoteUrl) throw new Error("У проекта нет подключённого репозитория");
    await ensureRepo(repository, userId);
    const branch = await currentBranch(repository.sandbox.root, repository.branch);
    const token = await tokenFor(userId, repository.provider);
    const outcome = await pullBranch(repository.sandbox.root, {
      branch,
      token,
      username: repository.username,
      ...(options.discardLocal ? { discardLocal: true } : {}),
    });
    // Выгрузка из GitHub добавляет файлы мимо агента: размер проекта нужно пересчитать,
    // иначе квота узнает о них только на ночной сверке.
    if (outcome.pulled) {
      await recordStorageMutation(projectId, userId, { heavy: true })
        .catch(error => console.warn("[storage] не удалось обновить размер после выгрузки", error));
    }
    return { ...outcome, overview: await changesOverview(projectId, userId) };
  });
}

/**
 * Ветки проекта для меню в шапке: локальные и те, что уже известны с GitHub. До первого
 * коммита веток нет, поэтому ответ говорит `initialized: false`, а не ошибкой.
 */
export async function listProjectBranches(projectId: string, userId: string) {
  const repository = await repositoryFor(projectId, userId);
  if (!await hasRepo(repository.sandbox.root)) {
    return { initialized: false, current: repository.branch, branches: [] };
  }
  const listed = await listBranches(repository.sandbox.root, repository.branch);
  return { initialized: true, ...listed };
}

/**
 * Переключение ветки — выбор, в какую ветку уйдёт следующая отправка. Файлы проекта берутся из
 * выбранной ветки, поэтому открытый предпросмотр перечитывается вызывающей стороной.
 */
export async function switchProjectBranch(projectId: string, userId: string, branch: string) {
  return withProjectLock(projectId, async () => {
    const repository = await repositoryFor(projectId, userId);
    if (!await hasRepo(repository.sandbox.root)) throw new Error("В проекте ещё нет истории изменений");
    const token = repository.remoteUrl ? await tokenFor(userId, repository.provider) : null;
    const outcome = await switchBranch(repository.sandbox.root, { branch, token, username: repository.username });
    return { ...outcome, overview: await changesOverview(projectId, userId) };
  });
}

/** Повторная отправка: сеть или GitHub могли отказать в момент задачи. */
export async function pushCurrentBranch(projectId: string, userId: string) {
  return withProjectLock(projectId, async () => {
    const repository = await repositoryFor(projectId, userId);
    if (!repository.remoteUrl) throw new Error("У проекта нет подключённого репозитория");
    if (!await hasRepo(repository.sandbox.root)) throw new Error("В проекте ещё нет истории изменений");
    const outcome = await pushWithTimeout(repository, userId);
    return outcome;
  });
}
