import test from "node:test";
import assert from "node:assert/strict";
import { beginRun, endRun, isRunActive } from "./active-runs.js";

test("a project counts as busy only while a run is in flight", () => {
  assert.equal(isRunActive("p1"), false);
  beginRun("p1");
  assert.equal(isRunActive("p1"), true);
  endRun("p1");
  assert.equal(isRunActive("p1"), false);
});

test("two runs on one project keep it busy until the last one ends", () => {
  beginRun("p2");
  beginRun("p2");
  endRun("p2");
  assert.equal(isRunActive("p2"), true);
  endRun("p2");
  assert.equal(isRunActive("p2"), false);
});

test("ending a run that never started does not mark the project busy", () => {
  endRun("p3");
  assert.equal(isRunActive("p3"), false);
});
