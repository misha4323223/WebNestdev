import test from "node:test";
import assert from "node:assert/strict";
// Модули инструментов регистрируют себя при импорте — так же, как это делает сервер при старте.
import "./tools/plan-tools.js";
import "./tools/filesystem-tools.js";
import { getToolDefinitions, getTool, toolNames, registerTool } from "./tool-registry.js";

type Definition = { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } };

function definition(name: string): Definition {
  const found = (getToolDefinitions() as Definition[]).find(item => item.function.name === name);
  assert.ok(found, "инструмент " + name + " есть в списке");
  return found;
}

test("модель получает настоящую схему инструмента, а не открытый объект", () => {
  const plan = definition("plan.update");
  const properties = plan.function.parameters.properties as Record<string, unknown>;
  assert.ok(properties?.items, "у plan.update видно поле items");
  assert.deepEqual(plan.function.parameters.required, ["items"]);
});

test("инструмент без схемы остаётся открытым, чтобы не сломать его вызовы", () => {
  registerTool({ name: "проба.без-схемы", description: "проба" });
  assert.deepEqual(definition("проба.без-схемы").function.parameters, { type: "object", additionalProperties: true });
});

test("схема не теряет описание: модель читает и его", () => {
  const read = definition("fs.read");
  assert.match(read.function.description, /utf-8|UTF-8/i);
  assert.ok(getTool("fs.read"), "инструмент зарегистрирован");
});

test("ошибка неизвестного инструмента называет доступные: модель может исправиться", () => {
  const names = toolNames();
  assert.ok(names.length > 0);
  assert.deepEqual(names, [...names].sort(), "имена отсортированы, чтобы ответ был стабильным");
  assert.ok(names.includes("plan.update"));
});
