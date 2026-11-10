import type { AmazonClient } from '@/lib/amazon/client';

/**
 * An `AmazonClient` for TESTS: every method REJECTS unless the test supplies
 * it — the `shopeeClientFalso` shape.
 *
 * A test passes only the methods its code under test should call —
 * `amazonClientFalso({ etiqueta })` — and every other method answers with an
 * error that NAMES it, so a provider calling the wrong route fails loudly
 * instead of resolving `undefined`. Use it instead of an
 * `as unknown as AmazonClient` cast, which hides exactly that mistake.
 *
 * ⚠️ The literal below lists EVERY method on purpose: a method added to
 * `AmazonClient` breaks this ONE file at compile time, never every test that
 * builds a client.
 *
 * Test-only, and it imports no `vitest`, so it is safe to import from anywhere
 * a test runs.
 */
export function amazonClientFalso(metodos: Partial<AmazonClient> = {}): AmazonClient {
  const base: AmazonClient = {
    conta: naoEsperado('conta'),
    oauthStart: naoEsperado('oauthStart'),
    etiqueta: naoEsperado('etiqueta'),
  };
  return { ...base, ...metodos };
}

/** A method the test did not supply: it rejects, naming itself. */
function naoEsperado(nome: keyof AmazonClient): () => Promise<never> {
  return () => Promise.reject(new Error(`AmazonClient.${nome} não era esperado neste teste`));
}
