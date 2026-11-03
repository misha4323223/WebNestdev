import { createHash, randomBytes } from "node:crypto";

/**
 * VK ID uses its own OAuth 2.1 endpoints on id.vk.ru, not the legacy oauth.vk.com.
 * The code exchange is protected by PKCE even when the app has no server secret:
 * VK does not issue a classic client_secret for the REST flow. A confidential app
 * additionally sends VK_SERVICE_TOKEN, so the optional parameter is kept here.
 */
const AUTHORIZE_URL = "https://id.vk.ru/authorize";
const TOKEN_URL = "https://id.vk.ru/oauth2/auth";
const PROFILE_URL = "https://id.vk.ru/oauth2/user_info";

export type VkProfile = {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
};

export function createVkPkce() {
  // 43–128 characters from [A-Za-z0-9_-] are required by RFC 7636; 48 random
  // bytes become 64 base64url characters.
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

/** VK requires at least 32 characters from [A-Za-z0-9_-]; a dot is not allowed. */
export function createVkState() {
  return randomBytes(32).toString("hex");
}

export function vkAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
}) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // An empty scope is deliberate: VK then grants the app's default permissions
  // (vkid.personal_info), so sign-in works before e-mail access is enabled.
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url;
}

function readError(text: string, response: Response) {
  try {
    const parsed = JSON.parse(text) as { error?: string; error_description?: string; error_code?: number };
    const reason = parsed.error_description || parsed.error;
    if (reason) return reason;
  } catch {}
  return "HTTP " + response.status;
}

/**
 * Exchanges the one-time code (10 minutes) for an access token (1 hour). The token
 * is used only to read the profile and is never stored: VK ID is identity, not
 * access to the user's VK account.
 */
export async function exchangeVkCode(input: {
  code: string;
  deviceId: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  state: string;
  serviceToken?: string;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    device_id: input.deviceId,
    state: input.state,
  });
  if (input.serviceToken) body.set("service_token", input.serviceToken);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  let parsed: { access_token?: string; error?: string; error_description?: string } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch {}
  if (!response.ok || !parsed.access_token) {
    throw new Error("VK ID не выдал токен входа: " + readError(text, response));
  }
  return parsed.access_token;
}

/** The profile id is the stable key; name, e-mail and avatar are optional. */
export async function fetchVkProfile(accessToken: string, clientId: string): Promise<VkProfile> {
  const response = await fetch(PROFILE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, access_token: accessToken }).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error("VK ID не отдал профиль: " + readError(text, response));
  }
  let parsed: {
    user?: {
      user_id?: string | number;
      first_name?: string;
      last_name?: string;
      email?: string;
      avatar?: string;
    };
  };
  try { parsed = JSON.parse(text) as typeof parsed; }
  catch { throw new Error("VK ID вернул не JSON-профиль"); }

  const user = parsed.user;
  if (user?.user_id === undefined || user.user_id === null || String(user.user_id).trim() === "") {
    throw new Error("VK ID не вернул идентификатор аккаунта");
  }
  const name = [user.first_name, user.last_name].map(part => part?.trim()).filter(Boolean).join(" ");
  return {
    id: String(user.user_id),
    name: name || "VK ID",
    email: user.email?.trim().toLowerCase() || undefined,
    avatar: user.avatar?.trim() || undefined,
  };
}
