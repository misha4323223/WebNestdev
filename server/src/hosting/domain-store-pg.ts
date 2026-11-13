import { randomBytes, randomUUID } from "node:crypto";
import { customDomainVerificationHost } from "./domain-config.js";
import { getTable, initializeStorage, ydbQuery } from "../storage/ydb.js";
import type { YdbQueryTag } from "../storage/pg.js";
import { HostingError } from "./types.js";
import type { CreateCustomDomainInput, CustomDomain, CustomDomainRow, CustomDomainStatus } from "./domain-types.js";

/** PostgreSQL-ветка хранит группу строк в одной транзакции: половина пары не должна остаться. */
function table() {
  return ydbQuery().identifier(getTable("site_domains"));
}

function fromRow(row: CustomDomainRow): CustomDomain {
  return {
    id: row.id,
    groupId: row.group_id,
    siteId: row.site_id,
    userId: row.user_id,
    hostname: row.hostname,
    displayHostname: row.display_hostname,
    kind: row.kind as CustomDomain["kind"],
    status: row.status as CustomDomainStatus,
    verificationToken: row.verification_token,
    verificationHost: row.verification_host,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error ?? "",
    certificateStatus: row.certificate_status as CustomDomain["certificateStatus"],
    certificateError: row.certificate_error ?? "",
    isCanonical: Boolean(row.is_canonical),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function uniqueViolation(error: unknown): boolean {
  return String((error as { code?: string } | null)?.code ?? "").includes("23505");
}

async function pgDomain(id: string): Promise<CustomDomain | null> {
  await initializeStorage();
  const [rows] = await ydbQuery()<CustomDomainRow[]>`
    SELECT * FROM ${table()} WHERE id = ${id} LIMIT 1`;
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listPgDomains(): Promise<CustomDomain[]> {
  await initializeStorage();
  const [rows] = await ydbQuery()<CustomDomainRow[]>`
    SELECT * FROM ${table()} ORDER BY hostname ASC`;
  return rows.map(fromRow);
}

export async function listPgDomainsBySite(siteId: string): Promise<CustomDomain[]> {
  await initializeStorage();
  const [rows] = await ydbQuery()<CustomDomainRow[]>`
    SELECT * FROM ${table()}
     WHERE site_id = ${siteId}
     ORDER BY is_canonical DESC, created_at ASC`;
  return rows.map(fromRow);
}

export async function listPgDomainsByGroup(groupId: string): Promise<CustomDomain[]> {
  await initializeStorage();
  const [rows] = await ydbQuery()<CustomDomainRow[]>`
    SELECT * FROM ${table()}
     WHERE group_id = ${groupId}
     ORDER BY is_canonical DESC, created_at ASC`;
  return rows.map(fromRow);
}

export async function getPgDomain(id: string): Promise<CustomDomain | null> {
  return pgDomain(id);
}

export async function getPgDomainByHostname(hostname: string): Promise<CustomDomain | null> {
  await initializeStorage();
  const [rows] = await ydbQuery()<CustomDomainRow[]>`
    SELECT * FROM ${table()} WHERE hostname = ${hostname} LIMIT 1`;
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function countPgDomainGroups(siteId: string): Promise<number> {
  await initializeStorage();
  const [rows] = await ydbQuery()<Array<{ count: number | string | bigint }>>`
    SELECT COUNT(DISTINCT group_id) AS count FROM ${table()} WHERE site_id = ${siteId}`;
  return Number(rows[0]?.count ?? 0);
}

export async function createPgDomainGroup(input: CreateCustomDomainInput): Promise<CustomDomain[]> {
  if (!input.hostnames.length) throw new HostingError("DOMAIN_INVALID", "Нужен хотя бы один домен", 400);
  await initializeStorage();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const groupId = randomUUID();
  const verificationToken = randomBytes(24).toString("base64url");
  const canonicalHost = input.hostnames.find(item => item.kind === "apex")?.hostname ?? input.hostnames[0].hostname;
  const created: CustomDomain[] = input.hostnames.map(item => ({
    id: randomUUID(),
    groupId,
    siteId: input.siteId,
    userId: input.userId,
    hostname: item.hostname,
    displayHostname: item.displayHostname,
    kind: item.kind,
    status: "pending_dns",
    verificationToken,
    verificationHost: customDomainVerificationHost(item.hostname),
    verifiedAt: null,
    lastCheckedAt: null,
    lastError: "",
    certificateStatus: "none",
    certificateError: "",
    isCanonical: item.hostname === canonicalHost,
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }));
  try {
    await ydbQuery().transaction({}, async tx => {
      const sites = tx.identifier(getTable("sites"));
      const domains = tx.identifier(getTable("site_domains"));
      // Блокировка сайта закрывает гонку двух одновременных POST и гонку с удалением сайта:
      // без неё оба запроса увидели бы 0 групп, а create мог бы пережить soft-delete.
      const [siteRows] = await tx<Array<{ status: string; user_id: string }>>`
        SELECT status, user_id FROM ${sites} WHERE id = ${input.siteId} FOR UPDATE`;
      if (!siteRows[0]) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      if (siteRows[0].user_id !== input.userId) throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      if (siteRows[0].status === "deleted") throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
      if (siteRows[0].status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт приостановлен", 409);
      const [duplicateRows] = await tx<Array<{ id: string }>>`
        SELECT id FROM ${domains}
         WHERE hostname = ANY(${input.hostnames.map(item => item.hostname)})
         LIMIT 1`;
      if (duplicateRows.length) throw new HostingError("DOMAIN_TAKEN", "Этот домен уже подключён", 409);
      if (input.maxGroups !== undefined) {
        const [countRows] = await tx<Array<{ count: number | string | bigint }>>`
          SELECT COUNT(DISTINCT group_id) AS count FROM ${domains} WHERE site_id = ${input.siteId}`;
        if (Number(countRows[0]?.count ?? 0) >= input.maxGroups) {
          throw new HostingError("DOMAIN_LIMIT", "На этом тарифе можно подключить один свой домен к сайту", 409);
        }
      }
      for (const domain of created) {
        await tx`
          INSERT INTO ${tx.identifier(getTable("site_domains"))}
            (id, group_id, site_id, user_id, hostname, display_hostname, kind, status,
             verification_token, verification_host, verified_at, last_checked_at, last_error,
             certificate_status, certificate_error, is_canonical, expires_at, created_at, updated_at)
          VALUES (${domain.id}, ${domain.groupId}, ${domain.siteId}, ${domain.userId}, ${domain.hostname},
                  ${domain.displayHostname}, ${domain.kind}, ${domain.status}, ${domain.verificationToken},
                  ${domain.verificationHost}, ${domain.verifiedAt}, ${domain.lastCheckedAt}, ${domain.lastError},
                  ${domain.certificateStatus}, ${domain.certificateError}, ${domain.isCanonical}, ${domain.expiresAt},
                  ${domain.createdAt}, ${domain.updatedAt})`;
      }
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new HostingError("DOMAIN_TAKEN", "Этот домен уже подключён", 409);
    throw error;
  }
  return created;
}

export async function updatePgDomain(
  id: string,
  patch: Partial<Pick<CustomDomain, "status" | "verifiedAt" | "lastCheckedAt" | "lastError" | "certificateStatus" | "certificateError" | "isCanonical">>,
): Promise<CustomDomain | null> {
  const current = await pgDomain(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await initializeStorage();
  const [rows] = await ydbQuery()<CustomDomainRow[]>`
    UPDATE ${table()}
       SET status = ${next.status}, verified_at = ${next.verifiedAt},
           last_checked_at = ${next.lastCheckedAt}, last_error = ${next.lastError},
           certificate_status = ${next.certificateStatus}, certificate_error = ${next.certificateError},
           is_canonical = ${next.isCanonical}, updated_at = ${next.updatedAt}
     WHERE id = ${id}
     RETURNING *`;
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function setPgCanonical(siteId: string, domainId: string): Promise<CustomDomain[]> {
  await initializeStorage();
  let groupId: string | undefined;
  await ydbQuery().transaction({}, async tx => {
    const domains = tx.identifier(getTable("site_domains"));
    const [rows] = await tx<Array<{ group_id: string }>>`
      SELECT group_id FROM ${domains}
       WHERE id = ${domainId} AND site_id = ${siteId}
       FOR UPDATE`;
    groupId = rows[0]?.group_id;
    if (!groupId) throw new HostingError("DOMAIN_NOT_FOUND", "Домен не найден", 404);
    await tx`
      UPDATE ${domains}
         SET is_canonical = (id = ${domainId}), updated_at = ${new Date().toISOString()}
       WHERE site_id = ${siteId} AND group_id = ${groupId}`;
  });
  if (!groupId) throw new HostingError("DOMAIN_NOT_FOUND", "Домен не найден", 404);
  return listPgDomainsByGroup(groupId);
}

export async function deletePgDomainGroup(siteId: string, domainId: string): Promise<boolean> {
  await initializeStorage();
  const target = await pgDomain(domainId);
  if (!target || target.siteId !== siteId) return false;
  const [rows] = await ydbQuery()<Array<{ id: string }>>`
    DELETE FROM ${table()}
     WHERE site_id = ${siteId} AND group_id = ${target.groupId}
     RETURNING id`;
  return rows.length > 0;
}

export async function deletePgDomainGroupsForSite(siteId: string, tx?: YdbQueryTag): Promise<number> {
  const sql = tx ?? ydbQuery();
  const domains = sql.identifier(getTable("site_domains"));
  const [rows] = await sql<Array<{ group_id: string }>>`
    DELETE FROM ${domains} WHERE site_id = ${siteId} RETURNING group_id`;
  return new Set(rows.map(row => row.group_id)).size;
}

export async function transferPgDomainOwners(siteIds: string[], fromUserId: string, toUserId: string, tx?: YdbQueryTag): Promise<number> {
  if (!siteIds.length) return 0;
  const sql = tx ?? ydbQuery();
  const domains = sql.identifier(getTable("site_domains"));
  const [rows] = await sql<Array<{ group_id: string }>>`
    UPDATE ${domains}
       SET user_id = ${toUserId}, updated_at = ${new Date().toISOString()}
     WHERE user_id = ${fromUserId} AND site_id = ANY(${siteIds})
     RETURNING group_id`;
  return new Set(rows.map(row => row.group_id)).size;
}
