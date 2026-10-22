import path from "node:path";
import { readdir } from "node:fs/promises";
import { cloneRepository } from "../changes/git-repo.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import type { RepoProvider, RepoSummary } from "./types.js";

const DEFAULT_API = "https://api.sourcecraft.tech";
const WEB = "https://sourcecraft.dev";

function apiBase() {
  return (getPlatformEnv("SOURCECRAFT_API_BASE") ?? process.env.SOURCECRAFT_API_BASE ?? DEFAULT_API).replace(/\/+$/, "");
}

async function request(token: string, pathname: string) {
  const response = await fetch(apiBase() + pathname, {
    headers: { Accept: "application/json", Authorization: "Bearer " + token },
  });
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 401) throw new Error("SourceCraft не принял токен: проверьте, что он скопирован целиком и не истёк");
    throw new Error("SourceCraft API вернул " + response.status + ": " + body.slice(0, 500));
  }
  return body ? JSON.parse(body) as unknown : null;
}

type RawRepository = {
  id?: string;
  slug?: string;
  name?: string;
  default_branch?: string;
  organization?: { slug?: string };
  clone_url?: { https?: string; ssh?: string };
  web_url?: string;
  visibility?: string;
  is_empty?: boolean;
};

function toSummary(raw: RawRepository): RepoSummary {
  const owner = raw.organization?.slug ?? "";
  const name = raw.slug ?? raw.name ?? "";
  const web = raw.web_url ?? (owner && name ? WEB + "/" + owner + "/" + name : "");
  return {
    id: raw.id ?? (owner && name ? owner + "/" + name : ""),
    owner,
    name,
    fullName: owner && name ? owner + "/" + name : name,
    defaultBranch: raw.default_branch?.trim() || "main",
    url: web,
    cloneUrl: raw.clone_url?.https ?? (web ? web.replace(/\/+$/, "") + ".git" : ""),
    isPrivate: raw.visibility === "private",
  };
}

/** Сколько файлов принёс клон: без этого карточка не сказала бы, что импорт что-то дал. */
async function countFiles(root: string) {
  const skip = new Set([".git", "node_modules", "dist", "build", ".next", ".nuxt", "coverage", ".webnestdev"]);
  let total = 0;
  const walk = async (dir: string) => {
    let entries;
    try { entries = await readdir(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const next = dir ? dir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(next);
      else total++;
    }
  };
  await walk("");
  return total;
}

export const sourcecraft: RepoProvider = {
  id: "sourcecraft",
  name: "SourceCraft",
  apiBase: apiBase(),
  webBase: WEB,
  // SourceCraft принимает токен как пароль при любом имени (https://anyname:<PAT>@git…).
  gitUsername: "oauth2",
  tokenUrl: WEB + "/portal/docs/en/sourcecraft/security/pat",
  async loginFromToken(token) {
    const user = await request(token, "/user") as { login?: string; username?: string; name?: string; email?: string };
    const login = user?.login ?? user?.username ?? user?.name ?? user?.email?.split("@")[0];
    if (!login) throw new Error("SourceCraft не вернул имя пользователя для этого токена");
    return login;
  },
  async listRepositories(token) {
    const data = await request(token, "/me/repos?page_size=100") as { repositories?: RawRepository[] } | RawRepository[];
    const list = Array.isArray(data) ? data : data?.repositories ?? [];
    return list.map(toSummary).filter(repository => repository.id);
  },
  async getRepository(token, id) {
    // Публичный API адресует репозиторий идентификатором: /repos/id:{id}.
    const raw = await request(token, "/repos/id:" + encodeURIComponent(id)) as RawRepository;
    return toSummary(raw);
  },
  async importRepository(token, repository, root) {
    // Чтения файла в публичном API SourceCraft нет — только дерево, поэтому импорт идёт клоном.
    await cloneRepository(root, {
      url: repository.cloneUrl,
      branch: repository.defaultBranch,
      token,
      username: sourcecraft.gitUsername,
    });
    return countFiles(root);
  },
  commitUrl(repository, sha) {
    return repository.url.replace(/\/+$/, "") + "/commit/" + sha;
  },
};
