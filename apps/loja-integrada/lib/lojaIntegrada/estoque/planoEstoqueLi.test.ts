import {
  type CandidatoReconcileEstoqueLi,
  type ComponentesKit,
  type EntradaSnapshotEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  type FlagEntradaEstoqueLi,
} from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CabecalhoKitsLi,
  DELTA_SEM_LIMITE_LI,
  type EntradaPlanoEstoqueLi,
  type EstoqueNaLojaLi,
  cruzaParaZeroLi,
  decidirEnvioEstoqueLi,
  diffLinhaEstoqueLi,
  disparaKitsZeradosLi,
  envioDeEstoqueDesligadoLi,
  estoqueNoDepositoLi,
  irmaosParaLerLi,
  kitRestritoLi,
  kitSinalizadoLi,
  kitsSinalizadosLi,
  ordenarCandidatosEstoqueLi,
  planoEstoqueLi,
  refletidoLi,
  relevanciaEventoEstoqueLi,
} from './planoEstoqueLi';
import type { DocEstoqueLi } from './quantidadeEstoqueLi';

// Per file: nothing here may reach the global `fetch` (the module is pure; no client exists).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('planoEstoqueLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SEM_TETO = Number.POSITIVE_INFINITY;

/** A stock record's path, as a read names it (and as the kit filter keys a sibling's reading). */
function caminho(produtoId: string, estoqueId: string): string {
  return `produtos/${produtoId}/estoques/${estoqueId}`;
}

/** A store row that shows `quantidade` with the four-field body, reservation `R`. */
function linha(quantidade: number, R = 0, extra: EstoqueNaLojaLi = {}): EstoqueNaLojaLi {
  return {
    gerenciado: true,
    quantidade,
    quantidade_reservada: R,
    quantidade_disponivel: quantidade - R,
    situacao_em_estoque: 0,
    situacao_sem_estoque: -1,
    ...extra,
  };
}

function registro(
  produtoId: string,
  estoqueId: string,
  dados: Record<string, unknown> = {},
): DocEstoqueLi {
  return { caminho: caminho(produtoId, estoqueId), dados };
}

function componentes(q: Record<string, number>): ComponentesKit {
  return Object.fromEntries(
    Object.entries(q).map(([id, quantidade]) => [
      id,
      { quantidade, limitarEstoque: true, timestamp: null },
    ]),
  );
}

/* -------------------------------------------------------------------------- */

describe('refletidoLi: the store already shows the body — ALL four fields, exactly', () => {
  it('EQUAL: the four fields match ⇒ reflected', () => {
    expect(refletidoLi(linha(12, 2), 12)).toBe(true);
  });

  it('⚠️ NEAR-MISS gerenciado: false, "true", 1 or absent is a write', () => {
    expect(refletidoLi(linha(12, 2, { gerenciado: false }), 12)).toBe(false);
    expect(refletidoLi(linha(12, 2, { gerenciado: 'true' }), 12)).toBe(false);
    // A truthy non-boolean that loose equality (`== true`) would accept.
    expect(refletidoLi(linha(12, 2, { gerenciado: 1 }), 12)).toBe(false);
    expect(refletidoLi(linha(12, 2, { gerenciado: undefined }), 12)).toBe(false);
  });

  it('⚠️ NEAR-MISS quantidade: one off, or the same number as text, is a write', () => {
    expect(refletidoLi(linha(11, 2), 12)).toBe(false);
    expect(refletidoLi(linha(12, 2, { quantidade: '12' }), 12)).toBe(false);
  });

  it('⚠️ NEAR-MISS situacao_em_estoque: a lead time (1) or "0" is a write', () => {
    expect(refletidoLi(linha(12, 2, { situacao_em_estoque: 1 }), 12)).toBe(false);
    expect(refletidoLi(linha(12, 2, { situacao_em_estoque: '0' }), 12)).toBe(false);
  });

  it('⚠️ NEAR-MISS situacao_sem_estoque: 0 (still purchasable at zero), −2 or "-1" is a write', () => {
    expect(refletidoLi(linha(12, 2, { situacao_sem_estoque: 0 }), 12)).toBe(false);
    expect(refletidoLi(linha(12, 2, { situacao_sem_estoque: -2 }), 12)).toBe(false);
    expect(refletidoLi(linha(12, 2, { situacao_sem_estoque: '-1' }), 12)).toBe(false);
  });

  it('⚠️ an unmanaged row reads back as all zeros, and is NOT a reflected 0', () => {
    const naoGerenciada = {
      gerenciado: false,
      quantidade: 0,
      quantidade_reservada: 0,
      situacao_em_estoque: 0,
      situacao_sem_estoque: 0,
    };
    expect(refletidoLi(naoGerenciada, 0)).toBe(false);
    expect(decidirEnvioEstoqueLi({ S: 0, cap: SEM_TETO, linha: naoGerenciada }).tipo).toBe(
      'escrever',
    );
  });
});

describe('decidirEnvioEstoqueLi: model A on the deciding GET', () => {
  it('R = 2 ⇒ PUT S + 2 with the four-field body', () => {
    expect(decidirEnvioEstoqueLi({ S: 10, cap: SEM_TETO, linha: linha(7, 2) })).toEqual({
      tipo: 'escrever',
      corpo: { gerenciado: true, quantidade: 12, situacao_em_estoque: 0, situacao_sem_estoque: -1 },
    });
  });

  it('⚠️ NEAR-MISS: R = −3 ⇒ PUT S, never S + 3', () => {
    const d = decidirEnvioEstoqueLi({ S: 10, cap: SEM_TETO, linha: linha(4, -3) });
    expect(d).toMatchObject({ tipo: 'escrever', corpo: { quantidade: 10 } });
  });

  it('⚠️ the reservation is `quantidade_reservada`, never `quantidade_disponivel`', () => {
    // The store's own derived figure disagrees with its two inputs here. Read through it, the
    // target would be 10 + 40 = 50 — exactly what the row shows — and the run would skip a
    // real 12.
    const discorda = linha(50, 2, { quantidade_disponivel: 40 });
    expect(decidirEnvioEstoqueLi({ S: 10, cap: SEM_TETO, linha: discorda })).toMatchObject({
      tipo: 'escrever',
      corpo: { quantidade: 12 },
    });
    // And the other way round: the row IS reflected by the reservation, not by the figure.
    const refletida = linha(12, 2, { quantidade_disponivel: 0 });
    expect(decidirEnvioEstoqueLi({ S: 10, cap: SEM_TETO, linha: refletida }).tipo).toBe(
      'refletido',
    );
  });

  it('a reflected row sends nothing', () => {
    expect(decidirEnvioEstoqueLi({ S: 10, cap: SEM_TETO, linha: linha(12, 2) })).toEqual({
      tipo: 'refletido',
      quantidade: 12,
    });
  });

  it('an unreadable reservation refuses: nothing is sent', () => {
    for (const R of [1.5, Number.NaN, '2', null]) {
      const d = decidirEnvioEstoqueLi({
        S: 10,
        cap: SEM_TETO,
        linha: linha(12, 0, { quantidade_reservada: R }),
      });
      expect(d).toEqual({ tipo: 'recusa', motivo: 'reserva-ilegivel' });
    }
  });

  it('the cap applies to S here, before the reservation: S 10, cap 4, R 1 ⇒ 5', () => {
    expect(decidirEnvioEstoqueLi({ S: 10, cap: 4, linha: linha(0, 1) })).toMatchObject({
      corpo: { quantidade: 5 },
    });
  });

  it('⚠️ NEAR-MISS: a bad S throws even ABOVE a finite cap — the cap never launders it', () => {
    // Capped first, 2.5 would become 2 and 2^60 would become 100, both sendable.
    expect(() => decidirEnvioEstoqueLi({ S: 2.5, cap: 2, linha: linha(0) })).toThrow(RangeError);
    expect(() => decidirEnvioEstoqueLi({ S: 2 ** 60, cap: 100, linha: linha(0) })).toThrow(
      RangeError,
    );
    expect(() => decidirEnvioEstoqueLi({ S: -1, cap: 5, linha: linha(0) })).toThrow(RangeError);
    // The control: a good S above the cap is capped.
    expect(decidirEnvioEstoqueLi({ S: 150, cap: 100, linha: linha(0) })).toMatchObject({
      corpo: { quantidade: 100 },
    });
  });
});

