import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";

/**
 * Тикет доступа к публичному адресу предпросмотра.
 *
 * Публичный адрес открывается в отдельной вкладке, а значит запрос приходит без cookie сессии
 * панели: cookie сессии выставляется для домена панели и на поддомен предпросмотра не отправляется.
 * Расширять его до `.nestdev.ru` нельзя — тогда cookie платформы уходил бы и в приложение
 * пользователя (прокси передаёт приложению заголовки запроса), и на любой другой поддомен.
 * Поэтому доступ даёт отдельный, узкий билет: он выпускается панелью для конкретного проекта,
 * живёт ограниченное время и открывает ровно один адрес.
 *
 * Билет шифруется тем же ключом, что и хранимые секреты (`WEBNESTDEV_ENCRYPTION_KEY`): подделать
 * его нельзя, а истёкший или чужой проект отвергается по расшифрованному содержимому.
 */

/** Cookie, которую получает браузер после первого запроса с тикетом: так работают ссылки внутри приложения. */
export const PREVIEW_TICKET_COOKIE = "webnestdev_preview";
/** Параметр запроса, в котором тикет приходит из панели. */
export const PREVIEW_TICKET_PARAM = "ticket";
/** Полсуток по умолчанию: столько может быть открыта вкладка с предпросмотром. */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export function previewTicketTtlMs(): number {
  const raw = Number(process.env.PREVIEW_TICKET_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TTL_MS;
}

/** Шифрованное содержимое тикета: чей это предпросмотр и до какого времени он открыт. */
type TicketPayload = { projectId: string; expiresAt: number };

export function mintPreviewTicket(projectId: string, now = Date.now()): string {
  return encryptSecret(JSON.stringify({ projectId, expiresAt: now + previewTicketTtlMs() } satisfies TicketPayload));
}

/**
 * Проект, которому принадлежит тикет, или пустая строка.
 *
 * Значение без префикса шифрования отвергается сразу: незашифрованную строку подписал бы кто
 * угодно, а `decryptSecret` возвращает legacy-значения как есть (они нужны при чтении старых
 * записей, но не как доказательство права на доступ).
 */
export function previewTicketProject(ticket: string | undefined | null, now = Date.now()): string {
  const value = (ticket ?? "").trim();
  if (!value || value.length > 4096 || !isEncryptedSecret(value)) return "";
  let parsed: Partial<TicketPayload>;
  try {
    parsed = JSON.parse(decryptSecret(value)) as Partial<TicketPayload>;
  } catch {
    return "";
  }
  if (typeof parsed.projectId !== "string" || typeof parsed.expiresAt !== "number") return "";
  if (!previewTicketProjectId(parsed.projectId)) return "";
  return parsed.expiresAt > now ? parsed.projectId : "";
}

/** Идентификатор проекта из тикета — та же форма, что и метка хоста: иначе тикет не открывает адрес. */
function previewTicketProjectId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

/** Ссылка с тикетом: единственная форма, по которой предпросмотр открывается впервые. */
export function previewTicketUrl(baseUrl: string, ticket: string): string {
  return baseUrl + "/?" + PREVIEW_TICKET_PARAM + "=" + encodeURIComponent(ticket);
}
