/**
 * Send the browser to an absolute URL — the OAuth consent redirect.
 *
 * A three-line module rather than an inline `window.location.assign(url)`
 * because it is the only seam a component test can hold. jsdom implements
 * `Location` as `[LegacyUnforgeable]`: its own properties are non-configurable,
 * so `vi.spyOn(window.location, 'assign')` throws and reassigning
 * `window.location` is a no-op. Mocking THIS module is the way a test observes
 * "the panel navigated to the consent URL" without leaving jsdom.
 *
 * The shape — a browser-only side effect behind one named function in `lib/` —
 * follows `lib/nfe/saveBlob.ts`; the testability motive above is this module's
 * own.
 */
export function navegarPara(url: string): void {
  window.location.assign(url);
}
