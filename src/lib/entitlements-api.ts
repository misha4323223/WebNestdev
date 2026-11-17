import { apiJson } from "./api";
import type { PlanId } from "./billing-api";

/** Возможности действующего тарифа; сервер проверяет их независимо от этой подсказки. */
export type PlanEntitlements = {
  staticHosting: boolean;
  serverlessFunctions: boolean;
  interactiveTerminal: boolean;
  containerPreview: boolean;
};

export type AccountEntitlements = {
  plan: PlanId;
  entitlements: PlanEntitlements;
};

export const getEntitlements = () => apiJson<AccountEntitlements>("/api/account/entitlements");
