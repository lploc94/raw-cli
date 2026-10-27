export interface AuthLimiterOptions { now?: () => number; limit?: number; windowMs?: number; maxKeys?: number }
export interface AuthLimiter {
  /** Records one wrong-or-missing-token response for `key`; `limited` is true from the (limit + 1)th inside the window. */
  fail(key: string): { limited: boolean; retryAfterSeconds: number };
  trackedKeys(): number;
}
interface Window { start: number; count: number }
/**
 * Resource protection for repeated wrong tokens, not a lockout: callers check the token first and never count a valid
 * one. A key's window starts at its first counted failure. At capacity, expired windows are dropped first; if every
 * tracked key is still active, new keys share one overflow window rather than evicting a key that is being throttled.
 */
export function createAuthLimiter(options: AuthLimiterOptions = {}): AuthLimiter {
  const now = options.now ?? Date.now; const limit = options.limit ?? 10; const windowMs = options.windowMs ?? 60_000; const maxKeys = options.maxKeys ?? 1000;
  const windows = new Map<string, Window>(); let overflow: Window | undefined;
  const live = (window: Window, at: number) => at - window.start < windowMs;
  function count(window: Window, at: number): { limited: boolean; retryAfterSeconds: number } {
    window.count++;
    return { limited: window.count > limit, retryAfterSeconds: Math.max(1, Math.ceil((window.start + windowMs - at) / 1000)) };
  }
  return {
    fail(key) {
      const at = now(); const known = windows.get(key);
      if (known) { if (!live(known, at)) { known.start = at; known.count = 0; } return count(known, at); }
      if (windows.size >= maxKeys) for (const [tracked, window] of windows) if (!live(window, at)) windows.delete(tracked);
      if (windows.size < maxKeys) { const window = { start: at, count: 0 }; windows.set(key, window); return count(window, at); }
      if (!overflow || !live(overflow, at)) overflow = { start: at, count: 0 };
      return count(overflow, at);
    },
    trackedKeys: () => windows.size,
  };
}
