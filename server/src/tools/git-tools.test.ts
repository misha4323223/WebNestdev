import test from "node:test";
import assert from "node:assert/strict";
import { filterSecretStatus, gitBinaryMissing, redactSecretEnvDiff, secretPathspecExclusions } from "./git-tools.js";

test("diff секретного файла выбрасывается целиком, а обычный остаётся", () => {
  const output = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1..2 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/.env.local b/.env.local",
    "index 3..4 100644",
    "--- a/.env.local",
    "+++ b/.env.local",
    "@@ -1 +1 @@",
    "-STRIPE=sk_live_old",
    "+STRIPE=sk_live_new",
    "diff --git a/apps/web/.env.production b/apps/web/.env.production",
    "--- a/apps/web/.env.production",
    "+++ b/apps/web/.env.production",
    "+TOKEN=secret",
    "",
  ].join("\n");
  const redacted = redactSecretEnvDiff(output);
  assert.match(redacted, /src\/app\.ts/);
  assert.match(redacted, /\+new/);
  assert.doesNotMatch(redacted, /STRIPE|TOKEN|\.env/);
});

test("git add исключает секретные файлы по literal pathspec, не трогая шаблон", () => {
  const paths = secretPathspecExclusions([".env.local", "apps/web/.env.production"]);
  assert.deepEqual(paths, [
    ":(exclude,literal).env.local",
    ":(exclude,literal)apps/web/.env.production",
  ]);
  assert.ok(!paths.some((value) => value.includes(".env.example")));
});

test("статус не показывает секретные пути, включая переименование в секрет", () => {
  const output = [
    "## main",
    " M src/app.ts",
    "?? .env.local",
    "A  apps/web/.env",
    "R  config.ts -> .env.production",
    "?? .env.example",
  ].join("\n");
  const filtered = filterSecretStatus(output);
  assert.match(filtered, /## main/);
  assert.match(filtered, /src\/app\.ts/);
  assert.match(filtered, /\.env\.example/);
  assert.doesNotMatch(filtered, /\.env\.local|apps\/web\/\.env|\.env\.production/);
});

test("ответ оболочки «git: not found» распознаётся как отсутствие git в образе", () => {
  // Ровно то, что вернул контейнер песочницы: код 127 и сообщение оболочки вместо состояния репозитория.
  assert.equal(
    gitBinaryMissing({ ok: false, exitCode: 127, stderr: "/bin/sh: 1: git: not found\n" }),
    true,
  );
  assert.equal(
    gitBinaryMissing({ ok: false, exitCode: 1, stderr: "fatal: not a git repository (or any of the parent directories): .git" }),
    false,
  );
  assert.equal(gitBinaryMissing({ ok: true, exitCode: 0, stderr: "" }), false);
});
