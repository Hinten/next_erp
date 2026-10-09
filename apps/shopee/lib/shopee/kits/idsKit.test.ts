import { describe, expect, it } from 'vitest';

import { idProdutoPaiShopee } from '../produtos/produtoIds';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from './idsKit';

/** Fixture roles (step 19, D1): the kit listing and its first kit model. */
const KIT_ITEM = 2500139870;
const KIT_MODEL = 2000458820;

describe('idDoVinculoDeKit — the kit listing link id', () => {
  it('is the hex sha256 of `shopee-kit|<conta>|<item_id>`, pinned character for character', () => {
    // Computed once outside this repo's code (`node -e` over node:crypto) and
    // written down: a reformat of the preimage fails HERE, not in the catálogo.
    expect(idDoVinculoDeKit('int-1', KIT_ITEM)).toBe(
      '0d36512cfa0fe35978c32b283eb23e4506cea04af4781e2bcedc157f96765285',
    );
  });

  it('is deterministic — the create and the import compute the SAME id', () => {
    expect(idDoVinculoDeKit('int-1', KIT_ITEM)).toBe(idDoVinculoDeKit('int-1', KIT_ITEM));
  });

  it('⛔ NEAR-MISS: another conta or another item is another id', () => {
    const base = idDoVinculoDeKit('int-1', KIT_ITEM);
    expect(idDoVinculoDeKit('int-2', KIT_ITEM)).not.toBe(base);
    expect(idDoVinculoDeKit('int-1', KIT_ITEM + 1)).not.toBe(base);
  });

  it('⛔ NEAR-MISS: the pipes keep `(int-1, 2500139870)` and `(int-12, 500139870)` apart', () => {
    expect(idDoVinculoDeKit('int-12', 500139870)).not.toBe(idDoVinculoDeKit('int-1', KIT_ITEM));
  });

  it('⛔ never equals the parent PRODUTO id of the same listing (the `shopee-kit` prefix)', () => {
    expect(idDoVinculoDeKit('int-1', KIT_ITEM)).not.toBe(idProdutoPaiShopee('int-1', KIT_ITEM));
  });

  it('refuses an empty conta and an id that is not a positive safe integer', () => {
    expect(() => idDoVinculoDeKit('', KIT_ITEM)).toThrow(RangeError);
    expect(() => idDoVinculoDeKit('int-1', 0)).toThrow(RangeError);
    expect(() => idDoVinculoDeKit('int-1', -1)).toThrow(RangeError);
    expect(() => idDoVinculoDeKit('int-1', 1.5)).toThrow(RangeError);
    expect(() => idDoVinculoDeKit('int-1', Number.NaN)).toThrow(RangeError);
  });
});

describe('idDaVariacaoDeKit — the kit model row id', () => {
  const LINK = idDoVinculoDeKit('int-1', KIT_ITEM);

  it('is the hex sha256 of `<linkDocId>|<model_id>`, pinned', () => {
    expect(idDaVariacaoDeKit(LINK, KIT_MODEL)).toBe(
      '6f0b222fda439b854a3d83ed3f767e93e42670e231a749778ff79bf18c897fad',
    );
  });

  it('⛔ NEAR-MISS: another link or another model is another row', () => {
    const base = idDaVariacaoDeKit(LINK, KIT_MODEL);
    expect(idDaVariacaoDeKit('auto-1', KIT_MODEL)).not.toBe(base);
    expect(idDaVariacaoDeKit(LINK, KIT_MODEL + 2)).not.toBe(base);
    expect(idDaVariacaoDeKit('a', 12)).not.toBe(idDaVariacaoDeKit('a1', 2));
  });

  it('refuses `model_id: 0` — the "no model" sentinel is never a row', () => {
    expect(() => idDaVariacaoDeKit(LINK, 0)).toThrow(RangeError);
    expect(() => idDaVariacaoDeKit('', KIT_MODEL)).toThrow(RangeError);
  });
});
