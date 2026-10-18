import { KeyCard, type KeyConnectionState } from "../KeyCard";
import type { CloudProviderInfo } from "./catalog";

export type CloudConnectionState = KeyConnectionState;

/** Облачная карточка — та же форма ключа, что и у регистраторов, с облачным API. */
export function CloudCard({ provider, state, onChanged }: {
  provider: CloudProviderInfo;
  state: CloudConnectionState | undefined;
  onChanged: (next: CloudConnectionState) => void;
}) {
  return <KeyCard provider={provider} state={state} onChanged={onChanged} endpoint="/api/cloud"/>;
}
