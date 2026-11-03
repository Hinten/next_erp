import { describe, expect, it } from 'vitest';

import {
  DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE,
  PORTA_DA_IMPORTACAO_SHOPEE,
} from './anuncioProduto';

/**
 * #1911 batch-B review R7-roundtrip#5 (the web half, P12 integrator): case (c)
 * of the `rascunhoCriacaoIncerta` discard dialog may not PROMISE the adoption.
 * The import adopts only a draft whose attempt window it can read, and an
 * unreadable lock or record reads `incerta` with no window — the same dialog
 * shows for both, so the sentence must be true for both.
 */
describe('DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE — case (c) never promises the adoption', () => {
  const D = DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE;

  it('says the import NORMALLY adopts the draft, and names the exit when it links the listing apart', () => {
    expect(D.existeSemVinculo).toMatch(/^O anúncio existe e não está vinculado: não descarte/);
    expect(D.existeSemVinculo).toContain('mesmo SKU');
    expect(D.existeSemVinculo).toContain(PORTA_DA_IMPORTACAO_SHOPEE);
    expect(D.existeSemVinculo).toContain('Normalmente a importação adota este rascunho');
    expect(D.existeSemVinculo).toContain('se ela criar um vínculo à parte');
  });

  it('the exit it names is the dialog’s own case (b): the quoted option is a real button label', () => {
    const citada = /«([^»]+)»/.exec(D.existeSemVinculo)?.[1];
    expect(citada).toBe('já está vinculado');
    // The quoted fragment picks ONE button: (b), never (a).
    expect(D.existeVinculado).toContain(citada);
    expect(D.naoExiste).not.toContain(citada);
  });

  it('NEAR-MISS: the unconditional promise — «; a importação adota este rascunho» — is gone', () => {
    expect(D.existeSemVinculo).not.toContain('; a importação adota este rascunho');
    expect(D.existeSemVinculo).not.toMatch(/que a importação adota/);
    // Softened, not dropped: the adoption is still the usual outcome.
    expect(D.existeSemVinculo).toMatch(/adota este rascunho/);
  });
});
