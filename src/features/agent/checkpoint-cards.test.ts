import { describe, expect, it } from "vitest";
import type { ChangeCheckpoint } from "../../lib/project-api";
import type { ChatMessage } from "../../lib/types";
import { checkpointCardsByMessage } from "./checkpoint-cards";

const messages: ChatMessage[] = [
  { role: "user", content: "Первая задача" },
  { role: "assistant", content: "Готово" },
  { role: "user", content: "Вторая задача" },
  { role: "assistant", content: "Тоже готово" },
];
const times = [
  "2026-11-22T10:00:00.000Z",
  "2026-11-22T10:01:00.000Z",
  "2026-11-22T11:00:00.000Z",
  "2026-11-22T11:01:00.000Z",
];

function checkpoint(overrides: Partial<ChangeCheckpoint>): ChangeCheckpoint {
  return {
    sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Задача", message: "Задача",
    kind: "task", createdAt: "2026-11-22T10:02:00.000Z", conversationId: "c1",
    files: [], filesChanged: 1, pushed: false, ...overrides,
  };
}

describe("карточки чекпоинтов в чате", () => {
  it("ставит каждую точку под ответом своего запуска", () => {
    const cards = checkpointCardsByMessage({
      checkpoints: [
        checkpoint({ sha: "b".repeat(40), shortSha: "bbbbbbb", createdAt: "2026-11-22T11:02:00.000Z" }),
        checkpoint({ sha: "a".repeat(40), shortSha: "aaaaaaa" }),
      ],
      conversationId: "c1",
      messages,
      messageTimes: times,
    });
    expect([...cards.keys()].sort((a, b) => a - b)).toEqual([1, 3]);
    expect(cards.get(1)?.shortSha).toBe("aaaaaaa");
    expect(cards.get(3)?.shortSha).toBe("bbbbbbb");
  });

  it("не показывает чужие чаты, откаты и ручные коммиты", () => {
    const cards = checkpointCardsByMessage({
      checkpoints: [
        checkpoint({ conversationId: "c2" }),
        checkpoint({ kind: "rollback", createdAt: "2026-11-22T11:02:00.000Z" }),
        checkpoint({ kind: "manual", createdAt: "2026-11-22T11:03:00.000Z" }),
      ],
      conversationId: "c1",
      messages,
      messageTimes: times,
    });
    expect(cards.size).toBe(0);
  });

  it("для старого чата без времени показывает последнюю точку у последнего ответа", () => {
    const cards = checkpointCardsByMessage({
      checkpoints: [checkpoint({ createdAt: "2026-11-22T11:02:00.000Z" })],
      conversationId: "c1",
      messages,
    });
    expect([...cards.keys()]).toEqual([3]);
  });
});
