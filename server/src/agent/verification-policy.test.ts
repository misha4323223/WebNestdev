import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSucceeded, routeFromMutation, shouldRunBrowserRuntime } from "./verification-policy.js";

test("routeFromMutation maps common Next.js page files to concrete smoke-test routes", () => {
  assert.equal(routeFromMutation("fs.write", { path: "pages/index.tsx" }), "/");
  assert.equal(routeFromMutation("fs.write", { path: "pages/products/index.tsx" }), "/products");
  assert.equal(routeFromMutation("fs.write", { path: "pages/products/[id].tsx" }), "/products/test");
  assert.equal(routeFromMutation("fs.write", { path: "app/page.tsx" }), "/");
  assert.equal(routeFromMutation("fs.write", { path: "app/products/page.tsx" }), "/products");
  assert.equal(routeFromMutation("fs.write", { path: "app/layout.tsx" }), "/");
  assert.equal(routeFromMutation("fs.write", { path: "app/products/layout.tsx" }), "/");
  assert.equal(routeFromMutation("fs.write", { path: "src/App.tsx" }), "/");
  assert.equal(routeFromMutation("fs.delete", { path: "pages/products/[id].tsx" }), "/products/test");
  assert.equal(routeFromMutation("terminal.exec", { command: "npm run build" }), "/");
});

test("commandSucceeded rejects missing, failed, and signaled command results", () => {
  assert.equal(commandSucceeded({ ok: true, exitCode: 0, signal: null }), true);
  assert.equal(commandSucceeded({ ok: true, exitCode: 1, signal: null }), false);
  assert.equal(commandSucceeded({ ok: false, exitCode: 0, signal: null }), false);
  assert.equal(commandSucceeded({ ok: true, exitCode: 0, signal: "SIGTERM" }), false);
  assert.equal(commandSucceeded(null), false);
});

test("browser runtime policy includes UI source changes but skips non-code documentation", () => {
  assert.equal(shouldRunBrowserRuntime("fs.write", { path: "src/App.tsx" }), true);
  assert.equal(shouldRunBrowserRuntime("fs.write", { path: "src/styles.css" }), true);
  assert.equal(shouldRunBrowserRuntime("fs.delete", { path: "src/components/Button.tsx" }), true);
  assert.equal(shouldRunBrowserRuntime("fs.delete", { path: "README.md" }), false);
  assert.equal(shouldRunBrowserRuntime("fs.write", { path: "README.md" }), false);
  assert.equal(shouldRunBrowserRuntime("terminal.exec", { command: "npm run build" }), true);
  assert.equal(shouldRunBrowserRuntime("terminal.exec", { command: "git status" }), false);
  assert.equal(shouldRunBrowserRuntime("npm.install", {}), true);
});
