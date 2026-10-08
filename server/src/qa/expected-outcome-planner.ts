import type { ParsedChange as ParsedQaChange } from "./change-parser.js";
import type { QaScenarioStep } from "./scenario-planner.js";

export type ExpectedOutcome = {
  kind: "url" | "text" | "visible" | "state";
  value: string;
  confidence: number;
  reason: string;
};

const outcomeText = (change: ParsedQaChange) => {
  const text = (change.text || "").toLowerCase();
  if (/cart|корзин|добавить/.test(text) || /cart|basket/.test(change.selector || "")) {
    return "cart";
  }
  if (/login|войти|sign in|signin/.test(text)) return "login";
  return "";
};

export function inferExpectedOutcomes(change: ParsedQaChange): ExpectedOutcome[] {
  if (change.action !== "added") return [];
  const outcomes: ExpectedOutcome[] = [];
  const semantic = outcomeText(change);

  if (change.element === "a" && change.route) {
    outcomes.push({
      kind: "url",
      value: change.route,
      confidence: 0.95,
      reason: "Added link contains an explicit destination route.",
    });
  }

  if (change.element === "button" && semantic === "cart") {
    outcomes.push({
      kind: "text",
      value: "cart",
      confidence: 0.72,
      reason: "Cart-related action should produce an observable cart-state change.",
    });
  }

  if (change.element === "button" && semantic === "login") {
    outcomes.push({
      kind: "url",
      value: "login",
      confidence: 0.68,
      reason: "Login action commonly changes the visible route.",
    });
  }

  return outcomes;
}

export function appendExpectedOutcomeSteps(steps: QaScenarioStep[], change: ParsedQaChange): QaScenarioStep[] {
  const outcomes = inferExpectedOutcomes(change);
  for (const outcome of outcomes) {
    if (outcome.kind === "url") steps.push({ action: "expectUrl", pattern: outcome.value });
    if (outcome.kind === "text") steps.push({ action: "expectText", text: outcome.value });
  }
  return steps;
}
