import test from "node:test";
import assert from "node:assert/strict";
import { addressOnNetworks, attachToServerNetworks, containerNetworks, firstContainerAddress, preferPreviewNetwork } from "./preview-network.js";

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
    // После connect сеть видна в контейнере; attach проверяет именно этот факт.
    containerNetworks: async () => connected.length ? ["bridge", "src_webnestdev"] : ["bridge"],
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

/**
 * Имя сети в Docker может содержать пробелы, а IPv6-адрес нельзя подставлять в `http://host:port`
 * без скобок. Раньше адрес резался по пробелам, поэтому имя `x 10.0.0.5` давало ложную запись, а
 * IPv6 мог стать host предпросмотра.
 */
test("сети и адреса читаются из JSON, а не из строки с пробелами", async () => {
  const docker = async () => ({
    code: 0,
    stdout: JSON.stringify({
      "network with spaces": { IPAddress: "10.0.0.5" },
      "ipv6-only": { IPAddress: "fd00::5" },
      empty: { IPAddress: "" },
    }),
    stderr: "",
  });
  assert.equal(await addressOnNetworks("c1", ["network with spaces"], docker), "10.0.0.5");
  assert.deepEqual(await containerNetworks("c1", docker), ["network with spaces", "ipv6-only", "empty"]);
  assert.equal(await firstContainerAddress("c1", docker), "10.0.0.5", "IPv6 и пустой адрес не становятся host");
});

test("неразобранный ответ inspect не превращается в сеть или адрес", async () => {
  const docker = async () => ({ code: 0, stdout: "network 10.0.0.5", stderr: "" });
  assert.equal(await addressOnNetworks("c1", ["network"], docker), "");
  assert.deepEqual(await containerNetworks("c1", docker), []);
});

/**
 * `docker network connect` под runsc может вернуть отказ, хотя endpoint уже появился, или успех,
 * хотя netstack его ещё не увидел. Поэтому успех определяется повторным чтением сетей, а не кодом
 * возврата команды.
 */
test("результат connect проверяется по фактическим сетям контейнера", async () => {
  let reads = 0;
  const result = await attachToServerNetworks("c-verify", {
    networks: async () => ["src_webnestdev"],
    containerNetworks: async () => {
      reads++;
      return reads === 1 ? [] : ["src_webnestdev"];
    },
    connect: async () => false,
    addressOnNetworks: async () => "172.18.0.5",
  });
  assert.equal(reads, 2, "сети перечитываются после connect");
  assert.deepEqual(result, { host: "172.18.0.5", connected: ["src_webnestdev"] });
});

test("адрес после connect перечитывается, пока netstack его не отдаст", async () => {
  let networkReads = 0;
  let addressReads = 0;
  const result = await attachToServerNetworks("c-wait", {
    networks: async () => ["src_webnestdev"],
    containerNetworks: async () => {
      networkReads++;
      return networkReads === 1 ? [] : ["src_webnestdev"];
    },
    connect: async () => true,
    addressOnNetworks: async () => {
      addressReads++;
      return addressReads >= 2 ? "172.18.0.5" : "";
    },
  });
  assert.equal(addressReads, 2, "адрес запрошен повторно после короткой паузы");
  assert.deepEqual(result, { host: "172.18.0.5", connected: ["src_webnestdev"] });
});

test("успешный код connect без сети в контейнере не считается подключением", async () => {
  const result = await attachToServerNetworks("c-absent", {
    networks: async () => ["src_webnestdev"],
    containerNetworks: async () => [],
    connect: async () => true,
    addressOnNetworks: async () => "",
  });
  assert.deepEqual(result, { host: "", connected: [] });
});

/** Сеть базы — последний барьер перед Docker, даже если вызывающий передал её в списке. */
test("attach никогда не подключает контейнер к сети базы", async () => {
  const connected: string[] = [];
  const attached = new Set<string>();
  const result = await attachToServerNetworks("c-db", {
    networks: async () => ["backend", "backend-db", "src_webnestdev"],
    containerNetworks: async () => [...attached],
    connect: async network => {
      connected.push(network);
      attached.add(network);
      return true;
    },
    addressOnNetworks: async (_containerId, networks) => networks.includes("backend") ? "10.0.0.7" : "",
  });
  assert.deepEqual(connected, ["backend", "src_webnestdev"]);
  assert.deepEqual(result.connected, ["backend", "src_webnestdev"]);
  assert.equal(result.host, "10.0.0.7");
});

/** Два статуса одного предпросмотра не должны одновременно дёргать `network connect`. */
test("параллельные attach одного контейнера выполняются последовательно", async () => {
  let connected = false;
  let connects = 0;
  const connect = async () => {
    connects++;
    await new Promise(resolve => setTimeout(resolve, 10));
    connected = true;
    return true;
  };
  const deps = {
    networks: async () => ["src_webnestdev"],
    containerNetworks: async () => connected ? ["src_webnestdev"] : [],
    connect,
    addressOnNetworks: async () => connected ? "172.18.0.5" : "",
  };
  const [first, second] = await Promise.all([
    attachToServerNetworks("c-lock", deps),
    attachToServerNetworks("c-lock", deps),
  ]);
  assert.equal(connects, 1, "второй вызов видит сеть, подключённую первым");
  assert.deepEqual(first, { host: "172.18.0.5", connected: ["src_webnestdev"] });
  assert.deepEqual(second, { host: "172.18.0.5", connected: [] });
});
