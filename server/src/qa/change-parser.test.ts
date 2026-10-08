import test from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, parseChangedSource } from "./change-parser.js";

test("parses an added button with a stable data selector", () => {
  const result = parseUnifiedDiff([
    "diff --git a/src/Product.tsx b/src/Product.tsx",
    "+++ b/src/Product.tsx",
    '+ <button data-action="cart">Добавить в корзину</button>',
  ].join("\n"));
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].selector, '[data-action="cart"]');
  assert.equal(result.changes[0].text, "Добавить в корзину");
});

test("parses form controls from changed source", () => {
  const result = parseChangedSource("src/Login.tsx", '<input name="email" />');
  assert.equal(result.changes[0].kind, "form-field");
  assert.equal(result.changes[0].selector, 'input[name="email"]');
});
