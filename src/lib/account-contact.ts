/**
 * Контакты аккаунта в интерфейсе.
 *
 * Вход по телефону и по Яндекс ID создаёт служебный адрес вида
 * `79531814136@phone.webnestdev.local` или `yandex-123@yandex-id.webnestdev.local`: он нужен
 * хранилищу как логин, но человеку показывать его нельзя — он читается как непонятная почта.
 * Телефон показывается отдельно, а почта берётся из контактов, оставленных при знакомстве.
 */
export function isSyntheticEmail(email: string | null | undefined): boolean {
  return Boolean(email && /@[^@]*\.local$/i.test(email.trim()));
}

/** Настоящий адрес входа; пустая строка, если адрес служебный. */
export function realAccountEmail(email: string | null | undefined): string {
  const value = email?.trim() ?? "";
  return isSyntheticEmail(value) ? "" : value;
}

/**
 * Куда писать человеку: почта из знакомства, иначе настоящий адрес входа, иначе почта Яндекс ID.
 * Служебные адреса не возвращаются никогда.
 */
export function contactEmailOf(input: {
  profileEmail?: string | null;
  accountEmail?: string | null;
  yandexEmail?: string | null;
}): string {
  return input.profileEmail?.trim()
    || realAccountEmail(input.accountEmail)
    || input.yandexEmail?.trim()
    || "";
}
