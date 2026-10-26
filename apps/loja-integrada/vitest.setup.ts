/**
 * Setup for the Loja Integrada UNIT suites (`vitest.config.ts`): the network
 * kill-switch.
 *
 * No code of this app calls Loja Integrada before the cutover (D17), and every
 * suite that exercises a client hands it a stub `fetch`. This makes that true BY
 * CONSTRUCTION for the code a test runs: a test that turns the read switch on
 * and forgets its stub — or a stub that falls through to the real `fetch` —
 * throws here instead of reaching `api.awsli.com.br` (or any other host).
 *
 * The emulator lane has its own, stricter setup (`vitest.tasks.setup.ts`, (5)).
 * This one is scoped the same way: a LOCAL host passes, so the Admin SDK's
 * emulator traffic and a test's own local server are untouched, and a test may
 * still replace `fetch` itself (`vi.stubGlobal`) for a canned answer — which is
 * what every suite here does.
 *
 * `vitest.setup.test.ts` proves it is loaded and refuses (anti-vacuity).
 */

/** The hosts a unit test may reach: this machine only. */
const HOSTS_LOCAIS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const fetchReal = globalThis.fetch;

/** The URL a `fetch` call names, whatever form it was given in. */
function urlDe(input: Parameters<typeof fetchReal>[0]): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

globalThis.fetch = (async (input: Parameters<typeof fetchReal>[0], init?: RequestInit) => {
  const { hostname } = urlDe(input);
  if (!HOSTS_LOCAIS.has(hostname)) {
    throw new Error(
      `rede bloqueada nos testes de unidade: chamada para ${hostname} recusada. ` +
        'Nenhum código desta app chama a Loja Integrada antes do cutover (D17). ' +
        'Passe um fetch de teste (deps.fetch) ou faça o stub do fetch dentro do teste.',
    );
  }
  return fetchReal(input, init);
}) as typeof globalThis.fetch;
