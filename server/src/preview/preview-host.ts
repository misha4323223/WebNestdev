/**
 * Публичный адрес предпросмотра: `<проект>.preview.nestdev.ru`.
 *
 * Панель показывает приложение через свой прокси по пути (`/api/projects/<id>/preview/open/…`),
 * и этому пути приходится переписывать корневые ссылки приложения (`/assets/…`, `/@vite/client`),
 * потому что приложение живёт не в корне. Публичный адрес убирает саму причину: приложение
 * отдаётся в корне своего имени, поэтому его абсолютные ссылки, service worker и адрес горячей
 * перезагрузки работают как при обычном запуске. Плюс такой адрес можно открыть в отдельной
 * вкладке и отдать другому человеку — но только вместе с тикетом (см. preview-ticket.ts).
 *
 * Домен задаётся переменной `PREVIEW_PUBLIC_DOMAIN` (например `preview.nestdev.ru`). В production
 * без неё он выводится из адреса панели (`preview.<WEBNESTDEV_SITE_DOMAIN>`), потому что Caddy уже
 * обслуживает этот поддомен; вне production публичных адресов нет, сервер отвечает только путём.
 *
 * Метка имени — идентификатор проекта. Он не зависит от названия проекта (переименование не
 * ломает ссылку), уникален и уже состоит из символов, допустимых в DNS-метке.
 */

/** Одна DNS-метка: буквы, цифры и дефисы; идентификаторы проектов (UUID) подходят как есть. */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Домен из `.env` в виде имени хоста: без схемы, порта, пути и лишних точек. */
function previewDomainValue(raw: string): string {
  const domain = raw.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  // Метки проверяются все: `*.preview.nestdev.ru` оператор напишет по привычке, но звёздочка в
  // значении — это не домен, и лучше выключить адреса, чем подставлять её в сравнение хостов.
  const labels = domain.split(".");
  return domain.length > 1 && labels.every(label => LABEL_PATTERN.test(label)) ? domain : "";
}

/**
 * Домен публичных адресов. Принимается в том виде, в каком его обычно пишут в .env: со схемой,
 * портом или слэшем на конце — всё это лишнее для сопоставления имени хоста. Пустая строка —
 * «выключено».
 *
 * Если переменная не задана, а сервер работает в production, домен выводится из адреса панели:
 * `preview.<WEBNESTDEV_SITE_DOMAIN>`. Это тот же домен, который Caddy уже обслуживает по
 * `*.preview.<домен>`; без него сервер закрывал бы предпросмотр в панели, хотя дверь публичных
 * адресов на фронте настроена. Явно заданное, но некорректное значение по-прежнему выключает
 * адреса, а не подменяется догадкой.
 */
export function previewPublicDomain(): string {
  const raw = (process.env.PREVIEW_PUBLIC_DOMAIN ?? "").trim();
  if (raw) return previewDomainValue(raw);
  if (process.env.NODE_ENV !== "production") return "";
  const site = previewDomainValue(process.env.WEBNESTDEV_SITE_DOMAIN ?? "").replace(/^www\./, "");
  // localhost и голый IP — не публичный домен: подстановочной DNS-записи и сертификата у них нет.
  if (!site || site === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(site)) return "";
  return "preview." + site;
}

/** Метка проекта в публичном адресе; пусто — идентификатор проекту не подходит. */
export function previewHostLabel(projectId: string): string {
  const label = projectId.trim().toLowerCase();
  return LABEL_PATTERN.test(label) ? label : "";
}

/** Публичный адрес проекта без тикета; пусто — публичные адреса не настроены. */
export function previewPublicUrl(projectId: string): string {
  const domain = previewPublicDomain();
  const label = previewHostLabel(projectId);
  return domain && label ? "https://" + label + "." + domain : "";
}

/** Адрес, по которому этот запрос пришёл, если он принадлежит предпросмотру проекта. */
export type PreviewHostTarget = { projectId: string; host: string };

/**
 * Имя хоста запроса → проект. Уровень ровно один: `p1.preview.nestdev.ru` — проект, а
 * `a.b.preview.nestdev.ru` и сам домен предпросмотра — нет. Иначе подстановочная DNS-запись
 * `*.preview…` превратила бы любой чужой поддомен в проект, а на on-demand TLS это ещё и
 * выдача сертификата (см. /api/preview/tls-ask).
 */
export function previewHostTarget(hostHeader: string | undefined | null): PreviewHostTarget | null {
  const domain = previewPublicDomain();
  if (!domain) return null;
  const host = (hostHeader ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!host.endsWith("." + domain)) return null;
  const label = host.slice(0, host.length - domain.length - 1);
  if (!label || label.includes(".")) return null;
  if (!previewHostLabel(label)) return null;
  return { projectId: label, host };
}

/** Строка в лог при старте: работают ли публичные адреса и по какому домену. */
export function describePreviewHosts(): string {
  const domain = previewPublicDomain();
  if (!domain) return "публичные адреса предпросмотра выключены (PREVIEW_PUBLIC_DOMAIN не задан)";
  return "публичные адреса предпросмотра: <проект>." + domain + " (HTTPS через on-demand TLS реверс-прокси)";
}
