import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { createUser, findUserByEmail, getUser, type User } from "./auth-store.js";

/**
 * A Yandex ID sign-in is an identity, not a Yandex Cloud credential. The link below
 * only remembers which local user owns a Yandex account, so the next sign-in opens the
 * same projects; no OAuth token is stored.
 */
export type YandexIdentity = {
  yandexId: string;
  userId: string;
  login: string;
  email?: string;
  createdAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const identitiesFile = path.join(root, "auth", "yandex-accounts.json");

async function readIdentities(): Promise<YandexIdentity[]> {
  try { return JSON.parse(await readFile(identitiesFile, "utf8")) as YandexIdentity[]; }
  catch { return []; }
}

async function writeIdentities(identities: YandexIdentity[]) {
  await mkdir(path.dirname(identitiesFile), { recursive: true });
  await writeFile(identitiesFile, JSON.stringify(identities, null, 2), { mode: 0o600 });
}

export async function findUserIdByYandexId(yandexId: string) {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ user_id: string }>>`
      SELECT user_id FROM ${ydbQuery().identifier(getTable("yandex_accounts"))}
      WHERE yandex_id = ${yandexId}
      LIMIT 1
    `;
    return rows?.[0]?.user_id ?? null;
  }
  return (await readIdentities()).find(identity => identity.yandexId === yandexId)?.userId ?? null;
}

/** The Yandex login linked to a local account, or null when it signed in another way. */
export async function findYandexIdentityByUserId(userId: string) {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ yandex_id: string; user_id: string; login: string; email: string; created_at: string }>>`
      SELECT yandex_id,user_id,login,email,created_at
      FROM ${ydbQuery().identifier(getTable("yandex_accounts"))}
      WHERE user_id = ${userId}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const row = rows?.[0];
    return row ? { yandexId: row.yandex_id, userId: row.user_id, login: row.login, email: row.email || undefined, createdAt: row.created_at } : null;
  }
  return (await readIdentities()).find(identity => identity.userId === userId) ?? null;
}

export async function linkYandexIdentity(identity: YandexIdentity) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("yandex_accounts"))}
        (yandex_id,user_id,login,email,created_at)
      VALUES (${identity.yandexId},${identity.userId},${identity.login},${identity.email ?? ""},${identity.createdAt})
    `;
    return;
  }
  const identities = await readIdentities();
  const next = identities.filter(item => item.yandexId !== identity.yandexId);
  next.push(identity);
  await writeIdentities(next);
}

/**
 * Resolves the local account for a Yandex profile. A known Yandex id wins; otherwise a
 * synthetic address derived from the id is used. The profile e-mail is stored with the
 * identity but deliberately does not merge accounts: e-mail/password registration never
 * verifies the address, so linking by e-mail would let whoever pre-registered a victim's
 * address take over the account when the victim signs in with Yandex.
 */
export async function ensureYandexAccount(profile: { id: string; login?: string; email?: string }): Promise<User> {
  const yandexId = profile.id.trim();
  if (!yandexId) throw new Error("Яндекс ID не вернул идентификатор аккаунта");

  const linkedId = await findUserIdByYandexId(yandexId);
  if (linkedId) {
    const linked = await getUser(linkedId);
    if (linked) {
      await rememberIdentity(yandexId, linked.id, profile);
      return linked;
    }
  }

  const synthetic = "yandex-" + yandexId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) + "@yandex-id.webnestdev.local";
  let user = await findUserByEmail(synthetic);
  if (!user) {
    try {
      user = await createUser(synthetic, randomBytes(24).toString("hex"));
    } catch (error) {
      // Two first sign-ins at once can race on the unique e-mail; the second one
      // reads the row the first one created instead of failing the login.
      user = await findUserByEmail(synthetic);
      if (!user) throw error;
    }
  }

  await rememberIdentity(yandexId, user.id, profile);
  return user;
}

async function rememberIdentity(yandexId: string, userId: string, profile: { login?: string; email?: string }) {
  const existing = await findYandexIdentityByUserId(userId);
  await linkYandexIdentity({
    yandexId,
    userId,
    login: profile.login?.trim() || existing?.login || "Yandex ID",
    email: profile.email?.trim().toLowerCase() || existing?.email,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
}
