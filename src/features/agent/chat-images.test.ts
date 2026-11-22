import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/types";
import { chatImagesByMessage } from "./agent-activity";

function screenshotConversation(output: Record<string, unknown>): ChatMessage[] {
  return [
    { role: "user", content: "Поправь главную" },
    { role: "assistant", content: "", tool_calls: [{ id: "shot-1", name: "browser.screenshot", arguments: { show: true } }] },
    { role: "tool", content: JSON.stringify(output), tool_call_id: "shot-1" },
    { role: "assistant", content: "Готово" },
  ];
}

describe("chatImagesByMessage", () => {
  it("показывает финальный снимок browser.screenshot под следующим ответом и сохраняет ссылку на страницу", () => {
    const messages = screenshotConversation({
      ok: true,
      shownInChat: true,
      viewport: "desktop",
      pageUrl: "/api/projects/p/preview/open/",
      screenshot: {
        path: ".webnestdev/screenshots/desktop.png",
        bucketUrl: "https://storage.example/desktop.png",
        url: "/api/projects/p/screenshot?path=desktop.png",
      },
    });
    const images = chatImagesByMessage(messages);
    expect(images.get(messages[3]!)).toEqual([{
      url: "https://storage.example/desktop.png",
      path: ".webnestdev/screenshots/desktop.png",
      prompt: "Снимок страницы desktop",
      pageUrl: "/api/projects/p/preview/open/",
      kind: "screenshot",
    }]);
  });

  it("не показывает промежуточный снимок без пометки shownInChat", () => {
    const messages = screenshotConversation({
      ok: true,
      viewport: "mobile",
      screenshot: { path: ".webnestdev/screenshots/mobile.png", url: "/api/projects/p/screenshot?path=mobile.png" },
    });
    expect(chatImagesByMessage(messages).size).toBe(0);
  });
});
