/**
 * Build script shared by the API-shaped fixtures.
 *
 * It does two real things a project build does: checks the syntax of every module and leaves a
 * built page in `dist/`. The second part matters for the product path under test — the static
 * preview serves `dist/index.html`, and a repository whose build produces nothing makes the
 * runtime's own verification fail before the agent's work is even considered.
 */
export const BUILD_DIST = `import { mkdir, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const source = path.join(process.cwd(), "src");
const files = (await readdir(source)).filter(name => name.endsWith(".mjs"));
for (const file of files) {
  execFileSync(process.execPath, ["--check", path.join(source, file)], { stdio: "inherit" });
}
await mkdir(path.join(process.cwd(), "dist"), { recursive: true });
await writeFile(
  path.join(process.cwd(), "dist", "index.html"),
  "<!doctype html><html lang=\\"ru\\"><head><meta charset=\\"utf-8\\"><title>Проект</title></head>" +
    "<body><main><h1>Проект собран</h1><p>Модулей: " + files.length + "</p></main></body></html>\\n",
);
console.log("build: " + files.length + " модулей, dist/index.html готов");
`;
