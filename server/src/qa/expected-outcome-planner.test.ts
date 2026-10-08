import test from "node:test";
import assert from "node:assert/strict";
import { inferExpectedOutcomes, appendExpectedOutcomeSteps } from "./expected-outcome-planner.js";

test("infers a cart result from a cart button", () => {
  const change = {
    kind: "ui-element",
    action: "added",
    element: "button",
    selector: '[data-action="cart"]',
    text: "Добавить в корзину",
    evidence: "",
  } as const;
  const outcomes = inferExpectedOutcomes(change);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].kind, "text");
  assert.equal(outcomes[0].value, "cart");
});

test("adds a URL assertion for an explicit link route", () => {
  const change = {
    kind: "ui-element",
    action: "added",
    element: "a",
    selector: 'a[name="checkout"]',
    route: "/checkout",
    evidence: "",
  } as const;
  const steps: any[] = [{ action: "click", selector: change.selector }];
  appendExpectedOutcomeSteps(steps, change);
  assert.deepEqual(steps.at(-1), { action: "expectUrl", pattern: "/checkout" });
});
