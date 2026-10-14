import test from "node:test";
import assert from "node:assert/strict";
import { newUserMessages } from "./agent-ws.js";
import type { ChatMessage } from "../types.js";

const stored: ChatMessage[] = [
  { role: "user", content: "сделай страницу" },
  { role: "assistant", content: "Готово." },
];

test("only the messages the conversation does not hold yet are appended", () => {
  const incoming = [
    { role: "user", content: "сделай страницу" },
    { role: "assistant", content: "Готово." },
    { role: "user", content: "добавь форму" },
  ];
  assert.deepEqual(newUserMessages(stored, incoming), [{ role: "user", content: "добавь форму" }]);
});

test("the same words sent twice are stored twice, not dropped", () => {
  const incoming = [
    { role: "user", content: "сделай страницу" },
    { role: "user", content: "продолжай" },
    { role: "user", content: "продолжай" },
  ];
  assert.deepEqual(newUserMessages(stored, incoming), [
    { role: "user", content: "продолжай" },
    { role: "user", content: "продолжай" },
  ]);
});

test("a history the conversation already holds appends nothing", () => {
  assert.deepEqual(newUserMessages(stored, [{ role: "user", content: "сделай страницу" }]), []);
});
