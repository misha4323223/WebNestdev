import { mwsServiceCatalog } from "../mws/mws-auth.js";
import { findCloudProvider, type CloudProviderId } from "./providers.js";

/**
 * Короткий каталог API каждого облака.
 *
 * Провайдеры не дают единого descubrible-каталога путей: у MWS сервис живёт на отдельном хосте и
 * называется иначе, чем ожидает модель (`virtualMachines`, а не `instances`), у Timeweb и REG.RU
 * свой префикс версии. Без подсказки агент узнаёт об этом только живым 404 — и тратит шаг.
 * Каталог не заменяет документацию: он называет несколько реальных путей и даёт ссылку на неё,
 * чтобы следующий запрос был осмысленным.
 */

export type CloudServiceEntry = {
  /** Первый сегмент пути, по которому выбирается сервис. */
  prefix: string;
  /** Хост, если он отличается от общего шлюза провайдера. */
  host?: string;
  /** Пример реального пути: его можно взять как шаблон. */
  example: string;
};

const CATALOG: Record<CloudProviderId, CloudServiceEntry[]> = {
  timeweb: [
    { prefix: "/api/v1/servers", example: "/api/v1/servers" },
    { prefix: "/api/v1/databases", example: "/api/v1/databases" },
    { prefix: "/api/v1/s3-storages", example: "/api/v1/s3-storages" },
    { prefix: "/api/v1/domains", example: "/api/v1/domains" },
    { prefix: "/api/v1/firewall-groups", example: "/api/v1/firewall-groups" },
    { prefix: "/api/v1/k8s-clusters", example: "/api/v1/k8s-clusters" },
    { prefix: "/api/v1/balancers", example: "/api/v1/balancers" },
    { prefix: "/api/v1/projects", example: "/api/v1/projects" },
  ],
  cloudru: [
    { prefix: "/v3/projects", example: "/v3/projects" },
    { prefix: "/v3/vms", example: "/v3/vms" },
    { prefix: "/v3/volumes", example: "/v3/volumes" },
    { prefix: "/v3/networks", example: "/v3/networks" },
    { prefix: "/v3/subnets", example: "/v3/subnets" },
    { prefix: "/v3/buckets", example: "/v3/buckets" },
  ],
  regru: [
    { prefix: "/v1/reglets", example: "/v1/reglets" },
    { prefix: "/v1/reglets/{id}", example: "/v1/reglets/123" },
    { prefix: "/v1/dns", example: "/v1/dns" },
    { prefix: "/v1/ssh-keys", example: "/v1/ssh-keys" },
    { prefix: "/v1/network", example: "/v1/network" },
  ],
  mws: [
    { prefix: "/rm", host: "iam.mwsapis.ru", example: "/rm/v3/projects" },
    { prefix: "/iam", host: "iam.mwsapis.ru", example: "/iam/v1/serviceAccounts" },
    { prefix: "/compute", host: "compute.mwsapis.ru", example: "/compute/v1/projects/{project}/virtualMachines" },
    { prefix: "/vpc", host: "vpc.mwsapis.ru", example: "/vpc/v1/networks" },
    { prefix: "/nlb", host: "vpc.mwsapis.ru", example: "/nlb/v1/loadBalancers" },
    { prefix: "/storage", host: "storage.mwsapis.ru", example: "/storage/v1/buckets" },
    { prefix: "/mpostgres", host: "mpostgres.mwsapis.ru", example: "/mpostgres/v1/projects/{project}/clusters" },
    { prefix: "/mmysql", host: "mmysql.mwsapis.ru", example: "/mmysql/v1/projects/{project}/clusters" },
    { prefix: "/mk8s", host: "mk8s.mwsapis.ru", example: "/mk8s/v1/projects/{project}/clusters" },
    { prefix: "/queue", host: "queue-api.mwsapis.ru", example: "/queue/v1/projects/{project}/queues" },
  ],
};

/** Ссылка на документацию провайдера: она уже есть в каталоге подключения. */
export function cloudDocsUrl(provider: CloudProviderId) {
  return findCloudProvider(provider)?.docsUrl ?? "";
}

/** Каталог одного облака или всех: у MWS он строится из того же списка, что и маршрутизация. */
export function cloudServiceCatalog(provider?: CloudProviderId) {
  if (provider === "mws") {
    return mwsServiceCatalog().map(entry => {
      const known = CATALOG.mws.find(item => item.prefix === entry.prefix);
      return known ?? { prefix: entry.prefix, host: entry.host, example: entry.prefix };
    });
  }
  if (provider) return CATALOG[provider];
  return (Object.keys(CATALOG) as CloudProviderId[]).flatMap(id =>
    CATALOG[id].map(entry => ({ provider: id, ...entry })),
  );
}

/** Подсказка к 404: какие пути существуют и где их описание, вместо «попробуйте ещё раз». */
export function cloudNotFoundHint(provider: CloudProviderId, path: string) {
  const catalog = cloudServiceCatalog(provider).slice(0, 12);
  const firstSegment = "/" + (path.split("?")[0].replace(/^\/+/, "").split("/")[0] ?? "");
  const matched = catalog.find(entry => entry.prefix === firstSegment || entry.prefix.startsWith(firstSegment + "/"));
  const docs = cloudDocsUrl(provider);
  return {
    hint:
      "Путь " + path + " не найден (HTTP 404)." +
      (matched ? " Похожий сервис: " + matched.prefix + " → " + matched.host + ", пример " + matched.example + "." : "") +
      " Сверьтесь с каталогом сервисов и документацией, прежде чем повторять запрос: у провайдера другой префикс или другое имя ресурса.",
    ...(docs ? { docsUrl: docs } : {}),
    catalog,
  };
}
