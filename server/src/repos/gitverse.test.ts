import test from "node:test";
import assert from "node:assert/strict";
import { gitverse } from "./gitverse.js";
import { sourcecraft } from "./sourcecraft.js";

const realFetch = globalThis.fetch;

type Call = { url: string; headers: Headers };

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), headers: new Headers(init?.headers) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

test("GitVerse: токен проверяется через /user и уходит Bearer-заголовком", async () => {
  const calls = stubFetch(() => reply({ id: 1, login: "pimashin" }));
  try {
    assert.equal(await gitverse.loginFromToken("token-abc"), "pimashin");
    assert.match(calls[0].url, /\/user$/);
    assert.equal(calls[0].headers.get("Authorization"), "Bearer token-abc");
    assert.match(calls[0].headers.get("Accept") ?? "", /gitverse/);
  } finally { globalThis.fetch = realFetch; }
});

test("GitVerse: репозитории приводятся к общему виду", async () => {
  stubFetch(() => reply([
    { id: 7, name: "site", full_name: "team/site", default_branch: "main", html_url: "https://gitverse.ru/team/site", clone_url: "https://gitverse.ru/team/site.git", owner: { login: "team" }, private: true },
  ]));
  try {
    const repositories = await gitverse.listRepositories("token");
    assert.deepEqual(repositories, [{
      id: "team/site",
      owner: "team",
      name: "site",
      fullName: "team/site",
      defaultBranch: "main",
      url: "https://gitverse.ru/team/site",
      cloneUrl: "https://gitverse.ru/team/site.git",
      isPrivate: true,
    }]);
  } finally { globalThis.fetch = realFetch; }
});

test("GitVerse: 401 объясняет, что токен не принят", async () => {
  stubFetch(() => reply({ error: "unauthorized" }, 401));
  try {
    await assert.rejects(() => gitverse.loginFromToken("bad"), /не принял токен/);
  } finally { globalThis.fetch = realFetch; }
});

test("SourceCraft: список берёт organizer slug и https-адрес клона", async () => {
  const calls = stubFetch(() => reply({
    repositories: [{
      id: "repo-1",
      slug: "app",
      default_branch: "main",
      organization: { id: "org-1", slug: "team" },
      clone_url: { https: "https://git.sourcecraft.dev/team/app.git", ssh: "git@git.sourcecraft.dev:team/app.git" },
      visibility: "private",
    }],
  }));
  try {
    const repositories = await sourcecraft.listRepositories("pat");
    assert.match(calls[0].url, /\/me\/repos/);
    assert.equal(calls[0].headers.get("Authorization"), "Bearer pat");
    assert.deepEqual(repositories[0], {
      id: "repo-1",
      owner: "team",
      name: "app",
      fullName: "team/app",
      defaultBranch: "main",
      url: "https://sourcecraft.dev/team/app",
      cloneUrl: "https://git.sourcecraft.dev/team/app.git",
      isPrivate: true,
    });
  } finally { globalThis.fetch = realFetch; }
});
