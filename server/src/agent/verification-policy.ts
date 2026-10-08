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
  if (name !== "fs.write" && name !== "fs.rename") return "/";
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
  if (name === "fs.write" || name === "fs.rename") {
    const value = typeof args.path === "string" ? args.path : typeof args.to === "string" ? args.to : "";
    return /\.(tsx?|jsx?|html?|css|scss|vue|svelte)$/i.test(value) || /^(src|app|pages|components)\//i.test(value);
  }
  if (name === "terminal.exec") {
    const command = typeof args.command === "string" ? args.command : "";
    return /(^|\s)(npm\s+(run|install)|pnpm\s+(run|install)|yarn\s+(run|install)|vite|next|react|webpack|tsc)\b/i.test(command);
  }
  return name === "npm.install";
}
