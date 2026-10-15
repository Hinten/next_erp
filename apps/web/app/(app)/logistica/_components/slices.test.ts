import { describe, expect, it } from 'vitest';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';
import { SHARED_EXCLUDED } from './slices';

/**
 * Every channel's conta back-reference on `int_frete` is server-owned — written
 * only by its channel's `onIntegracao…Changed` trigger and that channel's
 * backfill/window pass, all through `@delfrance/data/admin/frete` (#782, #1528,
 * #1826) — and is protected by CONVENTION only: `SHARED_EXCLUDED` is an
 * exclude-list over the shared `intFreteSchema`, so a back-ref missing from it
 * renders as an editable text input on every `/logistica` slice. The list is
 * derived from `VINCULO_INT_FRETE_CONTA`, so a fourth channel's row is demanded
 * here by itself.
 */
describe('SHARED_EXCLUDED', () => {
  it('hides every channel conta back-reference on every /logistica slice', () => {
    const refs = Object.values(VINCULO_INT_FRETE_CONTA)
      .map((v) => v.campoBackRef)
      .sort();
    // Non-vacuity: an emptied constant fails here, not silently.
    expect(refs).toEqual([
      'contaLojaIntegradaEnviosOuterRef',
      'contaMercadoLivreMercadoEnviosOuterRef',
      'contaShopeeFreteOuterRef',
    ]);
    for (const k of refs) expect(SHARED_EXCLUDED).toContain(k);
  });
});
