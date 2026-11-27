/**
 * The price snapshot's short forms ⇄ the price function's types (master plan step 13, PR 13-f1):
 * `leituraSnapshotDaTabelaLi` / `leituraTabelaDoSnapshotLi`, `alvoSnapshotDoAlvoLi` /
 * `envioDoAlvoSnapshotLi`, `mesmoAlvoSnapshotLi` and `valorDosCentavosSnapshotLi`. Each conversion
 * is tested from both sides — a pair that must come out equal and a near-miss that must stay
 * distinct — and the centavos round trip is swept over its whole domain. Every value is invented.
 */
import { describe, expect, it } from 'vitest';
import { centavosDeReais } from '@delfrance/core/money';

import {
  type AlvoPrecoLi,
  type LeituraTabelaPrecoLi,
  leituraTabelaPrecoLi,
  precoAlvoLi,
  precosDasLeiturasLi,
  valorPrecoLi,
} from './precoErpLojaIntegrada';
import {
  type AlvoSnapshotPrecoLi,
  alvoSnapshotDoAlvoLi,
  alvoSnapshotPrecoLiSchema,
  envioDoAlvoSnapshotLi,
  leituraSnapshotDaTabelaLi,
  leituraSnapshotPrecoLiSchema,
  leituraTabelaDoSnapshotLi,
  mesmoAlvoSnapshotLi,
  valorDosCentavosSnapshotLi,
} from './sincPrecoLojaIntegrada';

