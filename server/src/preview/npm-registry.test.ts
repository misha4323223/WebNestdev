import test from "node:test";
import assert from "node:assert/strict";
import { npmInstallEnv, npmRegistryReachable, npmRegistryUrl, resetNpmRegistryHealth } from "./npm-registry.js";

test("адрес зеркала: хвостовой слеш убирается, путь сохраняется", () => {
  assert.equal(npmRegistryUrl({ WEBNESTDEV_NPM_REGISTRY: "http://10.0.0.5:4873/" }), "http://10.0.0.5:4873");
  assert.equal(npmRegistryUrl({ WEBNESTDEV_NPM_REGISTRY: "https://npm.internal/registry/" }), "https://npm.internal/registry");
  assert.equal(npmRegistryUrl({ WEBNESTDEV_NPM_REGISTRY: "  http://10.0.0.5:4873  " }), "http://10.0.0.5:4873");
});

test("некорректный адрес — это «зеркала нет», а не ошибка", () => {
  assert.equal(npmRegistryUrl({}), null);
  assert.equal(npmRegistryUrl({ WEBNESTDEV_NPM_REGISTRY: "  " }), null);
  assert.equal(npmRegistryUrl({ WEBNESTDEV_NPM_REGISTRY: "ftp://10.0.0.5" }), null);
  assert.equal(npmRegistryUrl({ WEBNESTDEV_NPM_REGISTRY: "не адрес" }), null);
});

test("без зеркала установка идёт как раньше: пустое окружение", async () => {
  resetNpmRegistryHealth();
  assert.deepEqual(await npmInstallEnv({ env: {}, now: 1 }), {});
});

test("живое зеркало отдаёт только адрес реестра", async () => {
  resetNpmRegistryHealth();
  const env = await npmInstallEnv({
    env: { WEBNESTDEV_NPM_REGISTRY: "http://10.0.0.5:4873/" },
    now: 1_000,
    probe: async () => true,
  });
  assert.deepEqual(env, { npm_config_registry: "http://10.0.0.5:4873" });
});

test("упавшее зеркало не ломает установку: окружение пустое", async () => {
  resetNpmRegistryHealth();
  const env = await npmInstallEnv({
    env: { WEBNESTDEV_NPM_REGISTRY: "http://10.0.0.5:4873" },
    now: 1_000,
    probe: async () => false,
  });
  assert.deepEqual(env, {});
});

test("брошенная проверка считается недоступностью, а не исключением", async () => {
  resetNpmRegistryHealth();
  const env = await npmInstallEnv({
    env: { WEBNESTDEV_NPM_REGISTRY: "http://10.0.0.5:4873" },
    now: 1_000,
    probe: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(env, {});
});

test("результат проверки запоминается: проверка не идёт на каждой установке", async () => {
  resetNpmRegistryHealth();
  let probes = 0;
  const options = {
    env: { WEBNESTDEV_NPM_REGISTRY: "http://10.0.0.5:4873" },
    probe: async () => {
      probes++;
      return true;
    },
  };
  assert.equal(await npmRegistryReachable("http://10.0.0.5:4873", { ...options, now: 1_000 }), true);
  assert.equal(await npmRegistryReachable("http://10.0.0.5:4873", { ...options, now: 30_000 }), true);
  assert.equal(probes, 1);
});

test("неудача проверки помнится недолго: поднявшееся зеркало подхватывается само", async () => {
  resetNpmRegistryHealth();
  const url = "http://10.0.0.5:4873";
  assert.equal(await npmRegistryReachable(url, { now: 1_000, probe: async () => false }), false);
  assert.equal(await npmRegistryReachable(url, { now: 20_000, probe: async () => true }), true);
});
