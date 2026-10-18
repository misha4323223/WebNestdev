const TOKEN_URL = "https://oauth.yandex.com/token";
const PROFILE_URL = "https://login.yandex.ru/info?format=json";

export type YandexProfile = {
  id: string;
  login?: string;
  email?: string;
  displayName?: string;
};

/**
 * Exchanges the one-time authorization code. The access token is used only to read
 * the profile and is never stored: signing in with Yandex ID is identity, not access
 * to the user's Yandex Cloud.
 */
export async function exchangeYandexCode(code: string, clientId: string, clientSecret: string) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const text = await response.text();
  let parsed: { access_token?: string; error?: string; error_description?: string } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch {}
  if (!response.ok || !parsed.access_token) {
    throw new Error("Яндекс не выдал токен входа" + (parsed.error_description || parsed.error ? ": " + (parsed.error_description ?? parsed.error) : ""));
  }
  return parsed.access_token;
}

/** `id` and `login` are always present; e-mail and name need the matching permission. */
export async function fetchYandexProfile(accessToken: string): Promise<YandexProfile> {
  const response = await fetch(PROFILE_URL, {
    headers: { Authorization: "OAuth " + accessToken },
  });
  const text = await response.text();
  if (!response.ok) {
    // 403 here almost always means the app has no "Доступ к логину..." permission.
    throw new Error("Яндекс ID не отдал профиль (" + response.status + "): включите в приложении право login:info");
  }
  let profile: { id?: string | number; login?: string; default_email?: string; emails?: string[]; display_name?: string };
  try { profile = JSON.parse(text) as typeof profile; }
  catch { throw new Error("Яндекс ID вернул не JSON-профиль"); }
  if (profile.id === undefined || profile.id === null || String(profile.id).trim() === "") {
    throw new Error("Яндекс ID не вернул идентификатор аккаунта");
  }
  return {
    id: String(profile.id),
    login: profile.login?.trim() || undefined,
    email: profile.default_email?.trim() || profile.emails?.find(Boolean)?.trim() || undefined,
    displayName: profile.display_name?.trim() || undefined,
  };
}
