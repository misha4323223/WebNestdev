import { writeFileSync } from "node:fs";
import crypto from "node:crypto";

const key = crypto.randomBytes(32).toString("hex");
const env = [
  "NODE_ENV=production",
  "WEBNESTDEV_STORAGE=ydb",
  `WEBNESTDEV_ENCRYPTION_KEY=${key}`,
  "WEBNESTDEV_ALLOWED_ORIGINS=http://178.236.27.102:8787,http://localhost:8787",
  "YDB_CONNECTION_STRING=grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1gpj9488h3k7oaa3foh/etnk2b9gihblr0mitfim",
  "YDB_TOKEN=",
].join("\n");

writeFileSync(new URL("./tmp.env.b64", import.meta.url), Buffer.from(env).toString("base64"));
console.log("ok, env bytes:", env.length, "key prefix:", key.slice(0, 8));
