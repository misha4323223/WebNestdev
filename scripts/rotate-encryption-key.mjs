import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../server/dist/security/secret-crypto.js";

const root = path.resolve(process.env.WEBNESTDEV_DATA_DIR ?? ".webnestdev");
const oldKey = process.env.WEBNESTDEV_ENCRYPTION_KEY;
const newKey = process.env.WEBNESTDEV_ENCRYPTION_KEY_NEXT;
if (!oldKey || !newKey || oldKey === newKey) {
  throw new Error("Set WEBNESTDEV_ENCRYPTION_KEY to the current key and WEBNESTDEV_ENCRYPTION_KEY_NEXT to a different new key.");
}
const files = [];
for (const folder of ["providers", "github"]) {
  const dir = path.join(root, folder);
  try {
    for (const name of await readdir(dir)) if (name.endsWith(".json")) files.push(path.join(dir, name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const changes = [];
try {
  for (const file of files) {
    const value = JSON.parse(await readFile(file, "utf8"));
    const field = path.basename(path.dirname(file)) === "providers" ? "token" : "accessToken";
    if (typeof value[field] !== "string" || !value[field]) continue;
    process.env.WEBNESTDEV_ENCRYPTION_KEY = oldKey;
    const plaintext = decryptSecret(value[field]);
    process.env.WEBNESTDEV_ENCRYPTION_KEY = newKey;
    value[field] = encryptSecret(plaintext);
    changes.push({ file, value });
  }
  for (const change of changes) {
    const temp = change.file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(change.value, null, 2), { mode: 0o600 });
    await rename(temp, change.file);
  }
  console.log("Rotated credentials in " + changes.length + " file(s). Keep the old key in secure backup until the new deployment is verified.");
} catch (error) {
  console.error("Key rotation failed. Stop the application and restore the data-directory backup before retrying.");
  throw error;
}
