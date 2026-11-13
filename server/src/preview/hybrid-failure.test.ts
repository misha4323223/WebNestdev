import test from "node:test";
import assert from "node:assert/strict";
import { classifyBuildFailure, classifyStartFailure } from "./hybrid-failure.js";

test("network and incomplete-install build failures are transient", () => {
  assert.equal(classifyBuildFailure("npm ERR! code EAI_AGAIN\nnetwork request failed"), "transient");
  assert.equal(classifyBuildFailure("src/App.tsx(1,1): error TS7016: Could not find a declaration file for module 'x'"), "transient");
  assert.equal(classifyBuildFailure("Error: Cannot find module './missing'"), "transient");
  assert.equal(classifyBuildFailure("sh: 1: vite: not found"), "transient");
});

test("ordinary project build errors are architectural mismatches, not transient", () => {
  assert.equal(classifyBuildFailure("src/App.tsx(10,2): error TS2322: Type 'string' is not assignable to type 'number'"), "incompatible");
  assert.equal(classifyBuildFailure("vite build: transform failed"), "incompatible");
});

test("Docker infrastructure failures do not trigger a mode downgrade", () => {
  assert.equal(classifyStartFailure("Docker недоступен на этом хосте: spawn docker ENOENT"), "transient");
  assert.equal(classifyStartFailure("Cannot connect to the Docker daemon"), "transient");
});

test("a backend that cannot start is an incompatibility", () => {
  assert.equal(classifyStartFailure("Backend hybrid не запустился: process exited with code 1"), "incompatible");
});
