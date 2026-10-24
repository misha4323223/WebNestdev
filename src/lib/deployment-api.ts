import { apiJson } from "./api";

/** Что квиз узнаёт у сервера до первого вопроса. Значения ключей сюда не попадают. */
export type DeploymentArchitecture = "static" | "static-functions" | "functions" | "server" | "unknown";
export type DeploymentFrontend = "static" | "ssr" | "unknown";
export type DeploymentBackend = "none" | "functions" | "server" | "unknown";

export type DeploymentFunctionDir = {
  path: string;
  runtime: "node" | "python" | "unknown";
  evidence: string[];
};

export type DeploymentProjectType = {
  id: DeploymentArchitecture;
  frontend: DeploymentFrontend;
  backend: DeploymentBackend;
  shape: "instant-site" | "static-build" | "node-runtime" | "python-runtime" | "unknown";
  label: string;
  reason: string;
  evidence: string[];
  framework: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  functions: DeploymentFunctionDir[];
  serverDir: string | null;
};

export type DeploymentNeeds = {
  database: boolean;
  storage: boolean;
  email: boolean;
  sms: boolean;
  payments: boolean;
  ai: boolean;
  maps: boolean;
  crm: boolean;
};

export type DeploymentCloud = {
  id: string;
  name: string;
  connected: boolean;
  account: string | null;
  allowWrites: boolean | null;
  keyUrl: string;
  docsUrl: string;
};

export type DeploymentRegistrar = {
  id: string;
  name: string;
  connected: boolean;
  account: string | null;
  allowWrites: boolean | null;
  keyUrl: string;
  docsUrl: string;
};

export type DeploymentDatabase =
  | { connected: false }
  | {
      connected: true;
      provider: string;
      scheme: string;
      engine: string;
      host: string;
      port: number;
      database: string;
      username: string;
      ssl: boolean;
      maskedUrl: string;
    };

export type DeploymentService = {
  id: string;
  name: string;
  category: "storage" | "email" | "payments" | "ai" | "maps" | "crm";
  tagline: string;
  connected: boolean;
  /** Проект уже называет этого провайдера в зависимостях или .env.example. */
  preferred: boolean;
  account: string | null;
  env: string[];
  keyUrl: string;
  docsUrl: string;
};

export type DeploymentDatabaseOption = { id: string; name: string; note: string };

export type DeploymentOptions = {
  project: { id: string; name: string };
  projectType: DeploymentProjectType;
  needs: DeploymentNeeds;
  needsEvidence: Partial<Record<keyof DeploymentNeeds, string[]>>;
  clouds: DeploymentCloud[];
  domains: DeploymentRegistrar[];
  database: DeploymentDatabase;
  describeDatabase: DeploymentDatabaseOption[];
  services: DeploymentService[];
  smsSupported: boolean;
  plan: { exists: boolean; total: number; done: number; complete: boolean; current: string | null };
};

export const getDeploymentOptions = (projectId: string) =>
  apiJson<DeploymentOptions>("/api/projects/" + encodeURIComponent(projectId) + "/deployment/options");

/** Поля доступа сохраняются тем же маршрутом, что и карточка интеграции; значение не возвращается. */
export const submitProjectAccess = (
  projectId: string,
  requestId: string,
  fields: Record<string, string>,
  allowWrites?: boolean,
) => apiJson<{
  ok: boolean;
  kind: string;
  provider: string;
  name: string;
  account: string;
  allowWrites: boolean | null;
  delivered: boolean;
}>("/api/projects/" + encodeURIComponent(projectId) + "/access/" + encodeURIComponent(requestId), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ fields, ...(allowWrites === undefined ? {} : { allowWrites }) }),
});

export const cancelProjectAccess = (projectId: string, requestId: string) =>
  apiJson<{ cancelled: boolean }>("/api/projects/" + encodeURIComponent(projectId) + "/access/" + encodeURIComponent(requestId) + "/cancel", {
    method: "POST",
  });
