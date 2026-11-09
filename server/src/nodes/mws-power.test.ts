import assert from "node:assert/strict";
import test from "node:test";
import type { mwsRequest } from "../mws/mws-auth.js";
import { nodePowerPath, powerOnNode, readNodePower } from "./mws-power.js";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, body };
}

test("nodePowerPath uses the known projects and can be overridden", () => {
  delete process.env.MWS_VM_PATHS;
  assert.equal(nodePowerPath("node-1"), "/compute/v1/projects/project-pimashin2015/virtualMachines/webnestdev");
  assert.equal(nodePowerPath("node-2"), "/compute/v1/projects/project-pimashin2015/virtualMachines/node-2");

  process.env.MWS_VM_PATHS = JSON.stringify({ "node-2": "/compute/v1/projects/other/virtualMachines/vm-2" });
  try {
    assert.equal(nodePowerPath("node-2"), "/compute/v1/projects/other/virtualMachines/vm-2");
  } finally {
    delete process.env.MWS_VM_PATHS;
  }
});

test("powerOnNode does nothing when MWS already reports power=ON", async () => {
  const calls: string[] = [];
  const request = (async (input: { method?: string }) => {
    calls.push(input.method ?? "?");
    return response({ metadata: { etag: "e1" }, status: { hardware: { power: "ON" } } });
  }) as unknown as typeof mwsRequest;

  const state = await powerOnNode("node-2", { request });
  assert.equal(state.power, "ON");
  assert.deepEqual(calls, ["GET"]);
});

test("powerOnNode sends the etag and confirms ON after boot", async () => {
  const calls: Array<{ method?: string; body?: unknown }> = [];
  const request = (async (input: { method?: string; body?: unknown }) => {
    calls.push({ method: input.method, body: input.body });
    if (input.method === "POST") {
      return response({ metadata: { etag: "e2" }, status: { hardware: { power: "ON" } } });
    }
    return response({ metadata: { etag: "e1" }, status: { hardware: { power: "OFF" } } });
  }) as unknown as typeof mwsRequest;

  const state = await powerOnNode("node-2", { request });
  assert.equal(state.power, "ON");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.body, { metadata: { etag: "e1" }, spec: { hardware: { power: "ON" } } });
});

test("powerOnNode polls while MWS reports ON and then timeout is explicit", async () => {
  const request = (async (input: { method?: string }) => {
    if (input.method === "POST") {
      return response({ metadata: { etag: "e1" }, status: { hardware: { power: "OFF" } } });
    }
    return response({ metadata: { etag: "e1" }, status: { hardware: { power: "OFF" } } });
  }) as unknown as typeof mwsRequest;
  let clock = 0;

  await assert.rejects(
    () => powerOnNode("node-2", {
      request,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      timeoutMs: 5_000,
    }),
    /power=ON/,
  );
});

test("readNodePower rejects a malformed MWS response", async () => {
  const request = (async () => response({ status: { hardware: {} }, metadata: {} })) as unknown as typeof mwsRequest;
  await assert.rejects(() => readNodePower("node-2", { request }), /power/);
});
