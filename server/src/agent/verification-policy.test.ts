import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSucceeded,countVerificationFailure,MAX_VERIFICATION_ATTEMPTS,routeFromMutation,shouldRunBrowserRuntime,verificationBuildCommand,verificationFailureSummary } from "./verification-policy.js";

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

test("a project that is still being scaffolded can fail the automatic build many times", () => {
  // The reported run: package.json, then configs, then `npm install`, then components. Every write
  // ran the automatic check, so the build failed on `tsc: not found`, then on a missing App.tsx.
  // Three of those ended the run at the third file, before the project could ever build.
  let count = 0;
  for (let step = 0; step < 10; step++) count = countVerificationFailure(count, "auto");
  assert.equal(count, 0);
  assert.ok(count < MAX_VERIFICATION_ATTEMPTS);
});

test("only a claim that the task is finished, or a failed explicit check, counts toward the limit", () => {
  let count = 0;
  count = countVerificationFailure(count, "tool");
  assert.equal(count, 1);
  count = countVerificationFailure(count, "auto");
  assert.equal(count, 1);
  count = countVerificationFailure(count, "finish");
  assert.equal(count, 2);
  count = countVerificationFailure(count, "finish");
  assert.equal(count, MAX_VERIFICATION_ATTEMPTS);
});

test("a project without a build script is not asked to build", () => {
  // A static page (`index.html` + `styles.css`, no package.json) failed `npm run build` on every
  // write with `ENOENT …/package.json` and ended on the verification limit; the site itself worked.
  assert.equal(verificationBuildCommand("tsc -b && vite build"), "npm run build");
  assert.equal(verificationBuildCommand("vite build"), "npm run build");
  assert.equal(verificationBuildCommand(""), "");
  assert.equal(verificationBuildCommand("   "), "");
});

test("the failure summary names the line to fix, not the whole build log", () => {
  assert.equal(
    verificationFailureSummary({
      ok: false,
      stderr: "",
      stdout: "\n> agency-landing@1.0.0 build\n> tsc -b && vite build\n\nsrc/main.tsx(3,17): error TS2307: Cannot find module './App' or its corresponding type declarations.\n",
    }),
    "src/main.tsx(3,17): error TS2307: Cannot find module './App' or its corresponding type declarations.",
  );
  assert.equal(verificationFailureSummary({ ok: false, reason: "Предпросмотр не запущен", status: {} }), "Предпросмотр не запущен");
  assert.equal(verificationFailureSummary({ ok: false, error: "fetch failed" }), "fetch failed");
  assert.equal(verificationFailureSummary(null), "");
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