/** mulberry32: a deterministic generator in [0, 1). */
function gerador(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** The tabela a reading is replayed at. */
const TABELA = 'tab-n';

/** The reading a stored short form replays as, through the rebuilt map. */
function relida(s: ReturnType<typeof leituraSnapshotDaTabelaLi>): LeituraTabelaPrecoLi {
  return leituraTabelaPrecoLi(
    precosDasLeiturasLi({ [TABELA]: leituraTabelaDoSnapshotLi(s) }),
    TABELA,
  );
}

describe('leituraSnapshotDaTabelaLi / leituraTabelaDoSnapshotLi', () => {
  it('EQUAL: { valor: 10 } ⇒ 1000 ⇒ a map that reads back as 10, which is 1000 again', () => {
    const c = leituraSnapshotDaTabelaLi({ valor: 10 });
    expect(c).toBe(1000);
    expect(leituraTabelaDoSnapshotLi(c)).toEqual({ valor: 10 });
    expect(relida(c)).toEqual({ valor: 10 });
    expect(leituraSnapshotDaTabelaLi(relida(c))).toBe(1000);
  });

  it('a reading is rounded ONCE, by the shared money helper: 10.004 ⇒ 1000; 10.005 leans on the double (pinned)', () => {
    expect(leituraSnapshotDaTabelaLi({ valor: 10.004 })).toBe(1000);
    // `centavosDeReais` is the one conversion; whatever it answers for 10.005, the snapshot keeps.
    expect(leituraSnapshotDaTabelaLi({ valor: 10.005 })).toBe(centavosDeReais(10.005));
    expect(leituraSnapshotDaTabelaLi({ valor: 10.005 })).toBe(1001);
    // NEAR-MISS: one centavo apart stays apart.
    expect(leituraSnapshotDaTabelaLi({ valor: 10.01 })).toBe(1001);
    expect(leituraSnapshotDaTabelaLi({ valor: 10 })).not.toBe(
      leituraSnapshotDaTabelaLi({ valor: 10.01 }),
    );
  });

  it('a price whose centavos are not a positive safe integer that reads back as itself ⇒ `il`', () => {
    expect(leituraSnapshotDaTabelaLi({ valor: 1e14 })).toBe('il');
    expect(leituraSnapshotDaTabelaLi({ valor: Number.MAX_SAFE_INTEGER })).toBe('il');
    expect(leituraSnapshotDaTabelaLi({ valor: Number.POSITIVE_INFINITY })).toBe('il');
    // NEAR-MISS: the top of the swept domain is still a price.
    expect(leituraSnapshotDaTabelaLi({ valor: 1e10 })).toBe(1e12);
  });

  it('`ausente` ⇒ null, NEVER `il`; `ilegivel` ⇒ `il`, NEVER null — and each replays as itself', () => {
    expect(leituraSnapshotDaTabelaLi('ausente')).toBeNull();
    expect(leituraSnapshotDaTabelaLi('ilegivel')).toBe('il');
    expect(relida(null)).toBe('ausente');
    expect(relida('il')).toBe('ilegivel');
    expect(leituraTabelaDoSnapshotLi(undefined)).toBe('ausente');
    expect(leituraTabelaDoSnapshotLi(null)).toBe('ausente');
    expect(leituraTabelaDoSnapshotLi('il')).toBe('ilegivel');
  });

  it('every reading the converter produces is one the snapshot schema accepts', () => {
    for (const l of [{ valor: 0.01 }, { valor: 11.11 }, { valor: 1e14 }, 'ilegivel'] as const) {
      const s = leituraSnapshotDaTabelaLi(l);
      expect(leituraSnapshotPrecoLiSchema.safeParse(s).success, JSON.stringify(l)).toBe(true);
    }
  });
});

describe('alvoSnapshotDoAlvoLi / envioDoAlvoSnapshotLi', () => {
  it('the inverse pair: a send with a promotion, a send with the clear, a hold', () => {
    const comPromo: AlvoPrecoLi = {
      tipo: 'enviar',
      cheioCentavos: 2222,
      promo: { centavos: 1111 },
      sinais: { promoIgualNormal: false, promoNaoMenor: false },
    };
    const limpa: AlvoPrecoLi = {
      tipo: 'enviar',
      cheioCentavos: 3333,
      promo: 'limpar',
      sinais: { promoIgualNormal: true, promoNaoMenor: false },
    };
    const retido: AlvoPrecoLi = { tipo: 'retido', motivo: 'pai-ausente' };
    expect(alvoSnapshotDoAlvoLi(comPromo)).toEqual({ c: 2222, q: 1111 });
    expect(alvoSnapshotDoAlvoLi(limpa)).toEqual({ c: 3333, q: null });
    expect(alvoSnapshotDoAlvoLi(retido)).toEqual({ r: 'pai-ausente' });
    expect(envioDoAlvoSnapshotLi({ c: 2222, q: 1111 })).toEqual({
      cheioCentavos: 2222,
      promo: { centavos: 1111 },
    });
    expect(envioDoAlvoSnapshotLi({ c: 3333, q: null })).toEqual({
      cheioCentavos: 3333,
      promo: 'limpar',
    });
    expect(envioDoAlvoSnapshotLi({ r: 'pai-ausente' })).toBeNull();
    for (const a of [comPromo, limpa, retido]) {
      expect(alvoSnapshotPrecoLiSchema.safeParse(alvoSnapshotDoAlvoLi(a)).success).toBe(true);
    }
  });

  it('a target precoAlvoLi computes survives the short form and back', () => {
    const alvo = precoAlvoLi({
      produto: {
        id: 'p1',
        dados: { precos: { [TABELA]: { valor: 44.44 }, promo: { valor: 33.33 } } },
      },
      pai: null,
      tabelaNormalId: TABELA,
      tabelaPromocionalId: 'promo',
    });
    expect(alvo.tipo).toBe('enviar');
    const curto = alvoSnapshotDoAlvoLi(alvo);
    expect(curto).toEqual({ c: 4444, q: 3333 });
    if (alvo.tipo !== 'enviar') throw new Error('inalcançável');
    expect(envioDoAlvoSnapshotLi(curto)).toEqual({
      cheioCentavos: alvo.cheioCentavos,
      promo: alvo.promo,
    });
  });
});

describe('mesmoAlvoSnapshotLi — equal integers or the same motivo; absent never equals present', () => {
  const a: AlvoSnapshotPrecoLi = { c: 1111, q: null };

  it('EQUAL', () => {
    expect(mesmoAlvoSnapshotLi(a, { c: 1111, q: null })).toBe(true);
    expect(mesmoAlvoSnapshotLi({ c: 1111, q: 999 }, { c: 1111, q: 999 })).toBe(true);
    expect(mesmoAlvoSnapshotLi({ r: 'sem-preco' }, { r: 'sem-preco' })).toBe(true);
    expect(mesmoAlvoSnapshotLi(undefined, null)).toBe(true);
  });

  it('DISTINCT (near-misses)', () => {
    expect(mesmoAlvoSnapshotLi(a, { c: 1111, q: 999 })).toBe(false);
    expect(mesmoAlvoSnapshotLi(a, { c: 1112, q: null })).toBe(false);
    expect(mesmoAlvoSnapshotLi({ c: 1111, q: 1 }, { c: 1111, q: 2 })).toBe(false);
    expect(mesmoAlvoSnapshotLi({ r: 'sem-preco' }, { r: 'ilegivel' })).toBe(false);
    expect(mesmoAlvoSnapshotLi(a, { r: 'sem-preco' })).toBe(false);
    expect(mesmoAlvoSnapshotLi({ r: 'sem-preco' }, a)).toBe(false);
    expect(mesmoAlvoSnapshotLi(a, undefined)).toBe(false);
    expect(mesmoAlvoSnapshotLi(null, a)).toBe(false);
  });
});

describe('the centavos round trip over its whole domain', () => {
  it(
    'c ∈ [1, 1e12]: centavosDeReais(c / 100) === c, the store-value reader reads c / 100 as exactly c, and the converters agree',
    // 3,000 draws plus the bounds; CI runners are slower under load.
    { timeout: 30_000 },
    () => {
      const r = gerador(0x13f1);
      const amostras = [1, 99, 100, 101, 1e12, 1e12 - 1];
      for (let n = 0; n < 3_000; n += 1) {
        amostras.push(Math.max(1, Math.floor(Math.exp(r() * Math.log(1e12)))));
      }
      for (const c of amostras) {
        const v = valorDosCentavosSnapshotLi(c);
        expect(centavosDeReais(v), String(c)).toBe(c);
        expect(valorPrecoLi(v), String(c)).toEqual({ centavos: c });
        expect(leituraSnapshotDaTabelaLi(leituraTabelaDoSnapshotLi(c)), String(c)).toBe(c);
        expect(leituraSnapshotDaTabelaLi(relida(c)), String(c)).toBe(c);
      }
    },
  );

  it('outside the domain the converter answers `il`, never a wrong price', () => {
    for (const valor of [1e14, 9e15, Number.MAX_VALUE]) {
      expect(leituraSnapshotDaTabelaLi({ valor }), String(valor)).toBe('il');
    }
  });
});
