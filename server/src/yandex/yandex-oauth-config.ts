import { getPlatformEnv } from "../platform/platform-env.js";

/**
 * Client credentials of a Yandex ID app. The same app is used for the Yandex Cloud
 * integration and for "Sign in with Yandex ID"; the callback path is shared so an
 * existing registration keeps working. Values are read per request because they can
 * be entered in the server keys panel without a restart.
 */
export function yandexOAuthConfig() {
  const read = (name: string) => getPlatformEnv(name)?.trim() || undefined;
  return {
    clientId: read("YANDEX_CLIENT_ID"),
    clientSecret: read("YANDEX_CLIENT_SECRET"),
    configuredCallbackUrl: read("YANDEX_CALLBACK_URL"),
    configuredFrontendUrl: read("YANDEX_FRONTEND_URL"),
    // Only the Cloud integration requests a scope. Sign-in deliberately sends none:
    // it then gets the permissions already enabled in the app, and a scope list that
    // includes a permission the app no longer has would fail before the consent screen.
    scope: read("YANDEX_OAUTH_SCOPE"),
  };
}
