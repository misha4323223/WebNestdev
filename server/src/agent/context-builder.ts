import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { readFileInside } from "../sandbox/path-guard.js";
import type { Project } from "../project-store.js";
import { runInSandbox } from "../sandbox-worker.js";
import { isSecretProjectPath } from "../secrets/secret-paths.js";
import { deployPlanNotice, readDeployPlan } from "../deploy/deploy-plan.js";
import { isIgnoredProjectDir } from "../project-ignore.js";

const MAX_TREE_ENTRIES = 500;
const MAX_TREE_CHARS = 9000;
const MAX_PACKAGE_CHARS = 6000;

type TreeEntry = { path: string; type: "file" | "directory"; size?: number };

async function collectTree(root: string): Promise<TreeEntry[]> {
  const result: TreeEntry[] = [];

  async function walk(current: string, relative: string, depth: number) {
    if (result.length >= MAX_TREE_ENTRIES || depth > 8) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (result.length >= MAX_TREE_ENTRIES || isIgnoredProjectDir(entry.name)) continue;
      // Секреты не должны появляться в контексте даже как имя файла.
      if (isSecretProjectPath(entry.name)) continue;
      // Ссылка может вести наружу: в опись проекта она не попадает, а читать её запрещено.
      if (entry.isSymbolicLink()) continue;
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const child = path.join(current, entry.name);

      if (entry.isDirectory()) {
        result.push({ path: childRelative + "/", type: "directory" });
        await walk(child, childRelative, depth + 1);
      } else if (entry.isFile()) {
        let size: number | undefined;
        try { size = (await lstat(child)).size; } catch {}
        result.push({ path: childRelative, type: "file", size });
      }
    }
  }

  await walk(root, "", 0);
  return result;
}

export function packageSummary(raw: string): string {
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    // Версии — часть контракта: по снимку без них агент может поставить несовместимую
    // зависимость или решить, что пакета нет. Поэтому объект зависимостей сохраняется как есть,
    // а не превращается в список имён.
    const pick = (key: string) => {
      const value = pkg[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, version]) => typeof version === "string"),
      ) as Record<string, string>;
    };

    const summary = {
      name: pkg.name,
      version: pkg.version,
      private: pkg.private,
      packageManager: pkg.packageManager,
      workspaces: pkg.workspaces,
      scripts: pkg.scripts,
      dependencies: pick("dependencies"),
      devDependencies: pick("devDependencies"),
      engines: pkg.engines,
    };

    const pretty = JSON.stringify(summary, null, 2);
    if (pretty.length <= MAX_PACKAGE_CHARS) return pretty;
    const compact = JSON.stringify(summary);
    if (compact.length <= MAX_PACKAGE_CHARS) return compact;

    // Слишком большой package.json: сохраняем valid JSON, а не режем строку посередине объекта.
    // Сначала убираем devDependencies, затем ограничиваем сами карты зависимостей.
    const withoutDev = {
      ...summary,
      devDependencies: undefined,
      note: "devDependencies не показаны: package.json слишком велик для контекста",
    };
    const trimmed = JSON.stringify(withoutDev);
    if (trimmed.length <= MAX_PACKAGE_CHARS) return trimmed;

    const cap = (value: Record<string, string> | undefined) => value
      ? Object.fromEntries(Object.entries(value).slice(0, 80))
      : undefined;
    const dependencies = cap(summary.dependencies);
    const core = JSON.stringify({
      name: summary.name,
      version: summary.version,
      packageManager: summary.packageManager,
      workspaces: summary.workspaces,
      scripts: summary.scripts,
      dependencies,
      note: "Показаны первые 80 зависимостей; devDependencies пропущены — package.json слишком велик",
    });
    return core.length <= MAX_PACKAGE_CHARS
      ? core
      : JSON.stringify({
          name: summary.name,
          version: summary.version,
          packageManager: summary.packageManager,
          note: "package.json слишком велик для контекста; прочитайте файл через fs.read",
        });
  } catch {
    return raw.slice(0, MAX_PACKAGE_CHARS);
  }
}

export async function buildProjectContext(project: Project, userId: string): Promise<string> {
  const sandbox = await getSandbox(project.id, userId);
  const tree = await collectTree(sandbox.root);

  const treeText = tree.map(entry => {
    const size = entry.size == null ? "" : " (" + entry.size + " bytes)";
    return "- " + entry.path + size;
  }).join("\n").slice(0, MAX_TREE_CHARS);

  let packageText = "package.json: not found";
  try {
    packageText = "package.json:\n" + packageSummary(
      await readFileInside(sandbox.root, path.join(sandbox.root, "package.json")),
    );
  } catch {}

  let gitStatus = "unavailable";
  try {
    gitStatus = String(
      await runInSandbox(sandbox, "git status --short --branch", sandbox.root, { maskSecretEnvFiles: true }),
    ).slice(0, 3000);
  } catch {}

  const configPattern = /(^|\/)(package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|next\.config\.[^/]+|nuxt\.config\.[^/]+|astro\.config\.[^/]+|webpack\.config\.[^/]+|docker-compose[^/]*|Dockerfile|\.env\.example)$/;
  const keyConfigs = tree
    .filter(entry => configPattern.test(entry.path) && !isSecretProjectPath(entry.path))
    .map(entry => entry.path)
    .slice(0, 80);

  // План развёртывания — наоборот, включается: это закладка, ради которой файл и существует.
  // Сводка ограничена, а завершённый план занимает одну строку, поэтому старый деплой не
  // вытесняет из контекста текущую задачу.
  let deployNotice = "";
  try {
    deployNotice = deployPlanNotice(await readDeployPlan(sandbox.root));
  } catch (error) {
    console.error("Failed to read the deployment plan", error);
  }

  // TASKS.md намеренно не включается в контекст: список может быть длинным, а нужен редко.
  // Агент читает его сам через fs.read, когда запрос касается задач (правило — в SYSTEM_PROMPT).
  return [
    "PROJECT CONTEXT",
    "Project: " + project.name,
    "Project ID: " + project.id,
    project.github
      ? ({ github: "GitHub", gitlab: "GitLab", gitverse: "GitVerse", sourcecraft: "SourceCraft" }[project.github.provider ?? "github"] ?? "GitHub")
        + ": " + project.github.fullName + " (default branch: " + project.github.defaultBranch + ")"
      : "GitHub: not connected",
    "",
    "Key configuration files:",
    keyConfigs.length ? keyConfigs.map(file => "- " + file).join("\n") : "- none detected",
    ...(deployNotice ? ["", deployNotice] : []),
    "",
    packageText,
    "",
    "Git status:",
    gitStatus || "clean",
    "",
    "Project tree (bounded to " + MAX_TREE_ENTRIES + " entries):",
    treeText || "- empty project",
    "",
    "Use this as orientation, not as a substitute for reading source files. Inspect relevant files with filesystem tools before editing. Do not assume files not shown here are absent.",
  ].join("\n");
}
