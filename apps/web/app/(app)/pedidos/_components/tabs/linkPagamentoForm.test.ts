import { describe, expect, it } from 'vitest';
import { centavosDeReais } from '@delfrance/core/money';
import {
  LIMITES_LINK_PAGAMENTO,
  MODO_LINK_PAGAMENTO,
  TIPO_PAGAMENTO_MP,
  criarLinksPagamentoBodySchema,
} from '@delfrance/schemas';

import {
  MODO_FORM_LINK,
  TIPOS_PAGAMENTO_LINK,
  cotaDoCompartilhado,
  dividirIgualmente,
  divisoesExatas,
  errosSemSoma,
  formatarDataCivil,
  impressaoDigital,
  linkFormValido,
  montarCorpoCriar,
  novaPessoa,
  quantidadeDeLinks,
  somaDoFormularioCentavos,
  validarLinkForm,
  valoresIniciaisLinkForm,
  type ContextoValidacaoLink,
  type LinkFormState,
  type PessoaLinkForm,
} from './linkPagamentoForm';

const HOJE = '2026-09-29';

/** A link id in the shape the route accepts (20 alphanumerics, like `newDocId()`). */
function idDeLink(n: number): string {
  return `L${String(n).padStart(19, '0')}`;
}

/** A valid "Um link" draft: R$ 50,00 on account `conta-a`, due in 3 days. */
function umLink(patch: Partial<LinkFormState> = {}): LinkFormState {
  return { ...valoresIniciaisLinkForm(HOJE, 'conta-a'), valor: 50, ...patch };
}

function pessoa(nome: string, valor: number | null, chave = nome): PessoaLinkForm {
  return { chave, nome, valor };
}

function vaquinha(pessoas: PessoaLinkForm[], patch: Partial<LinkFormState> = {}): LinkFormState {
  return {
    ...valoresIniciaisLinkForm(HOJE, 'conta-a'),
    modo: MODO_FORM_LINK.vaquinha,
    pessoas,
    ...patch,
  };
}

function compartilhado(total: number | null, quantidade: number | null): LinkFormState {
  return {
    ...valoresIniciaisLinkForm(HOJE, 'conta-a'),
    modo: MODO_FORM_LINK.compartilhado,
    valorTotalCompartilhado: total,
    quantidade,
  };
}

/** `n` rows with distinct letter-only names, R$ 1,00 each. */
function linhas(n: number): PessoaLinkForm[] {
  return Array.from({ length: n }, (_, i) => pessoa(`Pessoa${String.fromCharCode(97 + i)}`, 1));
}

/** R$ 100,00 available for new links, no link stored yet, shared mode ON (both arms are tested). */
const CTX: ContextoValidacaoLink = {
  restanteSemLinkCentavos: 10_000,
  linksExistentes: 0,
  hoje: HOJE,
  compartilhadoHabilitado: true,
};

function erros(state: LinkFormState, ctx: Partial<ContextoValidacaoLink> = {}) {
  return validarLinkForm(state, { ...CTX, ...ctx });
}

function somaEmCentavos(valores: number[]): number {
  return valores.reduce((soma, v) => soma + centavosDeReais(v), 0);
}

describe('valoresIniciaisLinkForm', () => {
  it('starts as one link due in the default number of civil days, every type on', () => {
    const state = valoresIniciaisLinkForm(HOJE, null);
    expect(state.modo).toBe(MODO_FORM_LINK.umLink);
    expect(state.metodoId).toBeNull();
    expect(LIMITES_LINK_PAGAMENTO.expiracaoDiasPadrao).toBe(3);
    expect(state.expiraEm).toBe('2026-10-02');
    expect(state.tiposExcluidos).toEqual([]);
    expect(state.parcelasMaximas).toBeNull();
    expect(state.pessoas).toHaveLength(2);
  });

  it('crosses a month boundary on the civil calendar', () => {
    expect(valoresIniciaisLinkForm('2026-02-27', null).expiraEm).toBe('2026-03-02');
  });

  it('pre-selects the only account and prefills the payer only for a pedido with a cliente', () => {
    expect(valoresIniciaisLinkForm(HOJE, 'conta-a').metodoId).toBe('conta-a');
    expect(valoresIniciaisLinkForm(HOJE, null, true).preencherPagador).toBe(true);
    // Near-miss: no cliente ⇒ nothing to prefill.
    expect(valoresIniciaisLinkForm(HOJE, null, false).preencherPagador).toBe(false);
  });
});

