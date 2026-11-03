import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_REPOSITORY_IMPORT_BYTES,
  repositoryImportLimitFor,
  repositoryPushAllowedFor,
} from "./plans.js";

test("бесплатный тариф импортирует до 50 МБ и не отправляет коммиты обратно", () => {
  assert.equal(FREE_REPOSITORY_IMPORT_BYTES, 50 * 1024 * 1024);
  assert.equal(repositoryImportLimitFor("free"), 50 * 1024 * 1024);
  assert.equal(repositoryImportLimitFor("pro"), null);
  assert.equal(repositoryImportLimitFor("team"), null);
  assert.equal(repositoryPushAllowedFor("free"), false);
  assert.equal(repositoryPushAllowedFor("pro"), true);
  assert.equal(repositoryPushAllowedFor("team"), true);
});
