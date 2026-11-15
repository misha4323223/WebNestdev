import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_FEATURE_ENV, agentFeatureEnabled, agentFeatureSnapshot, describeAgentFeatures } from "./features.js";

test("все экспериментальные возможности выключены, если переменные не заданы", () => {
  assert.deepEqual(agentFeatureSnapshot({}), {
    repoMap: false,
    testRunner: false,
    archMemory: false,
    milestones: false,
    reviewer: false,
    multiWriter: false,
    modelRouter: false,
  });
  assert.match(describeAgentFeatures({}), /выключены/);
});

test("флаг включается только явным истинным значением", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
    assert.equal(agentFeatureEnabled("repoMap", { [AGENT_FEATURE_ENV.repoMap]: value }), true, value);
  }
  for (const value of ["0", "false", "no", "off", "", "maybe", "2"]) {
    assert.equal(agentFeatureEnabled("repoMap", { [AGENT_FEATURE_ENV.repoMap]: value }), false, value);
  }
});

test("каждый флаг читает свою переменную, а не соседнюю", () => {
  assert.equal(agentFeatureEnabled("reviewer", { [AGENT_FEATURE_ENV.reviewer]: "1" }), true);
  assert.equal(agentFeatureEnabled("reviewer", { [AGENT_FEATURE_ENV.repoMap]: "1" }), false);
});

test("описание перечисляет включённые флаги и не печатает значения окружения", () => {
  const text = describeAgentFeatures({
    [AGENT_FEATURE_ENV.repoMap]: "1",
    [AGENT_FEATURE_ENV.reviewer]: "1",
    SECRET_TOKEN: "must-not-leak",
  });
  assert.match(text, /AGENT_REPO_MAP/);
  assert.match(text, /AGENT_REVIEWER/);
  assert.equal(text.includes("must-not-leak"), false);
});
