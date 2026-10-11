import { useEffect, useState } from "react";
import type { BillingData, PlanId } from "./billing-api";

const storageKey = "webnestdev.selectedPlan";
/** Selection changes are broadcast, so every surface that names the plan stays in sync. */
const changeEvent = "webnestdev:plan-choice";

/**
 * The plan the user picked on the pricing screen. It is the plan that will be paid for
 * once billing is live, so every surface names it as a concrete plan instead of pointing
 * at a generic "subscription" link. It is remembered locally because it is a choice, not
 * an entitlement: the active plan still comes from the server.
 */
export function readPlanChoice(): PlanId | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "free" || value === "pro" || value === "team" ? value : null;
  } catch {
    return null;
  }
}

export function writePlanChoice(plan: PlanId | null) {
  try {
    if (plan) localStorage.setItem(storageKey, plan);
    else localStorage.removeItem(storageKey);
  } catch {}
  try { window.dispatchEvent(new Event(changeEvent)); } catch {}
}

function onPlanChoiceChange(listener: () => void) {
  const handler = () => listener();
  window.addEventListener(changeEvent, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(changeEvent, handler);
    window.removeEventListener("storage", handler);
  };
}

/** The selected plan as live state, for the surfaces that display it. */
export function usePlanChoice() {
  const [choice, setChoice] = useState<PlanId | null>(readPlanChoice);
  useEffect(() => onPlanChoiceChange(() => setChoice(readPlanChoice())), []);
  return choice;
}

const fallbackNames: Record<PlanId, string> = { free: "Бесплатный", pro: "Про", team: "Команда" };

export function planName(billing: BillingData | null, plan: PlanId) {
  return billing?.plans.find(item => item.id === plan)?.name ?? fallbackNames[plan];
}

/** The plan the account is actually on right now (a demo plan only counts while active). */
export function activePlanId(billing: BillingData | null): PlanId {
  return billing?.subscription.status === "demo_active" ? billing.subscription.plan : "free";
}

/**
 * The plan every surface advertises: the user's own selection when there is one,
 * otherwise the next plan up — Про from the free plan, then Команда.
 */
export function chosenPlanId(billing: BillingData | null, choice: PlanId | null = readPlanChoice()): PlanId {
  if (choice) return choice;
  const active = activePlanId(billing);
  return active === "free" ? "pro" : "team";
}

/** True when the advertised plan is not the one the account already has. */
export function isPendingChoice(billing: BillingData | null, choice: PlanId | null = readPlanChoice()) {
  return chosenPlanId(billing, choice) !== activePlanId(billing);
}

/** Label of the call to action that leads to the chosen plan. */
export function upgradeLabel(billing: BillingData | null, choice: PlanId | null = readPlanChoice()) {
  const chosen = chosenPlanId(billing, choice);
  return isPendingChoice(billing, choice)
    ? "Перейти на " + planName(billing, chosen)
    : "Тариф «" + planName(billing, chosen) + "» активен";
}
