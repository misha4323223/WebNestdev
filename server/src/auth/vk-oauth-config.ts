import { getPlatformEnv } from "../platform/platform-env.js";

/**
 * Client credentials of a VK ID web application. Values are read per request
 * because they can be entered in the server keys panel without a restart.
 *
 * `VK_SERVICE_TOKEN` is optional: a public client authenticates the exchange with
 * PKCE alone, while a confidential client also sends the service key and accepts
 * requests only from the IP addresses listed in the VK ID cabinet.
 */
export function vkOAuthConfig() {
  const read = (name: string) => getPlatformEnv(name)?.trim() || undefined;
  return {
    clientId: read("VK_CLIENT_ID"),
    serviceToken: read("VK_SERVICE_TOKEN"),
    configuredCallbackUrl: read("VK_CALLBACK_URL"),
    configuredFrontendUrl: read("VK_FRONTEND_URL"),
    // Empty by default: VK grants vkid.personal_info, which is enough for sign-in.
    // Set it to `email` only after e-mail access is enabled in the app.
    scope: read("VK_OAUTH_SCOPE"),
  };
}
