import test from "node:test";
import assert from "node:assert/strict";
import { attachToServerNetworks, preferPreviewNetwork } from "./preview-network.js";

/**
 * Контейнер предпросмотра мог остаться в сети, которой сервер не видит (Docker изолирует bridge-сети
 * друг от друга): приложение внутри живо, `docker exec` работает, а панель получает белый экран.
 * Подключение к сети сервера лечит это уже для запущенного контейнера, поэтому проверяется здесь,
 * без Docker: имена сетей и адреса приходят от подставленных функций.
 */
test("a container in a foreign network is attached to the server's network", async () => {
  const connected: string[] = [];
  const result = await attachToServerNetworks("c1", {
    networks: async () => ["src_webnestdev"],
    containerNetworks: async () => ["bridge"],
    connect: async (network, containerId) => {
      connected.push(network + ":" + containerId);
      return true;
    },
    addressOnNetworks: async (_containerId, networks) => (connected.length && networks.includes("src_webnestdev") ? "172.18.0.5" : ""),
  });
  assert.deepEqual(connected, ["src_webnestdev:c1"]);
  assert.deepEqual(result, { host: "172.18.0.5", connected: ["src_webnestdev"] });
});

test("a container already in the server's network is left alone", async () => {
  let connects = 0;
  const result = await attachToServerNetworks("c1", {
    networks: async () => ["src_webnestdev"],
    containerNetworks: async () => ["src_webnestdev"],
    connect: async () => {
      connects++;
      return true;
    },
    addressOnNetworks: async () => "172.18.0.5",
  });
  assert.equal(connects, 0, "повторное подключение к той же сети не нужно");
  assert.deepEqual(result, { host: "172.18.0.5", connected: [] });
});

test("a server that is not in a container has no network to attach to", async () => {
  let connects = 0;
  const result = await attachToServerNetworks("c1", {
    networks: async () => [],
    containerNetworks: async () => [],
    connect: async () => {
      connects++;
      return true;
    },
    addressOnNetworks: async () => "",
  });
  // Пустой список — это «сервер на хосте»: контейнер на bridge по умолчанию ему виден напрямую.
  assert.deepEqual(result, { host: "", connected: [] });
  assert.equal(connects, 0);
});

test("a refused connect does not claim the network was joined", async () => {
  const result = await attachToServerNetworks("c1", {
    networks: async () => ["src_webnestdev"],
    containerNetworks: async () => [],
    connect: async () => false,
    addressOnNetworks: async () => "",
  });
  assert.deepEqual(result, { host: "", connected: [] });
});

/**
 * Сеть базы отделена от сети предпросмотра именно для того, чтобы код проекта не дошёл до
 * postgres. Выбор сети не должен отменять это одним неверным именем.
 */
test("сеть с preview в имени побеждает остальные", () => {
  assert.equal(preferPreviewNetwork(["webnestdev", "webnestdev-preview", "webnestdev-db"]), "webnestdev-preview");
  assert.equal(preferPreviewNetwork(["webnestdev-preview"]), "webnestdev-preview");
});

test("сеть базы не выбирается никогда", () => {
  assert.equal(preferPreviewNetwork(["webnestdev-db"]), "");
  assert.notEqual(preferPreviewNetwork(["webnestdev", "webnestdev-db"]), "webnestdev-db");
  assert.equal(preferPreviewNetwork(["webnestdev"]), "webnestdev");
});

test("пустой список — нет сети, а не сеть по умолчанию", () => {
  assert.equal(preferPreviewNetwork([]), "");
});