describe('dividirIgualmente', () => {
  it('splits R$ 100,00 in three to the cent, the extra cent on the FIRST row', () => {
    const partes = dividirIgualmente(centavosDeReais(100), 3);
    expect(partes).toEqual([33.34, 33.33, 33.33]);
    expect(somaEmCentavos(partes)).toBe(10_000);
  });

  it('spreads a remainder of several cents over the first rows (10 / 6)', () => {
    // 1000 = 6 × 166 + 4: four rows get the extra cent. A rounded `total / n`
    // (1.67 × 6 = 10.02) would overshoot — the near-miss this pins.
    const partes = dividirIgualmente(centavosDeReais(10), 6);
    expect(partes).toEqual([1.67, 1.67, 1.67, 1.67, 1.66, 1.66]);
    expect(somaEmCentavos(partes)).toBe(1_000);
  });

  it('returns nothing for no rows or a target that is not whole cents', () => {
    expect(dividirIgualmente(10_000, 0)).toEqual([]);
    expect(dividirIgualmente(-1, 3)).toEqual([]);
    expect(dividirIgualmente(100.5, 3)).toEqual([]);
  });
});

describe('divisoesExatas / cotaDoCompartilhado', () => {
  it('lists only the counts that split the total exactly', () => {
    // Near-miss: 100 / 3 is 33.333… — rounding it up would overpay the pedido.
    expect(divisoesExatas(10_000)).toEqual([2, 4, 5, 8, 10, 16, 20, 25, 40, 50]);
  });

  it('drops counts whose share falls under the minimum a link may charge', () => {
    // R$ 3,00 in 2 is R$ 1,50 and in 3 is R$ 1,00 (both ≥ R$ 1,00); in 4 it is R$ 0,75.
    expect(divisoesExatas(300)).toEqual([2, 3]);
  });

  it('gives the exact share, or null when the total does not divide', () => {
    expect(cotaDoCompartilhado(compartilhado(100, 4))).toBe(25);
    expect(cotaDoCompartilhado(compartilhado(100, 3))).toBeNull();
  });
});

