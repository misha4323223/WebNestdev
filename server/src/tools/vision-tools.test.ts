import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../tool-registry.js";
import "./vision-tools.js";

test("image.inspect без vision-модели честно отвечает not_configured и называет переменную", async () => {
  const names = ["PLATFORM_VISION_MODEL", "PLATFORM_AI_MODEL", "AI_MODEL"] as const;
  const before = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const tool = getTool("image.inspect");
    assert.ok(tool?.execute);
    const result = (await tool.execute({ path: "uploads/screenshot.webp" }, {
      projectId: "p",
      runId: "r",
      userId: "u",
    })) as { ok: boolean; code?: string; error?: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, "not_configured");
    assert.match(result.error ?? "", /PLATFORM_VISION_MODEL/);
  } finally {
    for (const name of names) {
      const value = before.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
