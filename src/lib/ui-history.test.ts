import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types";
import { chatUiByMessage } from "./ui-history";

const blocks = [{
  type: "choice" as const,
  title: "Стек",
  options: [{ label: "React", prompt: "Сделай на React" }],
}];

function call(id: string): ChatMessage {
  return { role: "assistant", content: "", tool_calls: [{ id, name: "ui.render", arguments: { blocks } }] };
}

function result(id: string, ok = true): ChatMessage {
  return { role: "tool", content: JSON.stringify({ ok, rendered: ok }), tool_call_id: id };
}

describe("chatUiByMessage", () => {
  it("привязывает сохранённый интерфейс к следующему ответу агента", () => {
    const answer: ChatMessage = { role: "assistant", content: "Готово" };
    const messages: ChatMessage[] = [
      { role: "user", content: "Сделай" },
      call("ui-1"),
      result("ui-1"),
      answer,
    ];
    expect(chatUiByMessage(messages).get(answer)).toEqual(blocks);
  });

  it("не рисует интерфейс, если инструмент отверг схему или результата нет", () => {
    const answer: ChatMessage = { role: "assistant", content: "Готово" };
    const failed: ChatMessage[] = [call("ui-1"), result("ui-1", false), answer];
    expect(chatUiByMessage(failed).size).toBe(0);

    const interrupted: ChatMessage[] = [call("ui-2"), answer];
    expect(chatUiByMessage(interrupted).size).toBe(0);
  });

  it("без финального текста оставляет интерфейс на ходе с вызовом", () => {
    const assistant = call("ui-3");
    const messages: ChatMessage[] = [assistant, result("ui-3")];
    expect(chatUiByMessage(messages).get(assistant)).toEqual(blocks);
  });

  it("сохраняет все вызовы ui.render одного ответа, а не только последний", () => {
    const preview = {
      type: "preview" as const,
      title: "Экраны",
      images: [{ label: "Desktop", path: ".webnestdev/screenshots/desktop.png" }],
    };
    const first = call("ui-4");
    const second: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "ui-5", name: "ui.render", arguments: { blocks: [preview] } }],
    };
    const answer: ChatMessage = { role: "assistant", content: "Готово" };
    const messages: ChatMessage[] = [
      { role: "user", content: "Покажи интерфейс" },
      first,
      result("ui-4"),
      second,
      result("ui-5"),
      answer,
    ];
    expect(chatUiByMessage(messages).get(answer)).toEqual([...blocks, preview]);
  });

  it("сохраняет два ui.render в одном assistant tool_calls", () => {
    const preview = {
      type: "preview" as const,
      title: "Экраны",
      images: [{ label: "Desktop", path: ".webnestdev/screenshots/desktop.png" }],
    };
    const assistant: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "ui-6", name: "ui.render", arguments: { blocks } },
        { id: "ui-7", name: "ui.render", arguments: { blocks: [preview] } },
      ],
    };
    const answer: ChatMessage = { role: "assistant", content: "Готово" };
    const messages: ChatMessage[] = [assistant, result("ui-6"), result("ui-7"), answer];
    expect(chatUiByMessage(messages).get(answer)).toEqual([...blocks, preview]);
  });
});
