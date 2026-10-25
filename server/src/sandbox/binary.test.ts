import test from "node:test";
import assert from "node:assert/strict";
import { looksBinary } from "./binary.js";

test("обычный текст и русский UTF-8 читаются как текст", () => {
  assert.equal(looksBinary(Buffer.from("hello\nworld\n")), false);
  assert.equal(looksBinary(Buffer.from("Привет, это обычный текст проекта.\n")), false);
  assert.equal(looksBinary(Buffer.from("{\"ok\":true,\"страница\":\"главная\"}")), false);
});

test("нулевой байт выдаёт двоичный файл", () => {
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])), true);
});

test("сжатые данные без нулей ловятся по символам замены", () => {
  assert.equal(looksBinary(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb])), true);
});

test("один повреждённый байт в тексте — ещё не двоичный файл", () => {
  const text = Buffer.concat([Buffer.from("x".repeat(500)), Buffer.from([0xff]), Buffer.from("y".repeat(500))]);
  assert.equal(looksBinary(text), false);
});

test("пустой файл — текст", () => {
  assert.equal(looksBinary(Buffer.alloc(0)), false);
});
