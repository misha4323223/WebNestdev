import { listRegistrarDomains } from "./registrar-api.js";
import type { DomainRegistrarId } from "./providers.js";

/**
 * Доступ к кабинету регистратора сохраняется только после того, как регистратор его
 * принял и отдал список доменов. Иначе карточка показывала бы «подключено» для пароля,
 * который уже не работает.
 */
export async function verifyRegistrarCredential(id: DomainRegistrarId, fields: Record<string, string>) {
  const result = await listRegistrarDomains(id, fields);
  return { account: result.account, domains: result.domains.length };
}
