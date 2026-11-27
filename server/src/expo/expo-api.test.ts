import test from "node:test";
import assert from "node:assert/strict";
import { allBuilds, buildSummary, easEnvironment, easNetworkHint, parseEasJson, redactExpoToken } from "./expo-api.js";

const build = {
  id: "0b7d2f4e-1f2a-4c3d-9e8f-123456789abc",
  status: "IN_PROGRESS",
  platform: "ANDROID",
  buildProfile: "production",
  logFiles: ["https://logs.example/expo.log", "https://logs.example/second.log"],
  app: {
    slug: "nestdev",
    ownerAccount: { name: "nestdev-team" },
  },
};

test("EAS CLI: JSON отделяется от предупреждений npx", () => {
  const parsed = parseEasJson("npm warn exec The following package was not found\n" + JSON.stringify(build));
  assert.equal(allBuilds(parsed)[0]?.id, build.id);
  assert.equal(allBuilds({ builds: [build] }).length, 1);
  assert.equal(allBuilds([{ id: "" }, build])[0]?.id, build.id);
  assert.throws(() => parseEasJson("not json"), /не JSON/);
});

test("сборка отдаёт только страницу expo.dev, без подписанных ссылок на логи", () => {
  const summary = buildSummary(build);
  assert.equal(summary.url, "https://expo.dev/accounts/nestdev-team/projects/nestdev/builds/" + build.id);
  assert.equal("logUrls" in summary, false);
  assert.equal(JSON.stringify(summary).includes("logs.example"), false);
  assert.equal(summary.status, "IN_PROGRESS");
  assert.equal(summary.error, null);
  assert.deepEqual(summary.artifacts, { build: false, applicationArchive: false, buildArtifacts: false });
});

test("токен Expo вырезается из любого текста ошибки", () => {
  const token = "expo_secret_token_123";
  assert.equal(redactExpoToken("token=" + token + " failed", token), "token=[expo token] failed");
});

test("EAS CLI получает прокси платформы: без него сеть песочницы закрыта", () => {
  const env = easEnvironment("expo_secret_token_123");
  assert.equal(env.EXPO_TOKEN, "expo_secret_token_123");
  assert.equal(env.EAS_NO_VCS, "1");
  // Контейнер выходит в интернет только через прокси, а Node не читает HTTP(S)_PROXY без флага.
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  // Дополнительные значения не должны вытеснять флаг и токен.
  const withAccount = easEnvironment("t", { EAS_ACCOUNT: "team" });
  assert.equal(withAccount.EAS_ACCOUNT, "team");
  assert.equal(withAccount.NODE_USE_ENV_PROXY, "1");
  assert.equal(withAccount.EXPO_TOKEN, "t");
});

test("сетевой отказ объясняется как сеть платформы, а ошибка сборки — нет", () => {
  assert.match(easNetworkHint("FetchError: request failed, connect ECONNREFUSED 1.2.3.4:443"), /прокси платформы/);
  assert.match(easNetworkHint("403 домен не входит в список разрешённых: api.expo.dev"), /net\.request/);
  assert.equal(easNetworkHint("Android build failed: Gradle task assembleRelease failed"), "");
});
