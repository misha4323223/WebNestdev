import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_REPOSITORY_IMPORT_BYTES,
  PLUS_REPOSITORY_IMPORT_BYTES,
  TEAM_REPOSITORY_IMPORT_BYTES,
  functionLimitFor,
  functionLimitMessage,
  repositoryImportLimitFor,
  repositoryImportLimitMessage,
  repositoryPushAllowedFor,
} from "./plans.js";

test("бесплатный тариф импортирует до 50 МБ и не отправляет коммиты обратно", () => {
  assert.equal(FREE_REPOSITORY_IMPORT_BYTES, 50 * 1024 * 1024);
  assert.equal(repositoryImportLimitFor("free"), 50 * 1024 * 1024);
  assert.equal(PLUS_REPOSITORY_IMPORT_BYTES, 250 * 1024 * 1024);
  assert.equal(repositoryImportLimitFor("pro"), 250 * 1024 * 1024);
  assert.equal(TEAM_REPOSITORY_IMPORT_BYTES, 500 * 1024 * 1024);
  assert.equal(repositoryImportLimitFor("team"), 500 * 1024 * 1024);
  assert.match(repositoryImportLimitMessage("pro", 300 * 1024 * 1024, 250 * 1024 * 1024), /«Плюс».*250 МБ/);
  assert.equal(repositoryPushAllowedFor("free"), false);
  assert.equal(repositoryPushAllowedFor("pro"), true);
  assert.equal(repositoryPushAllowedFor("team"), true);
});

test("функции ограничены по тарифу на один сайт", () => {
  assert.equal(functionLimitFor("free"), 0);
  assert.equal(functionLimitFor("pro"), 5);
  assert.equal(functionLimitFor("team"), 25);
  assert.match(functionLimitMessage("pro", 6), /до 5 функций.*6/);
});
