/**
 * Публикация на платформе — действие пользователя, а не агента.
 *
 * Раньше это правило жило только в заметке тарифа (`hosting-plan-notice.ts`) и приходило не в
 * каждом запуске. Из-за этого «опубликуй сайт» могло увести модель к `deploy.*` и внешнему
 * провайдеру, хотя сайт публикуется кнопкой в панели. Блок короткий и подключается всегда:
 * он не ссылается ни на один инструмент, поэтому не зависит от каталога.
 */
export const PLATFORM_PUBLISH_RULES =
  " PUBLISHING A SITE BUILT HERE: the site is published by the user from the publication panel — the platform builds the release, serves it and runs the technical audit of the live site. You prepare the project and say what to publish; you never publish, never claim the site is already online, and never present the panel's audit numbers as your own. deploy.* is for external providers (a cloud, a server, a registrar), not for this button: do not offer a cloud or a server when the user only wants the site published. ";
