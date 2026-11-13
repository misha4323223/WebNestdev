/**
 * Пользовательский домен — отдельная сущность, а не поле сайта.
 *
 * Один запрос пользователя создаёт группу из apex и `www` (если это обычный домен).
 * Группа нужна, чтобы лимит тарифа считался по домену, а не по каждой DNS-записи, и
 * чтобы удаление/перенос не оставляли половину пары. Каждый hostname всё равно хранится
 * отдельной строкой: TLS, TXT-проверка и маршрутизация работают именно с именем.
 */

export type CustomDomainKind = "apex" | "www" | "subdomain";
export type CustomDomainStatus = "pending_dns" | "verified" | "configuring" | "issuing_certificate" | "active" | "error";
export type CustomDomainCertificateStatus = "none" | "issuing" | "active" | "error";

export type CustomDomain = {
  id: string;
  groupId: string;
  siteId: string;
  userId: string;
  hostname: string;
  displayHostname: string;
  kind: CustomDomainKind;
  status: CustomDomainStatus;
  verificationToken: string;
  verificationHost: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string;
  certificateStatus: CustomDomainCertificateStatus;
  certificateError: string;
  isCanonical: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomDomainGroup = {
  groupId: string;
  siteId: string;
  userId: string;
  domains: CustomDomain[];
};

export type CustomDomainDnsRecord = {
  type: "TXT" | "A" | "CNAME";
  name: string;
  value: string;
  purpose: "verification" | "traffic";
  /** Для apex-записи UI показывает `@`, но API всегда отдаёт полное имя. */
  relativeName: string;
};

export type NormalizedCustomDomain = {
  hostname: string;
  displayHostname: string;
  kind: CustomDomainKind;
};

export type NormalizeCustomDomainOptions = {
  includeWww?: boolean;
  /** Домены платформы, которые нельзя подключать как пользовательские. */
  reservedDomains?: string[];
};

export type NormalizedCustomDomainGroup = {
  rootDomain: string;
  hostnames: NormalizedCustomDomain[];
};

export type CreateCustomDomainInput = {
  siteId: string;
  userId: string;
  hostnames: NormalizedCustomDomain[];
  /** Проверяется внутри блокировки хранилища, а не только на входе API. */
  maxGroups?: number;
};

export type CustomDomainCheck = {
  hostname: string;
  txt: { allowed: boolean; reason: string };
  traffic: { allowed: boolean; reason: string };
  caa: { allowed: boolean; reason: string };
};

export type CustomDomainVerificationResult = {
  domains: CustomDomain[];
  checks: CustomDomainCheck[];
};

export type CustomDomainRow = {
  id: string;
  group_id: string;
  site_id: string;
  user_id: string;
  hostname: string;
  display_hostname: string;
  kind: string;
  status: string;
  verification_token: string;
  verification_host: string;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string;
  certificate_status: string;
  certificate_error: string;
  is_canonical: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};
