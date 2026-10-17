import test from "node:test";
import assert from "node:assert/strict";
import { resolveOAuthFlow, redirectToApp } from "./oauth-flow.js";

/**
 * Пустая переменная окружения — это не адрес. Compose передаёт в контейнер каждую
 * перечисленную переменную, поэтому незаданный GITHUB_CALLBACK_URL приходит как "".
 * Ошибка стоила рабочей кнопки «Подключить»: в GitHub уходил пустой redirect_uri, а
 * возврат в приложение — без пути, и браузер оказывался на `/?github=state_expired`.
 */
const request = { headers: {}, protocol: "https" } as never;

function withOrigin(run: () => void) {
  const previous = process.env.WEBNESTDEV_ALLOWED_ORIGINS;
  process.env.WEBNESTDEV_ALLOWED_ORIGINS = "https://nestdev.ru";
  try { run(); }
  finally {
    if (previous === undefined) delete process.env.WEBNESTDEV_ALLOWED_ORIGINS;
    else process.env.WEBNESTDEV_ALLOWED_ORIGINS = previous;
  }
}

test("пустые настройки провайдера не побеждают вычисленный адрес", () => {
  withOrigin(() => {
    const flow = resolveOAuthFlow(request, {
      callbackPath: "/api/github/callback",
      configuredCallbackUrl: "",
      configuredFrontendUrl: "   ",
      requestedOrigin: "https://nestdev.ru",
    });
    assert.equal(flow.callbackUrl, "https://nestdev.ru/api/github/callback");
    assert.equal(flow.frontendUrl, "https://nestdev.ru/");
  });
});

test("заданные адреса важнее вычисленных, пробелы обрезаются", () => {
  withOrigin(() => {
    const flow = resolveOAuthFlow(request, {
      callbackPath: "/api/github/callback",
      configuredCallbackUrl: " https://auth.example.com/api/github/callback\n",
      configuredFrontendUrl: "https://app.example.com/ ",
      requestedOrigin: "https://nestdev.ru",
    });
    assert.equal(flow.callbackUrl, "https://auth.example.com/api/github/callback");
    assert.equal(flow.frontendUrl, "https://app.example.com/");
  });
});

test("отказ возвращает в приложение, а не в пустой адрес", () => {
  withOrigin(() => {
    const flow = resolveOAuthFlow(request, {
      callbackPath: "/api/github/callback",
      configuredCallbackUrl: "",
      configuredFrontendUrl: "",
      requestedOrigin: "https://nestdev.ru",
    });
    let target = "";
    redirectToApp({ redirect: (url: string) => { target = url; } }, flow.frontendUrl, "github", "state_expired");
    assert.equal(target, "https://nestdev.ru/?github=state_expired");
  });
});
