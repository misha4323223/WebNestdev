import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-edit-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
await import("./filesystem-tools.js");
const { getTool } = await import("../tool-registry.js");

const project = await createProject("Edit tools", undefined, "u1");
const context = { projectId: project.id, userId: "u1", runId: "run-edit" };
const projectRoot = sandboxRootPath(project.id);
await mkdir(projectRoot, { recursive: true });

async function tool(name: string, input: unknown) {
  const definition = getTool(name);
  assert.ok(definition?.execute, name + " не зарегистрирован");
  return definition.execute(input, context);
}

test("fs.edit заменяет точный уникальный фрагмент и сохраняет остальной файл", async () => {
  await tool("fs.write", { path: "app.ts", content: "const a = 1;\nconst b = 2;\n" });
  const result = await tool("fs.edit", {
    path: "app.ts",
    oldText: "const b = 2;",
    newText: "const b = 3;",
  }) as { replacements?: number; bytes?: number };
  assert.equal(result.replacements, 1);
  assert.ok((result.bytes ?? 0) > 0);
  assert.equal(await readFile(path.join(projectRoot, "app.ts"), "utf8"), "const a = 1;\nconst b = 3;\n");
});

test("неоднозначный фрагмент отклоняется, пока replaceAll не разрешён явно", async () => {
  await tool("fs.write", { path: "repeat.ts", content: "const x = 1;\nconst x = 2;\n" });
  await assert.rejects(
    async () => tool("fs.edit", { path: "repeat.ts", oldText: "const x", newText: "let x" }),
    /встречается 2 раз/,
  );
  const result = await tool("fs.edit", {
    path: "repeat.ts",
    oldText: "const x",
    newText: "let x",
    replaceAll: true,
  }) as { replacements?: number };
  assert.equal(result.replacements, 2);
  assert.equal(await readFile(path.join(projectRoot, "repeat.ts"), "utf8"), "let x = 1;\nlet x = 2;\n");
});

test("отсутствующий фрагмент — понятная ошибка, а не молчаливая запись", async () => {
  await assert.rejects(
    async () => tool("fs.edit", { path: "app.ts", oldText: "const z = 9;", newText: "const z = 0;" }),
    /не найден/,
  );
  await assert.rejects(
    async () => tool("fs.edit", { path: "app.ts", oldText: "", newText: "x" }),
    /пустым/,
  );
});

test("fs.edit не может изменить секретный файл", async () => {
  await assert.rejects(
    async () => tool("fs.edit", { path: ".env.local", oldText: "A=1", newText: "A=2" }),
    /секрет/i,
  );
});

test("повторное чтение неизменённого файла отдаёт короткий кэш, а fresh — полный текст", async () => {
  const content = "line\n".repeat(300);
  await tool("fs.write", { path: "large.txt", content });
  const first = await tool("fs.read", { path: "large.txt" }) as { content?: string; cached?: boolean; totalChars?: number };
  assert.equal(first.cached, undefined);
  assert.equal(first.content, content);

  const second = await tool("fs.read", { path: "large.txt" }) as { content?: string; cached?: boolean; previewChars?: number };
  assert.equal(second.cached, true);
  assert.equal(second.previewChars, 800);
  assert.ok((second.content?.length ?? 0) <= 800);

  const fresh = await tool("fs.read", { path: "large.txt", fresh: true }) as { content?: string; cached?: boolean };
  assert.equal(fresh.cached, undefined);
  assert.equal(fresh.content, content);
});

test("fs.read в построчном режиме отдаёт строки 900–1020, а не 120 символов", async () => {
  const content = Array.from({ length: 1200 }, (_, index) => "line " + (index + 1)).join("\n") + "\n";
  await tool("fs.write", { path: "long.ts", content });
  const result = await tool("fs.read", { path: "long.ts", lineStart: 900, lineLimit: 120 }) as {
    content?: string;
    mode?: string;
    totalLines?: number;
    lineStart?: number;
    lineEnd?: number;
    nextLineStart?: number;
    truncated?: boolean;
  };
  assert.equal(result.mode, "lines");
  assert.equal(result.totalLines, 1200);
  assert.equal(result.lineStart, 900);
  assert.equal(result.lineEnd, 1019);
  assert.equal(result.nextLineStart, 1020);
  assert.equal(result.truncated, true);
  assert.equal(result.content?.split("\n")[0], "line 900");
  assert.equal(result.content?.split("\n").length, 120);
});

test("fs.read за концом файла говорит, сколько строк, вместо возврата последней", async () => {
  await tool("fs.write", { path: "short.ts", content: "one\ntwo\n" });
  const result = await tool("fs.read", { path: "short.ts", lineStart: 10, lineLimit: 5 }) as {
    content?: string;
    totalLines?: number;
    lineStart?: number;
    lineEnd?: number;
    hint?: string;
  };
  assert.equal(result.content, "");
  assert.equal(result.totalLines, 2);
  assert.equal(result.lineStart, 10);
  assert.equal(result.lineEnd, 0);
  assert.match(result.hint ?? "", /2 строк/);
});

test("fs.edit подтверждает правку диффом и временем изменения", async () => {
  await tool("fs.write", { path: "diff.ts", content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" });
  const result = await tool("fs.edit", {
    path: "diff.ts",
    oldText: "const b = 2;",
    newText: "const b = 20;",
  }) as { diff?: string; mtime?: string };
  assert.match(result.diff ?? "", /^--- a\/diff\.ts/m);
  assert.match(result.diff ?? "", /^-const b = 2;$/m);
  assert.match(result.diff ?? "", /^\+const b = 20;$/m);
  assert.ok(result.mtime && !Number.isNaN(Date.parse(result.mtime)), "mtime должен быть ISO-датой");
});

test("правка инвалидирует кэш: следующее чтение возвращает новый файл целиком", async () => {
  await tool("fs.write", { path: "cache.ts", content: "export const value = 1;\n" });
  await tool("fs.read", { path: "cache.ts" });
  await tool("fs.edit", { path: "cache.ts", oldText: "value = 1", newText: "value = 2" });
  const after = await tool("fs.read", { path: "cache.ts" }) as { content?: string; cached?: boolean };
  assert.equal(after.cached, undefined);
  assert.match(after.content ?? "", /value = 2/);
});
