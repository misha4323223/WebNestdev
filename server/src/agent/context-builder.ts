import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import type { Project } from "../project-store.js";
import { runInSandbox } from "../sandbox-worker.js";

const MAX_TREE_ENTRIES = 500;
const MAX_TREE_CHARS = 9000;
const MAX_PACKAGE_CHARS = 6000;

type TreeEntry = { path: string; type: "file" | "directory"; size?: number };

async function collectTree(root: string): Promise<TreeEntry[]> {
  const result: TreeEntry[] = [];
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", ".turbo"]);
  async function walk(current: string, relative: string, depth: number) {
    if (result.length >= MAX_TREE_ENTRIES || depth > 8) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= MAX_TREE_ENTRIES || ignored.has(entry.name)) continue;
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: childRelative + "/", type: "directory" });
        await walk(child, childRelative, depth + 1);
      } else {
        let size: number | undefined;
        try { size = (await stat(child)).size; } catch {}
        result.push({ path: childRelative, type: "file", size });
      }
    }
  }
  await walk(root, "", 0);
  return result;
}

function packageSummary(raw: string): string {
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const pick = (key: string) => {
      const value = pkg[key];
      return value && typeof value === "object" ? Object.keys(value as object) : [];
    };
    return JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      private: pkg.private,
      packageManager: pkg.packageManager,
      workspaces: pkg.workspaces,
      scripts: pkg.scripts,
      dependencies: pick("dependencies"),
      devDependencies: pick("devDependencies"),
    }, null, 2).slice(0, MAX_PACKAGE_CHARS);
  } catch {
    return raw.slice(0, MAX_PACKAGE_CHARS);
  }
}

export async function buildProjectContext(project: Project, userId: string): Promise<string> {
  const sandbox = await getSandbox(project.id, userId);
  const tree = await collectTree(sandbox.root);
  const treeText = tree.map(entry => {
    const size = entry.size == null ? "" : \` (${entry.size} bytes)\`;
    return \`- ${entry.path}${size}\`;
  }).join("\n").slice(0, MAX_TREE_CHARS);

  let packageText = "package.json: not found";
  try { packageText = "package.json:\n" + packageSummary(await readFile(path.join(sandbox.root, "package.json"), "utf8")); } catch {}

  let gitStatus = "unavailable";
  try { gitStatus = String(await runInSandbox(sandbox, "git status --short --branch", sandbox.root)).slice(0, 3000); } catch {}

  const keyConfigs = tree
    .filter(entry => /(^|\\/)(package\\.json|tsconfig[^/]*\\.json|vite\\.config\\.[^/]+|next\\.config\\.[^/]+|nuxt\\.config\\.[^/]+|astro\\.config\\.[^/]+|webpack\\.config\\.[^/]+|docker-compose[^/]*|Dockerfile|\\.env\\.example)$/.test(entry.path))
    .map(entry => entry.path)
    .slice(0, 80);

  return [
    "PROJECT CONTEXT",
    \`Project: ${project.name}\`,
    \`Project ID: ${project.id}\`,
    project.github ? \`GitHub: ${project.github.fullName} (default branch: ${project.github.defaultBranch})\` : "GitHub: not connected",
    "",
    "Key configuration files:",
    keyConfigs.length ? keyConfigs.map(file => "- " + file).join("\n") : "- none detected",
    "",
    packageText,
    "",
    "Git status:",
    gitStatus || "clean",
    "",
    \`Project tree (bounded to ${MAX_TREE_ENTRIES} entries):\`,
    treeText || "- empty project",
    "",
    "Use this as orientation, not as a substitute for reading source files. Inspect relevant files with filesystem tools before editing. Do not assume files not shown here are absent.",
  ].join("\n");
}
