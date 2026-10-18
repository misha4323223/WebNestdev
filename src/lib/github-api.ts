import { apiJson } from "./api";
import type { ProjectChanges } from "./project-api";

/**
 * Подключение GitHub на уровне аккаунта и репозиторий проекта. Создание репозитория живёт
 * здесь, а не в панели интеграций: оно принадлежит «Изменениям» — это место, куда уходят
 * коммиты задачи.
 */
export type GitHubStatus = { connected: boolean; githubLogin?: string | null; configured?: boolean };

export const getGitHubStatus = () => apiJson<GitHubStatus>("/api/github/status");

export const createProjectRepository = (projectId: string, name: string) =>
  apiJson<{ pushed: boolean; branch: string; pushError?: string; overview: ProjectChanges }>(
    "/api/projects/" + projectId + "/changes/repository",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) },
  );
