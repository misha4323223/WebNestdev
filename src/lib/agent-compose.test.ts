import { afterEach, describe, expect, it } from "vitest";
import { AGENT_COMPOSE_EVENT, AGENT_DRAFT_EVENT, composeAgentDraft, composeAgentPrompt } from "./agent-compose";

describe("agent compose events", () => {
  let received: CustomEvent[] = [];
  const listener = (event: Event) => received.push(event as CustomEvent);

  afterEach(() => {
    window.removeEventListener(AGENT_COMPOSE_EVENT, listener);
    window.removeEventListener(AGENT_DRAFT_EVENT, listener);
    received = [];
  });

  it("dispatches trimmed prompt and draft text", () => {
    window.addEventListener(AGENT_COMPOSE_EVENT, listener);
    window.addEventListener(AGENT_DRAFT_EVENT, listener);

    composeAgentPrompt("  сделай крупнее  ");
    composeAgentDraft("  выбери этот элемент  ");

    expect(received.map(event => event.detail)).toEqual([
      { prompt: "сделай крупнее" },
      { draft: "выбери этот элемент" },
    ]);
  });

  it("ignores empty input", () => {
    window.addEventListener(AGENT_COMPOSE_EVENT, listener);
    window.addEventListener(AGENT_DRAFT_EVENT, listener);

    composeAgentPrompt("   ");
    composeAgentDraft("");

    expect(received).toHaveLength(0);
  });
});
