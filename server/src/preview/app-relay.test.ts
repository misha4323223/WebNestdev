import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chooseRelayPort, relayScript, startContainerRelay } from "./app-relay.js";

/** Свободный порт занимается и сразу освобождается: пробросу нужен адрес, а не диапазон. */
async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "0.0.0.0", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

test("the relay carries traffic to an app that listens on localhost only", async () => {
  // Приложение слушает только петлю — именно так его не видит сервер предпросмотра.
  const app = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body>проброс работает: " + (request.url ?? "") + "</body></html>");
  });
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  const appAddress = app.address();
  const appPort = typeof appAddress === "object" && appAddress ? appAddress.port : 0;

  const listenPort = await freePort();
  const relay: ChildProcess = spawn(process.execPath, ["-e", relayScript(appPort, listenPort)], { stdio: "ignore" });
  try {
    let body = "";
    for (let attempt = 0; attempt < 40 && !body; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      body = await fetch(`http://127.0.0.1:${listenPort}/style.css`).then(response => response.text()).catch(() => "");
    }
    // Через проброс виден ответ приложения вместе с путём запроса: и страница, и её файлы.
    assert.match(body, /проброс работает: \/style\.css/);
  } finally {
    relay.kill("SIGKILL");
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});

test("the relay port avoids the ports the app already holds", () => {
  // Приложение заняло канонический порт на петле: проброс берёт следующий.
  assert.equal(chooseRelayPort([3000]), 3001);
  // Приложение на 5173: канонический порт свободен, платформа остаётся на нём.
  assert.equal(chooseRelayPort([5173, 5432]), 3000);
  assert.equal(chooseRelayPort([3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009]), null);
});

test("the relay is started detached through docker exec", async () => {
  const calls: string[][] = [];
  const docker = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.equal(await startContainerRelay({ containerId: "c1", targetPort: 5173, listenPort: 3000, docker }), true);
  assert.deepEqual(calls[0].slice(0, 5), ["exec", "-d", "c1", "node", "-e"]);
  assert.match(calls[0][5], /net\.connect\(5173,"127\.0\.0\.1"\)/);
  assert.match(calls[0][5], /listen\(3000,"0\.0\.0\.0"\)/);

  // Отказ docker — это «проброса нет», а не исключение наружу.
  assert.equal(await startContainerRelay({ containerId: "c1", targetPort: 3000, listenPort: 3001, docker: async () => ({ code: 1, stdout: "", stderr: "no such container" }) }), false);
});