describe('validarLinkForm', () => {
  it('accepts a complete single link', () => {
    expect(erros(umLink())).toEqual({});
    expect(linkFormValido(erros(umLink()))).toBe(true);
  });

  it('requires an account', () => {
    expect(erros(umLink({ metodoId: null })).metodoId).toBeDefined();
    expect(erros(umLink({ metodoId: 'conta-a' })).metodoId).toBeUndefined();
  });

  it('enforces the route minimum of R$ 1,00 per link', () => {
    expect(erros(umLink({ valor: 0.99 })).valor).toMatch(/mínimo/);
    expect(erros(umLink({ valor: 1 })).valor).toBeUndefined();
    expect(erros(umLink({ valor: null })).valor).toBe('Informe o valor.');
  });

  it('rejects a third decimal instead of rounding it', () => {
    expect(erros(umLink({ valor: 1.005 })).valor).toMatch(/2 casas/);
    expect(erros(umLink({ valor: 1.01 })).valor).toBeUndefined();
  });

  it('treats the single-link name as optional, but valid when given', () => {
    expect(erros(umLink({ nomePagador: '' })).nomePagador).toBeUndefined();
    expect(erros(umLink({ nomePagador: 'Maria S.' })).nomePagador).toBeUndefined();
    expect(erros(umLink({ nomePagador: 'Maria2' })).nomePagador).toBeDefined();
    expect(erros(umLink({ nomePagador: 'A'.repeat(21) })).nomePagador).toBeDefined();
  });

  it('refuses a batch above what new links may charge, in cents, equality allowed', () => {
    const acima = erros(umLink({ valor: 100.01 }));
    expect(acima.soma).toContain('Os links somam mais do que o restante');
    expect(linkFormValido(acima)).toBe(false);
    // Near-miss: exactly the available amount is fine.
    expect(erros(umLink({ valor: 100 })).soma).toBeUndefined();
    // The limit is the AVAILABLE amount (restante minus open links), not the total.
    const menor = erros(umLink({ valor: 60 }), { restanteSemLinkCentavos: 5_000 });
    expect(menor.soma).toBeDefined();
  });

  it('caps the stored links plus the batch at the per-pedido limit, equality allowed', () => {
    const max = LIMITES_LINK_PAGAMENTO.linksPorPedidoMax;
    expect(max).toBe(50);
    // 49 stored + 1 = 50: allowed.
    expect(erros(umLink(), { linksExistentes: max - 1 }).limiteLinks).toBeUndefined();
    // Near-miss: 49 stored + 2 (a vaquinha of two) = 51: refused.
    const doisAMais = erros(vaquinha([pessoa('Ana', 50), pessoa('Bia', 50)]), {
      linksExistentes: max - 1,
    });
    expect(doisAMais.limiteLinks).toMatch(/51 links/);
    expect(linkFormValido(doisAMais)).toBe(false);
    // The same vaquinha with one link fewer stored fits exactly.
    const doisNoLimite = erros(vaquinha([pessoa('Ana', 50), pessoa('Bia', 50)]), {
      linksExistentes: max - 2,
    });
    expect(doisNoLimite.limiteLinks).toBeUndefined();
  });

  it('keeps at least one payment type on', () => {
    const nenhum = erros(umLink({ tiposExcluidos: [...TIPOS_PAGAMENTO_LINK] }));
    expect(nenhum.tiposExcluidos).toBeDefined();
    const umSo = erros(umLink({ tiposExcluidos: TIPOS_PAGAMENTO_LINK.slice(1) }));
    expect(umSo.tiposExcluidos).toBeUndefined();
  });

  it('bounds the installments at 1..12, empty meaning the Mercado Pago default', () => {
    expect(erros(umLink({ parcelasMaximas: null })).parcelasMaximas).toBeUndefined();
    expect(erros(umLink({ parcelasMaximas: 12 })).parcelasMaximas).toBeUndefined();
    expect(erros(umLink({ parcelasMaximas: 13 })).parcelasMaximas).toBeDefined();
    expect(erros(umLink({ parcelasMaximas: 0 })).parcelasMaximas).toBeDefined();
    expect(erros(umLink({ parcelasMaximas: 1.5 })).parcelasMaximas).toBeDefined();
  });

  it('bounds the expiry between today and today + 29', () => {
    expect(erros(umLink({ expiraEm: HOJE })).expiraEm).toBeUndefined();
    expect(erros(umLink({ expiraEm: '2026-10-28' })).expiraEm).toBeUndefined();
    expect(erros(umLink({ expiraEm: '2026-10-29' })).expiraEm).toMatch(/28\/10\/2026/);
    expect(erros(umLink({ expiraEm: '2026-09-28' })).expiraEm).toBeDefined();
    const inexistente = erros(umLink({ expiraEm: '2026-02-30' }), { hoje: '2026-02-01' });
    expect(inexistente.expiraEm).toBeDefined();
  });

  describe('vaquinha', () => {
    it('accepts named rows that fit the available amount', () => {
      expect(erros(vaquinha([pessoa('Ana', 50), pessoa('Bia', 50)]))).toEqual({});
    });

    it('requires a valid first name on every row', () => {
      const e = erros(vaquinha([pessoa('Ana', 10), pessoa('', 10), pessoa('Bia 2', 10)]));
      expect(e.pessoa?.[0]).toBeUndefined();
      expect(e.pessoa?.[1]?.nome).toBe('Informe o primeiro nome.');
      expect(e.pessoa?.[2]?.nome).toBeDefined();
    });

    it('refuses a repeated name (case-insensitive) but not a disambiguated one', () => {
      const repetido = erros(vaquinha([pessoa('Maria', 10), pessoa('maria', 10)]));
      expect(repetido.pessoa?.[1]?.nome).toMatch(/repetido/);
      const distinto = erros(vaquinha([pessoa('Maria', 10), pessoa('Maria S.', 10)]));
      expect(distinto.pessoa).toBeUndefined();
    });

    it('validates each row value', () => {
      const e = erros(vaquinha([pessoa('Ana', 0.5), pessoa('Bia', null)]));
      expect(e.pessoa?.[0]?.valor).toMatch(/mínimo/);
      expect(e.pessoa?.[1]?.valor).toBe('Informe o valor.');
    });

    it('caps the batch at the route limit', () => {
      const max = LIMITES_LINK_PAGAMENTO.linksPorLoteMax;
      expect(erros(vaquinha(linhas(max))).pessoas).toBeUndefined();
      expect(erros(vaquinha(linhas(max + 1))).pessoas).toBeDefined();
      expect(erros(vaquinha([])).pessoas).toBeDefined();
    });

    it('sums the rows in cents against the available amount', () => {
      const acima = erros(vaquinha([pessoa('Ana', 50), pessoa('Bia', 50.01)]));
      expect(acima.soma).toBeDefined();
      const partes = [pessoa('Ana', 33.34), pessoa('Bia', 33.33), pessoa('Cid', 33.33)];
      expect(erros(vaquinha(partes)).soma).toBeUndefined();
    });
  });

  describe('link compartilhado', () => {
    it('is refused while the feature is off', () => {
      expect(erros(compartilhado(100, 4), { compartilhadoHabilitado: false }).modo).toBeDefined();
      expect(erros(compartilhado(100, 4), { compartilhadoHabilitado: true })).toEqual({});
    });

    it('only accepts a total that splits EXACTLY into the payments', () => {
      // 100 / 3 would need 33.34 × 3 = 100.02: an overpayment that blocks the NF-e.
      expect(erros(compartilhado(100, 3)).quantidade).toMatch(/não se divide/);
      expect(erros(compartilhado(99, 3)).quantidade).toBeUndefined();
    });

    it('needs 2..50 payments of at least the minimum', () => {
      expect(erros(compartilhado(100, 1)).quantidade).toBeDefined();
      expect(erros(compartilhado(100, 51)).quantidade).toBeDefined();
      expect(erros(compartilhado(1.5, 2)).quantidade).toMatch(/pelo menos/);
      expect(erros(compartilhado(null, 2)).valorTotalCompartilhado).toBeDefined();
      expect(erros(compartilhado(100.005, 2)).valorTotalCompartilhado).toMatch(/2 casas/);
    });

    it('counts the whole total against the available amount', () => {
      expect(erros(compartilhado(102, 2)).soma).toBeDefined();
      expect(erros(compartilhado(100, 2)).soma).toBeUndefined();
    });
  });
});

