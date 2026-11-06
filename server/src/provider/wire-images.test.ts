import assert from "node:assert/strict";
import test from "node:test";
import { toWireMessages } from "./openai-compatible-provider.js";
import type { ChatMessage } from "../types.js";

/**
 * Картинка вложения должна уехать в запрос частью сообщения пользователя, а не отдельным
 * vision-запросом: именно второй путь и ломался с «провайдер вернул пустой ответ».
 */
test("изображение в сообщении становится частью image_url", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "инструкции" },
    { role: "user", content: "Что не так с экраном?", images: [{ contentType: "image/png", data: "AAAB" }] },
  ];
  const wire = toWireMessages(messages);
  assert.deepEqual(wire[0], { role: "system", content: "инструкции" });
  assert.deepEqual(wire[1], {
    role: "user",
    content: [
      { type: "text", text: "Что не так с экраном?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAB", detail: "high" } },
    ],
  });
});

test("сообщение без изображений остаётся строкой", () => {
  const wire = toWireMessages([{ role: "user", content: "привет" }]);
  assert.deepEqual(wire[0], { role: "user", content: "привет" });
});
