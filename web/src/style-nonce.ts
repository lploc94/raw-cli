export function styleNonce(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="raw-style-nonce"]')
      ?.content ?? ""
  );
}
export function initializeStyleNonce(): void {
  // The bundled Radix stylesheet helper reads this documented host nonce hook.
  (
    globalThis as typeof globalThis & { __webpack_nonce__?: string }
  ).__webpack_nonce__ = styleNonce();
}
