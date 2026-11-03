import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-search-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
await import("./filesystem-tools.js");
const { getTool } = await import("../tool-registry.js");

const project = await createProject("Search tools", undefined, "u1");
const context = { projectId: project.id, userId: "u1", runId: "run-search" };
const projectRoot = sandboxRootPath(project.id);
await mkdir(path.join(projectRoot, "src"), { recursive: true });
await mkdir(path.join(projectRoot, "src", "nested"), { recursive: true });
await mkdir(path.join(projectRoot, "node_modules", "pkg"), { recursive: true });
await mkdir(path.join(projectRoot, ".webnestdev", "screenshots"), { recursive: true });

const appSource = [
  'import { helper } from "./helper";',
  "",
  "export type User = { id: string };",
  "",
  "export interface Session {",
  "  token: string;",
  "}",
  "",
  "export class AuthService {",
  "  private cache = new Map<string, string>();",
  "",
  "  async login(name: string): Promise<string> {",
  "    return helper(name);",
  "  }",
  "}",
  "",
  "export function buildSession(user: User): Session {",
  "  return { token: user.id };",
  "}",
  "",
  "export const formatName = (name: string) => name.trim();",
  "",
].join("\n");

await writeFile(path.join(projectRoot, "src", "app.ts"), appSource);
await writeFile(path.join(projectRoot, "src", "helper.ts"), 'export function helper(name: string) {\n  return name.toLowerCase();\n}\n');
await writeFile(path.join(projectRoot, "src", "nested", "extra.ts"), 'export const marker = "needle";\n');
await writeFile(path.join(projectRoot, "node_modules", "pkg", "index.ts"), 'export const marker = "needle in dependency";\n');
await writeFile(path.join(projectRoot, ".env.local"), "SECRET=needle\n");
await writeFile(path.join(projectRoot, ".webnestdev", "screenshots", "runtime.txt"), "needle in service screenshot log\n");

async function tool(name: string, input: unknown) {
  const definition = getTool(name);
  assert.ok(definition?.execute, name + " не зарегистрирован");
  return definition.execute(input, context);
}

test("fs.grep ищет по исходникам и отдаёт file/line/column без вывода оболочки", async () => {
  const result = await tool("fs.grep", { pattern: "buildSession" }) as {
    matches?: Array<{ file: string; line: number; column: number; text: string }>;
    fileCount?: number;
    filesScanned?: number;
  };
  assert.equal(result.matches?.length, 1);
  assert.equal(result.matches?.[0].file, "src/app.ts");
  assert.equal(result.matches?.[0].line, appSource.split("\n").findIndex(line => line.includes("buildSession")) + 1);
  assert.equal(result.matches?.[0].column, 17);
  assert.match(result.matches?.[0].text ?? "", /buildSession/);
  assert.equal(result.fileCount, 1);
  assert.ok((result.filesScanned ?? 0) >= 2);
});

test("fs.grep пропускает зависимости, секреты, служебную папку и уважает glob", async () => {
  const all = await tool("fs.grep", { pattern: "needle" }) as { matches?: Array<{ file: string }> };
  assert.deepEqual(all.matches?.map(match => match.file), ["src/nested/extra.ts"]);

  const onlyNested = await tool("fs.grep", { pattern: "needle", path: "src", glob: "**/nested/*.ts" }) as { matches?: Array<{ file: string }> };
  assert.equal(onlyNested.matches?.length, 1);

  const literal = await tool("fs.grep", { pattern: "marker = \"needle\"", literal: true }) as { matches?: Array<{ file: string }> };
  assert.equal(literal.matches?.length, 1);
});

test("fs.grep понимает regex, ignoreCase и context", async () => {
  const result = await tool("fs.grep", { pattern: "function\\s+HELPER", ignoreCase: true, context: 1 }) as {
    matches?: Array<{ file: string; line: number; before?: unknown[]; after?: unknown[] }>;
  };
  const match = result.matches?.find(item => item.file === "src/helper.ts");
  assert.ok(match);
  assert.ok((match?.before?.length ?? 0) >= 0);
  assert.ok((match?.after?.length ?? 0) >= 1);
});

test("fs.grep останавливается на maxResults и честно помечает вывод", async () => {
  const result = await tool("fs.grep", { pattern: "export", maxResults: 2 }) as { matches?: unknown[]; truncated?: boolean };
  assert.equal(result.matches?.length, 2);
  assert.equal(result.truncated, true);
});

test("fs.outline строит карту функций, классов и методов с номерами строк", async () => {
  const result = await tool("fs.outline", { path: "src/app.ts" }) as {
    symbols?: Array<{ kind: string; name: string; line: number; container?: string }>;
    imports?: string[];
    supported?: boolean;
  };
  const symbols = result.symbols ?? [];
  const names = symbols.map(symbol => (symbol.container ? symbol.container + "." : "") + symbol.name);
  for (const expected of ["User", "Session", "AuthService", "AuthService.login", "buildSession", "formatName"]) {
    assert.ok(names.includes(expected), "нет символа " + expected + ": " + names.join(", "));
  }
  assert.equal(symbols.find(symbol => symbol.name === "buildSession")?.kind, "function");
  assert.deepEqual(result.imports, ["./helper"]);
  assert.equal(result.supported, undefined);
});

test("fs.outline по имени отдаёт тело символа, а не весь файл", async () => {
  const result = await tool("fs.outline", { path: "src/app.ts", name: "buildSession" }) as {
    symbols?: Array<{ name: string; line: number; endLine: number; source: string }>;
  };
  assert.equal(result.symbols?.length, 1);
  const symbol = result.symbols?.[0];
  assert.match(symbol?.source ?? "", /return \{ token: user\.id \}/);
  assert.doesNotMatch(symbol?.source ?? "", /class AuthService/);
  assert.ok((symbol?.endLine ?? 0) > (symbol?.line ?? 0));
});

test("fs.outline не обрывает метод с объектом в параметрах по умолчанию", async () => {
  await writeFile(path.join(projectRoot, "src", "options.ts"), [
    "export class Options {",
    "  resolve(options: { deep?: boolean } = {}): string {",
    '    return options.deep ? "deep" : "flat";',
    "  }",
    "}",
    "",
  ].join("\n"));
  const result = await tool("fs.outline", { path: "src/options.ts", name: "resolve" }) as {
    symbols?: Array<{ line: number; endLine: number; source: string }>;
  };
  assert.equal(result.symbols?.length, 1);
  assert.match(result.symbols?.[0].source ?? "", /return options\.deep/);
  assert.equal(result.symbols?.[0].endLine, 4);
});

test("fs.outline для неподдерживаемого языка объясняет, что делать", async () => {
  await writeFile(path.join(projectRoot, "notes.md"), "# Заметки\n");
  const result = await tool("fs.outline", { path: "notes.md" }) as { supported?: boolean; hint?: string };
  assert.equal(result.supported, false);
  assert.match(result.hint ?? "", /fs\.grep/);
});

test("fs.outline не раскрывает секретный файл", async () => {
  await assert.rejects(
    async () => tool("fs.outline", { path: ".env.local" }),
    /секрет/i,
  );
});
