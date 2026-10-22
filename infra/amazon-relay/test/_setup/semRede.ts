/**
 * Runs before every test file (`vitest.config.ts` → `setupFiles`).
 *
 * D11: nothing in this suite may reach AWS, Amazon or any other host. The CDK
 * synthesises in-process and needs no network; this replaces the GLOBAL
 * `fetch` with a function that throws, so a dependency that ever tried would
 * fail the test loudly instead of making a real request.
 *
 * Assigned with `defineProperty`, never `vi.stubGlobal`, so a test that unstubs
 * its own globals restores THIS function, not Node's fetch (the amazon-sp-api
 * package's `semRede.ts`, same shape).
 */
export const MENSAGEM_SEM_REDE =
  'D11: um teste do relay chamou o fetch global. A síntese do CDK é local e nunca usa a rede.';

function semRede(): never {
  throw new Error(MENSAGEM_SEM_REDE);
}

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: semRede,
});
