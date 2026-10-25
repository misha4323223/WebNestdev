import test from "node:test";
import assert from "node:assert/strict";
import { allBuilds, buildSummary, parseEasJson, redactExpoToken } from "./expo-api.js";

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
