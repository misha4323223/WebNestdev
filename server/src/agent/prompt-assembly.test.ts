import test from "node:test";
import assert from "node:assert/strict";
import { DEPLOYMENT_RULES, SYSTEM_PROMPT } from "./message-builder.js";
import { MOBILE_TOOL_RULES } from "./expo-tool-rules.js";
import { systemPromptFor } from "./prompt-assembly.js";
import { selectToolNames } from "./tool-catalog.js";

test("без групп промт не требует их инструментов", () => {
  const prompt = systemPromptFor(selectToolNames({ mode: "developer", task: "поправь кнопку" }));
  assert.ok(!prompt.includes("deploy.status"), "без deploy.* нет требования звать deploy.status");
  assert.ok(!prompt.includes("expo.build"), "без expo.* нет требования звать expo.build");
  assert.ok(!prompt.includes(DEPLOYMENT_RULES));
  assert.ok(!prompt.includes(MOBILE_TOOL_RULES));
  assert.match(prompt, /publication panel/, "правило публикации не зависит от каталога");
});

test("незавершённый план деплоя включает и инструменты, и их правила", () => {
  const names = selectToolNames({ mode: "developer", task: "продолжай", deployPlanActive: true });
  const prompt = systemPromptFor(names);
  assert.ok(names.includes("deploy.status"));
  assert.ok(prompt.includes(DEPLOYMENT_RULES));
  assert.match(prompt, /deploy\.status/);
  assert.ok(!prompt.includes("expo.build"));
});

test("мобильная группа включает только свои правила", () => {
  const prompt = systemPromptFor(["fs.read", "expo.status", "expo.build"]);
  assert.ok(prompt.includes(MOBILE_TOOL_RULES));
  assert.match(prompt, /expo\.build/);
  assert.ok(!prompt.includes(DEPLOYMENT_RULES));
});

test("SYSTEM_PROMPT остаётся полным для тестов и совместимости", () => {
  assert.ok(SYSTEM_PROMPT.includes(DEPLOYMENT_RULES));
  assert.ok(SYSTEM_PROMPT.includes(MOBILE_TOOL_RULES));
  assert.match(SYSTEM_PROMPT, /publication panel/);
});
