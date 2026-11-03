import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../tool-registry.js";
import "./vision-tools.js";

test("image.inspect без vision-модели честно отвечает not_configured и называет переменную", async () => {
  const before = process.env.PLATFORM_VISION_MODEL;
  delete process.env.PLATFORM_VISION_MODEL;
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
    if (before === undefined) delete process.env.PLATFORM_VISION_MODEL;
    else process.env.PLATFORM_VISION_MODEL = before;
  }
});
