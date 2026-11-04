import { describe, expect, it, vi } from 'vitest';

/**
 * T5l (reconcile §4, PR 8): the uncertain kit create's wait is the schemas'
 * `AGUARDAR_KIT_INCERTO_SHOPEE_MS` — read, never copied. The constant is
 * swapped for a value no copy could hold, so a web-local `240_000` (the same
 * number today, a wrong one the day the route ceiling moves) fails here, and so
 * do both sentences that interpolate it.
 */
vi.mock('@delfrance/schemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/schemas')>()),
  AGUARDAR_KIT_INCERTO_SHOPEE_MS: 420_000,
}));

const { TEXTO_MOTIVO_KIT, esperaDoKitIncerto } = await import('./anuncioProduto');

describe('the uncertain kit create waits the schemas’ constant, whatever it is', () => {
  it('waits it when the body carried no aguardarMs', () => {
    expect(esperaDoKitIncerto(undefined)).toBe(420_000);
  });

  it('words its minutes from it', () => {
    expect(TEXTO_MOTIVO_KIT['instabilidade-shopee']).toContain('Aguarde 7 minutos');
  });
});
