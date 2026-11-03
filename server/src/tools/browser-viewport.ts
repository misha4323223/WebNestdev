/** Размеры окна, которые понимают и `browser.screenshot`, и `browser.scenario`. */
export const BROWSER_VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
} as const;

export type BrowserViewport = keyof typeof BROWSER_VIEWPORTS;

export function readBrowserViewport(value: unknown): BrowserViewport {
  return value === "mobile" || value === "tablet" ? value : "desktop";
}
