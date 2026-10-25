import { KeyCard, type KeyConnectionState } from "../KeyCard";
import type { CloudProviderInfo } from "./catalog";

/** Состояние облака: как у остальных ключей плюс разрешение на изменения. */
export type CloudConnectionState = KeyConnectionState & { allowWrites: boolean };

/**
 * Облачная карточка — та же форма ключа, что и у регистраторов, с облачным API.
 *
 * Отличие одно, и оно важное: у облака ключ открывает не только чтение. Поэтому у карточки есть
 * переключатель изменений — с ним пользователь решает про доступ до сохранения ключа, а не
 * узнаёт о нём, когда агент уже что-то создал. Абзаца «что даёт подключение» здесь нет: его
 * место занял сам переключатель, а объяснение осталось в подписи к нему.
 */
export function CloudCard({ provider, state, onChanged, onToggleWrites, writesBusy, onRefresh, refreshing }: {
  provider: CloudProviderInfo;
  state: CloudConnectionState | undefined;
  /** Карточка сообщает только «подключено / кто»; разрешение на изменения живёт рядом. */
  onChanged: (next: KeyConnectionState) => void;
  onToggleWrites: (allowed: boolean) => void;
  writesBusy?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return <KeyCard
    provider={provider}
    state={state}
    onChanged={onChanged}
    endpoint="/api/cloud"
    writes={{ allowed: Boolean(state?.allowWrites), busy: writesBusy, onToggle: onToggleWrites }}
    {...(onRefresh ? { onRefresh } : {})}
    {...(refreshing ? { refreshing } : {})}
  />;
}
