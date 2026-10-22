import { getRepoConnection, saveRepoConnection, type RepoProviderId } from "./connection-store.js";
import { gitverseOAuth } from "./gitverse.js";

/** Запас до истечения: токен обновляется заранее, чтобы запрос не упал на середине. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Действующий токен подключения. Обычный личный токен возвращается как есть; OAuth-токен
 * GitVerse живёт час, поэтому при подходе к сроку он меняется на свежий по refresh_token.
 * Неудача обновления не отменяет подключение: отдаём прежний токен, а ошибку покажет запрос.
 */
export async function repoToken(userId: string, provider: RepoProviderId): Promise<string | null> {
  const connection = await getRepoConnection(userId, provider);
  if (!connection) return null;
  if (provider !== "gitverse" || !connection.refreshToken) return connection.accessToken;
  const expiresAt = connection.expiresAt ? Date.parse(connection.expiresAt) : 0;
  if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) return connection.accessToken;
  try {
    const oauth = gitverseOAuth();
    const response = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken,
        client_id: oauth.clientId ?? "",
        ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
      }),
    });
    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return connection.accessToken;
    await saveRepoConnection({
      userId,
      provider,
      accessToken: data.access_token,
      // GitVerse вращает refresh_token: старый после обмена может перестать работать.
      refreshToken: data.refresh_token ?? connection.refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
      login: connection.login,
      baseUrl: connection.baseUrl,
    });
    return data.access_token;
  } catch (error) {
    console.warn("[repos] не удалось обновить токен " + provider, error);
    return connection.accessToken;
  }
}
