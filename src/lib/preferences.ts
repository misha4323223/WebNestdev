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
 * Applies cached preferences immediately (so the interface does not flicker on reload)
 * and then refreshes them from the account when the user is signed in.
 */
export async function loadPreferences() {
  applyPreferences(readCachedPreferences());
  try {
    const data = await apiJson<{ preferences: UserPreferences }>("/api/account/settings");
    applyPreferences(data.preferences);
  } catch {
    // Guest or API unavailable: the cached values stay in effect.
  }
}
