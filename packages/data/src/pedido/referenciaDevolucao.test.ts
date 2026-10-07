import { describe, expect, it } from 'vitest';
import type { DfeReferenciadoItem } from '@delfrance/schemas';
import { createFakeDevolucaoPort } from './fakePort';
import { chaveFake, nfeAprovadaFake, type LinhaFake } from './procNFeFake';
import {
  lerNotasDeOrigem,
  notasDeOrigemDe,
  preencherReferenciasPendentes,
  referenciaCompleta,
  referenciarItensDaDevolucao,
  referenciasPendentes,
  type ItemParaReferenciar,
  type NotaDeOrigem,
} from './referenciaDevolucao';

const CH1 = chaveFake(1);
const CH2 = chaveFake(2);

/** A devolução line: product `sku`, price, and its line order. */
const linha = (
  sku: string | null,
  precoDeVenda = 10,
  ordem = 1,
  extra: Partial<ItemParaReferenciar> = {},
): ItemParaReferenciar => ({ sku, gtin: null, produtoUid: null, precoDeVenda, ordem, ...extra });

const nota = (chave: string, linhas: readonly LinhaFake[] | null): NotaDeOrigem =>
  notasDeOrigemDe([nfeAprovadaFake(chave, linhas)])[0]!;

const ref = (chaveAcesso: string, nItem: number | null): DfeReferenciadoItem => ({
  chaveAcesso,
  nItem,
});

describe('notasDeOrigemDe', () => {
  it('orders the approved NF-es latest first, by ultima_modificacao', () => {
    const notas = notasDeOrigemDe([
      nfeAprovadaFake(CH1, [{ cProd: 'A' }], 1_000),
      nfeAprovadaFake(CH2, [{ cProd: 'A' }], 2_000),
    ]);
    expect(notas.map((n) => n.chave)).toEqual([CH2, CH1]);
  });

  it('skips a doc whose chave is absent or fails the check digit', () => {
    const quebrada = `${CH1.slice(0, 43)}${(Number(CH1[43]) + 1) % 10}`;
    const notas = notasDeOrigemDe([
      { chave: null, xml_nfe_proc: null },
      nfeAprovadaFake(quebrada, [{ cProd: 'A' }]),
      nfeAprovadaFake(CH1, [{ cProd: 'A' }]),
    ]);
    expect(notas.map((n) => n.chave)).toEqual([CH1]);
  });

  it('keeps a nota with no proc XML, with null lines (a legacy aprovada without its XML)', () => {
    expect(notasDeOrigemDe([nfeAprovadaFake(CH1, null)])).toEqual([{ chave: CH1, itens: null }]);
  });

  it('lerNotasDeOrigem reads each origin through the port', async () => {
    const { port } = createFakeDevolucaoPort({
      nfesAprovadasByPedido: { o1: [nfeAprovadaFake(CH1, [{ cProd: 'A' }])] },
    });
    const porOrigem = await lerNotasDeOrigem(port, ['o1', 'o2']);
    expect(porOrigem.get('o1')?.map((n) => n.chave)).toEqual([CH1]);
    expect(porOrigem.get('o2')).toEqual([]);
  });
});

