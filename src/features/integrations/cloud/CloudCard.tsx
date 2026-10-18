import { KeyCard, type KeyConnectionState } from "../KeyCard";
import type { CloudProviderInfo } from "./catalog";

/** Состояние облака: как у остальных ключей плюс разрешение на изменения. */
export type CloudConnectionState = KeyConnectionState & { allowWrites: boolean };

/**
 * Облачная карточка — та же форма ключа, что и у регистраторов, с облачным API.
 *
 * Отличие одно, и оно важное: у облака ключ открывает не только чтение. Поэтому карточка
 * сообщает об этом до сохранения ключа и даёт переключатель изменений — с ним пользователь
 * решает про доступ, а не узнаёт о нём, когда агент уже что-то создал.
 */
export function CloudCard({ provider, state, onChanged, onToggleWrites, writesBusy }: {
  provider: CloudProviderInfo;
  state: CloudConnectionState | undefined;
  /** Карточка сообщает только «подключено / кто»; разрешение на изменения живёт рядом. */
  onChanged: (next: KeyConnectionState) => void;
  onToggleWrites: (allowed: boolean) => void;
  writesBusy?: boolean;
}) {
  return <KeyCard
    provider={provider}
    state={state}
    onChanged={onChanged}
    endpoint="/api/cloud"
    accessNotice={<>
      <strong>Что даёт подключение</strong>
      <p>Ключ облака открывает все операции сервиса: чтение, создание, изменение и удаление ресурсов. Агент выполняет изменения только по вашей явной просьбе и называет ресурс перед действием — запретить их совсем можно переключателем ниже или позже в этой карточке.</p>
    </>}
    writes={{ allowed: Boolean(state?.allowWrites), busy: writesBusy, onToggle: onToggleWrites }}
  />;
}
