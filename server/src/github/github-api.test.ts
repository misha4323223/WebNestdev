import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { getGitHubLoginFromToken } from "./github-api.js";

/**
 * Подключение по личному токену — способ, который работает без OAuth-приложения, поэтому проверка
 * токена должна давать точную причину: «не принят», «истёк», «лишние символы». Здесь GitHub
 * подменяется локальным сервером: сеть и настоящий api.github.com в тестах не нужны.
 */
async function githubStub(handler: (authorization: string | undefined) => { status: number; body: string }) {
  const seen: (string | undefined)[] = [];
  const server: Server = createServer((request, response) => {
    const authorization = request.headers.authorization;
    seen.push(authorization);
    const answer = handler(authorization);
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(answer.body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

async function withApiBase<T>(base: string, run: () => Promise<T>) {
  const previous = process.env.GITHUB_API_BASE;
  process.env.GITHUB_API_BASE = base;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GITHUB_API_BASE;
    else process.env.GITHUB_API_BASE = previous;
  }
}

test("a valid personal token is answered with the account login", async () => {
  const stub = await githubStub(() => ({ status: 200, body: JSON.stringify({ login: "octocat" }) }));
  try {
    const login = await withApiBase(stub.base, () => getGitHubLoginFromToken("ghp_realtoken"));
    assert.equal(login, "octocat");
    // Токен уходит именно в Authorization, иначе GitHub ответил бы 401 в бою.
    assert.equal(stub.seen.at(-1), "Bearer ghp_realtoken");
  } finally {
    await stub.close();
  }
});

test("a rejected token says it was not accepted instead of a raw status", async () => {
  const stub = await githubStub(() => ({ status: 401, body: JSON.stringify({ message: "Bad credentials" }) }));
  try {
    await assert.rejects(
      () => withApiBase(stub.base, () => getGitHubLoginFromToken("ghp_wrong")),
      /GitHub не принял токен/,
    );
  } finally {
    await stub.close();
  }
});

test("an answer without a login is an error, not an empty account", async () => {
  const stub = await githubStub(() => ({ status: 200, body: JSON.stringify({}) }));
  try {
    await assert.rejects(
      () => withApiBase(stub.base, () => getGitHubLoginFromToken("ghp_nouser")),
      /не вернул имя пользователя/,
    );
  } finally {
    await stub.close();
  }
});

test("an unreachable GitHub is reported as a connection problem", async () => {
  // Порт закрыт: сервер поднимается и сразу останавливается.
  const stub = await githubStub(() => ({ status: 200, body: "{}" }));
  const base = stub.base;
  await stub.close();
  await assert.rejects(
    () => withApiBase(base, () => getGitHubLoginFromToken("ghp_offline")),
    /Не удалось связаться с GitHub/,
  );
});
