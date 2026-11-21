/**
 * Planner mode is read-only. This file is the single source of truth for that rule.
 *
 * The old implementation kept a denylist of mutating tools; a new tool silently became allowed
 * until someone remembered to add it. Here the default is deny: a tool is visible to the planner
 * only when it is listed as read-only, or when its input is checked as conditional (a GET request,
 * an inspection command, a read-only memory action or a theme read). Unknown tools are denied.
 */

/** Tools that never change the project, the account, the plan or an external system. */
const PLANNER_READ_TOOLS = new Set([
  "project.list_files", "project.stat", "project.assets", "project.verify",
  "fs.list", "fs.read", "fs.grep", "fs.outline",
  "terminal.tail", "terminal.jobs",
  "git.status", "git.diff", "git.log", "git.branch",
  "preview.status", "preview.logs",
  "seo.templates",
  "database.status",
  "service.status", "service.secrets",
  "deploy.status", "deploy.check",
  "domain.check", "domain.list",
  "cloud.status", "cloud.catalog",
  "yandex.status", "yandex.resources",
  "expo.status",
  // Browser execution and screenshots write files or change app state; planner gets only the
  // HTTP/HTML inspection. Notes are a real project write and are not part of read-only planning.
  "browser.inspect", "browser.perf",
  "image.view", "image.inspect",
  "web.search", "web.read",
  "repo.map", "repo.find",
  "note.find", "chat.history",
  "plan.update", "plan.milestones", "question.ask",
  "ui.render", "agent.scout",
]);

/**
 * Tools whose input decides whether the call is a read. They are in the catalog because the planner
 * needs them for inspection and planning, but `changesSomething` refuses writes.
 */
const PLANNER_CONDITIONAL_TOOLS = new Set([
  "terminal.exec",
  "project.memory",
  "net.request",
  "yandex.request",
  "design.theme",
]);

/** Tools that change the project or platform even when their input looks harmless. */
export const MUTATING_TOOLS = new Set([
  "fs.write", "fs.edit", "fs.rename", "fs.delete",
  "terminal.exec", "terminal.start", "terminal.stop",
  "npm.install", "pip.install", "net.download",
  "database.env", "database.client", "service.env",
  "git.pull", "git.add", "git.commit",
  "preview.start", "preview.stop",
  "project.check", "project.test", "image.generate",
  "secrets.request", "access.request", "deploy.plan", "cloud.request", "domain.request",
  "expo.setup", "expo.build", "service.env",
]);

/** Visible in the planner catalog, but still subject to the input check. */
export function plannerToolVisible(name: string): boolean {
  return PLANNER_READ_TOOLS.has(name) || PLANNER_CONDITIONAL_TOOLS.has(name);
}