describe('referenciarItensDaDevolucao', () => {
  it('no approved NF-e → no reference at all', () => {
    expect(referenciarItensDaDevolucao([linha('A')], [])).toEqual([null]);
  });

  it("references the origin line carrying the item's sku, by its det nItem", () => {
    const notas = [nota(CH1, [{ cProd: 'X' }, { cProd: 'A' }])];
    expect(referenciarItensDaDevolucao([linha('A')], notas)).toEqual([ref(CH1, 2)]);
  });

  it('reads nItem from the XML, not from the position — a nota numbered out of order', () => {
    const notas = [
      nota(CH1, [
        { cProd: 'B', nItem: 7 },
        { cProd: 'A', nItem: 3 },
      ]),
    ];
    expect(referenciarItensDaDevolucao([linha('A'), linha('B')], notas)).toEqual([
      ref(CH1, 3),
      ref(CH1, 7),
    ]);
  });

  it("codes in PRIORITY order: the sku's line wins over a line coded by the item's gtin", () => {
    // Line 1 is ANOTHER product whose cProd happens to equal this item's gtin.
    const notas = [nota(CH1, [{ cProd: '7891234567890' }, { cProd: 'A' }])];
    const item = linha('A', 10, 1, { gtin: '7891234567890' });
    expect(referenciarItensDaDevolucao([item], notas)).toEqual([ref(CH1, 2)]);
  });

  it('a product whose sku lines are all taken never falls through to its gtin', () => {
    const notas = [nota(CH1, [{ cProd: 'A' }, { cProd: '789' }])];
    const itens = [linha('A', 10, 1), linha('A', 10, 2, { gtin: '789' })];
    expect(referenciarItensDaDevolucao(itens, notas)).toEqual([ref(CH1, 1), ref(CH1, null)]);
  });

  it('falls back to gtin, then to produtoUid — the legacy app coded cProd `sku ?? gtin ?? produtoUid`', () => {
    const notas = [nota(CH1, [{ cProd: 'uid-legacy' }, { cProd: '789' }])];
    const porGtin = linha(null, 10, 1, { gtin: '789' });
    const porUid = linha(null, 10, 2, { produtoUid: 'uid-legacy' });
    expect(referenciarItensDaDevolucao([porGtin, porUid], notas)).toEqual([
      ref(CH1, 2),
      ref(CH1, 1),
    ]);
  });

  it('matches a code longer than 60 by its first 60 characters (the legacy cut)', () => {
    const longo = `SKU-${'X'.repeat(70)}`;
    const notas = [nota(CH1, [{ cProd: longo.slice(0, 60) }])];
    expect(referenciarItensDaDevolucao([linha(longo)], notas)).toEqual([ref(CH1, 1)]);
  });

  it('decodes the XML side: a sku `A&B` matches the serialized `A&amp;B`', () => {
    const notas = [nota(CH1, [{ cProd: 'A&amp;B' }])];
    expect(referenciarItensDaDevolucao([linha('A&B')], notas)).toEqual([ref(CH1, 1)]);
  });

  it('NEAR-MISS: a code is compared EXACTLY — `a1` and `A1 ` are not `A1`', () => {
    const notas = [nota(CH1, [{ cProd: 'A1' }])];
    expect(referenciarItensDaDevolucao([linha('a1'), linha('A1 ', 10, 2)], notas)).toEqual([
      ref(CH1, null),
      ref(CH1, null),
    ]);
  });

  it('EQUAL PAIR: the same product at the same centavo — 10.004 is 10 — claims the line', () => {
    const notas = [
      nota(CH1, [
        { cProd: 'A', vUnCom: 10 },
        { cProd: 'A', vUnCom: 20 },
      ]),
    ];
    expect(referenciarItensDaDevolucao([linha('A', 10.004)], notas)).toEqual([ref(CH1, 1)]);
  });

  it('NEAR-MISS: one centavo apart is a different line — the line priced 50 claims the 50 det, even though it comes later', () => {
    const notas = [
      nota(CH1, [
        { cProd: 'A', vUnCom: 49.99 },
        { cProd: 'A', vUnCom: 50 },
      ]),
    ];
    expect(referenciarItensDaDevolucao([linha('A', 50)], notas)).toEqual([ref(CH1, 2)]);
  });

  it('LINE ORDER: two lines at the same price claim the origin lines in pedido order (ordem), not input order', () => {
    const notas = [
      nota(CH1, [
        { cProd: 'A', vUnCom: 10 },
        { cProd: 'A', vUnCom: 10 },
      ]),
    ];
    const segunda = linha('A', 10, 2);
    const primeira = linha('A', 10, 1);
    expect(referenciarItensDaDevolucao([segunda, primeira], notas)).toEqual([
      ref(CH1, 2),
      ref(CH1, 1),
    ]);
  });

  it('EDITED PRICE: a price matching no line of the product falls back to line order (Lucas, 2026-10-07)', () => {
    const notas = [
      nota(CH1, [
        { cProd: 'A', vUnCom: 40 },
        { cProd: 'A', vUnCom: 60 },
      ]),
    ];
    expect(referenciarItensDaDevolucao([linha('A', 50, 1), linha('A', 55, 2)], notas)).toEqual([
      ref(CH1, 1),
      ref(CH1, 2),
    ]);
  });

  it('claims each origin line at most once — a surplus line keeps the chave with nItem null (never 1072)', () => {
    const notas = [nota(CH1, [{ cProd: 'A' }])];
    expect(referenciarItensDaDevolucao([linha('A', 10, 1), linha('A', 10, 2)], notas)).toEqual([
      ref(CH1, 1),
      ref(CH1, null),
    ]);
  });

  it('a product the nota does not carry, or a nota without XML: the chave, nItem null — never a guess', () => {
    expect(referenciarItensDaDevolucao([linha('Z')], [nota(CH1, [{ cProd: 'A' }])])).toEqual([
      ref(CH1, null),
    ]);
    expect(referenciarItensDaDevolucao([linha('A')], [nota(CH1, null)])).toEqual([ref(CH1, null)]);
  });

  it('looks through every approved NF-e of the origin, latest first; an unplaced line keeps the LATEST chave', () => {
    const notas = notasDeOrigemDe([
      nfeAprovadaFake(CH1, [{ cProd: 'OLD' }], 1),
      nfeAprovadaFake(CH2, [{ cProd: 'NEW' }], 2),
    ]);
    expect(
      referenciarItensDaDevolucao([linha('OLD'), linha('NEW', 10, 2), linha('Z', 10, 3)], notas),
    ).toEqual([ref(CH1, 1), ref(CH2, 1), ref(CH2, null)]);
  });
});

