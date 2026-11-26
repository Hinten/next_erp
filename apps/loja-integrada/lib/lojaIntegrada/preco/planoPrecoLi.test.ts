/**
 * `planoPrecoLi.ts` (master plan step 13, PR 13-d): the pure plan of one price send — the write
 * kind of each origin, the guard on the deciding read, and the decision in integer centavos
 * (unreadable, reflected, a refused lowering, or the builder inputs to send).
 *
 * Every value is INVENTED (`testing/precoLi.ts`: store product 1001, a variation of 1000; a price
 * row's own id is its produto's + 8000; plain repeated-digit amounts). Each fold has its EQUAL pair
 * and its NEAR-MISS: the reflected rule and the no-lower rule decide whether something is sent.
 */
import { describe, expect, it } from 'vitest';
import type { ProdutoComPrecoDetalheLi } from '@delfrance/integrations-loja-integrada';
import {
  type EnvioPrecoLi,
  FORMA_PROMO_LIMPA_LI,
  type FormaPromoLimpaLi,
  ORIGEM_TAREFA_PRECO_LI,
  type OrigemTarefaPrecoLi,
  TIPO_PRODUTO_LI,
  precoAlvoLi,
} from '@delfrance/schemas';

import { detalhePrecoLi, idDaLinhaDePrecoLi } from '../testing/precoLi';
import {
  type DecisaoEnvioPrecoLi,
  decidirEnvioPrecoLi,
  guardaDoDetalhePrecoLi,
  planoPrecoLi,
  tipoEscritaDaOrigemPrecoLi,
} from './planoPrecoLi';

const ID = 1001;

/** The store's detail of {@link ID}, its prices and any leaf replaced by `over`. */
function detalhe(
  cheio: unknown,
  promocional: unknown,
  over: Readonly<Record<string, unknown>> = {},
): ProdutoComPrecoDetalheLi {
  return {
    ...detalhePrecoLi(ID, { preco_cheio: null, preco_promocional: null, preco_custo: null }),
    preco_cheio: cheio,
    preco_promocional: promocional,
    ...over,
  };
}

/** A target in centavos: a positive promotion, or the clear. */
const alvo = (cheioCentavos: number, promo: number | null = null): EnvioPrecoLi => ({
  cheioCentavos,
  promo: promo === null ? 'limpar' : { centavos: promo },
});

function plano(
  a: EnvioPrecoLi,
  d: ProdutoComPrecoDetalheLi,
  o: { baixar?: boolean; forma?: FormaPromoLimpaLi } = {},
) {
  return planoPrecoLi({
    alvo: a,
    detalhe: d,
    idLi: ID,
    baixar: o.baixar ?? false,
    forma: o.forma ?? FORMA_PROMO_LIMPA_LI.nulo,
  });
}

/* -------------------------------------------------------------------------- */
/*                                The write kind                               */
/* -------------------------------------------------------------------------- */

