/**
 * Runs before every test file (`vitest.config.ts` → `setupFiles`).
 *
 * D11: nothing in this package's suite may reach Amazon, or any other host.
 * Every test injects its own `fetch`; this replaces the GLOBAL one with a
 * function that throws, so a test that forgets the injection fails loudly
 * instead of making a real request.
 *
 * ⚠️ Assigned with `defineProperty`, never `vi.stubGlobal`: a test that stubs
 * the global itself (`client.test.ts`, "the default fetch") restores it with
 * `vi.unstubAllGlobals()`, which must restore THIS function, not Node's fetch.
 *
 * The thrown class is a plain `Error`, deliberately not a `TypeError`: the
 * transport wraps a `TypeError` as a network failure, while anything else is
 * rethrown as-is, so the message below reaches the test output unchanged.
 */
export const MENSAGEM_SEM_REDE =
  'D11: um teste chamou o fetch global. Injete um fetch falso; este pacote nunca chama a Amazon nos testes.';

function semRede(): never {
  throw new Error(MENSAGEM_SEM_REDE);
}

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: semRede,
});
