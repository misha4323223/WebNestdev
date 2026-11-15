import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { MAX_INLINE_IMAGE_BYTES } from "../media/image-limits.js";
import { makeScreenshotContext } from "./screenshot-context.js";

test("большой PNG кодируется в отдельном контексте, а не в контексте снимка", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "screenshot-context-"));
  await mkdir(path.join(root, ".webnestdev/screenshots"), { recursive: true });
  const payload = Buffer.from("webp-copy");
  let contexts = 0;
  let closed = 0;
  const browser = {
    newContext: async () => {
      contexts++;
      return {
        newPage: async () => ({
          evaluate: async () => ({
            dataUrl: "data:image/webp;base64," + payload.toString("base64"),
            width: 1200,
            height: 800,
          }),
        }),
        close: async () => {
          closed++;
        },
      };
    },
  };
  // Контекст browser.newPage() запрещает вторую страницу — именно на этом ломался сценарий.
  const page = {
    context: () => ({
      browser: () => browser,
      newPage: async () => {
        throw new Error("Please use browser.newContext()");
      },
    }),
  } as unknown as Page;
  try {
    const result = await makeScreenshotContext(page, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1), {
      root,
      relative: ".webnestdev/screenshots/large.png",
    });
    assert.ok(result);
    assert.equal(contexts, 1);
    assert.equal(closed, 1);
    assert.match(result.path, /large\.context\.webp$/);
    assert.equal((await readFile(path.join(root, result.path))).toString(), "webp-copy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
