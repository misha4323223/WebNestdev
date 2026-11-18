import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../tool-registry.js";
import { selectToolNames } from "../agent/tool-catalog.js";
import "./client-database-tools.js";

const tool = getTool("database.client")!;

test("инструмент клиентской базы зарегистрирован и не обещает вернуть строку подключения", () => {
  assert.ok(tool, "database.client должен быть в реестре");
  assert.match(tool.description, /masked address/);
  assert.match(tool.description, /DATABASE_URL/);
  assert.match(tool.description, /128 MB/);
  assert.ok(!/postgres:\/\//.test(tool.description), "в описании не должно быть строки подключения");
});

test("инструмент виден в разработке и спрятан от планировщика", () => {
  assert.ok(selectToolNames({ mode: "developer", task: "сделай проект" }).includes("database.client"));
  assert.ok(selectToolNames({ mode: "developer", task: "подключи базу данных" }).includes("database.client"));
  assert.ok(!selectToolNames({ mode: "planner", task: "подключи базу данных" }).includes("database.client"));
});

test("неизвестное действие отклоняется до обращения к базе", async () => {
  const context = { projectId: "p1", userId: "u1", runId: "r1", emit: () => {} };
  await assert.rejects(
    () => tool.execute!({ action: "drop" }, context as Parameters<NonNullable<typeof tool.execute>>[1]),
    /action/,
  );
});
