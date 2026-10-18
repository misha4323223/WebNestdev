import { createHash, createHmac } from "node:crypto";

/**
 * Проверка ключей объектного хранилища: подписываем `GET /` (ListBuckets) по AWS Signature V4
 * и читаем ответ. Подпись написана здесь, а не взята из SDK, потому что нужен один запрос:
 * зависимость ради него была бы лишней. Правильность канонического запроса и цепочки HMAC
 * проверяется на опубликованном контрольном векторе AWS (`s3.test.ts`).
 *
 * Сервер отвечает `InvalidAccessKeyId`, если ключа нет, и `SignatureDoesNotMatch`, если подпись
 * собрана неверно, — поэтому «ключ не принят» и «ключ верный, но прав на список нет»
 * различаются и в интерфейсе, и в тесте на живом сервисе.
 */

export type S3Credentials = {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
};

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const TIMEOUT_MS = 15_000;

function sha256Hex(data: string) {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Кодирование по RFC 3986, как того требует подпись AWS (encodeURIComponent его не даёт). */
export function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
}

export function parseS3Endpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Некорректный адрес хранилища: " + endpoint);
  }
  if (url.protocol !== "https:") throw new Error("Адрес хранилища должен начинаться с https://");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Адрес хранилища — это только хост, например https://s3.twcstorage.ru");
  }
  return { host: url.host, origin: url.origin };
}

/** Дата в формате подписи: 20150830T123600Z. */
export function amzDate(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export type SignInput = {
  method: string;
  /** Путь без query, уже закодированный по RFC 3986 (например «/»). */
  path: string;
  query?: Record<string, string>;
  /** Заголовки, которые попадут в подпись; ключи — в нижнем регистре. */
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  region: string;
  service?: string;
  accessKey: string;
  secretKey: string;
};

export type SignedRequest = {
  canonicalRequest: string;
  stringToSign: string;
  signedHeaders: string;
  signature: string;
  authorization: string;
};

/**
 * Подпись AWS Signature V4. Экспортируется отдельно от S3, чтобы контрольный вектор AWS можно
 * было воспроизвести ровно так, как он опубликован (хост и дата без прочих заголовков).
 */
export function signAwsV4(input: SignInput): SignedRequest {
  const service = input.service ?? SERVICE;
  const query = Object.entries(input.query ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => awsEncode(key) + "=" + awsEncode(value))
    .join("&");

  const headerNames = Object.keys(input.headers).map(name => name.toLowerCase()).sort();
  const canonicalHeaders = headerNames
    .map(name => name + ":" + input.headers[name].trim().replace(/\s+/g, " ") + "\n")
    .join("");
  const signedHeaders = headerNames.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const date = input.amzDate.slice(0, 8);
  const scope = date + "/" + input.region + "/" + service + "/aws4_request";
  const stringToSign = [ALGORITHM, input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(hmac(hmac(hmac("AWS4" + input.secretKey, date), input.region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    canonicalRequest,
    stringToSign,
    signedHeaders,
    signature,
    authorization:
      ALGORITHM + " Credential=" + input.accessKey + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
  };
}

/** Разбор ответа ListBuckets: нужны только имена бакетов. */
export function parseBucketList(xml: string): string[] {
  const names: string[] = [];
  const pattern = /<Bucket>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<\/Bucket>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) names.push(match[1].trim());
  return names;
}

/** Код ошибки из XML-ответа S3 (`<Code>…</Code>`). */
export function parseS3ErrorCode(xml: string): string | null {
  const match = /<Code>([^<]+)<\/Code>/.exec(xml);
  return match ? match[1].trim() : null;
}

/**
 * Один подписанный запрос списка бакетов. Ошибки переводим в человеческий текст здесь, потому
 * что сообщение сервиса зависит от провайдера, а смысл один.
 */
export async function listS3Buckets(credentials: S3Credentials, deps: { fetch?: typeof fetch } = {}) {
  const { host, origin } = parseS3Endpoint(credentials.endpoint);
  const now = new Date();
  const date = amzDate(now);
  const payloadHash = sha256Hex("");
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  const signed = signAwsV4({
    method: "GET",
    path: "/",
    headers,
    payloadHash,
    amzDate: date,
    region: credentials.region,
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await (deps.fetch ?? fetch)(origin + "/", {
      method: "GET",
      headers: { ...headers, Authorization: signed.authorization },
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Хранилище не ответило: превышено время ожидания");
    throw new Error("Нет ответа от хранилища: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) return { buckets: parseBucketList(text), host };

  const code = parseS3ErrorCode(text);
  const detail = code ?? "HTTP " + response.status;
  if (code === "AccessDenied" || code === "AllAccessDisabled" || code === "Forbidden") {
    // Cloud.ru отвечает AccessDenied и на неизвестный ключ: различить «неверный ключ» и «нет роли»
    // снаружи нельзя, поэтому в сообщении обе причины, а не одна.
    throw new Error("Хранилище ответило «доступ запрещён» (" + detail + "): либо ключи неверны, либо у ключа нет роли на список бакетов. Проверьте ключи и права для " + host + ".");
  }
  throw new Error("Хранилище отклонило ключ (" + detail + "): проверьте Access key и Secret key для " + host);
}
