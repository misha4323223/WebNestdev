import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  brokerPing,
  brokerSelfNetworks,
  configureDockerEndpoint,
  describeDockerEndpoint,
  dockerBrokerSocket,
} from "./endpoint.js";

/**
 * Проверка выбора адреса Docker без настоящего демона: на unix-сокете поднимается заглушка,
 * которая отвечает на `/_ping` и `/_webnestdev/self`. Главное, что здесь проверяется, — фолбэк:
 * старт сервера не должен зависеть от того, успел ли подняться брокер.
 */

const ENV_KEYS = ["DOCKER_HOST", "WEBNESTDEV_DOCKER_BROKER", "WEBNESTDEV_DOCKER_BROKER_WAIT_MS"] as const;

async function withEnv<T>(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function startFakeBroker(socketPath: string) {
  const server = http.createServer((request, response) => {
    if (request.url === "/_ping") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("OK");
      return;
    }
    if (request.url === "/_webnestdev/self") {
      const payload = JSON.stringify({ networks: ["src_webnestdev", "src_webnestdev-preview"] });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise<http.Server>(resolve => server.listen(socketPath, () => resolve(server)));
}

async function close(server: http.Server) {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test("сокет брокера берётся только из unix DOCKER_HOST", () => {
  assert.equal(dockerBrokerSocket({ DOCKER_HOST: "unix:///run/webnestdev-docker/docker.sock" }), "/run/webnestdev-docker/docker.sock");
  assert.equal(dockerBrokerSocket({ DOCKER_HOST: "tcp://127.0.0.1:2375" }), null);
  assert.equal(dockerBrokerSocket({}), null);
  assert.equal(
    dockerBrokerSocket({ DOCKER_HOST: "unix:///run/webnestdev-docker/docker.sock", WEBNESTDEV_DOCKER_BROKER: "0" }),
    null,
  );
});

test("describeDockerEndpoint не скрывает выключенный брокер", () => {
  assert.match(describeDockerEndpoint(), /брокер|напрямую/);
});

test("живой брокер сохраняет DOCKER_HOST", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wnd-endpoint-"));
  const socket = path.join(dir, "broker.sock");
  const server = await startFakeBroker(socket);
  try {
    assert.equal(await brokerPing(socket), true);
    await withEnv({ DOCKER_HOST: "unix://" + socket, WEBNESTDEV_DOCKER_BROKER_WAIT_MS: "1000" }, async () => {
      await configureDockerEndpoint();
      assert.equal(process.env.DOCKER_HOST, "unix://" + socket);
    });
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("мёртвый брокер не блокирует старт: адрес откатывается на прямой сокет", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wnd-endpoint-"));
  const socket = path.join(dir, "missing.sock");
  try {
    assert.equal(await brokerPing(socket), false);
    await withEnv({ DOCKER_HOST: "unix://" + socket, WEBNESTDEV_DOCKER_BROKER_WAIT_MS: "0" }, async () => {
      await configureDockerEndpoint();
      assert.equal(process.env.DOCKER_HOST, undefined);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("WEBNESTDEV_DOCKER_BROKER=0 выключает брокер принудительно", async () => {
  await withEnv({ DOCKER_HOST: "unix:///run/webnestdev-docker/docker.sock", WEBNESTDEV_DOCKER_BROKER: "0" }, async () => {
    await configureDockerEndpoint();
    assert.equal(process.env.DOCKER_HOST, undefined);
  });
});

test("сети берутся у брокера, а без него — null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wnd-endpoint-"));
  const socket = path.join(dir, "broker.sock");
  const server = await startFakeBroker(socket);
  try {
    await withEnv({ DOCKER_HOST: "unix://" + socket }, async () => {
      assert.deepEqual(await brokerSelfNetworks(), ["src_webnestdev", "src_webnestdev-preview"]);
    });
    await withEnv({}, async () => {
      assert.equal(await brokerSelfNetworks(), null);
    });
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
