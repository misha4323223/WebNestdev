import test from "node:test";
import assert from "node:assert/strict";
import { chooseAppPort, discoverAppPort, listListeningPorts, listLoggedPorts, parseListeningPorts, parseLoggedPorts } from "./app-port.js";

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

/**
 * Вывод настоящего дев-сервера (Vite в контейнере предпросмотра): ANSI-коды, адрес платформы рядом.
 * Именно эта дверь остаётся открытой, когда `docker exec` не работает вообще.
 */
const viteLog = [
  "\u001b[32m[1mVITE\u001b[22m v8.3.4\u001b[39m ready in \u001b[1m1294\u001b[22m ms",
  "\u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m",
  "\u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m: \u001b[36mhttp://172.21.0.4:\u001b[1m5173\u001b[22m/\u001b[39m",
  'Server listening at http://127.0.0.1:8787',
].join("\n");

test("the dev server's own output names its port, without docker exec", () => {
  assert.deepEqual(parseLoggedPorts(viteLog), [5173, 8787]);
  // Порт приложения тот же, что выбрал бы разбор таблиц ядра: API рядом (8787) его не перебивает.
  assert.equal(chooseAppPort(parseLoggedPorts(viteLog)), 5173);
  // Без адреса в строке порт не выдумывается из таймингов и версий.
  assert.deepEqual(parseLoggedPorts("ready in 1294 ms\nversion 1:2:3"), []);
  assert.deepEqual(parseLoggedPorts(""), []);
});

test("logged ports are read with docker logs, so a broken exec door is not a dead end", async () => {
  const calls: string[][] = [];
  const docker = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: viteLog, stderr: "" };
  };
  assert.deepEqual(await listLoggedPorts("c1", docker), [5173, 8787]);
  assert.deepEqual(calls[0].slice(0, 2), ["logs", "--tail"]);
  assert.deepEqual(await listLoggedPorts("c1", async () => { throw new Error("docker недоступен"); }), []);
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
