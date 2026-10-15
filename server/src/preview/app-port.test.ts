import test from "node:test";
import assert from "node:assert/strict";
import { chooseAppPort, discoverAppPort, listListeningPorts, parseListeningPorts } from "./app-port.js";

/** Строка таблицы ядра: local_address (hex ip:hex port), rem_address, состояние. */
function tcpLine(port: number, state = "0A") {
  return `  12: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00:00000000 00000000 1000 0 0 10 0`;
}

const table = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  tcpLine(3000),
  tcpLine(3001, "01"), // ESTABLISHED — не слушатель
  tcpLine(5173),
  tcpLine(3000), // дубликат: порт уже известен
  "",
].join("\n");

test("listening ports come from the kernel tables, not from the launch flags", () => {
  assert.deepEqual(parseListeningPorts(table), [3000, 5173]);
  // Пустая и мусорная таблица — это «ничего не слушает», а не исключение.
  assert.deepEqual(parseListeningPorts(""), []);
  assert.deepEqual(parseListeningPorts("  sl local_address rem_address st\n"), []);
});

test("the canonical port wins, then a familiar one, then the first real one", () => {
  assert.equal(chooseAppPort([5173, 3000]), 3000);
  // dev-скрипт не понял `--port 3000`: берём порт, на котором он оказался.
  assert.equal(chooseAppPort([5173]), 5173);
  assert.equal(chooseAppPort([12345, 6543]), 6543);
  // Сервисы, поднятые рядом с приложением (postgres, redis), не притворяются сайтом: иначе
  // проброс целился бы в базу и проверка падала бы с непонятной ошибкой.
  assert.equal(chooseAppPort([5432, 6379]), null);
  assert.equal(chooseAppPort([5432, 12345]), 12345);
  // Порты ниже 1024 не может занять непривилегированный процесс контейнера.
  assert.equal(chooseAppPort([80, 443]), null);
  assert.equal(chooseAppPort([]), null);
});

test("discovery reads the container's own tables and survives a failed exec", async () => {
  const calls: string[][] = [];
  const docker = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: table, stderr: "" };
  };
  assert.deepEqual(await listListeningPorts("c1", docker), [3000, 5173]);
  assert.equal(await discoverAppPort("c1", 3000, docker), 3000);
  // Приложение на 5173 и ничего на 3000: платформа узнаёт настоящий порт.
  assert.equal(await discoverAppPort("c1", 3000, async () => ({ code: 0, stdout: tcpLine(5173), stderr: "" })), 5173);
  assert.equal(calls[0][0], "exec");

  const broken = async () => { throw new Error("docker недоступен"); };
  assert.deepEqual(await listListeningPorts("c1", broken), []);
  assert.equal(await discoverAppPort("c1", 3000, async () => ({ code: 1, stdout: "", stderr: "no such container" })), null);
});