describe('referenciarItensDaDevolucao — an unreadable nota is never skipped past', () => {
  it('the LATEST nota unreadable: an older nota carrying the product is not taken — chave of the latest, nItem null', () => {
    const notas = notasDeOrigemDe([
      nfeAprovadaFake(CH1, [{ cProd: 'A' }], 1),
      nfeAprovadaFake(CH2, null, 2),
    ]);
    expect(referenciarItensDaDevolucao([linha('A')], notas)).toEqual([ref(CH2, null)]);
  });
});

describe('referenciasPendentes', () => {
  it('counts every item without a chave AND an nItem', () => {
    expect(
      referenciasPendentes([
        { dfeReferenciado: ref(CH1, 1) },
        { dfeReferenciado: ref(CH1, null) },
        { dfeReferenciado: ref('', 1) },
        { dfeReferenciado: null },
        {},
      ]),
    ).toBe(4);
    expect(referenciaCompleta(ref(CH1, 1))).toBe(true);
  });
});

describe('preencherReferenciasPendentes (the Fiscal tab button)', () => {
  const porOrigem = (
    entradas: Record<string, readonly NotaDeOrigem[]>,
  ): ReadonlyMap<string, readonly NotaDeOrigem[]> => new Map(Object.entries(entradas));

  it('keeps a complete reference and counts its origin line as taken', () => {
    const notas = porOrigem({ o1: [nota(CH1, [{ cProd: 'A' }, { cProd: 'A' }])] });
    const itens = [
      { ...linha('A', 10, 1), dfeReferenciado: ref(CH1, 1) },
      { ...linha('A', 10, 2), dfeReferenciado: null },
    ];
    expect(preencherReferenciasPendentes(itens, notas)).toEqual([ref(CH1, 1), ref(CH1, 2)]);
  });

  it('fills from the ONE origin whose notas carry the product', () => {
    const notas = porOrigem({
      o1: [nota(CH1, [{ cProd: 'A' }])],
      o2: [nota(CH2, [{ cProd: 'B' }])],
    });
    expect(preencherReferenciasPendentes([linha('B'), linha('A', 10, 2)], notas)).toEqual([
      ref(CH2, 1),
      ref(CH1, 1),
    ]);
  });

  it('leaves the item as it was when TWO origins carry the product — never a guess between two notas', () => {
    const notas = porOrigem({
      o1: [nota(CH1, [{ cProd: 'A' }])],
      o2: [nota(CH2, [{ cProd: 'A' }])],
    });
    expect(preencherReferenciasPendentes([linha('A')], notas)).toEqual([null]);
  });

  it('NEAR-MISS: another origin whose nota is UNREADABLE makes a single readable hit ambiguous — left as it was', () => {
    const notas = porOrigem({
      o1: [nota(CH1, null)],
      o2: [nota(CH2, [{ cProd: 'A' }])],
    });
    expect(preencherReferenciasPendentes([linha('A')], notas)).toEqual([null]);
  });

  it('a typed chave without nItem looks only at THAT nota', () => {
    const notas = porOrigem({
      o1: [nota(CH1, [{ cProd: 'A' }])],
      o2: [nota(CH2, [{ cProd: 'X' }, { cProd: 'A' }])],
    });
    const itens = [{ ...linha('A'), dfeReferenciado: ref(CH2, null) }];
    expect(preencherReferenciasPendentes(itens, notas)).toEqual([ref(CH2, 2)]);
  });

  it('a product no nota carries, with a single origin: its latest chave, nItem null', () => {
    const notas = porOrigem({ o1: [nota(CH1, [{ cProd: 'A' }])] });
    expect(preencherReferenciasPendentes([linha('Z')], notas)).toEqual([ref(CH1, null)]);
  });
});