describe('every function that takes the cap refuses a bad one', () => {
  const kitsVazios: CabecalhoKitsLi = { qMax: 1, comps: {}, kits: {} };
  // Each call reaches its result with no other validation on the way, so only the cap check can
  // throw: an entry-less diff returns before it would reach the send decision's own check.
  const chamadas: [string, (cap: number) => unknown][] = [
    ['decidirEnvioEstoqueLi', (cap) => decidirEnvioEstoqueLi({ S: 1, cap, linha: linha(1) })],
    [
      'relevanciaEventoEstoqueLi',
      (cap) =>
        relevanciaEventoEstoqueLi({ antes: { quantidade: 1 }, depois: { quantidade: 2 }, cap }),
    ],
    [
      'irmaosParaLerLi',
      (cap) =>
        irmaosParaLerLi({ cabecalho: kitsVazios, componenteId: 'b', antes: 1, depois: 0, cap }),
    ],
    [
      'kitSinalizadoLi',
      (cap) =>
        kitSinalizadoLi({
          kit: { q: { b: 1 } },
          componenteId: 'b',
          antes: 1,
          depois: 0,
          cap,
          disponivelDe: () => 0,
        }),
    ],
    [
      'kitsSinalizadosLi',
      (cap) =>
        kitsSinalizadosLi({
          cabecalho: kitsVazios,
          componenteId: 'b',
          antes: 1,
          depois: 0,
          cap,
          leituras: new Map(),
        }),
    ],
    [
      'diffLinhaEstoqueLi',
      (cap) => diffLinhaEstoqueLi({ idLi: '1', linha: linha(1), entrada: undefined, cap }),
    ],
  ];
  const ruins = [0, -1, 2.5, Number.NaN, Number.NEGATIVE_INFINITY];

  it.each(chamadas)('%s: 0, −1, 2.5, NaN and −∞ each throw', (_nome, chamar) => {
    for (const cap of ruins) expect(() => chamar(cap)).toThrow(RangeError);
  });

  it.each(chamadas)('%s: +∞ and a positive integer are accepted', (_nome, chamar) => {
    expect(() => chamar(SEM_TETO)).not.toThrow();
    expect(() => chamar(3)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */

describe('relevanciaEventoEstoqueLi: the trigger’s payload-only gate', () => {
  const dep = 'documents/depositos/dep1';
  const r = (quantidade: number, quantidadeReservada = 0, extra: Record<string, unknown> = {}) => ({
    depositoOuterRef: dep,
    quantidade,
    quantidadeReservada,
    ...extra,
  });
  const gate = (antes: Record<string, unknown> | null, depois: Record<string, unknown> | null) =>
    relevanciaEventoEstoqueLi({ antes, depois, cap: SEM_TETO });

  it('a create and a delete are relevant AND direct; nothing on both sides is nothing', () => {
    expect(gate(null, r(0))).toEqual({ relevante: true, direta: true });
    expect(gate(r(5), null)).toEqual({ relevante: true, direta: true });
    expect(gate(null, null)).toEqual({ relevante: false, direta: false });
  });

  it('a depósito change is direct — a mere spelling change too (fail open)', () => {
    expect(gate(r(5), r(5, 0, { depositoOuterRef: 'documents/depositos/dep2' }))).toEqual({
      relevante: true,
      direta: true,
    });
    expect(gate(r(5), r(5, 0, { depositoOuterRef: 'depositos/dep1' })).direta).toBe(true);
  });

  it('⚠️ −3 → −2 is relevant (a kit quotient may move) but sends nothing of its own', () => {
    expect(gate(r(2, 5), r(3, 5))).toEqual({ relevante: true, direta: false });
  });

  it('⚠️ NEAR-MISS: 0 → 1 is direct', () => {
    expect(gate(r(0), r(1))).toEqual({ relevante: true, direta: true });
  });

  it('a fractional move inside one unit (1.2 → 1.8) is relevant, not direct', () => {
    expect(gate(r(1.2), r(1.8))).toEqual({ relevante: true, direta: false });
  });

  it('the cap: 150 → 160 under a cap of 100 publishes 100 both times; 90 → 110 does not', () => {
    const comTeto = (a: number, d: number) =>
      relevanciaEventoEstoqueLi({ antes: r(a), depois: r(d), cap: 100 });
    expect(comTeto(150, 160)).toEqual({ relevante: true, direta: false });
    expect(comTeto(90, 110)).toEqual({ relevante: true, direta: true });
  });

  it('irrelevant: a localizacao edit, the kit stamp, the paid → shipped pair (q − k, r − k)', () => {
    expect(
      gate(r(5, 1, { localizacao: 'prateleira-1' }), r(5, 1, { localizacao: 'prateleira-2' })),
    ).toEqual({
      relevante: false,
      direta: false,
    });
    expect(
      gate(r(0, 0, { ultimaModificacao: 1 }), r(0, 0, { ultimaModificacao: 2 })).relevante,
    ).toBe(false);
    expect(gate(r(10, 3), r(7, 0)).relevante).toBe(false);
  });

  it('a move of a NEGATIVE stored reservation moves nothing (the floor is `estoqueDisponivel`’s)', () => {
    expect(gate(r(8, -2), r(8, -5)).relevante).toBe(false);
  });

  it('absent counters are the schema’s 0: {} → 0 is nothing, {} → 1 is direct', () => {
    expect(gate({ depositoOuterRef: dep }, r(0)).relevante).toBe(false);
    expect(gate({ depositoOuterRef: dep }, r(1)).direta).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '5', true])(
    'an unreadable counter (%j) on either side fails open: relevant and direct',
    (v) => {
      expect(gate(r(5), { ...r(5), quantidade: v })).toEqual({ relevante: true, direta: true });
      expect(gate({ ...r(5), quantidadeReservada: v }, r(5))).toEqual({
        relevante: true,
        direta: true,
      });
    },
  );
});

/* -------------------------------------------------------------------------- */

describe('estoqueNoDepositoLi: the one record to read', () => {
  const base = { produtoId: 'p1', depositoId: 'dep1' };

  it('none, and the only one', () => {
    expect(estoqueNoDepositoLi({ ...base, registros: [] })).toEqual({ tipo: 'nenhum' });
    const unico = registro('p1', 'auto-1');
    expect(estoqueNoDepositoLi({ ...base, registros: [unico] })).toEqual({
      tipo: 'um',
      registro: unico,
    });
  });

  it('the canonical id wins over a legacy auto-id record beside it', () => {
    const canonico = registro('p1', 'est-p1-dep1');
    expect(
      estoqueNoDepositoLi({ ...base, registros: [registro('p1', 'auto-1'), canonico] }),
    ).toEqual({ tipo: 'um', registro: canonico });
  });

  it('⚠️ two non-canonical records are ambiguous — even with a canonical id of ANOTHER depósito', () => {
    expect(
      estoqueNoDepositoLi({
        ...base,
        registros: [registro('p1', 'auto-1'), registro('p1', 'est-p1-dep2')],
      }),
    ).toEqual({ tipo: 'ambiguo' });
  });

  it('the same path read twice counts once', () => {
    const a = registro('p1', 'auto-1');
    expect(estoqueNoDepositoLi({ ...base, registros: [a, a] }).tipo).toBe('um');
  });

  it('a record of another produto is a bug', () => {
    expect(() => estoqueNoDepositoLi({ ...base, registros: [registro('p2', 'x')] })).toThrow(
      RangeError,
    );
  });

  it('⚠️ NEAR-MISS: the depósito is a BARE id — a ref there is a bug, never "ambiguous"', () => {
    const registros = [registro('p1', 'auto-1'), registro('p1', 'est-p1-dep1')];
    // As a ref, the canonical id would be `est-p1-documents/depositos/dep1`, which no document
    // can have: the pair would read `ambiguo` and the produto would be held for good.
    for (const depositoId of ['documents/depositos/dep1', 'depositos/dep1', '']) {
      expect(() => estoqueNoDepositoLi({ produtoId: 'p1', depositoId, registros })).toThrow(
        RangeError,
      );
    }
    expect(() => estoqueNoDepositoLi({ produtoId: '', depositoId: 'dep1', registros: [] })).toThrow(
      RangeError,
    );
    // The control: the bare id finds the canonical record.
    expect(estoqueNoDepositoLi({ produtoId: 'p1', depositoId: 'dep1', registros })).toEqual({
      tipo: 'um',
      registro: registro('p1', 'est-p1-dep1'),
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('planoEstoqueLi: the run’s plan', () => {
  const CONTA = 'C1';
  const ID = 123456789;
  const filho = (extra: Record<string, unknown> = {}) => ({
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: ID,
    paiProdutoIntegradaId: 7654321,
    sku: 'SKU-1',
    ...extra,
  });
  const raiz = (extra: Record<string, unknown> = {}) => ({
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: 7654321,
    paiProdutoIntegradaId: null,
    sku: 'SKU-PAI',
    ...extra,
  });
  const entrada = (e: Partial<EntradaPlanoEstoqueLi> = {}): EntradaPlanoEstoqueLi => ({
    contaId: CONTA,
    produtoId: 'p1',
    depositoId: 'dep1',
    produto: {},
    links: [filho()],
    estoque: { tipo: 'um', registro: registro('p1', 'est-p1-dep1', { quantidade: 7 }) },
    componentes: [],
    apagado: false,
    temEstoqueEmQualquerDeposito: null,
    duplicado: false,
    ...e,
  });

  it('a counting child link and a record ⇒ enviar S', () => {
    expect(planoEstoqueLi(entrada())).toEqual({
      tipo: 'enviar',
      idLi: '123456789',
      S: 7,
      kitNaoVerificavel: false,
    });
  });

  it('sem-vinculo: no link, another conta’s, one in the trash, an unreadable id', () => {
    for (const links of [
      [],
      [filho({ contaLojaIntegrada: 'documents/integracao/C2' })],
      [filho({ removido: true })],
      [filho({ id: '0123' })],
      ['não é objeto', null],
    ]) {
      expect(planoEstoqueLi(entrada({ links })).tipo).toBe('sem-vinculo');
    }
  });

  it('both stored ref forms of the conta count', () => {
    expect(
      planoEstoqueLi(entrada({ links: [filho({ contaLojaIntegrada: `integracao/${CONTA}` })] }))
        .tipo,
    ).toBe('enviar');
  });

  it('pai: only parent roots (grades listed); nao-suportado: a root with no grades', () => {
    expect(planoEstoqueLi(entrada({ links: [raiz({ grades: ['Cor'] })] })).tipo).toBe('pai');
    expect(planoEstoqueLi(entrada({ links: [raiz({ grades: null })] })).tipo).toBe('nao-suportado');
    expect(planoEstoqueLi(entrada({ links: [raiz({ grades: [] })] })).tipo).toBe('nao-suportado');
  });

  it('⚠️ NEAR-MISS: ANY root without grades is nao-suportado, even beside a parent root of the same id', () => {
    // Two documents of one store id (a number and its canonical text) that disagree on grades.
    expect(
      planoEstoqueLi(
        entrada({ links: [raiz({ grades: ['Cor'] }), raiz({ id: '7654321', grades: null })] }),
      ).tipo,
    ).toBe('nao-suportado');
  });

  it('⚠️ NEAR-MISS: a root whose paiProdutoIntegradaId is ABSENT is a root, never a child', () => {
    // The link schema defaults the field to `null`, so an absent stored value is a legal root;
    // read as a child, S would be PUT onto a parent's or a simple product's row.
    const semPai = (link: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(link).filter(([k]) => k !== 'paiProdutoIntegradaId'));
    expect(planoEstoqueLi(entrada({ links: [semPai(raiz({ grades: ['Cor'] }))] })).tipo).toBe(
      'pai',
    );
    expect(planoEstoqueLi(entrada({ links: [semPai(raiz({ grades: null }))] })).tipo).toBe(
      'nao-suportado',
    );
  });

  it('vinculo-ambiguo: child links naming two store ids', () => {
    expect(planoEstoqueLi(entrada({ links: [filho(), filho({ id: 999 })] })).tipo).toBe(
      'vinculo-ambiguo',
    );
  });

  it('⚠️ NEAR-MISS: a ROOT of the conta naming another store id beside the child is ambiguous too', () => {
    // One ERP produto holds one store product per conta: sending S to the child would silently
    // ignore the second mapping, whatever its kind.
    for (const outra of [raiz({ id: 999, grades: ['Cor'] }), raiz({ id: 999, grades: null })]) {
      expect(planoEstoqueLi(entrada({ links: [filho(), outra] })).tipo).toBe('vinculo-ambiguo');
    }
    expect(
      planoEstoqueLi(
        entrada({ links: [raiz({ grades: ['Cor'] }), raiz({ id: 999, grades: ['Cor'] })] }),
      ).tipo,
    ).toBe('vinculo-ambiguo');
    // The controls: another conta's root, or one in the trash, is not this conta's mapping.
    for (const outra of [
      raiz({ id: 999, contaLojaIntegrada: 'documents/integracao/C2' }),
      raiz({ id: 999, removido: true }),
    ]) {
      expect(planoEstoqueLi(entrada({ links: [filho(), outra] })).tipo).toBe('enviar');
    }
  });

  it('⚠️ NEAR-MISS: two documents of ONE store id — a number and its canonical text — are one product', () => {
    expect(planoEstoqueLi(entrada({ links: [filho(), filho({ id: String(ID) })] }))).toMatchObject({
      tipo: 'enviar',
      idLi: '123456789',
    });
  });

  it('vinculo-duplicado wins over everything below it', () => {
    expect(
      planoEstoqueLi(
        entrada({
          duplicado: true,
          produto: { statusProdutosMarketplace: { [`${CONTA}_${ID}`]: { enviarEstoque: false } } },
        }),
      ),
    ).toEqual({ tipo: 'vinculo-duplicado', idLi: '123456789' });
  });

  it('parity: exactly `false` skips; "false", absent, true and null send', () => {
    const comStatus = (enviarEstoque: unknown) =>
      planoEstoqueLi(
        entrada({
          produto: { statusProdutosMarketplace: { [`${CONTA}_${ID}`]: { enviarEstoque } } },
        }),
      ).tipo;
    expect(comStatus(false)).toBe('paridade');
    for (const v of ['false', undefined, true, null, 0]) expect(comStatus(v)).toBe('enviar');
    expect(
      planoEstoqueLi(
        entrada({ produto: { statusProdutosMarketplace: { [`${CONTA}_${ID}`]: {} } } }),
      ).tipo,
    ).toBe('enviar');
  });

  it('⚠️ NEAR-MISS parity: another conta’s or another store id’s entry, and an inherited key, send', () => {
    const status = (chave: string) => ({ [chave]: { enviarEstoque: false } });
    expect(envioDeEstoqueDesligadoLi(status(`C2_${ID}`), CONTA, String(ID))).toBe(false);
    expect(envioDeEstoqueDesligadoLi(status(`${CONTA}_999`), CONTA, String(ID))).toBe(false);
    const herdado = Object.create(status(`${CONTA}_${ID}`)) as Record<string, unknown>;
    expect(envioDeEstoqueDesligadoLi(herdado, CONTA, String(ID))).toBe(false);
    expect(envioDeEstoqueDesligadoLi(status(`${CONTA}_${ID}`), CONTA, String(ID))).toBe(true);
  });

  describe('the never-had-stock hold, read literally', () => {
    const semRegistro = { estoque: { tipo: 'nenhum' } as const };

    it('no record here, no delete as proof: the any-depósito fact is read only now', () => {
      expect(planoEstoqueLi(entrada(semRegistro))).toEqual({
        tipo: 'consultar-estoques',
        idLi: '123456789',
      });
    });

    it('no record anywhere ⇒ retido: the store keeps its own number', () => {
      expect(
        planoEstoqueLi(entrada({ ...semRegistro, temEstoqueEmQualquerDeposito: false })).tipo,
      ).toBe('retido');
    });

    it('⚠️ NEAR-MISS: a record at ANOTHER depósito ⇒ push this depósito’s real 0', () => {
      expect(
        planoEstoqueLi(entrada({ ...semRegistro, temEstoqueEmQualquerDeposito: true })),
      ).toMatchObject({ tipo: 'enviar', S: 0 });
    });

    it('⚠️ NEAR-MISS: the delete of the last record is proof one existed ⇒ 0, with no read', () => {
      expect(planoEstoqueLi(entrada({ ...semRegistro, apagado: true }))).toMatchObject({
        tipo: 'enviar',
        S: 0,
      });
    });

    it('a record here never asks', () => {
      expect(planoEstoqueLi(entrada()).tipo).toBe('enviar');
    });

    it('a CONSTRAINED kit is exempt: sent from its components, never held, never asks', () => {
      const kit = { ehKit: true, componentesKit: componentes({ blank: 2 }) };
      expect(kitRestritoLi(kit)).toBe(true);
      expect(
        planoEstoqueLi(
          entrada({
            ...semRegistro,
            produto: kit,
            componentes: [registro('blank', 'est-blank-dep1', { quantidade: 9 })],
          }),
        ),
      ).toMatchObject({ tipo: 'enviar', S: 4 });
    });

    it('⚠️ NEAR-MISS: a constrained VIRTUAL kit with no own record is exempt too', () => {
      // A virtual kit usually has no own record at all: keyed on `ehKit` alone, it would be held
      // and its components' stock never sent.
      const kit = { ehKitVirtual: true, componentesKit: componentes({ blank: 3 }) };
      expect(kitRestritoLi(kit)).toBe(true);
      expect(
        planoEstoqueLi(
          entrada({
            ...semRegistro,
            temEstoqueEmQualquerDeposito: false,
            produto: kit,
            componentes: [registro('blank', 'est-blank-dep1', { quantidade: 10 })],
          }),
        ),
      ).toMatchObject({ tipo: 'enviar', S: 3 });
    });

    it('⚠️ NEAR-MISS: an UNCONSTRAINED kit is like a non-kit (its own record feeds S)', () => {
      const kit = { ehKit: true, componentesKit: {} };
      expect(kitRestritoLi(kit)).toBe(false);
      expect(planoEstoqueLi(entrada({ ...semRegistro, produto: kit })).tipo).toBe(
        'consultar-estoques',
      );
    });

    it('parity outranks the hold', () => {
      expect(
        planoEstoqueLi(
          entrada({
            ...semRegistro,
            temEstoqueEmQualquerDeposito: false,
            produto: {
              statusProdutosMarketplace: { [`${CONTA}_${ID}`]: { enviarEstoque: false } },
            },
          }),
        ).tipo,
      ).toBe('paridade');
    });
  });

  it('estoque-ambiguo for a produto whose own record feeds S; ignored for a constrained kit', () => {
    expect(planoEstoqueLi(entrada({ estoque: { tipo: 'ambiguo' } })).tipo).toBe('estoque-ambiguo');
    expect(
      planoEstoqueLi(
        entrada({
          estoque: { tipo: 'ambiguo' },
          produto: { ehKit: true, componentesKit: componentes({ blank: 1 }) },
          componentes: [registro('blank', 'est-blank-dep1', { quantidade: 3 })],
        }),
      ),
    ).toMatchObject({ tipo: 'enviar', S: 3 });
  });

  it('a kit none of whose constraining components resolved ⇒ S = 0 and the warning flag', () => {
    expect(
      planoEstoqueLi(
        entrada({ produto: { ehKit: true, componentesKit: componentes({ blank: 1, print: 1 }) } }),
      ),
    ).toEqual({ tipo: 'enviar', idLi: '123456789', S: 0, kitNaoVerificavel: true });
  });

  it('a VIRTUAL kit is sent from its components', () => {
    expect(
      planoEstoqueLi(
        entrada({
          produto: { ehKitVirtual: true, componentesKit: componentes({ blank: 3 }) },
          componentes: [registro('blank', 'est-blank-dep1', { quantidade: 10 })],
        }),
      ),
    ).toMatchObject({ tipo: 'enviar', S: 3, kitNaoVerificavel: false });
  });

  describe('a kit component with more than one record at the depósito', () => {
    const kit = { ehKit: true, componentesKit: componentes({ blank: 1 }) };
    const canonico = registro('blank', 'est-blank-dep1', { quantidade: 3 });
    const legado = registro('blank', 'auto-1', { quantidade: 9 });
    const outroLegado = registro('blank', 'auto-2', { quantidade: 9 });

    it('the canonical record wins in EITHER order: S = 3, never the legacy 9', () => {
      // Handed to the core raw, the last record of the component would win: 9 in one order,
      // 3 in the other — an oversell decided by a query's row order.
      for (const comps of [
        [canonico, legado],
        [legado, canonico],
      ]) {
        expect(planoEstoqueLi(entrada({ produto: kit, componentes: comps }))).toMatchObject({
          tipo: 'enviar',
          S: 3,
        });
      }
    });

    it('⚠️ NEAR-MISS: two non-canonical records of a constraining component ⇒ estoque-ambiguo, in either order', () => {
      for (const comps of [
        [legado, outroLegado],
        [outroLegado, legado],
      ]) {
        expect(planoEstoqueLi(entrada({ produto: kit, componentes: comps }))).toEqual({
          tipo: 'estoque-ambiguo',
          idLi: '123456789',
        });
      }
    });

    it('an ambiguous component that does not constrain the kit decides nothing', () => {
      const produto = {
        ehKit: true,
        componentesKit: {
          ...componentes({ blank: 1 }),
          tag: { quantidade: 1, limitarEstoque: false, timestamp: null },
        },
      };
      expect(
        planoEstoqueLi(
          entrada({
            produto,
            componentes: [canonico, registro('tag', 'auto-1'), registro('tag', 'auto-2')],
          }),
        ),
      ).toMatchObject({ tipo: 'enviar', S: 3 });
    });

    it('the same record read twice is one record', () => {
      expect(
        planoEstoqueLi(entrada({ produto: kit, componentes: [legado, legado] })),
      ).toMatchObject({ tipo: 'enviar', S: 9 });
    });

    it('the depósito is a bare id here too — for a kit, and for a produto with no component', () => {
      expect(() =>
        planoEstoqueLi(
          entrada({
            produto: kit,
            componentes: [canonico],
            depositoId: 'documents/depositos/dep1',
          }),
        ),
      ).toThrow(RangeError);
      expect(() => planoEstoqueLi(entrada({ depositoId: 'depositos/dep1' }))).toThrow(RangeError);
    });
  });
});

/* -------------------------------------------------------------------------- */

/** One kit inline in a component's header; `comps` = component → its record id (or null). */
function cabecalho(
  q: Record<string, number>,
  comps: Record<string, string | null>,
  kitId = 'kit-1',
): CabecalhoKitsLi {
  return {
    qMax: Math.max(...Object.values(q)),
    comps,
    kits: { [kitId]: { i: '123456789', q } },
  };
}

describe('kits, at most 30 per component: the tie-inclusive, fail-open filter', () => {
  const comps = { blank: 'est-blank-dep1', print: 'est-print-dep1' };

  it('⚠️ THE NEAR-MISS: blank and print both 5 → 4 in ONE commit (a kit sale)', () => {
    const q = { blank: 1, print: 1 };
    // Each event is handled after the commit, so each sees the OTHER component already at 4.
    const eventoBlank = { componenteId: 'blank', antes: 5, depois: 4, outro: 4 };
    const eventoPrint = { componenteId: 'print', antes: 5, depois: 4, outro: 4 };

    // The rejected rule, "K(before) ≠ K(after)": min(5, 4) = 4 → min(4, 4) = 4 — both skip, and
    // the kit, which went 5 → 4, keeps advertising 5.
    const kMudou = (e: typeof eventoBlank) =>
      Math.min(e.antes, e.outro) !== Math.min(e.depois, e.outro);
    expect(kMudou(eventoBlank)).toBe(false);
    expect(kMudou(eventoPrint)).toBe(false);

    // The tie rule flags both.
    for (const e of [eventoBlank, eventoPrint]) {
      expect(
        kitSinalizadoLi({
          kit: { q },
          componenteId: e.componenteId,
          antes: e.antes,
          depois: e.depois,
          cap: SEM_TETO,
          disponivelDe: () => e.outro,
        }),
      ).toBe(true);
      expect(
        kitsSinalizadosLi({
          cabecalho: cabecalho(q, comps),
          componenteId: e.componenteId,
          antes: e.antes,
          depois: e.depois,
          cap: SEM_TETO,
          leituras: new Map([
            [caminho('blank', 'est-blank-dep1'), e.outro],
            [caminho('print', 'est-print-dep1'), e.outro],
          ]),
        }),
      ).toEqual(['kit-1']);
    }
  });

  it('a sibling strictly below both sides holds the kit: no flag', () => {
    expect(
      kitSinalizadoLi({
        kit: { q: { blank: 1, print: 1 } },
        componenteId: 'blank',
        antes: 9,
        depois: 8,
        cap: SEM_TETO,
        disponivelDe: () => 3,
      }),
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS: a RISING bottleneck flags — the before side bounds it, not the after side', () => {
    // blank 3 → 5 beside print at 4: the kit goes min(3, 4) = 3 → min(5, 4) = 4. An after-only
    // rule reads 5 > 4 and skips the rise; the minimum of both sides reads 3 ≤ 4 and flags.
    const subir = (antes: number, depois: number) =>
      kitSinalizadoLi({
        kit: { q: { blank: 1, print: 1 } },
        componenteId: 'blank',
        antes,
        depois,
        cap: SEM_TETO,
        disponivelDe: () => 4,
      });
    expect(subir(3, 5)).toBe(true);
    // The control: a rise wholly above the sibling moves nothing.
    expect(subir(6, 9)).toBe(false);
  });

  it('the cap is a pseudo-component: 9 → 8 under a cap of 5 moves nothing; 9 → 4 does', () => {
    const avaliar = (depois: number) =>
      kitSinalizadoLi({
        kit: { q: { blank: 1, print: 1 } },
        componenteId: 'blank',
        antes: 9,
        depois,
        cap: 5,
        disponivelDe: () => 20,
      });
    expect(avaliar(8)).toBe(false);
    expect(avaliar(4)).toBe(true);
    expect(avaliar(5)).toBe(true); // a tie with the cap counts
  });

  it('an unknown sibling flags: no record id, not read (gone, another depósito), unreadable', () => {
    const q = { blank: 1, print: 1 };
    const evento = { componenteId: 'blank', antes: 9, depois: 8, cap: SEM_TETO };
    expect(
      kitsSinalizadosLi({
        ...evento,
        cabecalho: cabecalho(q, { blank: 'est-blank-dep1', print: null }),
        leituras: new Map(),
      }),
    ).toEqual(['kit-1']);
    expect(
      kitsSinalizadosLi({ ...evento, cabecalho: cabecalho(q, comps), leituras: new Map() }),
    ).toEqual(['kit-1']);
    expect(
      kitsSinalizadosLi({
        ...evento,
        cabecalho: cabecalho(q, comps),
        leituras: new Map([[caminho('print', 'est-print-dep1'), Number.NaN]]),
      }),
    ).toEqual(['kit-1']);
    // NEAR-MISS: the same sibling READ, and low, holds the kit.
    expect(
      kitsSinalizadosLi({
        ...evento,
        cabecalho: cabecalho(q, comps),
        leituras: new Map([[caminho('print', 'est-print-dep1'), 3]]),
      }),
    ).toEqual([]);
  });

  it('⚠️ NEAR-MISS: an unknown sibling flags even where a KNOWN low sibling would hold the kit', () => {
    // Dropped from the minimum instead, the unknown one would leave tag at 3 bounding the kit,
    // and 8 against 3 does not flag. The module flags whatever it cannot read.
    const q = { blank: 1, print: 1, tag: 1 };
    const evento = { componenteId: 'blank', antes: 9, depois: 8, cap: SEM_TETO };
    const todos = { blank: 'est-blank-dep1', print: 'est-print-dep1', tag: 'est-tag-dep1' };
    const soTag = new Map([[caminho('tag', 'est-tag-dep1'), 3]]);
    expect(
      kitsSinalizadosLi({
        ...evento,
        cabecalho: cabecalho(q, { ...todos, print: null }),
        leituras: soTag,
      }),
    ).toEqual(['kit-1']);
    expect(
      kitsSinalizadosLi({ ...evento, cabecalho: cabecalho(q, todos), leituras: soTag }),
    ).toEqual(['kit-1']);
    expect(
      kitSinalizadoLi({
        ...evento,
        kit: { q: { blank: 1, print: -1, tag: 1 } },
        disponivelDe: (c) => (c === 'tag' ? 3 : 9),
      }),
    ).toBe(true);
    // The control: every sibling read, tag at 3 holds the kit.
    expect(
      kitsSinalizadosLi({
        ...evento,
        cabecalho: cabecalho(q, todos),
        leituras: new Map([
          [caminho('print', 'est-print-dep1'), 9],
          [caminho('tag', 'est-tag-dep1'), 3],
        ]),
      }),
    ).toEqual([]);
  });

  it('a kit that does not list the component, or with an unreadable quantity, flags', () => {
    const evento = { antes: 9, depois: 8, cap: SEM_TETO, disponivelDe: () => 0 };
    expect(kitSinalizadoLi({ ...evento, kit: { q: { print: 1 } }, componenteId: 'blank' })).toBe(
      true,
    );
    expect(
      kitSinalizadoLi({ ...evento, kit: { q: { blank: 0, print: 1 } }, componenteId: 'blank' }),
    ).toBe(true);
    expect(
      kitSinalizadoLi({ ...evento, kit: { q: { blank: 1, print: -1 } }, componenteId: 'blank' }),
    ).toBe(true);
  });

  it('an unreadable side of the event flags; a missing side is the record’s absence (0)', () => {
    const base = { kit: { q: { blank: 1, print: 1 } }, componenteId: 'blank', cap: SEM_TETO };
    expect(kitSinalizadoLi({ ...base, antes: Number.NaN, depois: 8, disponivelDe: () => 3 })).toBe(
      true,
    );
    // A delete (after = no record = 0) beside a sibling at 3: the kit falls to 0.
    expect(kitSinalizadoLi({ ...base, antes: 9, depois: null, disponivelDe: () => 3 })).toBe(true);
    // A create (before = 0) beside a sibling at −1: min(0, 9) = 0 > −1, nothing moves.
    expect(kitSinalizadoLi({ ...base, antes: null, depois: 9, disponivelDe: () => -1 })).toBe(
      false,
    );
  });

  it('⚠️ a fractional quantity divides the RAW available, as the core does', () => {
    const base = {
      kit: { q: { blank: 0.5, print: 1 } },
      componenteId: 'blank',
      cap: SEM_TETO,
    };
    // 2.9 → 2.6 at 0.5 is ⌊5.8⌋ → ⌊5.2⌋ = 5 → 5 beside a sibling at 4: the kit stays 4.
    // Flooring the available first would read ⌊2.9⌋ / 0.5 = 4 and flag needlessly.
    expect(kitSinalizadoLi({ ...base, antes: 2.9, depois: 2.6, disponivelDe: () => 4 })).toBe(
      false,
    );
    // 2.6 → 2.4 is 5 → 4 beside a sibling at 5: the kit goes 5 → 4, flagged.
    expect(kitSinalizadoLi({ ...base, antes: 2.6, depois: 2.4, disponivelDe: () => 5 })).toBe(true);
  });

  it('several kits: only the flagged ones, sorted', () => {
    const header: CabecalhoKitsLi = {
      qMax: 2,
      comps: { blank: 'e-b', print: 'e-p', tag: 'e-t' },
      kits: {
        'kit-z': { i: '3', q: { blank: 1, print: 1 } },
        'kit-a': { i: '1', q: { blank: 2, tag: 1 } },
        'kit-m': { i: '2', q: { blank: 1, tag: 1 } },
      },
    };
    expect(
      kitsSinalizadosLi({
        cabecalho: header,
        componenteId: 'blank',
        antes: 6,
        depois: 5,
        cap: SEM_TETO,
        leituras: new Map([
          [caminho('print', 'e-p'), 9],
          [caminho('tag', 'e-t'), 2],
        ]),
      }),
    ).toEqual(['kit-a', 'kit-z']); // kit-a: min(3, 2) = 2 ≤ 2; kit-m: 5 > 2; kit-z: 5 ≤ 9
  });

  it('a header whose kits live in shards is refused (that component takes the zero-crossing path)', () => {
    expect(() =>
      kitsSinalizadosLi({
        cabecalho: { qMax: 1, comps: {}, kits: null },
        componenteId: 'blank',
        antes: 1,
        depois: 0,
        cap: SEM_TETO,
        leituras: new Map(),
      }),
    ).toThrow(RangeError);
  });
});

describe('irmaosParaLerLi: what the filter reads, and the zero-cost skip', () => {
  const header: CabecalhoKitsLi = {
    qMax: 2,
    comps: { blank: 'e-b', print: 'e-p', tag: 'e-t', sem: null },
    kits: {
      k1: { i: '1', q: { blank: 2, print: 1, sem: 1 } },
      k2: { i: '2', q: { blank: 1, tag: 1 } },
    },
  };
  const lidos = [caminho('print', 'e-p'), caminho('tag', 'e-t')];

  it('every OTHER component’s record PATH, sorted; a null id is not read', () => {
    expect(
      irmaosParaLerLi({
        cabecalho: header,
        componenteId: 'blank',
        antes: 6,
        depois: 5,
        cap: SEM_TETO,
      }),
    ).toEqual(lidos);
  });

  it('⚠️ min(before, after) / qMax above the cap ⇒ 0 sibling reads, and nothing is flagged', () => {
    const evento = { componenteId: 'blank', antes: 20, depois: 18, cap: 5 };
    expect(irmaosParaLerLi({ ...evento, cabecalho: header })).toEqual([]);
    expect(
      kitsSinalizadosLi({
        ...evento,
        cabecalho: header,
        leituras: new Map(), // nothing read — and the unknown siblings do not flag either
      }),
    ).toEqual([]);
  });

  it('⚠️ NEAR-MISS: at the cap (⌊18 / 2⌋ = 9 with a cap of 9) the siblings ARE read', () => {
    expect(
      irmaosParaLerLi({ cabecalho: header, componenteId: 'blank', antes: 20, depois: 18, cap: 9 }),
    ).toEqual(lidos);
    expect(
      irmaosParaLerLi({
        cabecalho: header,
        componenteId: 'blank',
        antes: 20,
        depois: 18,
        cap: SEM_TETO,
      }),
    ).toEqual(lidos);
  });

  it('⚠️ NEAR-MISS: two components whose records share a doc id are TWO reads, never one', () => {
    // A record id is unique only under its owner: produtos/print/estoques/X and
    // produtos/laco/estoques/X are two documents. Keyed by the bare id, print's 2 would stand in
    // for laco's 20, and the kit (laco-bound, 9 → 8) would go unflagged.
    const dupla: CabecalhoKitsLi = {
      qMax: 1,
      comps: { blank: 'b1', print: 'X', laco: 'X' },
      kits: {
        K: { i: '1', q: { blank: 1, laco: 1 } },
        K2: { i: '2', q: { blank: 1, print: 1 } },
      },
    };
    const evento = { cabecalho: dupla, componenteId: 'blank', antes: 9, depois: 8, cap: SEM_TETO };
    expect(irmaosParaLerLi(evento)).toEqual([caminho('laco', 'X'), caminho('print', 'X')]);
    expect(
      kitsSinalizadosLi({
        ...evento,
        leituras: new Map([
          [caminho('print', 'X'), 2],
          [caminho('laco', 'X'), 20],
        ]),
      }),
    ).toEqual(['K']); // K: 8 ≤ laco 20; K2: 8 > print 2
  });

  it('⚠️ NEAR-MISS: a stored qMax BELOW a kit’s quantity never lets the skip hide that kit', () => {
    // K needs 2 blanks; the header claims 1. Trusting it, ⌊3 / 1⌋ = 3 > cap 2 would skip, while
    // K goes min(⌊4 / 2⌋, 5, 2) = 2 → min(⌊3 / 2⌋, 5, 2) = 1.
    const baixo: CabecalhoKitsLi = {
      qMax: 1,
      comps: { blank: 'b', print: 'p' },
      kits: { K: { i: '1', q: { blank: 2, print: 1 } } },
    };
    const evento = { cabecalho: baixo, componenteId: 'blank', antes: 4, depois: 3, cap: 2 };
    expect(irmaosParaLerLi(evento)).toEqual([caminho('print', 'p')]);
    expect(
      kitsSinalizadosLi({ ...evento, leituras: new Map([[caminho('print', 'p'), 5]]) }),
    ).toEqual(['K']);
    // The control: with the header right (qMax 2) the same event is read and flagged alike, and
    // a higher stock (20 → 18, ⌊18 / 2⌋ = 9 > 2) is skipped.
    expect(irmaosParaLerLi({ ...evento, cabecalho: { ...baixo, qMax: 2 } })).toEqual([
      caminho('print', 'p'),
    ]);
    expect(irmaosParaLerLi({ ...evento, antes: 20, depois: 18 })).toEqual([]);
  });

  it('a kit that does not list the component never lets the skip apply (it flags)', () => {
    const torto: CabecalhoKitsLi = {
      qMax: 1,
      comps: { blank: 'b', print: 'p' },
      kits: { K: { i: '1', q: { print: 1 } } },
    };
    const evento = { cabecalho: torto, componenteId: 'blank', antes: 50, depois: 40, cap: 2 };
    expect(irmaosParaLerLi(evento)).toEqual([caminho('print', 'p')]);
    expect(kitsSinalizadosLi({ ...evento, leituras: new Map() })).toEqual(['K']);
  });

  it('a header whose kits live in shards is refused here too', () => {
    expect(() =>
      irmaosParaLerLi({
        cabecalho: { qMax: 1, comps: {}, kits: null },
        componenteId: 'blank',
        antes: 1,
        depois: 0,
        cap: SEM_TETO,
      }),
    ).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */

describe('kits beyond 30: only a positive → 0 crossing is sent at once', () => {
  it.each([
    [1, 0, 1, true],
    [5, -2, 1, true],
    [3, 1, 2, true], // the component still shows 1, the kit that needs 2 is out
    [2, 1, 1, false],
    [0, 0, 1, false],
    [0, 1, 1, false],
    [-1, 0, 1, false],
    [4, 7, 2, false],
    [1.5, 0.9, 1, true],
  ])('%j → %j at q %j crosses: %j', (antes, depois, q, esperado) => {
    expect(cruzaParaZeroLi(antes, depois, q)).toBe(esperado);
  });

  it('a create never crosses; a delete of a positive record does', () => {
    expect(cruzaParaZeroLi(null, 5, 1)).toBe(false);
    expect(cruzaParaZeroLi(5, null, 1)).toBe(true);
  });

  it('an unreadable side or kit quantity fires (over-advertising cannot wait)', () => {
    expect(cruzaParaZeroLi(Number.NaN, 0, 1)).toBe(true);
    expect(cruzaParaZeroLi(1, 0, 0)).toBe(true);
    expect(disparaKitsZeradosLi({ antes: 5, depois: Number.NaN, qMax: 2 })).toBe(true);
  });

  it('the header decision fires iff before > 0, after < before and after < qMax', () => {
    expect(disparaKitsZeradosLi({ antes: 3, depois: 1, qMax: 2 })).toBe(true);
    expect(disparaKitsZeradosLi({ antes: 9, depois: 5, qMax: 2 })).toBe(false);
    expect(disparaKitsZeradosLi({ antes: 0, depois: 0, qMax: 2 })).toBe(false);
    expect(disparaKitsZeradosLi({ antes: 0, depois: 1, qMax: 2 })).toBe(false);
    expect(disparaKitsZeradosLi({ antes: 1, depois: 1, qMax: 2 })).toBe(false);
  });

  it('⚠️ NEAR-MISS: a component already at or below 0 that falls further fires NOTHING', () => {
    // No kit is positive before, so none can cross; firing here would fan a paced store read out
    // over every kit of an oversold component on each further sale.
    expect(disparaKitsZeradosLi({ antes: 0, depois: -1, qMax: 2 })).toBe(false);
    expect(disparaKitsZeradosLi({ antes: -1, depois: -3, qMax: 2 })).toBe(false);
    expect(disparaKitsZeradosLi({ antes: null, depois: -2, qMax: 2 })).toBe(false);
    // The control: from a positive start the same fall fires.
    expect(disparaKitsZeradosLi({ antes: 1, depois: -1, qMax: 2 })).toBe(true);
  });

  it('⚠️ NEAR-MISS: after == qMax keeps every quotient at 1 or more — no fire; just below fires', () => {
    expect(disparaKitsZeradosLi({ antes: 5, depois: 2, qMax: 2 })).toBe(false);
    expect(disparaKitsZeradosLi({ antes: 5, depois: 1.5, qMax: 2 })).toBe(true);
  });

  it('PROPERTY: the header decision is a superset of every kit’s own crossing', () => {
    let rnd = 0x2a;
    const proximo = () => {
      rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0;
      return rnd / 2 ** 32;
    };
    const qs = [0.5, 1, 1, 2, 3, 1.5, 4];
    let cruzou = 0;
    for (let n = 0; n < 5000; n++) {
      const antes = Math.floor(proximo() * 12) - 2;
      const depois = Math.floor(proximo() * 12) - 2;
      const kits = qs.filter(() => proximo() < 0.5);
      if (kits.length === 0) continue;
      const algum = kits.some((q) => cruzaParaZeroLi(antes, depois, q));
      if (algum) {
        cruzou++;
        expect(disparaKitsZeradosLi({ antes, depois, qMax: Math.max(...kits) })).toBe(true);
      }
    }
    expect(cruzou).toBeGreaterThan(100);
  });
});

/* -------------------------------------------------------------------------- */

describe('diffLinhaEstoqueLi: the reconcile’s verdict on one store row', () => {
  const v = (s: number, p = 'p1'): EntradaSnapshotEstoqueLi => ({
    p,
    s,
    f: FLAG_ENTRADA_ESTOQUE_LI.valido,
  });
  const diff = (
    l: EstoqueNaLojaLi,
    entrada: EntradaSnapshotEstoqueLi | undefined,
    cap = SEM_TETO,
  ) => diffLinhaEstoqueLi({ idLi: '123456789', linha: l, entrada, cap });

  it('no entry ⇒ the link lookup; a non-sendable entry ⇒ counted, never a candidate', () => {
    expect(diff(linha(1), undefined)).toEqual({ tipo: 'sem-entrada' });
    const F = FLAG_ENTRADA_ESTOQUE_LI;
    const flags: FlagEntradaEstoqueLi[] = [
      F.retido,
      F.paridade,
      F.ambiguo,
      F.duplicado,
      F.naoSuportado,
    ];
    for (const f of flags) {
      expect(diff(linha(1), { p: 'p1', s: null, f })).toEqual({ tipo: 'nao-enviavel', flag: f });
    }
    expect(diff(linha(1), { p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo })).toEqual({
      tipo: 'nao-enviavel',
      flag: 'x',
    });
  });

  it('in sync: managed, situações (0, −1), quantidade − max(0, R) = S', () => {
    expect(diff(linha(12, 2), v(10))).toEqual({ tipo: 'em-dia' });
  });

  it('⚠️ NEAR-MISS: R = −3 is no reservation — 10 shown is S = 10, never S = 13', () => {
    expect(diff(linha(10, -3), v(10))).toEqual({ tipo: 'em-dia' });
    expect(diff(linha(10, -3), v(13))).toEqual({
      tipo: 'candidato',
      idLi: '123456789',
      produtoId: 'p1',
      delta: -3,
    });
  });

  it('⚠️ a `gerenciado: false` all-zero row is a candidate, sorted first (unbounded)', () => {
    const naoGerenciada = {
      gerenciado: false,
      quantidade: 0,
      quantidade_reservada: 0,
      situacao_em_estoque: 0,
      situacao_sem_estoque: 0,
    };
    expect(diff(naoGerenciada, v(0))).toEqual({
      tipo: 'candidato',
      idLi: '123456789',
      produtoId: 'p1',
      delta: DELTA_SEM_LIMITE_LI,
    });
  });

  it('⚠️ NEAR-MISS: `gerenciado` decides unbounded on its own — false or "true" beside situações (0, −1)', () => {
    expect(diff(linha(5, 0, { gerenciado: false }), v(5))).toMatchObject({
      tipo: 'candidato',
      delta: DELTA_SEM_LIMITE_LI,
    });
    expect(diff(linha(5, 0, { gerenciado: 'true' }), v(5))).toMatchObject({
      delta: DELTA_SEM_LIMITE_LI,
    });
    // The control: managed, the same numbers ⇒ in sync.
    expect(diff(linha(5, 0), v(5))).toEqual({ tipo: 'em-dia' });
  });

  it('a row still purchasable at zero is unbounded too; a lead time alone is a bounded candidate', () => {
    expect(diff(linha(5, 0, { situacao_sem_estoque: 0 }), v(5))).toMatchObject({
      delta: DELTA_SEM_LIMITE_LI,
    });
    expect(diff(linha(5, 0, { situacao_em_estoque: 3 }), v(5))).toMatchObject({
      tipo: 'candidato',
      delta: 0,
    });
  });

  it('a negative row is a candidate (under-advertising)', () => {
    expect(diff(linha(-2, 0), v(0))).toMatchObject({ tipo: 'candidato', delta: -2 });
  });

  it('an unreadable reservation or quantity is a candidate, unbounded', () => {
    expect(diff(linha(5, 0, { quantidade_reservada: 1.5 }), v(5))).toMatchObject({
      delta: DELTA_SEM_LIMITE_LI,
    });
    expect(diff(linha(5, 0, { quantidade: '5' }), v(5))).toMatchObject({
      delta: DELTA_SEM_LIMITE_LI,
    });
  });

  it('⚠️ a cap change moves verdicts from the snapshot alone — no ERP read exists to make', () => {
    // The diff's inputs are the store row, the stored entry and the cap: nothing else is
    // reachable from it. Frozen, so a read is all it can do with them.
    const entradas = Object.freeze([v(3, 'pa'), v(8, 'pb'), v(40, 'pc')]);
    const linhas = Object.freeze([linha(3), linha(8), linha(40)]);
    const verdicts = (cap: number) =>
      entradas.map((e, n) =>
        diffLinhaEstoqueLi({ idLi: String(n + 1), linha: linhas[n] ?? {}, entrada: e, cap }),
      );
    expect(verdicts(SEM_TETO).map((d) => d.tipo)).toEqual(['em-dia', 'em-dia', 'em-dia']);
    expect(verdicts(5)).toEqual([
      { tipo: 'em-dia' },
      { tipo: 'candidato', idLi: '2', produtoId: 'pb', delta: 3 },
      { tipo: 'candidato', idLi: '3', produtoId: 'pc', delta: 35 },
    ]);
  });

  it('a `v` entry without S is a bug', () => {
    expect(() => diff(linha(1), { p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.valido })).toThrow(
      RangeError,
    );
  });
});

describe('ordenarCandidatosEstoqueLi: over-advertising first', () => {
  it('d descending (unbounded first, under-advertising last), then conta, store id, produto', () => {
    const c = (conta: number, i: string, d: number, p = 'p'): CandidatoReconcileEstoqueLi => ({
      c: conta,
      i,
      p,
      d,
    });
    const entrada = Object.freeze([
      c(0, '5', -4),
      c(1, '10', 3),
      c(0, '7', 0),
      c(1, '9', 3),
      c(0, '9', 3),
      c(0, '2', DELTA_SEM_LIMITE_LI),
      c(0, '9', 3, 'a'),
      c(0, '6', -1),
      c(0, '8', 12),
    ]);
    expect(ordenarCandidatosEstoqueLi(entrada)).toEqual([
      c(0, '2', DELTA_SEM_LIMITE_LI),
      c(0, '8', 12),
      c(0, '9', 3, 'a'),
      c(0, '9', 3),
      c(1, '9', 3),
      c(1, '10', 3), // 9 before 10: numeric order, not text order
      c(0, '7', 0),
      c(0, '6', -1),
      c(0, '5', -4),
    ]);
    expect(entrada[0]).toEqual(c(0, '5', -4)); // the input is untouched
  });
});
