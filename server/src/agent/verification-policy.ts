/**
 * Сколько раз запуску можно сказать, что проверка не прошла, прежде чем его остановить.
 *
 * Неудача автоматической проверки сюда не входит: она случается в том же шаге, что и правка, до
 * того как модель увидела диагностику, и в проекте, который ещё собирают, сборка падает до тех
 * пор, пока не появится последний файл (`tsc` до `npm install`, затем `Cannot find module './App'`).
 * Счёт этих падений заканчивал обычный запуск на третьем файле — на этом падал каркас лендинга.
 * Считается другое: шаг, который попытался завершить задачу при непройденной проверке.
 */
export const MAX_VERIFICATION_ATTEMPTS = 3;

/** Откуда пришёл отказ проверки: автопроверка после правки, вызов модели или попытка завершить. */
export type VerificationFailureSource = "auto" | "tool" | "finish";

/**
 * The new count of consecutive failures. An automatic failure keeps the count: the model has not
 * had its turn to fix anything yet, and scaffolding a project is a series of builds that cannot
 * succeed. A failed explicit check and an attempt to finish are the model's own claims, so they
 * do count — for browser QA the same rule applies.
 */
export function countVerificationFailure(current: number, source: VerificationFailureSource) {
  return source === "auto" ? current : current + 1;
}

/** Короткая причина последнего отказа — чтобы сообщение об остановке говорило, на чём именно. */
export function verificationFailureSummary(output: unknown) {
  if (typeof output !== "object" || output === null) return "";
  const value = output as Record<string, unknown>;
  const direct = [value.reason, value.error].find(item => typeof item === "string" && item.trim());
  if (typeof direct === "string") return clip(direct);
  for (const stream of [value.stderr, value.stdout]) {
    if (typeof stream !== "string") continue;
    const line = stream.split("\n").map(item => item.trim()).filter(Boolean).at(-1);
    if (line) return clip(line);
  }
  return "";
}

const MAX_SUMMARY_CHARS = 300;

function clip(text: string) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > MAX_SUMMARY_CHARS ? value.slice(0, MAX_SUMMARY_CHARS - 1) + "…" : value;
}

/**
 * Сборка в автоматической проверке — только когда проект её объявил. У статической страницы без
 * `package.json` шага сборки нет, а `npm run build` в ней падает с `ENOENT …/package.json`: это
 * свойство проекта, а не дефект, и раньше такая проверка считалась проваленной всегда.
 */
export function verificationBuildCommand(buildScript: string) {
  return buildScript.trim() ? "npm run build" : "";
}

export type CommandResultLike = { ok?: unknown; exitCode?: unknown; signal?: unknown };

export function commandSucceeded(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const result = output as CommandResultLike;
  return result.ok === true && result.exitCode === 0 && result.signal == null;
}

/**
 * Derive a safe smoke-test route from a changed source file.
 * Files that cannot be mapped confidently to a page fall back to "/".
 */
export function routeFromMutation(name: string, args: Record<string, unknown>): string {
  if (name !== "fs.write" && name !== "fs.rename" && name !== "fs.delete") return "/";
  const value = typeof args.path === "string" ? args.path : typeof args.to === "string" ? args.to : "";
  const normalized = value.replace(/^\.\//, "").replace(/\.(tsx?|jsx?|html?)$/i, "");

  const pagesMatch = normalized.match(/(?:^|\/)pages\/(.+)$/i);
  if (pagesMatch) {
    let page = pagesMatch[1];
    if (/^_(app|document)$/i.test(page)) return "/";
    page = page.replace(/\/index$/i, "");
    if (/^index$/i.test(page)) return "/";
    page = page.replace(/\[(\.\.\.)?\[?([^\]]+)\]?\]/g, "test");
    return page ? normalizeRoute("/" + page) : "/";
  }

  const appMatch = normalized.match(/(?:^|\/)app\/(.+)$/i);
  if (!appMatch) return "/";
  let page = appMatch[1];
  if (/^(page|layout|loading|error|not-found|template|default)$/i.test(page)) return "/";
  if (!/\/page$/i.test(page)) return "/";
  page = page.replace(/\/page$/i, "");
  page = page.replace(/\[(\.\.\.)?\[?([^\]]+)\]?\]/g, "test");
  return page ? normalizeRoute("/" + page) : "/";
}

function normalizeRoute(route: string): string {
  return route.replace(/\/+/g, "/").replace(/\/index$/i, "") || "/";
}

export function shouldRunBrowserRuntime(name: string, args: Record<string, unknown>): boolean {
  if (name === "fs.write" || name === "fs.rename" || name === "fs.delete") {
    const value = typeof args.path === "string" ? args.path : typeof args.to === "string" ? args.to : "";
    return /\.(tsx?|jsx?|html?|css|scss|vue|svelte)$/i.test(value) || /^(src|app|pages|components)\//i.test(value);
  }
  if (name === "terminal.exec") {
    const command = typeof args.command === "string" ? args.command : "";
    return /(^|\s)(npm\s+(run|install)|pnpm\s+(run|install)|yarn\s+(run|install)|vite|next|react|webpack|tsc)\b/i.test(command);
  }
  return name === "npm.install";
}
