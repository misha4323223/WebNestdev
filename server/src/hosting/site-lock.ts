/**
 * Короткая очередь операций над одним сайтом внутри процесса. Публикация и смена адреса
 * не должны одновременно читать старый slug: публикация запоминает slug на всё время
 * сборки, а смена адреса переименовывает каталог. В PostgreSQL состояние дополнительно
 * защищено блокировкой строки, но она не сериализует файловую систему между этими двумя
 * действиями. Межрепличная гонка остаётся редкой и закрывается проверкой publishingReleaseId.
 */
const queues = new Map<string, Promise<unknown>>();

export function withSiteLock<T>(siteId: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(siteId) ?? Promise.resolve();
  const next = previous.then(action, action);
  queues.set(siteId, next.then(() => undefined, () => undefined));
  return next;
}