describe('the write kind of each origin', () => {
  it('the table, exhaustive over the origins: four read back, two bulk', () => {
    const tabela = Object.fromEntries(
      Object.values(ORIGEM_TAREFA_PRECO_LI).map((o: OrigemTarefaPrecoLi) => [
        o,
        tipoEscritaDaOrigemPrecoLi(o),
      ]),
    );
    expect(tabela).toEqual({
      evento: 'preco-produto',
      manual: 'preco-produto',
      publicacao: 'preco-produto',
      deriva: 'preco-produto',
      reconcile: 'preco-produto-lote',
      atualizacao: 'preco-produto-lote',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The guard                                  */
/* -------------------------------------------------------------------------- */

describe('the guard on the deciding read (first hit wins)', () => {
  const base = detalhe(55.55, null);

  it('EQUAL: a live, unblocked variation naming the product asked ⇒ ok, with its sob_consulta', () => {
    expect(guardaDoDetalhePrecoLi(base, ID)).toEqual({ tipo: 'ok', sobConsulta: false });
    expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { preco_sob_consulta: true }), ID)).toEqual({
      tipo: 'ok',
      sobConsulta: true,
    });
  });

  it.each([1002, idDaLinhaDePrecoLi(ID)])(
    '⚠️ NEAR-MISS: a detail whose id is %i (another product, or the price row’s own id) ⇒ linha-divergente',
    (id) => {
      expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { id }), ID)).toEqual({
        tipo: 'linha-divergente',
      });
    },
  );

  it.each([TIPO_PRODUTO_LI.atributo, TIPO_PRODUTO_LI.normal, 'Atributo_opcao', 'atributo_opcao '])(
    '⚠️ NEAR-MISS: tipo %j ⇒ nao-e-variacao',
    (tipo) => {
      expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { tipo }), ID)).toEqual({
        tipo: 'nao-e-variacao',
      });
    },
  );

  it.each(['removido', 'bloqueado'] as const)(
    '%s: exactly false passes; true stops; anything else fails CLOSED (guarda-ilegivel)',
    (folha) => {
      expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { [folha]: false }), ID).tipo).toBe('ok');
      expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { [folha]: true }), ID)).toEqual({
        tipo: folha,
      });
      for (const v of ['false', null, 0, 'true', 1, undefined]) {
        expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { [folha]: v }), ID), String(v)).toEqual(
          { tipo: 'guarda-ilegivel' },
        );
      }
    },
  );

  it.each([null, 'false', 0, 'true', undefined])(
    '⚠️ NEAR-MISS: preco_sob_consulta %j ⇒ sob-consulta-ilegivel (the engine would refuse its echo)',
    (v) => {
      expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { preco_sob_consulta: v }), ID)).toEqual({
        tipo: 'sob-consulta-ilegivel',
      });
    },
  );

  it('⚠️ `ativo` is NOT read: an inactive child (false, or unreadable) is priced', () => {
    for (const ativo of [false, null, 'x']) {
      expect(guardaDoDetalhePrecoLi(detalhe(55.55, null, { ativo }), ID).tipo).toBe('ok');
    }
  });

  it('the order: the id first, then the tipo, removido, bloqueado, sob_consulta', () => {
    const tudoErrado = {
      id: 1002,
      tipo: TIPO_PRODUTO_LI.normal,
      removido: true,
      bloqueado: true,
      preco_sob_consulta: null,
    };
    expect(guardaDoDetalhePrecoLi(detalhe(1, 1, tudoErrado), ID).tipo).toBe('linha-divergente');
    expect(guardaDoDetalhePrecoLi(detalhe(1, 1, { ...tudoErrado, id: ID }), ID).tipo).toBe(
      'nao-e-variacao',
    );
    const variacao = { ...tudoErrado, id: ID, tipo: TIPO_PRODUTO_LI.atributoOpcao };
    expect(guardaDoDetalhePrecoLi(detalhe(1, 1, variacao), ID).tipo).toBe('removido');
    expect(guardaDoDetalhePrecoLi(detalhe(1, 1, { ...variacao, removido: false }), ID).tipo).toBe(
      'bloqueado',
    );
    expect(
      guardaDoDetalhePrecoLi(detalhe(1, 1, { ...variacao, removido: false, bloqueado: false }), ID)
        .tipo,
    ).toBe('sob-consulta-ilegivel');
  });

  it('planoPrecoLi answers the guard before any price is judged (an unreadable price behind it)', () => {
    expect(plano(alvo(5555), detalhe('abc', 'abc', { removido: true }))).toEqual({
      tipo: 'removido',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                The decision                                 */
/* -------------------------------------------------------------------------- */

const tipoDe = (d: DecisaoEnvioPrecoLi | { readonly tipo: string }) => d.tipo;

describe('no-lower: refuse ANY lower buyer price unless the task may lower', () => {
  it('store 55.55 / none: 55.54 + clear refused (cheio, efetivo); 55.55 + clear reflected; 55.56 + clear sent', () => {
    const d = detalhe(55.55, null);
    expect(plano(alvo(5554), d)).toEqual({ tipo: 'nao-baixado', folhas: ['cheio', 'efetivo'] });
    expect(plano(alvo(5555), d)).toEqual({ tipo: 'refletido' });
    const enviar = plano(alvo(5556), d);
    expect(enviar.tipo).toBe('enviar');
    if (enviar.tipo === 'enviar') {
      expect(enviar.entrada.alvo).toEqual({ cheioCentavos: 5556, promo: 'limpar' });
    }
  });

  it('⚠️ a NEW promotion where the store shows none lowers the effective price: refused, sent only when the task may lower', () => {
    const d = detalhe(55.55, null);
    expect(plano(alvo(5555, 4443), d)).toEqual({ tipo: 'nao-baixado', folhas: ['efetivo'] });
    expect(tipoDe(plano(alvo(5555, 4443), d, { baixar: true }))).toBe('enviar');
  });

  it('⚠️ NEAR-MISS (kills `<=` on the effective price): a promotion ABOVE the full price leaves the buyer price unchanged ⇒ sent', () => {
    expect(tipoDe(plano(alvo(5555, 5560), detalhe(55.55, null)))).toBe('enviar');
  });

  it('store 55.55 / 44.44: a promotion one centavo lower is refused on both leaves; sent when the task may lower', () => {
    const d = detalhe(55.55, 44.44);
    expect(plano(alvo(5555, 4443), d)).toEqual({
      tipo: 'nao-baixado',
      folhas: ['promocional', 'efetivo'],
    });
    expect(tipoDe(plano(alvo(5555, 4443), d, { baixar: true }))).toBe('enviar');
  });

  it('⚠️ NEAR-MISS (kills `<=` on the full price): the same full price with a RAISED promotion ⇒ sent', () => {
    expect(tipoDe(plano(alvo(5555, 4445), detalhe(55.55, 44.44)))).toBe('enviar');
  });

  it('a CLEAR is never a lowering: 55.55 + clear over 55.55 / 44.44 ⇒ sent', () => {
    expect(tipoDe(plano(alvo(5555), detalhe(55.55, 44.44)))).toBe('enviar');
  });

  it('⚠️ a lower full price beside a clear is still refused, and the effective price rises: exactly [cheio]', () => {
    expect(plano(alvo(5554), detalhe(55.55, 44.44))).toEqual({
      tipo: 'nao-baixado',
      folhas: ['cheio'],
    });
  });

  it.each([null, 0])(
    'a store full price of %j protects nothing: 11.11 + clear is sent with baixar false',
    (cheio) => {
      expect(tipoDe(plano(alvo(1111), detalhe(cheio, null)))).toBe('enviar');
    },
  );

  it('baixar true sends a lower full price', () => {
    expect(tipoDe(plano(alvo(5554), detalhe(55.55, null), { baixar: true }))).toBe('enviar');
  });
});

describe('an unreadable current price: neither lowers nor does not', () => {
  it.each<[string, unknown, unknown]>([
    ['the full price as text', 'abc', null],
    ['a negative full price', -1, null],
    ['a comma decimal', '1,50', null],
    ['the promotion as text', 55.55, 'abc'],
    ['a negative promotion', 55.55, -1],
  ])('%s ⇒ atual-ilegivel under BOTH baixar values', (_r, cheio, promo) => {
    for (const baixar of [false, true]) {
      expect(plano(alvo(5555), detalhe(cheio, promo), { baixar })).toEqual({
        tipo: 'atual-ilegivel',
      });
    }
  });

  it('⚠️ NEAR-MISS: the padded text `55.5500` is readable ⇒ reflected for 55.55', () => {
    expect(plano(alvo(5555), detalhe('55.5500', null))).toEqual({ tipo: 'refletido' });
  });
});

describe('reflected: every spelling the store answers, and the clear under the forma', () => {
  it.each<[string, unknown, unknown]>([
    ['`55.5500` / `0.0000`', '55.5500', '0.0000'],
    ['`55.5500` / 0', '55.5500', 0],
    ['55.55 / `0.00`', 55.55, '0.00'],
    ['`55.55` / null', '55.55', null],
  ])('EQUAL: %s after a clear ⇒ refletido', (_r, cheio, promo) => {
    expect(plano(alvo(5555), detalhe(cheio, promo))).toEqual({ tipo: 'refletido' });
  });

  it('⚠️ NEAR-MISS: a promotion of one centavo (`0.01`) is a price, not a clear ⇒ sent', () => {
    expect(tipoDe(plano(alvo(5555), detalhe(55.55, '0.01')))).toBe('enviar');
  });

  it('EQUAL: a positive promotion in its four-decimal text ⇒ refletido', () => {
    expect(plano(alvo(5555, 4444), detalhe('55.5500', '44.4400'))).toEqual({ tipo: 'refletido' });
  });

  it('the forma: a promotion equal to the full price is a landed clear under igual-cheio ONLY', () => {
    const d = detalhe(55.55, 55.55);
    expect(tipoDe(plano(alvo(5555), d, { forma: FORMA_PROMO_LIMPA_LI.igualCheio }))).toBe(
      'refletido',
    );
    for (const forma of [FORMA_PROMO_LIMPA_LI.nulo, FORMA_PROMO_LIMPA_LI.zero]) {
      expect(tipoDe(plano(alvo(5555), d, { forma })), forma).toBe('enviar');
    }
  });

  it('⚠️ the custo is never compared: prices equal, any custo ⇒ refletido', () => {
    for (const preco_custo of [12.34, 99.99, 'abc', null, -1.5]) {
      expect(plano(alvo(5555), detalhe(55.55, null, { preco_custo }))).toEqual({
        tipo: 'refletido',
      });
    }
  });

  it('⚠️ sob_consulta true on the store is echoed, never compared: equal prices ⇒ refletido', () => {
    expect(plano(alvo(5555), detalhe(55.55, null, { preco_sob_consulta: true }))).toEqual({
      tipo: 'refletido',
    });
  });
});

describe('enviar: the builder inputs come FROM THE DECIDING READ', () => {
  it.each<[unknown, string]>([
    [null, 'omitido-nulo'],
    [0, 'enviado'],
    [12.34, 'enviado'],
    [-1.5, 'omitido-ilegivel'],
    ['12.34', 'omitido-ilegivel'],
    ['abc', 'omitido-ilegivel'],
    [true, 'omitido-ilegivel'],
  ])('the store custo %j is echoed BY IDENTITY; the builder’s verdict is %s', (custo, verdict) => {
    const enviar = plano(alvo(5555), detalhe(44.44, null, { preco_custo: custo }));
    if (enviar.tipo !== 'enviar') throw new TypeError(`esperava enviar, veio ${enviar.tipo}`);
    expect(Object.is(enviar.entrada.custo, custo)).toBe(true);
    expect(enviar.custo).toBe(verdict);
  });

  it('⚠️ NEAR-MISS: 0 is not null — a 0 custo is sent, a null custo omitted', () => {
    const zero = plano(alvo(5555), detalhe(44.44, null, { preco_custo: 0 }));
    const nulo = plano(alvo(5555), detalhe(44.44, null, { preco_custo: null }));
    expect(zero.tipo === 'enviar' && zero.custo).toBe('enviado');
    expect(nulo.tipo === 'enviar' && nulo.custo).toBe('omitido-nulo');
  });

  it('sob_consulta is the guard’s boolean, the forma the configured one, and the target carries ONLY its two leaves', () => {
    const doAlvo = precoAlvoLi({
      produto: { id: 'p', dados: { precos: { n: { valor: 55.55 }, p: { valor: 33.33 } } } },
      pai: null,
      tabelaNormalId: 'n',
      tabelaPromocionalId: 'p',
    });
    if (doAlvo.tipo !== 'enviar') throw new TypeError('alvo inventado não enviável');
    const enviar = planoPrecoLi({
      alvo: doAlvo,
      detalhe: detalhe(22.22, null, { preco_sob_consulta: true }),
      idLi: ID,
      baixar: false,
      forma: FORMA_PROMO_LIMPA_LI.zero,
    });
    expect(enviar).toEqual({
      tipo: 'enviar',
      entrada: {
        alvo: { cheioCentavos: 5555, promo: { centavos: 3333 } },
        formaPromoLimpa: 'zero',
        custo: null,
        sobConsulta: true,
      },
      custo: 'omitido-nulo',
    });
    // The price function's own `tipo` and `sinais` never ride into the builder's inputs.
    if (enviar.tipo === 'enviar') {
      expect(Object.keys(enviar.entrada.alvo).sort()).toEqual(['cheioCentavos', 'promo']);
    }
  });

  it('decidirEnvioPrecoLi alone takes the sob_consulta it is handed (the guard’s)', () => {
    const d = decidirEnvioPrecoLi({
      alvo: alvo(5555),
      detalhe: detalhe(44.44, null),
      sobConsulta: false,
      baixar: false,
      forma: FORMA_PROMO_LIMPA_LI.nulo,
    });
    expect(d.tipo === 'enviar' && d.entrada.sobConsulta).toBe(false);
  });
});
