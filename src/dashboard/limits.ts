/**
 * Caps that the dashboard's host routes and the browser rendering them must agree on (docs/dashboard-api.md). This
 * module imports nothing, so the web bundle can read a cap without pulling a host module into the browser.
 */
export const MAX_LISTED_PATHS = 20_000;
export const MAX_TEXT_BYTES = 1024 * 1024;
