import test from "node:test";
import assert from "node:assert/strict";
import { canActivateDemo } from "./account.js";

test("a demo can be activated only for an account that has never claimed one", () => {
  assert.equal(canActivateDemo({
    userId: "new-user",
    plan: "free",
    status: "free",
    startedAt: null,
    expiresAt: null,
    updatedAt: new Date(0).toISOString(),
  }), true);
  for (const status of ["demo_active", "demo_expired", "demo_cancelled"] as const) {
    assert.equal(canActivateDemo({
      userId: "existing-user",
      plan: status === "demo_active" ? "pro" : "free",
      status,
      startedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: status === "demo_active" ? "2099-01-01T00:00:00.000Z" : null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }), false, status + " must not be eligible for a second demo");
  }
});
