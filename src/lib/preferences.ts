import { apiJson } from "./api";

export type UserPreferences = {
  language: "ru" | "en";
  compactMode: boolean;
  emailNotifications: boolean;
  productUpdates: boolean;
};

const storageKey = "webnestdev.preferences";
export const defaultPreferences: UserPreferences = { language: "ru", compactMode: false, emailNotifications: true, productUpdates: false };

export function readCachedPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { ...defaultPreferences };
    return { ...defaultPreferences, ...(JSON.parse(raw) as Partial<UserPreferences>) };
  } catch {
    return { ...defaultPreferences };
  }
}

/** Preferences that affect the whole interface. Density is applied to the document root. */
export function applyPreferences(preferences: UserPreferences) {
  const root = document.documentElement;
  root.dataset.density = preferences.compactMode ? "compact" : "comfortable";
  root.lang = preferences.language;
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {}
}

/**
 * Applies cached preferences immediately, so the interface does not flicker on reload.
 * No request is made here on purpose: this runs on every boot, including the sign-in
 * screen, and `/api/account/settings` needs a session — asking for it before the user
 * is known is what put 401 Unauthorized in the browser console of a signed-out visitor.
 */
export function loadCachedPreferences() {
  applyPreferences(readCachedPreferences());
}

/**
 * Replaces the cached preferences with the ones the account stores. Called only once the
 * user is known to be signed in, because the endpoint answers 401 without a session.
 */
export async function refreshPreferences() {
  try {
    const data = await apiJson<{ preferences: UserPreferences }>("/api/account/settings");
    applyPreferences(data.preferences);
  } catch {
    // Session expired or API unavailable: the cached values stay in effect.
  }
}
