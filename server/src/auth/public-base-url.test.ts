import test from "node:test";
import assert from "node:assert/strict";
import { publicBaseUrl } from "./public-base-url.js";

function request(headers: Record<string, string>, protocol = "https") {
  return { headers, protocol } as never;
}

function withEnv(changes: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(changes)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("PLATFORM_URL важнее Host и Origin", () => {
  withEnv({
    PLATFORM_URL: "https://app.example/",
    WEBNESTDEV_ALLOWED_ORIGINS: "https://panel.example",
  }, () => {
    assert.equal(
      publicBaseUrl(request({ host: "evil.example", origin: "https://evil.example" })),
      "https://app.example",
    );
  });
});

test("без PLATFORM_URL ссылка не строится из поддельного Host", () => {
  withEnv({
    PLATFORM_URL: undefined,
    WEBNESTDEV_ALLOWED_ORIGINS: "https://panel.example",
  }, () => {
    assert.equal(publicBaseUrl(request({ host: "evil.example" })), "https://panel.example");
    assert.equal(
      publicBaseUrl(request({ host: "evil.example", origin: "https://evil.example" })),
      "https://panel.example",
    );
  });
});
