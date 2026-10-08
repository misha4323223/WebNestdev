import { test } from "node:test";
import assert from "node:assert/strict";
import { planQaScenario } from "./scenario-planner.js";
import type { ParsedChange } from "./change-parser.js";

const removedButton: ParsedChange = {
  kind: "ui-element",
  file: "src/App.tsx",
  action: "removed",
  element: "button",
  selector: '[data-testid="delete-account"]',
  text: "Delete account",
  evidence: '<button data-testid="delete-account">Delete account</button>',
};

test("planner asserts that removed UI elements are no longer visible", () => {
  const scenario = planQaScenario("Remove the delete account button", "/", "ui-element", 0.9, [removedButton]);
  assert.equal(scenario.steps[0].action, "goto");
  assert.ok(scenario.steps.some(step => step.action === "expectNotVisible" && step.selector === '[data-testid="delete-account"]'));
  assert.match(scenario.reason, /removed UI element/i);
});

test("planner creates an observable interaction for a newly added button", () => {
  const addedButton: ParsedChange = {
    ...removedButton,
    action: "added",
    selector: '[data-testid="add-to-cart"]',
    text: "Add to cart",
  };
  const scenario = planQaScenario("Add an add to cart button", "/", "ui-element", 0.9, [addedButton]);
  assert.ok(scenario.steps.some(step => step.action === "expectVisible" && step.selector === '[data-testid="add-to-cart"]'));
  assert.ok(scenario.steps.some(step => step.action === "click" && step.selector === '[data-testid="add-to-cart"]'));
  assert.ok(scenario.steps.some(step => step.action === "expectText" && step.text === "cart"));
});
