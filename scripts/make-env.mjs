import { writeFileSync } from "node:fs";
import crypto from "node:crypto";

const key = crypto.randomBytes(32).toString("hex");
const env = [
  "NODE_ENV=production",
  // ydB больше не бэкенд: неизвестное значение теперь останавливает сервер.
  "WEBNESTDEV_STORAGE=json",
  "WEBNESTDEV_DATA_DIR=/root/webnestdev/data",
  `WEBNESTDEV_ENCRYPTION_KEY=${key}`,
  "WEBNESTDEV_ALLOWED_ORIGINS=http://178.236.27.102:8787,http://localhost:8787",
].join("\n");

writeFileSync(new URL("./tmp.env.b64", import.meta.url), Buffer.from(env).toString("base64"));
console.log("ok, env bytes:", env.length, "key prefix:", key.slice(0, 8));
