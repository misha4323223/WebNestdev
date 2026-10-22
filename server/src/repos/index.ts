import type { RepoProviderId } from "./connection-store.js";
import { gitverse } from "./gitverse.js";
import { sourcecraft } from "./sourcecraft.js";
import type { RepoProvider } from "./types.js";

/** Все хостинги кода, которые подключаются токеном: карточки и маршруты у них общие. */
export const REPO_PROVIDERS: RepoProvider[] = [gitverse, sourcecraft];

export function repoProvider(id: RepoProviderId): RepoProvider {
  const provider = REPO_PROVIDERS.find(item => item.id === id);
  if (!provider) throw new Error("Неизвестный хостинг кода: " + id);
  return provider;
}
