import fs from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import { deleteInside, writeFileInside } from "../sandbox/path-guard.js";
import type { Checkpoint, CheckpointFile, CheckpointFileStatus, CheckpointKind, PushState } from "./types.js";

/**
 * Контрольные точки проекта — это обычные git-коммиты в каталоге проекта, а не отдельное
 * хранилище снимков: историю видно, её можно забрать на GitHub, и откат — это тоже коммит.
 *
 * Git здесь работает в процессе сервера (isomorphic-git), а не в контейнере песочницы.
 * Причины две: контейнер запускается с `--read-only` и без сети по умолчанию, а образ
 * песочницы выбирается через `SANDBOX_IMAGE` и может быть собран без git (стандартный образ
 * платформы git содержит — он нужен инструментам агента, см. sandbox/config.ts). Поэтому
 * история проекта не зависит от содержимого образа: файлы сервер и так читает и пишет сам
 * (импорт репозитория, инструменты файлов), и один и тот же код обслуживает и `fs.write`,
 * и `terminal.exec`.
 */

export const GIT_AUTHOR = { name: "NestDev Agent", email: "agent@nestdev.local" };
export const PUSH_STATE_FILE = "nestdev.json";

/**
 * Что не попадает в историю проекта: зависимости, сборки, кеши и секреты. Правила пишутся
 * в `.git/info/exclude`, а не в `.gitignore`: проект остаётся таким, каким его написал
 * пользователь, и наш список не спорит с его собственным `.gitignore` (оба действуют).
 */
const IGNORED_DIRS = new Set([
  ".git", "node_modules", "bower_components", "dist", "build", ".next", ".nuxt", ".output",
  ".cache", ".parcel-cache", ".turbo", ".vite", ".venv", "venv", "env", "__pycache__",
  "coverage", ".nyc_output", ".webnestdev", ".idea", ".vscode", "target",
]);
const IGNORED_FILE = /^(\.DS_Store|Thumbs\.db|npm-debug\.log|yarn-error\.log|\.env(\..+)?)$/;
const ALLOWED_ENV_TEMPLATE = /^\.env\.(example|sample|template)$/;

/** Быстрая проверка до обращения к git: `node_modules` не должен даже обходиться. */
export function ignoredPath(filepath: string) {
  const parts = filepath.split("/").filter(Boolean);
  if (!parts.length) return true;
  if (parts.some(part => IGNORED_DIRS.has(part))) return true;
  const name = parts[parts.length - 1];
  if (ALLOWED_ENV_TEMPLATE.test(name)) return false;
  return IGNORED_FILE.test(name);
}