describe('errosSemSoma', () => {
  it('drops only the sum error — an exact replay is re-checked by the route instead', () => {
    const comSoma = erros(umLink({ valor: 100.01, nomePagador: 'Maria2' }));
    expect(comSoma.soma).toBeDefined();
    const semSoma = errosSemSoma(comSoma);
    expect(semSoma.soma).toBeUndefined();
    expect('soma' in semSoma).toBe(false);
    // Near-miss: every other error survives, so an invalid draft stays invalid.
    expect(semSoma.nomePagador).toBe(comSoma.nomePagador);
    expect(linkFormValido(semSoma)).toBe(false);
    // ...and a draft whose only error was the sum becomes valid.
    expect(linkFormValido(errosSemSoma(erros(umLink({ valor: 100.01 }))))).toBe(true);
  });
});

describe('montarCorpoCriar', () => {
  const BASE = { pedidoId: 'pedido123', valorCobradoEsperado: 150 };

  function esperarValido(corpo: unknown) {
    const lido = criarLinksPagamentoBodySchema.safeParse(corpo);
    expect(lido.success, JSON.stringify(lido.error?.issues)).toBe(true);
  }

  it('builds one individual link for "Um link", the name trimmed and the prefill kept', () => {
    const state = umLink({ nomePagador: '  Ana ', preencherPagador: true });
    const corpo = montarCorpoCriar(state, { ...BASE, linkIds: [idDeLink(1)] });
    expect(corpo).toMatchObject({
      pedidoId: 'pedido123',
      metodoId: 'conta-a',
      modo: MODO_LINK_PAGAMENTO.individual,
      valorCobradoEsperado: 150,
      expiraEm: '2026-10-02',
      quantidadeMaxima: null,
      preencherPagador: true,
      links: [{ linkId: idDeLink(1), nomePagador: 'Ana', valor: 50 }],
    });
    esperarValido(corpo);
  });

  it('sends a blank single-link name as null', () => {
    const corpo = montarCorpoCriar(umLink({ nomePagador: '   ' }), {
      ...BASE,
      linkIds: [idDeLink(1)],
    });
    expect(corpo.links[0]?.nomePagador).toBeNull();
    esperarValido(corpo);
  });

  it('builds one individual link per vaquinha row, in order, never with the payer prefill', () => {
    const pessoas = [pessoa('Ana', 33.34), pessoa(' Bia ', 33.33), pessoa('Cid', 33.33)];
    const linkIds = [idDeLink(1), idDeLink(2), idDeLink(3)];
    const corpo = montarCorpoCriar(vaquinha(pessoas, { preencherPagador: true }), {
      ...BASE,
      linkIds,
    });
    expect(corpo.modo).toBe(MODO_LINK_PAGAMENTO.individual);
    expect(corpo.preencherPagador).toBe(false);
    expect(corpo.quantidadeMaxima).toBeNull();
    expect(corpo.links).toEqual([
      { linkId: idDeLink(1), nomePagador: 'Ana', valor: 33.34 },
      { linkId: idDeLink(2), nomePagador: 'Bia', valor: 33.33 },
      { linkId: idDeLink(3), nomePagador: 'Cid', valor: 33.33 },
    ]);
    esperarValido(corpo);
  });

  it('builds ONE shared link whose value is each payment, with the payment count', () => {
    const corpo = montarCorpoCriar(compartilhado(100, 4), { ...BASE, linkIds: [idDeLink(1)] });
    expect(corpo.modo).toBe(MODO_LINK_PAGAMENTO.compartilhado);
    expect(corpo.quantidadeMaxima).toBe(4);
    expect(corpo.links).toEqual([{ linkId: idDeLink(1), nomePagador: null, valor: 25 }]);
    esperarValido(corpo);
  });

  it('sends the excluded types in canonical order and drops installments without credit', () => {
    const excluidos = [TIPO_PAGAMENTO_MP.pix, TIPO_PAGAMENTO_MP.cartaoCredito];
    const semCredito = montarCorpoCriar(umLink({ tiposExcluidos: excluidos, parcelasMaximas: 6 }), {
      ...BASE,
      linkIds: [idDeLink(1)],
    });
    expect(semCredito.tiposExcluidos).toEqual([
      TIPO_PAGAMENTO_MP.cartaoCredito,
      TIPO_PAGAMENTO_MP.pix,
    ]);
    expect(semCredito.parcelasMaximas).toBeNull();
    esperarValido(semCredito);

    // Near-miss: credit card still on ⇒ the installment cap is kept.
    const comCredito = montarCorpoCriar(
      umLink({ tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto], parcelasMaximas: 6 }),
      { ...BASE, linkIds: [idDeLink(1)] },
    );
    expect(comCredito.parcelasMaximas).toBe(6);
    esperarValido(comCredito);
  });

  it('refuses to build a body with the wrong number of ids', () => {
    const state = vaquinha([pessoa('Ana', 10), pessoa('Bia', 10)]);
    expect(() => montarCorpoCriar(state, { ...BASE, linkIds: [idDeLink(1)] })).toThrow();
  });
});

