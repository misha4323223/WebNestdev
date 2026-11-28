import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EVAL_CHECKS } from "./checks.js";

/**
 * These guard rails exist because of a real miss: a single `\b` inside one of the template
 * literals became a backspace character in the generated script, so a correct project failed the
 * hidden check. A grader that fails for its own reasons makes every number in the report a lie.
 */
test("ни в одном скрипте проверки нет управляющих символов вместо регэкспов", () => {
  for (const [id, check] of Object.entries(EVAL_CHECKS)) {
    const position = [...check.script].findIndex(char => {
      const code = char.charCodeAt(0);
      return code < 32 && code !== 10 && code !== 9;
    });
    assert.equal(position, -1, `${id}: управляющий символ на позиции ${position} — вероятно, один обратный слэш вместо двух`);
  }
});

test("каждый скрипт проверки разбирается Node как ESM", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-checks-"));
  try {
    for (const [id, check] of Object.entries(EVAL_CHECKS)) {
      const file = path.join(dir, id + ".mjs");
      await writeFile(file, check.script, "utf8");
      assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }), `${id}: синтаксическая ошибка в скрипте проверки`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("у каждой задачи с проверкой есть непустой скрипт", () => {
  for (const [id, check] of Object.entries(EVAL_CHECKS)) {
    assert.ok(check.script.trim().length > 100, `${id}: скрипт подозрительно короткий`);
    assert.ok(check.script.includes("CHECK FAIL"), `${id}: скрипт не сообщает причину провала`);
  }
});