/**
 * Planner mode still has to read the project, so plain inspection commands are allowed while
 * everything that writes is refused. Anything chained or piped is refused too: one command, one
 * answer, with no room for a write hidden behind a pipe.
 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "tree", "pwd", "file", "stat", "du",
  "df", "which", "whereis", "echo", "jq", "diff", "sort", "cut", "basename", "dirname", "realpath",
  "eslint", "prettier",
]);
const WRITE_MARKERS = [
  ">", "<", "tee ", "sed -i", "perl -i", "--in-place", "--write", "--fix", "--output", "rm ",
  "rmdir ", "mv ", "cp ", "mkdir ", "touch ", "truncate ", "chmod ", "chown ", "ln ", "dd ", "patch ",
  "git add", "git commit", "git push", "git pull", "git fetch", "git clone", "git checkout",
  "git switch", "git restore", "git reset", "git clean", "git merge", "git rebase", "git rm", "git mv",
  "npm i ", "npm install", "npm ci", "npm run", "npm exec", "yarn add", "pnpm add", "bun add", "bun run",
  "pip install", "python -c", "node -e", "node --eval", "curl ", "wget ", "ssh ", "scp ", "sudo ",
  "kill ", "systemctl ", "docker ",
];

function isReadOnlyFind(args: string[]) {
  const unsafe = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];
  return !args.some(arg => unsafe.some(flag => arg === flag || arg.startsWith(flag + "=")));
}

function isReadOnlyGit(args: string[]) {
  let index = 0;
  while (args[index] && /^--(no-pager|literal-pathspecs|no-replace-objects)$/.test(args[index])) index++;
  const sub = args[index];
  const rest = args.slice(index + 1);
  if (!sub) return false;
  const readSubs = new Set([
    "status", "diff", "log", "show", "blame", "grep", "shortlog", "describe", "rev-parse", "ls-files",
    "ls-tree", "cat-file", "merge-base", "name-rev", "show-ref", "for-each-ref", "count-objects",
    "diff-tree", "whatchanged",
  ]);
  if (readSubs.has(sub)) {
    return !rest.some(arg => /^(--output|--ext-diff|--textconv|--open-files-in-pager|--paginate)(=|$)/.test(arg));
  }
  if (sub === "branch") return rest.every(arg => /^(--list|--show-current|-a|-r|-v|--verbose)$/.test(arg));
  if (sub === "tag") {
    return rest.length === 0 || ((rest[0] === "-l" || rest[0] === "--list") && rest.slice(1).every(arg => !arg.startsWith("-")));
  }
  if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  if (sub === "config") return rest[0] === "--get" || rest[0] === "--get-all" || rest[0] === "--list" || rest[0] === "-l";
  if (sub === "worktree") return rest[0] === "list";
  return false;
}

function isReadOnlyCommand(command: string) {
  const value = command.trim();
  if (!value) return false;
  // Newline, command substitution and input redirection are multiple commands or a read outside
  // the project, even when the first word looks harmless.
  if (/[;&|\n\r<>`]/.test(value) || value.includes("$(")) return false;
  if (WRITE_MARKERS.some(marker => value.includes(marker))) return false;
  const tokens = value.split(/\s+/);
  const head = tokens[0].replace(/^.*\//, "");
  const args = tokens.slice(1);
  if (head === "git") return isReadOnlyGit(args);
  if (head === "npm") return args.length > 0 && ["ls", "list", "ll", "la"].includes(args[0]);
  if (head === "find") return isReadOnlyFind(args);
  if (head === "grep" || head === "rg") return !args.some(arg => /^--pre(=|$)/.test(arg));
  if (head === "sort") return !args.some(arg => /^(-o|--output|--compress-program)/.test(arg));
  if (head === "diff") return !args.some(arg => /^(-o|--output)/.test(arg));
  if (head === "tree") return !args.some(arg => /^(-o|--output)/.test(arg));
  return READ_ONLY_COMMANDS.has(head);
}

/**
 * Planner mode is read-only, so any call that changes something is refused. The default is true:
 * a tool not listed in the read/conditional metadata is treated as mutating until someone makes its
 * policy explicit. `yandex.request` and `net.request` read with GET/HEAD and change the external
 * account with every other method; `terminal.exec` only inspects when the command is on the list.
 */
export function changesSomething(name: string, input: unknown): boolean {
  if (PLANNER_READ_TOOLS.has(name)) return false;
  if (name === "terminal.exec") {
    const command = (input as { command?: unknown } | null)?.command;
    return typeof command !== "string" || !isReadOnlyCommand(command);
  }
  if (name === "project.memory") {
    return (input as { action?: unknown } | null)?.action === "write";
  }
  if (name === "design.theme") {
    const value = (input as { tokens?: unknown; create?: unknown } | null) ?? {};
    return value.create === true || (value.tokens !== undefined && value.tokens !== null);
  }
  if (name === "net.request" || name === "yandex.request") {
    const method = (input as { method?: unknown } | null)?.method;
    if (typeof method !== "string") return false;
    return method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD";
  }
  // Unknown tools and all explicit writers are denied in planner mode.
  return true;
}