describe('quantidadeDeLinks / somaDoFormularioCentavos', () => {
  it('asks for one id per vaquinha row and one otherwise', () => {
    expect(quantidadeDeLinks(umLink())).toBe(1);
    expect(quantidadeDeLinks(compartilhado(100, 4))).toBe(1);
    expect(quantidadeDeLinks(vaquinha(linhas(3)))).toBe(3);
  });

  it('sums in cents, and not at all while a value is blank', () => {
    expect(somaDoFormularioCentavos(vaquinha([pessoa('A', 0.1), pessoa('B', 0.2)]))).toBe(30);
    expect(somaDoFormularioCentavos(vaquinha([pessoa('A', 0.1), pessoa('B', null)]))).toBeNull();
  });
});

describe('impressaoDigital', () => {
  it('is stable for the same draft and ignores the UI-only row keys', () => {
    const a = vaquinha([pessoa('Ana', 50, 'k1'), pessoa('Bia', 50, 'k2')]);
    const b = vaquinha([pessoa('Ana', 50, 'x9'), pessoa('Bia', 50, 'x8')]);
    expect(impressaoDigital(a)).toBe(impressaoDigital(b));
  });

  it('matches whenever the body would match (names are trimmed in both)', () => {
    const comEspacos = impressaoDigital(umLink({ nomePagador: ' Ana ' }));
    expect(comEspacos).toBe(impressaoDigital(umLink({ nomePagador: 'Ana' })));
  });

  it('changes with any edit that reaches the body', () => {
    const base = impressaoDigital(umLink());
    expect(impressaoDigital(umLink({ valor: 51 }))).not.toBe(base);
    expect(impressaoDigital(umLink({ nomePagador: 'Ana' }))).not.toBe(base);
    expect(impressaoDigital(umLink({ expiraEm: '2026-10-03' }))).not.toBe(base);
    expect(impressaoDigital(umLink({ metodoId: 'conta-b' }))).not.toBe(base);
    expect(impressaoDigital(umLink({ tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto] }))).not.toBe(base);
    expect(impressaoDigital(umLink({ parcelasMaximas: 3 }))).not.toBe(base);
  });
});

describe('novaPessoa / formatarDataCivil', () => {
  it('builds a blank row and formats a civil date for display', () => {
    expect(novaPessoa('k')).toEqual({ chave: 'k', nome: '', valor: null });
    expect(formatarDataCivil('2026-10-28')).toBe('28/10/2026');
  });
});
