import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FUNCTIONS_NETWORK, functionsNetwork } from "./network.js";

test("по умолчанию функции идут в отдельную сеть, а не в bridge", () => {
  assert.equal(functionsNetwork({}), DEFAULT_FUNCTIONS_NETWORK);
  assert.equal(functionsNetwork({ FUNCTIONS_DOCKER_NETWORK: "  " }), DEFAULT_FUNCTIONS_NETWORK);
});

test("имя сети можно переопределить, но не произвольной строкой", () => {
  assert.equal(functionsNetwork({ FUNCTIONS_DOCKER_NETWORK: "custom-functions" }), "custom-functions");
  assert.throws(() => functionsNetwork({ FUNCTIONS_DOCKER_NETWORK: "bridge --privileged" }), /именем Docker-сети/);
  assert.throws(() => functionsNetwork({ FUNCTIONS_DOCKER_NETWORK: "-bad" }), /именем Docker-сети/);
  assert.throws(() => functionsNetwork({ FUNCTIONS_DOCKER_NETWORK: "bridge" }), /встроенной сетью/);
  assert.throws(() => functionsNetwork({ FUNCTIONS_DOCKER_NETWORK: "webnestdev-preview" }), /сетью предпросмотра/);
  assert.throws(() => functionsNetwork({ FUNCTIONS_DOCKER_NETWORK: "custom-preview", PREVIEW_NETWORK: "custom-preview" }), /сетью предпросмотра/);
});
