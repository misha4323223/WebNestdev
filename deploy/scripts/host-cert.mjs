#!/usr/bin/env node
/**
 * Скачивает managed-сертификат `*.host.nestdev.ru` из MWS Certificate Manager и раскладывает
 * `fullchain.pem`/`key.pem` для origin-Caddy. Запускается на раннере выкатки: там уже есть
 * MWS_SA_* из Secrets, поэтому приватный ключ не нужно хранить на ВМ.
 *
 * Только Node-встроенные модули: на ubuntu-latest не требуется устанавливать пакеты.
 */
import { createPrivateKey, createPublicKey, sign, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const IAM_HOST = "iam.mwsapis.ru";
const CERT_HOST = "certmanager.mwsapis.ru";
const KEY_ID_RE = /^projects\/([^/]+)\/serviceAccounts\/([^/]+)\/authorizedKeys\/([^/]+)$/;
const CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function fail(message) {
  console.error(`[host-cert] ошибка: ${message}`);
  process.exit(1);
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function parseArgs(argv) {
  const args = { out: "/tmp/host-cert", project: "project-pimashin2015", certificate: "host-wildcard" };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const value = argv[++i];
    if (name === "--out") args.out = value;
    else if (name === "--project") args.project = value;
    else if (name === "--certificate") args.certificate = value;
    else fail(`неизвестный аргумент ${name}`);
  }
  return args;
}

/**
 * В окружении могут одновременно лежать MWS_SA_KEY и однострочные MWS_SA_KEY_ID/
 * MWS_SA_PRIVATE_KEY от разных выпусков ключа. Пробуем обе формы: рабочая выкатка может
 * обновить только одну, а вторая остаться от прежнего ключа (IAM отвечает 403).
 */
function loadCandidates() {
  const candidates = [];
  const seen = new Set();
  const add = (keyIdValue, privateValue) => {
    const keyId = String(keyIdValue || "").trim();
    const secret = String(privateValue || "").trim();
    if (!keyId || !secret) return;
    const dedupe = `${keyId}\n${secret}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const match = KEY_ID_RE.exec(keyId);
    if (!match) return;
    let key;
    try {
      key = secret.includes("BEGIN")
        ? createPrivateKey(secret)
        : createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" });
    } catch {
      return;
    }
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return;
    // В JWT поле kid — имя авторизованного ключа (последний сегмент keyId), а не весь
    // resource name: именно так его подписывает серверный mws-auth.ts.
    candidates.push({ key, keyName: match[3], serviceAccount: `projects/${match[1]}/serviceAccounts/${match[2]}` });
  };

  if (process.env.MWS_SA_KEY) {
    try {
      const document = JSON.parse(process.env.MWS_SA_KEY);
      add(document.keyId, document.privateKey);
    } catch {
      // Нечитаемый JSON не должен скрывать однострочную форму.
    }
  }
  if (process.env.MWS_SA_KEY_FILE) {
    try {
      const document = JSON.parse(readFileSync(process.env.MWS_SA_KEY_FILE, "utf8"));
      add(document.keyId, document.privateKey);
    } catch (error) {
      console.error(`[host-cert] MWS_SA_KEY_FILE не читается: ${error.message}`);
    }
  }
  add(process.env.MWS_SA_KEY_ID, process.env.MWS_SA_PRIVATE_KEY);
  if (candidates.length === 0) fail("нет рабочей формы ключа MWS (MWS_SA_KEY или MWS_SA_KEY_ID/MWS_SA_PRIVATE_KEY)");
  return candidates;
}

function jwt(key, keyName, serviceAccount) {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyName, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: serviceAccount, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const input = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(signature)}`;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${url.split("?")[0]}: HTTP ${response.status}: ${text.slice(0, 400)}`);
    error.status = response.status;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url.split("?")[0]} вернул не JSON`);
  }
}

function certsFrom(text) {
  return (text.match(CERT_RE) || []).map(value => `${value.trim()}\n`);
}

function fingerprint(pem) {
  return new X509Certificate(pem).fingerprint256;
}

function samePublicKey(privateKey, leafPem) {
  const cert = new X509Certificate(leafPem);
  const pub = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return cert.publicKey.export({ type: "spki", format: "der" }).equals(pub);
}

function buildFullchain(certificate, chained) {
  const leafs = certsFrom(certificate);
  if (leafs.length !== 1) fail("в ответе Certificate Manager не один листовой сертификат");
  const leaf = leafs[0];
  const leafFingerprint = fingerprint(leaf);
  const rest = [];
  const seen = new Set([leafFingerprint]);
  for (const pem of certsFrom(chained)) {
    const value = fingerprint(pem);
    if (seen.has(value)) continue;
    seen.add(value);
    rest.push(pem);
  }
  while (rest.length > 0) {
    const cert = new X509Certificate(rest[rest.length - 1]);
    if (cert.subject !== cert.issuer) break;
    rest.pop();
  }
  return { fullchain: `${[leaf, ...rest].join("\n")}\n`, leaf, leafFingerprint };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = loadCandidates();
  let token = "";
  let lastError = null;
  for (const candidate of candidates) {
    const signed = jwt(candidate.key, candidate.keyName, candidate.serviceAccount);
    const tokenUrl = `https://${IAM_HOST}/iam/v2/tokens/:issueServiceAccountToken?` +
      new URLSearchParams({ serviceAccount: candidate.serviceAccount }).toString();
    try {
      const tokenBody = await fetchJson(tokenUrl, { Authorization: signed, Accept: "application/json" });
      token = tokenBody.accessToken || tokenBody.iamToken || "";
      if (token) break;
      lastError = new Error("MWS IAM не выдал токен");
    } catch (error) {
      lastError = error;
      if (error.status !== 401 && error.status !== 403) break;
    }
  }
  if (!token) fail(lastError?.message || "MWS IAM не выдал токен");

  const url = `https://${CERT_HOST}/certmanager/v1/projects/${encodeURIComponent(args.project)}` +
    `/certificates/${encodeURIComponent(args.certificate)}:download`;
  const body = await fetchJson(url, { Authorization: `Bearer ${token}`, Accept: "application/json" });
  if (typeof body.certificate !== "string" || typeof body.privateKey !== "string" ||
      typeof body.chainedCert !== "string") {
    fail("в ответе Certificate Manager нет certificate/privateKey/chainedCert");
  }
  const { fullchain, leaf, leafFingerprint } = buildFullchain(body.certificate, body.chainedCert);
  if (!samePublicKey(createPrivateKey(body.privateKey), leaf)) {
    fail("privateKey не соответствует листовому сертификату");
  }

  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  writeFileSync(join(args.out, "fullchain.pem"), fullchain, { mode: 0o644 });
  writeFileSync(join(args.out, "key.pem"), `${body.privateKey.trim()}\n`, { mode: 0o600 });
  chmodSync(join(args.out, "fullchain.pem"), 0o644);
  chmodSync(join(args.out, "key.pem"), 0o600);
  const cert = new X509Certificate(leaf);
  console.log(`[host-cert] ${cert.subject} до ${cert.validTo}, sha256 ${leafFingerprint}`);
}

main().catch(error => fail(error.message));
