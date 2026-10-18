import test from "node:test";
import assert from "node:assert/strict";
import { encodeEnvValue } from "./env-value.js";
import { mergeEnvFile, removeEnvVariables } from "../database/env-file.js";

test("голый токен остаётся без кавычек", () => {
  assert.equal(encodeEnvValue("sk-live_51AbC-xyz.123"), "sk-live_51AbC-xyz.123");
});

test("пробелы, решётка и кавычки берутся в двойные кавычки и экранируются", () => {
  assert.equal(encodeEnvValue("  ключ с пробелом  "), '"ключ с пробелом"');
  assert.equal(encodeEnvValue('значение "в кавычках"'), '"значение \\"в кавычках\\""');
  assert.equal(encodeEnvValue("путь\\к\\ключу"), '"путь\\\\к\\\\ключу"');
});

test("многострочный ключ становится одной строкой с \\n", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
  assert.equal(encodeEnvValue(pem), '"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----"');
});

test("слияние файла заменяет нашу переменную и сохраняет остальные строки", () => {
  const existing = "# комментарий\nOTHER=1\nSTRIPE_SECRET_KEY=старое\n";
  const merged = mergeEnvFile(existing, { STRIPE_SECRET_KEY: encodeEnvValue("sk_live_new") });
  assert.equal(merged, "# комментарий\nOTHER=1\nSTRIPE_SECRET_KEY=sk_live_new\n");
});

test("многострочное значение не разрывает файл на лишние переменные", () => {
  const merged = mergeEnvFile("", { PRIVATE_KEY: encodeEnvValue("line1\nline2") });
  assert.equal(merged.split("\n").filter(Boolean).length, 1);
  assert.equal(merged, 'PRIVATE_KEY="line1\\nline2"\n');
});

test("замена понимает export и не оставляет хвост многострочного значения", () => {
  const existing = "# ключи\nexport PRIVATE_KEY=\"первая строка\nвторая строка\"\nOTHER=1\n";
  const merged = mergeEnvFile(existing, { PRIVATE_KEY: encodeEnvValue("новый ключ") });
  assert.equal(merged, '# ключи\nOTHER=1\nPRIVATE_KEY="новый ключ"\n');
});

test("удаление переменной сохраняет комментарии и соседние ключи", () => {
  const existing = "# комментарий\nKEEP=1\nGONE=2\nPRIVATE_KEY=\"a\nb\"\n";
  assert.equal(removeEnvVariables(existing, ["GONE", "PRIVATE_KEY"]), "# комментарий\nKEEP=1\n");
});
