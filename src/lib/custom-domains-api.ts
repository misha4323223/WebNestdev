import { apiJson } from "./api";

export type CustomDomainStatus =
  | "pending_dns"
  | "verified"
  | "configuring"
  | "issuing_certificate"
  | "active"
  | "error";

export type CustomDomainDnsRecord = {
  type: "TXT" | "A" | "CNAME";
  name: string;
  relativeName: string;
  value: string;
  purpose: "verification" | "traffic";
};

export type CustomDomain = {
  id: string;
  groupId: string;
  hostname: string;
  displayHostname: string;
  kind: "apex" | "www" | "subdomain";
  status: CustomDomainStatus;
  isCanonical: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string;
  certificateStatus: "none" | "issuing" | "active" | "error";
  certificateError: string;
  dns: CustomDomainDnsRecord[];
};

export type CustomDomainState = {
  enabled: boolean;
  target: string;
  ip: string;
  domains: CustomDomain[];
};

export type CustomDomainCheck = {
  hostname: string;
  txt: { allowed: boolean; reason: string };
  traffic: { allowed: boolean; reason: string };
  caa: { allowed: boolean; reason: string };
};

const base = (projectId: string) =>
  "/api/projects/" + encodeURIComponent(projectId) + "/hosting/domains";

export const getCustomDomains = (projectId: string) =>
  apiJson<CustomDomainState>(base(projectId));

export const addCustomDomain = (
  projectId: string,
  hostname: string,
  includeWww: boolean,
) =>
  apiJson<{ domains: CustomDomain[]; target: string; ip: string }>(base(projectId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname, includeWww }),
  });

export const checkCustomDomain = (projectId: string, domainId: string) =>
  apiJson<{ domains: CustomDomain[]; checks: CustomDomainCheck[] }>(
    base(projectId) + "/" + encodeURIComponent(domainId) + "/check",
    { method: "POST" },
  );

export const setCanonicalCustomDomain = (projectId: string, domainId: string) =>
  apiJson<{ domains: CustomDomain[] }>(
    base(projectId) + "/" + encodeURIComponent(domainId),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonical: true }),
    },
  );

export const removeCustomDomain = (projectId: string, domainId: string) =>
  apiJson<{ deleted: boolean }>(
    base(projectId) + "/" + encodeURIComponent(domainId),
    { method: "DELETE" },
  );
