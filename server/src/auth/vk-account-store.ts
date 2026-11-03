import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { createUser, findUserByEmail, getUser, type User } from "./auth-store.js";

/**
 * A VK ID sign-in is an identity, not access to the user's VK account. This link
 * remembers which local account owns a VK profile, so the next sign-in opens the
 * same projects; the VK access token itself is never stored.
 */
export type VkIdentity = {
  vkId: string;
  userId: string;
  name: string;
  email?: string;
  createdAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const identitiesFile = path.join(root, "auth", "vk-accounts.json");

async function readIdentities(): Promise<VkIdentity[]> {
  try { return JSON.parse(await readFile(identitiesFile, "utf8")) as VkIdentity[]; }
  catch { return []; }
}

async function writeIdentities(identities: VkIdentity[]) {
  await mkdir(path.dirname(identitiesFile), { recursive: true });
  await writeFile(identitiesFile, JSON.stringify(identities, null, 2), { mode: 0o600 });
}

export async function findUserIdByVkId(vkId: string) {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ user_id: string }>>`
      SELECT user_id FROM ${ydbQuery().identifier(getTable("vk_accounts"))}
      WHERE vk_id = ${vkId}
      LIMIT 1
    `;
    return rows?.[0]?.user_id ?? null;
  }
  return (await readIdentities()).find(identity => identity.vkId === vkId)?.userId ?? null;
}

/** The VK profile linked to a local account, or null when it signed in another way. */
export async function findVkIdentityByUserId(userId: string) {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ vk_id: string; user_id: string; name: string; email: string; created_at: string }>>`
      SELECT vk_id,user_id,name,email,created_at
      FROM ${ydbQuery().identifier(getTable("vk_accounts"))}
      WHERE user_id = ${userId}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const row = rows?.[0];
    return row ? { vkId: row.vk_id, userId: row.user_id, name: row.name, email: row.email || undefined, createdAt: row.created_at } : null;
  }
  return (await readIdentities()).find(identity => identity.userId === userId) ?? null;
}

export async function linkVkIdentity(identity: VkIdentity) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("vk_accounts"))}
        (vk_id,user_id,name,email,created_at)
      VALUES (${identity.vkId},${identity.userId},${identity.name},${identity.email ?? ""},${identity.createdAt})
    `;
    return;
  }
  const identities = await readIdentities();
  const next = identities.filter(item => item.vkId !== identity.vkId);
  next.push(identity);
  await writeIdentities(next);
}

/**
 * Resolves the local account for a VK profile. A known VK id wins; otherwise a
 * synthetic address derived from the id is used. The profile e-mail is stored with
 * the identity but deliberately does not merge accounts: e-mail/password
 * registration never verifies the address, so linking by e-mail would let whoever
 * pre-registered a victim's address take over the account when the victim signs in
 * with VK.
 */
export async function ensureVkAccount(profile: { id: string; name?: string; email?: string }): Promise<User> {
  const vkId = profile.id.trim();
  if (!vkId) throw new Error("VK ID не вернул идентификатор аккаунта");

  const linkedId = await findUserIdByVkId(vkId);
  if (linkedId) {
    const linked = await getUser(linkedId);
    if (linked) {
      await rememberIdentity(vkId, linked.id, profile);
      return linked;
    }
  }

  const synthetic = "vk-" + vkId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) + "@vk-id.webnestdev.local";
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

  await rememberIdentity(vkId, user.id, profile);
  return user;
}

async function rememberIdentity(vkId: string, userId: string, profile: { name?: string; email?: string }) {
  const existing = await findVkIdentityByUserId(userId);
  await linkVkIdentity({
    vkId,
    userId,
    name: profile.name?.trim() || existing?.name || "VK ID",
    email: profile.email?.trim().toLowerCase() || existing?.email,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });
}
