import { useEffect, useState } from "react";
import type { BillingData, PlanId } from "./billing-api";

const storageKey = "webnestdev.selectedPlan";
/** Selection changes are broadcast, so every surface that names the plan stays in sync. */
const changeEvent = "webnestdev:plan-choice";

/**
 * The plan the user would move to. Payment is not connected yet, so this is a wish rather
 * than an entitlement: it is remembered locally and the active plan still comes from the server.
 * Every surface names it, so the choice is visible instead of pointing at a generic «подписка».
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

/** Тариф, на котором аккаунт работает сейчас: платные пока не продаются, значит бесплатный. */
export function activePlanId(): PlanId {
  return "free";
}

/**
 * The plan every surface advertises: the user's own selection when there is one,
 * otherwise the next plan up — Про from the free plan.
 */
export function chosenPlanId(choice: PlanId | null = readPlanChoice()): PlanId {
  return choice ?? "pro";
}

/** True when the advertised plan is not the one the account already has. */
export function isPendingChoice(choice: PlanId | null = readPlanChoice()) {
  return chosenPlanId(choice) !== activePlanId();
}

/** Label of the call to action that leads to the chosen plan. */
export function upgradeLabel(billing: BillingData | null, choice: PlanId | null = readPlanChoice()) {
  const chosen = chosenPlanId(choice);
  return isPendingChoice(choice)
    ? "Перейти на «" + planName(billing, chosen) + "»"
    : "Тариф «" + planName(billing, chosen) + "» выбран";
}
