import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveStoredSecretValues } from "../secrets/secret-store.js";
import { redactPreviewError, redactPreviewLog } from "./log-redaction.js";

const KEY = "a".repeat(64);

async function withSecretProject(action: (projectId: string) => Promise<void>) {
  const previousDir = process.env.WEBNESTDEV_DATA_DIR;
  const previousKey = process.env.WEBNESTDEV_ENCRYPTION_KEY;
  const root = await mkdtemp(path.join(tmpdir(), "wnd-preview-redact-"));
  process.env.WEBNESTDEV_DATA_DIR = root;
  process.env.WEBNESTDEV_ENCRYPTION_KEY = KEY;
  const projectId = "preview-redact-" + process.pid;
  try {
    await saveStoredSecretValues(projectId, {
      ".env.local": { TOKEN: "super-secret-token-12345", SHORT: "abc" },
    });
    await action(projectId);
  } finally {
    if (previousDir === undefined) delete process.env.WEBNESTDEV_DATA_DIR;
    else process.env.WEBNESTDEV_DATA_DIR = previousDir;
    if (previousKey === undefined) delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
    else process.env.WEBNESTDEV_ENCRYPTION_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
}

test("значение секрета вырезается из лога, ANSI и путь песочницы убираются", async () => {
  await withSecretProject(async projectId => {
    const text = "\u001b[31msuper-secret-token-12345\u001b[0m /var/lib/webnestdev/sandboxes/project-x/index.js";
    const result = await redactPreviewLog(projectId, text);
    assert.doesNotMatch(result, /super-secret-token-12345/);
    assert.match(result, /\[redacted\]/);
    assert.match(result, /<project>\/index\.js/);
    assert.doesNotMatch(result, /\u001b\[/);
  });
});

test("короткое значение не режется: цена ложных совпадений выше", async () => {
  await withSecretProject(async projectId => {
    const result = await redactPreviewLog(projectId, "port abc is ready");
    assert.equal(result, "port abc is ready");
  });
});

test("ошибка запуска теряет значение секрета, но сохраняет тип", async () => {
  await withSecretProject(async projectId => {
    const error = new Error("сборка упала: super-secret-token-12345");
    const safe = await redactPreviewError(projectId, error);
    assert.equal(safe, error);
    assert.doesNotMatch(error.message, /super-secret-token-12345/);
    assert.match(error.message, /\[redacted\]/);
  });
});
