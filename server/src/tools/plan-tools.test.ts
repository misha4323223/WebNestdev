import test from "node:test";
import assert from "node:assert/strict";
import "./plan-tools.js";
import { getTool } from "../tool-registry.js";

const milestones = [
  { title: "Схема", scope: "Таблицы", files: ["db/schema.ts"], tests: ["npm test schema"], definitionOfDone: "схема применяется" },
  { title: "API", scope: "Ручки", files: ["api/orders.ts"], tests: ["npm test api"], definitionOfDone: "ручки отвечают" },
  { title: "UI", scope: "Экран", files: ["src/Orders.tsx"], tests: ["npm run test:web"], definitionOfDone: "экран открывается" },
];

test("plan.milestones возвращает план, текущий этап и границу следующего", async () => {
  const tool = getTool("plan.milestones");
  assert.ok(tool?.execute);
  const output = await tool.execute({ milestones }, { request: {}, projectId: "p", userId: "u" } as never);
  const value = output as { ok?: boolean; plan?: { items?: unknown[]; milestones?: unknown[] }; progress?: unknown; current?: { title?: string }; next?: string | null };
  assert.equal(value.ok, true);
  assert.equal(value.plan?.milestones?.length, 3);
  assert.equal(value.plan?.items?.length, 3);
  assert.deepEqual(value.progress, { done: 0, total: 3 });
  assert.equal(value.current?.title, "Схема");
  assert.equal(value.next, "API");
});

test("plan.milestones после done не запускает следующий этап автоматически", async () => {
  const tool = getTool("plan.milestones");
  assert.ok(tool?.execute);
  const done = milestones.map((item, index) => ({ ...item, status: index === 0 ? "done" : "pending" }));
  const output = await tool.execute({ milestones: done }, { request: {}, projectId: "p", userId: "u" } as never);
  const value = output as { current?: unknown; next?: string | null; reminder?: string };
  assert.equal(value.current, null);
  assert.equal(value.next, "API");
  assert.match(value.reminder ?? "", /checkpoint/);
});
