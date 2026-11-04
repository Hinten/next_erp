import type { LojaIntegradaClient } from '@/lib/loja-integrada/client';

/**
 * A `LojaIntegradaClient` for TESTS: every method REJECTS unless the test
 * supplies it — the `shopeeClientFalso` shape.
 *
 * A test passes only the methods its code under test should call —
 * `lojaIntegradaClientFalso({ conferirPagamento })` — and every other method
 * answers with an error that NAMES it, so a gate calling the wrong route fails
 * loudly instead of resolving `undefined`. Use it instead of an
 * `as unknown as LojaIntegradaClient` cast, which hides exactly that mistake.
 *
 * ⚠️ The literal below lists EVERY method on purpose: a method added to
 * `LojaIntegradaClient` breaks this ONE file at compile time, never every test
 * that builds a client.
 *
 * Test-only, and it imports no `vitest`, so it is safe to import from anywhere
 * a test runs.
 */
export function lojaIntegradaClientFalso(
  metodos: Partial<LojaIntegradaClient> = {},
): LojaIntegradaClient {
  const base: LojaIntegradaClient = {
    conta: naoEsperado('conta'),
    salvarCredencial: naoEsperado('salvarCredencial'),
    renovarValidade: naoEsperado('renovarValidade'),
    removerCredencial: naoEsperado('removerCredencial'),
    grades: naoEsperado('grades'),
    grade: naoEsperado('grade'),
    rotearEtiqueta: naoEsperado('rotearEtiqueta'),
    conferirPagamento: naoEsperado('conferirPagamento'),
  };
  return { ...base, ...metodos };
}

/** A method the test did not supply: it rejects, naming itself. */
function naoEsperado(nome: keyof LojaIntegradaClient): () => Promise<never> {
  return () =>
    Promise.reject(new Error(`LojaIntegradaClient.${nome} não era esperado neste teste`));
}
