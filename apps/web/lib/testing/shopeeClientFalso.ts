import type { ShopeeClient } from '@/lib/shopee/client';

/**
 * A `ShopeeClient` for TESTS: every method REJECTS unless the test supplies it.
 *
 * The ONE `ShopeeClient` literal in test code. A test passes only the methods
 * its code under test should call — `shopeeClientFalso({ etiqueta })` — and
 * every other method answers with an error that NAMES it, so a provider calling
 * the wrong one fails loudly instead of resolving `undefined`. Use it instead of
 * an `as unknown as ShopeeClient` cast, which hides exactly that mistake.
 *
 * ⚠️ The literal below lists EVERY method on purpose: a method added to
 * `ShopeeClient` breaks this ONE file at compile time, never every test that
 * builds a client.
 *
 * Test-only (the `lib/testing/mantine.tsx` precedent), and it imports no
 * `vitest`, so it is safe to import from anywhere a test runs.
 */
export function shopeeClientFalso(metodos: Partial<ShopeeClient> = {}): ShopeeClient {
  const base: ShopeeClient = {
    oauthStart: naoEsperado('oauthStart'),
    conta: naoEsperado('conta'),
    etiqueta: naoEsperado('etiqueta'),
    reclamacaoEstado: naoEsperado('reclamacaoEstado'),
    reclamacaoAcao: naoEsperado('reclamacaoAcao'),
    categorias: naoEsperado('categorias'),
    limites: naoEsperado('limites'),
    tabelaMedidasLista: naoEsperado('tabelaMedidasLista'),
    tabelaMedidasDetalhe: naoEsperado('tabelaMedidasDetalhe'),
    enviarEstoque: naoEsperado('enviarEstoque'),
    enviarPrecos: naoEsperado('enviarPrecos'),
    definirStatusAnuncios: naoEsperado('definirStatusAnuncios'),
    publicar: naoEsperado('publicar'),
    reverificarAnuncio: naoEsperado('reverificarAnuncio'),
    startMassImport: naoEsperado('startMassImport'),
    massImportStatus: naoEsperado('massImportStatus'),
    cancelMassImport: naoEsperado('cancelMassImport'),
    startPriceSync: naoEsperado('startPriceSync'),
    priceSyncStatus: naoEsperado('priceSyncStatus'),
    cancelPriceSync: naoEsperado('cancelPriceSync'),
    priceSyncHistorico: naoEsperado('priceSyncHistorico'),
    priceSyncRelatorio: naoEsperado('priceSyncRelatorio'),
  };
  return { ...base, ...metodos };
}

/** A method the test did not supply: it rejects, naming itself. */
function naoEsperado(nome: keyof ShopeeClient): () => Promise<never> {
  return () => Promise.reject(new Error(`ShopeeClient.${nome} não era esperado neste teste`));
}
