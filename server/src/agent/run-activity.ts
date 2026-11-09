import { isRunActive } from "./active-runs.js";
import { isProjectRunLeaseActive } from "./run-lease.js";

/**
 * Занят ли проект агентом на этой или на другой реплике.
 *
 * Локальная карта отвечает мгновенно и без базы; общая аренда закрывает случай, когда запрос
 * архивации, переноса или idle-уборки пришёл на вторую ВМ, а агент работает на первой.
 */
export async function isRunActiveAnywhere(projectId: string): Promise<boolean> {
  if (isRunActive(projectId)) return true;
  return isProjectRunLeaseActive(projectId);
}