export async function hasRepo(root: string) {
  try {
    return (await stat(path.join(root, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

/** Есть ли уже коммиты: пустой репозиторий ещё можно поставить на историю GitHub. */
export async function hasCommits(root: string) {
  try {
    await git.resolveRef({ fs, dir: root, ref: "HEAD" });
    return true;
  } catch {
    return false;
  }
}

const EXCLUDE_HEADER = "# webnestdev: служебные файлы проекта не попадают в историю";
const EXCLUDE_RULES = [
  "node_modules/", "bower_components/", "dist/", "build/", ".next/", ".nuxt/", ".output/",
  ".cache/", ".parcel-cache/", ".turbo/", ".vite/", ".venv/", "venv/", "__pycache__/",
  "coverage/", ".nyc_output/", ".webnestdev/",
  ".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template",
  ".DS_Store", "Thumbs.db", "*.log",
];

async function writeExcludes(root: string) {
  const file = path.join(root, ".git", "info", "exclude");
  await mkdir(path.dirname(file), { recursive: true });
  let existing = "";
  try { existing = await readFile(file, "utf8"); } catch {}
  // Свой блок заменяется, чужие строки (если файл уже правили) остаются на месте.
  const kept = existing
    .split("\n")
    .filter(line => !line.startsWith("# webnestdev:") && !EXCLUDE_RULES.includes(line.trim()) && line.trim() !== EXCLUDE_HEADER)
    .join("\n")
    .trim();
  const block = [EXCLUDE_HEADER, ...EXCLUDE_RULES].join("\n");
  await writeFile(file, (kept ? kept + "\n\n" : "") + block + "\n", "utf8");
}

export type InitOptions = {
  branch: string;
  remoteUrl?: string | null;
  token?: string | null;
  /** GitHub ждёт `x-access-token`, GitLab — `oauth2`; остальные принимают любое имя. */
  username?: string;
};

/**
 * Создаёт историю проекта. Если репозиторий на GitHub подключён, локальная ветка ставится на
 * удалённый HEAD (fetch без изменения файлов): коммит задачи получает родителем настоящий
 * коммит репозитория, и push — это fast-forward, а не «несвязанная история».
 */
export async function initRepo(root: string, options: InitOptions): Promise<{ adopted: boolean; warning?: string }> {
  await git.init({ fs, dir: root, defaultBranch: options.branch });
  await writeExcludes(root);
  if (!options.remoteUrl) return { adopted: false };

  await git.addRemote({ fs, dir: root, remote: "origin", url: options.remoteUrl, force: true }).catch(() => {});
  try {
    const fetched = await git.fetch({
      fs,
      http,
      dir: root,
      remote: "origin",
      ref: options.branch,
      singleBranch: true,
      depth: 1,
      ...(options.token ? { onAuth: () => ({ username: options.username ?? "x-access-token", password: options.token as string }) } : {}),
    });
    if (!fetched.fetchHead) return { adopted: false, warning: "Репозиторий не вернул ветку " + options.branch };
    await git.writeRef({ fs, dir: root, ref: "refs/heads/" + options.branch, value: fetched.fetchHead, force: true });
    await git.writeRef({ fs, dir: root, ref: "HEAD", value: "refs/heads/" + options.branch, force: true, symbolic: true });
    // Импорт пропускает файлы, которые GitHub отдаёт без base64 (крупные бинарники).
    // Восстанавливаем их из скачанной истории, иначе первый же коммит задачи удалил бы
    // их из репозитория — то есть импорт молча испортил бы чужой проект.
    try {
      for (const [filepath, oid] of await treeFiles(root, options.branch)) {
        if (await stat(path.join(root, filepath)).catch(() => null)) continue;
        const { blob } = await git.readBlob({ fs, dir: root, oid });
        await writeWorktreeFile(root, filepath, blob);
      }
    } catch (error) {
      return { adopted: true, warning: "часть файлов истории не удалось восстановить: " + describe(error) };
    }
    // Индекс — это рабочее дерево; дерево коммита строится из индекса, поэтому первая же
    // задача станет обычным коммитом поверх удалённой истории.
    await stageWorkdir(root);
    return { adopted: true };
  } catch (error) {
    return { adopted: false, warning: "не удалось загрузить историю репозитория: " + describe(error) };
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Импорт клоном — для провайдеров, у которых API не отдаёт файлы (SourceCraft). Клон приносит
 * и файлы, и историю, поэтому первая же задача станет коммитом поверх настоящей ветки.
 * Токен передаётся в `onAuth`, а не в URL: адрес с секретом попал бы в `.git/config`.
 */
export async function cloneRepository(root: string, options: {
  url: string;
  branch: string;
  token: string | null;
  username?: string;
}) {
  if (!options.url) throw new Error("У репозитория нет адреса для git");
  await mkdir(root, { recursive: true });
  await git.clone({
    fs,
    http,
    dir: root,
    url: options.url,
    ref: options.branch || undefined,
    singleBranch: true,
    depth: 1,
    ...(options.token ? { onAuth: () => ({ username: options.username ?? "oauth2", password: options.token as string }) } : {}),
  });
  // Служебные исключения ставим и здесь: клон чужого проекта не должен притащить в нашу
  // историю .env и node_modules при первой же отправке.
  await writeExcludes(root);
}

/** Адрес GitHub в конфигурации проекта: нужен, когда репозиторий создан уже после импорта. */
export async function addRemote(root: string, url: string) {
  await git.addRemote({ fs, dir: root, remote: "origin", url, force: true });
}

/** Текущая ветка репозитория: пользователь мог принести свой клон с `master`. */
export async function currentBranch(root: string, fallback: string) {
  try {
    const branch = await git.currentBranch({ fs, dir: root, fullname: false });
    return branch ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Ветка проекта в списке выбора. `remote` — ветка есть и на GitHub, `pushed` — локальный
 * HEAD совпадает с последней отправленной точкой. Оба флага нужны, чтобы шапка честно
 * показывала, куда уйдёт кнопка «Отправить» и что ещё не отправлено.
 */
export type BranchInfo = { name: string; current: boolean; remote: boolean; pushed: boolean };

export async function listBranches(root: string, fallback: string): Promise<{ current: string; branches: BranchInfo[] }> {
  const current = await currentBranch(root, fallback);
  const local = await git.listBranches({ fs, dir: root }).catch(() => [] as string[]);
  // Список удалённых веток читается из локальных ссылок, которые оставил fetch: так меню
  // открывается без сети, а неизвестные ветки всё равно можно выбрать — switchBranch
  // заберёт их из GitHub по имени.
  const remote = await git.listBranches({ fs, dir: root, remote: "origin" }).catch(() => [] as string[]);
  const remoteSet = new Set(remote.filter(name => name !== "HEAD"));
  const names = [...new Set([...local, ...remoteSet])].sort((a, b) => a.localeCompare(b));
  const branches: BranchInfo[] = [];
  for (const name of names) {
    const inLocal = local.includes(name);
    branches.push({
      name,
      current: inLocal && name === current,
      remote: remoteSet.has(name),
      pushed: inLocal ? await branchPushed(root, name) : false,
    });
  }
  return { current, branches };
}

/** Совпадает ли локальная ветка с последней отправленной точкой. */
async function branchPushed(root: string, branch: string) {
  try {
    const head = await git.resolveRef({ fs, dir: root, ref: "refs/heads/" + branch });
    const pushed = await git.resolveRef({ fs, dir: root, ref: "refs/webnestdev/pushed/" + branch });
    return head === pushed;
  } catch {
    return false;
  }
}

export type BranchSwitchOutcome = { switched: boolean; branch: string; error?: string };

/**
 * Переключение ветки проекта. Незакоммиченные правки не переносятся: переключение либо
 * сохраняет их как точку истории, либо отказывает. Молча стереть работу агента нельзя, а
 * переносить её в другую ветку без спроса — тоже.
 */
export async function switchBranch(root: string, options: { branch: string; token: string | null; username?: string }): Promise<BranchSwitchOutcome> {
  const branch = options.branch.trim();
  if (!branch) return { switched: false, branch, error: "Не указана ветка" };
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    return { switched: false, branch, error: "Недопустимое имя ветки" };
  }
  if (!await hasCommits(root)) return { switched: false, branch, error: "В проекте ещё нет истории изменений" };
  const dirty = await scanChanges(root);
  if (dirty.changed.length) {
    return {
      switched: false,
      branch,
      error: "В проекте есть несохранённые правки. Дождитесь конца задачи или создайте точку, затем переключите ветку.",
    };
  }
  try {
    const local = await git.listBranches({ fs, dir: root }).catch(() => [] as string[]);
    if (local.includes(branch)) {
      await git.checkout({ fs, dir: root, ref: branch, force: true });
    } else {
      if (!options.token) {
        return { switched: false, branch, error: "Ветки " + branch + " нет в проекте: чтобы забрать её из репозитория, подключите GitHub или GitLab." };
      }
      const fetched = await git.fetch({
        fs,
        http,
        dir: root,
        remote: "origin",
        ref: branch,
        singleBranch: true,
        depth: 1,
        onAuth: () => ({ username: options.username ?? "x-access-token", password: options.token as string }),
      });
      if (!fetched.fetchHead) return { switched: false, branch, error: "Репозиторий не вернул ветку " + branch };
      const previous = await treeFiles(root, "HEAD").catch(() => new Map<string, string>());
      const target = await treeFiles(root, fetched.fetchHead);
      for (const [filepath, oid] of target) {
        if (previous.get(filepath) === oid) continue;
        const { blob } = await git.readBlob({ fs, dir: root, oid });
        await writeWorktreeFile(root, filepath, blob);
      }
      for (const filepath of previous.keys()) {
        if (target.has(filepath)) continue;
        await deleteInside(root, path.join(root, filepath));
      }
      await git.writeRef({ fs, dir: root, ref: "refs/heads/" + branch, value: fetched.fetchHead, force: true });
      await git.writeRef({ fs, dir: root, ref: "refs/remotes/origin/" + branch, value: fetched.fetchHead, force: true });
    }
    await git.writeRef({ fs, dir: root, ref: "HEAD", value: "refs/heads/" + branch, force: true, symbolic: true });
    await stageWorkdir(root);
    return { switched: true, branch };
  } catch (error) {
    return { switched: false, branch, error: "Не удалось переключить ветку: " + describe(error) };
  }
}

/**
 * Содержимое рабочего дерева: путь → хеш блоба. Хешируются все файлы, кроме служебных.
 *
 * `git.statusMatrix` здесь не годится: его кеш сравнивает mtime с точностью до секунды и размер,
 * поэтому правка, записанная в ту же секунду и той же длины, выглядит неизменённой — а агент
 * пишет файлы именно так. Своё сканирование стоит одного прохода по файлам и всегда честно.
 */
/**
 * Предел на один файл: история — это исходники, а не диски с видео. Без него один большой
 * файл читался бы в память целиком на каждой задаче и мог уронить маленькую ВМ.
 */
const MAX_TRACKED_FILE_BYTES = Number(process.env.CHANGES_MAX_FILE_BYTES ?? 12_000_000);

export async function walkWorkdir(root: string) {
  const files = new Map<string, string>();
  const stack: string[] = [""];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir ? path.join(root, dir) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = dir ? dir + "/" + entry.name : entry.name;
      if (ignoredPath(relative)) continue;
      if (entry.isDirectory()) { stack.push(relative); continue; }
      if (!entry.isFile()) continue;
      try {
        const full = path.join(root, relative);
        const info = await stat(full);
        if (info.size > MAX_TRACKED_FILE_BYTES) continue;
        const content = await readFile(full);
        const { oid } = await git.hashBlob({ object: content });
        files.set(relative, oid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return files;
}

/**
 * Разница рабочего дерева с HEAD: то, что станет точкой в истории.
 *
 * Файл, который лежит в HEAD, но подпадает под наши правила исключений (например, проект
 * хранит собранный `dist/`), продолжает отслеживаться: git так и работает — исключения
 * касаются новых файлов, а не уже принятых в историю. Иначе импортированный репозиторий
 * потерял бы часть файлов на первом же коммите.
 */
export async function scanChanges(root: string) {
  const head = await treeFiles(root, "HEAD").catch(() => new Map<string, string>());
  const workdir = await walkWorkdir(root);
  for (const filepath of head.keys()) {
    if (workdir.has(filepath) || !ignoredPath(filepath)) continue;
    const full = path.join(root, filepath);
    // lstat, а не stat: ссылка наружу не должна попасть в историю под видом файла проекта.
    const info = await lstat(full).catch(() => null);
    if (!info?.isFile() || info.size > MAX_TRACKED_FILE_BYTES) continue;
    const { oid } = await git.hashBlob({ object: await readFile(full) });
    workdir.set(filepath, oid);
  }
  const changed: CheckpointFile[] = [];
  for (const [filepath, oid] of workdir) {
    const previous = head.get(filepath);
    if (!previous) changed.push({ path: filepath, status: "added" });
    else if (previous !== oid) changed.push({ path: filepath, status: "modified" });
  }
  for (const filepath of head.keys()) if (!workdir.has(filepath)) changed.push({ path: filepath, status: "deleted" });
  return { workdir, head, changed };
}

/** Индекс приводится к тому, что уже посчитано: изменённые файлы добавляются, удалённые убираются. */
async function stageChanges(root: string, changed: CheckpointFile[]) {
  for (const file of changed) {
    if (file.status === "deleted") await git.remove({ fs, dir: root, filepath: file.path });
    else await git.add({ fs, dir: root, filepath: file.path });
  }
}

/**
 * Что действительно попало в индекс. `git.add` сам пропускает файлы из `.gitignore`
 * проекта, поэтому список изменений берётся у индекса, а не у рабочего дерева: иначе
 * точка обещала бы файлы, которых в коммите нет.
 */
export async function stagedChanges(root: string): Promise<CheckpointFile[]> {
  // Свой фильтр здесь не нужен: statusMatrix сам скрывает игнорируемые новые файлы
  // и оставляет уже отслеживаемые, даже если они подпадают под правило исключения.
  const matrix = await git.statusMatrix({ fs, dir: root });
  const files: CheckpointFile[] = [];
  for (const [filepath, head, , stage] of matrix) {
    if (head === stage) continue;
    if (head === 0) files.push({ path: filepath, status: "added" });
    else if (stage === 0) files.push({ path: filepath, status: "deleted" });
    else files.push({ path: filepath, status: "modified" });
  }
  return files;
}

async function stageWorkdir(root: string) {
  const matrix = await git.statusMatrix({ fs, dir: root, filter: filepath => !ignoredPath(filepath) });
  for (const [filepath, head, workdir, stage] of matrix) {
    if (workdir === 0) {
      if (stage !== 0) await git.remove({ fs, dir: root, filepath });
      continue;
    }
    // stage === 2 значит «в индексе лежит ровно то, что в рабочем дереве» — такой файл уже готов.
    if (stage === 0 || stage === 3 || (workdir === 2 && stage === 1)) await git.add({ fs, dir: root, filepath });
  }
  return matrix;
}

/** Трейлеры в сообщении коммита — метаданные, которые переживают и push, и перезапуск. */
function trailer(message: string, name: string) {
  const match = message.match(new RegExp("^" + name + ":[ \\t]*(.+)$", "m"));
  return match?.[1]?.trim();
}

export type CreateCheckpointOptions = {
  branch: string;
  subject: string;
  kind: CheckpointKind;
  runId?: string;
  conversationId?: string;
  revertedTo?: string;
};

function commitMessage(options: CreateCheckpointOptions) {
  const subject = options.subject.replace(/\s+/g, " ").trim().slice(0, 140) || "Изменения проекта";
  const trailers = [
    "NestDev-Kind: " + options.kind,
    options.runId ? "NestDev-Run: " + options.runId : "",
    options.conversationId ? "NestDev-Conversation: " + options.conversationId : "",
    options.revertedTo ? "NestDev-Reverted-To: " + options.revertedTo : "",
  ].filter(Boolean);
  return subject + "\n\n" + trailers.join("\n") + "\n";
}

/**
 * Записывает текущее состояние проекта в коммит. Возвращает null, когда менять нечего:
 * запуск мог закончиться разговором, а не правкой файлов, и пустая точка в истории не нужна.
 */
export async function createCheckpoint(root: string, options: CreateCheckpointOptions): Promise<Checkpoint | null> {
  const { changed } = await scanChanges(root);
  if (!changed.length) return null;

  await stageChanges(root, changed);
  const files = await stagedChanges(root);
  if (!files.length) return null;
  const message = commitMessage(options);
  const sha = await git.commit({ fs, dir: root, message, author: GIT_AUTHOR, committer: GIT_AUTHOR });
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: message.split("\n")[0],
    message,
    kind: options.kind,
    createdAt: new Date().toISOString(),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    ...(options.revertedTo ? { revertedTo: options.revertedTo } : {}),
    files: files.slice(0, 200),
    filesChanged: files.length,
    pushed: false,
  };
}

export type PushOptions = {
  branch: string;
  token?: string | null;
  force?: boolean;
  username?: string;
};

export type PushOutcome = { pushed: boolean; branch: string; at: string; error?: string };

/**
 * Отправляет ветку на GitHub. Возвращает результат, а не бросает: коммит уже создан и
 * откат работает, поэтому отказ сети — это «не отправлено», а не потерянная работа.
 */
export async function pushBranch(root: string, options: PushOptions): Promise<PushOutcome> {
  const at = new Date().toISOString();
  if (!options.token) {
    const outcome: PushOutcome = { pushed: false, branch: options.branch, at, error: "Репозиторий не подключён: отправлять нечем" };
    await writePushState(root, { branch: options.branch, lastPushAt: undefined, lastPushError: outcome.error });
    return outcome;
  }
  try {
    const remotes = await git.listRemotes({ fs, dir: root }).catch(() => []);
    if (!remotes.some(remote => remote.remote === "origin")) {
      const outcome: PushOutcome = { pushed: false, branch: options.branch, at, error: "У проекта нет подключённого репозитория" };
      await writePushState(root, { branch: options.branch, lastPushError: outcome.error });
      return outcome;
    }
    const result = await git.push({
      fs,
      http,
      dir: root,
      remote: "origin",
      ref: options.branch,
      force: Boolean(options.force),
      onAuth: () => ({ username: options.username ?? "x-access-token", password: options.token as string }),
    });
    const ref = result.refs?.["refs/heads/" + options.branch] ?? Object.values(result.refs ?? {})[0];
    if (!result.ok || (ref && !ref.ok)) {
      const reason = ref?.error || result.error || "Репозиторий отклонил отправку";
      const outcome: PushOutcome = { pushed: false, branch: options.branch, at, error: reason };
      await writePushState(root, { branch: options.branch, lastPushError: reason });
      return outcome;
    }
    const head = await git.resolveRef({ fs, dir: root, ref: "HEAD" });
    await git.writeRef({ fs, dir: root, ref: "refs/webnestdev/pushed/" + options.branch, value: head, force: true });
    await writePushState(root, { branch: options.branch, lastPushAt: at, lastPushError: undefined });
    return { pushed: true, branch: options.branch, at };
  } catch (error) {
    const reason = pushErrorText(error, options.branch);
    await writePushState(root, { branch: options.branch, lastPushError: reason });
    return { pushed: false, branch: options.branch, at, error: reason };
  }
}

export type PullOutcome = { pulled: boolean; branch: string; at: string; sha?: string; changed?: number; error?: string };

/**
 * Выгрузка из GitHub — это fast-forward, а не слияние: панель забирает то, что уже лежит в ветке.
 * Если в проекте есть точки, которых нет на GitHub, выгрузка отказала бы: молча перезаписать
 * работу агента нельзя. Поэтому операция разрешена только когда локальная ветка стоит ровно на
 * последней отправленной точке (или история только начинается).
 *
 * Файлы берутся из полученного коммита, а не из рабочего дерева: так выгрузка приносит именно
 * состояние GitHub, включая удалённые там файлы.
 */
export async function pullBranch(root: string, options: { branch: string; token: string | null; username?: string }): Promise<PullOutcome> {
  const at = new Date().toISOString();
  if (!options.token) return { pulled: false, branch: options.branch, at, error: "Репозиторий не подключён: выгружать нечем" };
  try {
    const remotes = await git.listRemotes({ fs, dir: root }).catch(() => []);
    if (!remotes.some(remote => remote.remote === "origin")) {
      return { pulled: false, branch: options.branch, at, error: "У проекта нет подключённого репозитория" };
    }
    const localHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" }).catch(() => null);
    const pushedHead = await git.resolveRef({ fs, dir: root, ref: "refs/webnestdev/pushed/" + options.branch }).catch(() => null);
    const fetched = await git.fetch({
      fs,
      http,
      dir: root,
      remote: "origin",
      ref: options.branch,
      singleBranch: true,
      depth: 1,
      // `oauth2` для GitLab/GitVerse/SourceCraft и `x-access-token` для GitHub — то же имя, что у
      // pushBranch: с жёстко вписанным GitHub-именем выгрузка с остальных провайдеров получала 401
      // и выглядела как «токен не принят».
      onAuth: () => ({ username: options.username ?? "x-access-token", password: options.token as string }),
    });
    const remoteHead = fetched.fetchHead;
    if (!remoteHead) return { pulled: false, branch: options.branch, at, error: "Репозиторий не вернул ветку " + options.branch };
    if (localHead && localHead !== pushedHead) {
      return { pulled: false, branch: options.branch, at, error: "В проекте есть точки, которых нет в удалённом репозитории. Сначала отправьте их — выгрузка перезаписала бы эту работу." };
    }
    if (localHead === remoteHead) {
      await writePushState(root, { branch: options.branch, lastPushAt: at, lastPushError: undefined });
      return { pulled: true, branch: options.branch, at, sha: remoteHead, changed: 0 };
    }
    const previous = localHead ? await treeFiles(root, "HEAD").catch(() => new Map<string, string>()) : new Map<string, string>();
    const target = await treeFiles(root, remoteHead);
    let changed = 0;
    for (const [filepath, oid] of target) {
      if (previous.get(filepath) === oid) continue;
      const { blob } = await git.readBlob({ fs, dir: root, oid });
      await writeWorktreeFile(root, filepath, blob);
      changed++;
    }
    for (const filepath of previous.keys()) {
      if (target.has(filepath)) continue;
      await deleteInside(root, path.join(root, filepath));
      changed++;
    }
    await git.writeRef({ fs, dir: root, ref: "refs/heads/" + options.branch, value: remoteHead, force: true });
    await git.writeRef({ fs, dir: root, ref: "HEAD", value: "refs/heads/" + options.branch, force: true, symbolic: true });
    await git.writeRef({ fs, dir: root, ref: "refs/webnestdev/pushed/" + options.branch, value: remoteHead, force: true });
    await stageWorkdir(root);
    await writePushState(root, { branch: options.branch, lastPushAt: at, lastPushError: undefined });
    return { pulled: true, branch: options.branch, at, sha: remoteHead, changed };
  } catch (error) {
    return { pulled: false, branch: options.branch, at, error: pullErrorText(error) };
  }
}

/** Отказы GitHub при выгрузке: пользователю нужен следующий шаг, а не текст HTTP-ошибки. */
export function pullErrorText(error: unknown) {
  const text = describe(error);
  if (/401|403|auth|credential|permission/i.test(text)) return "Удалённый репозиторий не принял доступ: проверьте подключение и права токена.";
  if (/404|not found/i.test(text)) return "Репозиторий не найден: возможно, он переименован или удалён.";
  return "Не удалось выгрузить изменения из репозитория: " + text;
}

/**
 * Отказы git-сервера приходят техническим текстом; в панели нужен ответ, по которому
 * понятно, что делать (нет прав, ветка ушла вперёд, истёк токен).
 */
export function pushErrorText(error: unknown, branch: string) {
  const message = describe(error);
  if (/not a simple fast-forward|notFastForward|non-fast-forward|fetch first/i.test(message)) {
    return "Ветка " + branch + " в удалённом репозитории ушла вперёд: отправка отклонена, чтобы не потерять чужие коммиты. Создайте откат ещё раз или отправьте изменения из терминала.";
  }
  if (/401|Unauthorized|bad credentials/i.test(message)) return "Репозиторий не принял токен: переподключите GitHub или GitLab в настройках.";
  if (/403|Forbidden|permission/i.test(message)) return "У токена нет прав на запись в этот репозиторий.";
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|fetch failed|network/i.test(message)) {
    return "Сервер не смог связаться с репозиторием: изменения сохранены локально, отправьте их позже.";
  }
  return message;
}

async function writePushState(root: string, state: PushState) {
  const file = path.join(root, ".git", PUSH_STATE_FILE);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("[changes] не удалось записать состояние отправки", error);
  }
}

export async function readPushState(root: string): Promise<PushState | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, ".git", PUSH_STATE_FILE), "utf8")) as PushState;
    return parsed && typeof parsed.branch === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function fileStatus(newOid: string | null, oldOid: string | null): CheckpointFileStatus {
  if (!oldOid) return "added";
  if (!newOid) return "deleted";
  return "modified";
}

async function pushedCommits(root: string, branch: string) {
  try {
    const ref = await git.resolveRef({ fs, dir: root, ref: "refs/webnestdev/pushed/" + branch });
    return ref;
  } catch {
    return null;
  }
}

export type ListCheckpointsOptions = { branch: string; depth?: number };

export async function listCheckpoints(root: string, options: ListCheckpointsOptions): Promise<Checkpoint[]> {
  let entries: Awaited<ReturnType<typeof git.log>>;
  try {
    entries = await git.log({ fs, dir: root, ref: options.branch, depth: options.depth ?? 30, includeChanges: true });
  } catch (error) {
    // Пустая история — это не ошибка: проект ещё ничего не коммитил. Любая другая ошибка
    // остаётся ошибкой: молча показать «точек нет» вместо сломанной истории хуже всего.
    if (!await hasCommits(root)) return [];
    throw error;
  }
  const pushed = await pushedCommits(root, options.branch);
  const result: Checkpoint[] = [];
  for (const entry of entries) {
    const message = entry.commit.message;
    const kind = (trailer(message, "NestDev-Kind") as CheckpointKind | undefined) ?? "imported";
    const changes = (entry.commit.changes ?? []).filter((change): change is [string | null, string | null, string] => Boolean(change[2]));
    const files = changes.map(([newOid, oldOid, filepath]) => ({ path: filepath as string, status: fileStatus(newOid, oldOid) }));
    let isPushed = false;
    if (pushed) {
      try {
        isPushed = pushed === entry.oid || await git.isDescendent({ fs, dir: root, oid: pushed, ancestor: entry.oid });
      } catch {
        isPushed = false;
      }
    }
    result.push({
      sha: entry.oid,
      shortSha: entry.oid.slice(0, 7),
      subject: message.split("\n")[0] || "Изменения",
      message,
      kind,
      createdAt: new Date(entry.commit.committer.timestamp * 1000).toISOString(),
      ...(trailer(message, "NestDev-Run") ? { runId: trailer(message, "NestDev-Run") as string } : {}),
      ...(trailer(message, "NestDev-Conversation") ? { conversationId: trailer(message, "NestDev-Conversation") as string } : {}),
      ...(trailer(message, "NestDev-Reverted-To") ? { revertedTo: trailer(message, "NestDev-Reverted-To") as string } : {}),
      files: files.slice(0, 200),
      filesChanged: files.length,
      pushed: isPushed,
    });
  }
  return result;
}

async function treeFiles(root: string, ref: string) {
  const files = new Map<string, string>();
  await git.walk({
    fs,
    dir: root,
    trees: [git.TREE({ ref })],
    map: async (filepath, entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (await entry.type() === "tree") return;
      const oid = await entry.oid();
      if (oid) files.set(filepath, oid);
    },
  });
  return files;
}

async function writeWorktreeFile(root: string, filepath: string, content: Uint8Array) {
  // Путь приходит из git-дерева, то есть из данных, а не из кода: проверяются и `..`, и ссылки.
  const resolved = await writeFileInside(root, path.join(root, filepath), content);
  await openDirsForSandbox(root, path.dirname(resolved));
  await openFileForSandbox(resolved);
}

/**
 * Возвращает файлы проекта к состоянию коммита. Это откат «вперёд»: восстанавливается дерево
 * файлов, а сверху создаётся новый коммит. Удалённая история не переписывается, поэтому не
 * нужен force-push и чужие коммиты в ветке не теряются.
 */
export async function restoreCheckpoint(root: string, options: { sha: string; branch: string; subject: string }): Promise<Checkpoint> {
  let target: Map<string, string>;
  try {
    target = await treeFiles(root, options.sha);
  } catch (error) {
    throw new Error("Точка " + options.sha.slice(0, 7) + " не найдена в истории проекта: " + describe(error));
  }
  const [current, scan] = await Promise.all([
    treeFiles(root, "HEAD").catch(() => new Map<string, string>()),
    scanChanges(root),
  ]);
  const workdir = scan.workdir;

  let changed = 0;
  for (const [filepath, oid] of target) {
    if (workdir.get(filepath) === oid) continue;
    const { blob } = await git.readBlob({ fs, dir: root, oid });
    await writeWorktreeFile(root, filepath, blob);
    changed++;
  }
  for (const filepath of current.keys()) {
    if (target.has(filepath)) continue;
    await deleteInside(root, path.join(root, filepath));
    changed++;
  }
  if (!changed) throw new Error("Проект уже находится в состоянии этой точки");

  const checkpoint = await createCheckpoint(root, {
    branch: options.branch,
    subject: options.subject,
    kind: "rollback",
    revertedTo: options.sha,
  });
  if (!checkpoint) throw new Error("Нечего откатывать: изменения не найдены");
  return checkpoint;
}
