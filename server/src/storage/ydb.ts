/**
 * Storage dispatcher: в режиме "postgres" (новый) — делегирует в pg.ts.
 * Старые импорты (../storage/ydb.js) продолжают работать без изменений.
 */
export {
  isYdbEnabled,
  ydbQuery,
  getTable,
  initializeStorage,
  closeStorage,
  describeStorage,
  assertStorageConfigured,
} from "./pg.js";
