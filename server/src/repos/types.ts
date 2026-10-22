import type { RepoProviderId } from "./connection-store.js";

/**
 * Один репозиторий в том виде, в каком его понимает панель: у GitHub, GitVerse и SourceCraft
 * разные ответы API, но пользователю нужны одни и те же пять полей — кто владелец, как
 * называется, какая ветка по умолчанию, ссылка в браузере и адрес для git.
 */
export type RepoSummary = {
  /** Идентификатор внутри провайдера: у GitVerse — owner/repo, у SourceCraft — id репозитория. */
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  url: string;
  cloneUrl: string;
  isPrivate?: boolean;
};

export type OAuthSettings = {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
};

/**
 * Всё, что панель умеет делать с хостингом кода. Маршруты и карточка общие, поэтому новый
 * провайдер — это адаптер, а не копия GitLab целиком.
 */
export type RepoProvider = {
  id: RepoProviderId;
  name: string;
  /** База REST API, например https://api.gitverse.ru. */
  apiBase: string;
  /** Адрес сайта: из него собираются ссылки на коммиты и страница выдачи токена. */
  webBase: string;
  /** Имя для git-аутентификации: GitHub ждёт x-access-token, GitLab — oauth2. */
  gitUsername: string;
  /** Страница, где пользователь создаёт токен. */
  tokenUrl: string;
  oauth?: OAuthSettings;
  loginFromToken(token: string): Promise<string>;
  listRepositories(token: string): Promise<RepoSummary[]>;
  getRepository(token: string, id: string): Promise<RepoSummary>;
  /** Записывает файлы репозитория в песочницу и возвращает их число. */
  importRepository(token: string, repository: RepoSummary, root: string): Promise<number>;
  commitUrl(repository: RepoSummary, sha: string): string;
};
