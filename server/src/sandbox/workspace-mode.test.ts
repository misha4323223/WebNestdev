import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INTERNAL_API_PORT,
  describeWorkspaceSettings,
  internalApiPort,
  ownerRoutingEnabled,
  workspaceMode,
  workspaceSettings,
} from "./workspace-mode.js";

test("workspace defaults to shared and owner-routing stays off", () => {
  assert.equal(workspaceMode({}), "shared");
  assert.equal(ownerRoutingEnabled({}), false);
  const settings = workspaceSettings({});
  assert.equal(settings.mode, "shared");
  assert.equal(settings.ownerRouting, false);
  assert.equal(settings.internalApiPort, DEFAULT_INTERNAL_API_PORT);
  assert.equal(settings.internalTokenConfigured, false);
});

test("local mode and owner-routing require explicit values", () => {
  assert.equal(workspaceMode({ WEBNESTDEV_WORKSPACE_MODE: "LOCAL" }), "local");
  assert.equal(ownerRoutingEnabled({ WEBNESTDEV_OWNER_ROUTING: "true" }), true);
  assert.equal(ownerRoutingEnabled({ WEBNESTDEV_OWNER_ROUTING: "0" }), false);
  assert.equal(internalApiPort({ WEBNESTDEV_INTERNAL_API_PORT: "9001" }), 9001);
  assert.equal(internalApiPort({ WEBNESTDEV_INTERNAL_API_PORT: "nope" }), DEFAULT_INTERNAL_API_PORT);
});

test("an unknown workspace mode is rejected instead of silently falling back", () => {
  assert.throws(() => workspaceMode({ WEBNESTDEV_WORKSPACE_MODE: "gluster" }), /shared или local/);
});

test("health description does not expose the internal token", () => {
  const text = describeWorkspaceSettings({
    WEBNESTDEV_WORKSPACE_MODE: "local",
    WEBNESTDEV_OWNER_ROUTING: "1",
    WEBNESTDEV_INTERNAL_TOKEN: "x".repeat(64),
  });
  assert.match(text, /workspace: local/);
  assert.match(text, /owner-routing: вкл/);
  assert.doesNotMatch(text, /x{64}/);
});
