/**
 * The family read model and THE quantity: the shared core under Amazon's
 * options, every component's produto from its path, and the row at the conta's
 * depósito.
 */
import { describe, expect, it } from 'vitest';
import { kitNaoVerificavel, quantidadeDoMembroCore } from '@delfrance/data/admin/estoque';
import { unidadeVendavelDaRaiz } from '@delfrance/data/admin/produtos';
import { REF_DEPOSITO_ESTOQUE_AMAZON_REGEX, makeEstoqueUid } from '@delfrance/schemas';

import {
  CAMPOS_LINHA_ESTOQUE_AMAZON,
  CAMPOS_UNIDADE_ESTOQUE_AMAZON,
  type DocEstoqueLidoAmazon,
  type UnidadeLidaEstoqueAmazon,
  formasRefDepositoEstoqueAmazon,
  linhaEstoqueNoDepositoAmazon,
  membroParaEstoqueAmazon,
  partesDoCaminhoEstoqueAmazon,
  quantidadeEstoqueAmazon,
} from './familiaEstoque';
import { opcoesEstoqueAmazon } from './opcoesEstoque';

const DEP = 'dep-1';
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;

/** An estoque row of `produtoId` with doc id `docId` (at the depósito, canonical form, by default). */
function linha(
  produtoId: string,
  docId: string,
  dados: Record<string, unknown> = {},
): DocEstoqueLidoAmazon {
  return {
    caminho: `produtos/${produtoId}/estoques/${docId}`,
    raw: { depositoOuterRef: CANONICA, ...dados },
  };
}

/** The row at the canonical id. */
function canonica(produtoId: string, dados: Record<string, unknown> = {}): DocEstoqueLidoAmazon {
  return linha(produtoId, makeEstoqueUid(produtoId, DEP), dados);
}

function unidade(id: string, raw: Record<string, unknown> = {}): UnidadeLidaEstoqueAmazon {
  return { id, raw };
}

function quantidade(
  u: UnidadeLidaEstoqueAmazon,
  estoque: DocEstoqueLidoAmazon | null,
  componentes: readonly DocEstoqueLidoAmazon[] = [],
): number {
  return quantidadeEstoqueAmazon(membroParaEstoqueAmazon(u, estoque, componentes));
}

/** A kit of 2× A and 1× B. */
const KIT_2A_1B = { A: { quantidade: 2 }, B: { quantidade: 1 } };

/** The kit with its own stock 3, A = 9, B = 5. */
function kit(
  extra: Record<string, unknown> = {},
  componentes: readonly DocEstoqueLidoAmazon[] = [
    canonica('A', { quantidade: 9, parentId: 'A' }),
    canonica('B', { quantidade: 5, parentId: 'B' }),
  ],
) {
  return quantidade(
    unidade('K', { ehKit: true, componentesKit: KIT_2A_1B, ...extra }),
    canonica('K', { quantidade: 3 }),
    componentes,
  );
}

describe('★ the quantity table (the shared core, Amazon options)', () => {
  it('a simple produto: 10 − reserved 3 ⇒ 7', () => {
    expect(
      quantidade(unidade('P'), canonica('P', { quantidade: 10, quantidadeReservada: 3 })),
    ).toBe(7);
  });

  it('a negative reservation is floored at 0 (reservaEfetiva): 10 − (−2) ⇒ 10, never 12', () => {
    expect(
      quantidade(unidade('P'), canonica('P', { quantidade: 10, quantidadeReservada: -2 })),
    ).toBe(10);
  });

  it('2.9 ⇒ 2 (floored)', () => {
    expect(quantidade(unidade('P'), canonica('P', { quantidade: 2.9 }))).toBe(2);
  });

  it('−3 ⇒ 0 (clamped)', () => {
    expect(quantidade(unidade('P'), canonica('P', { quantidade: -3 }))).toBe(0);
  });

  it('a kit of 2× A (A = 9) and 1× B (B = 5) ⇒ 4, its own 3 never added', () => {
    expect(kit()).toBe(4);
  });

  it('NEAR-MISS: the own-stock knob on would publish 7 for the same kit', () => {
    const membro = membroParaEstoqueAmazon(
      unidade('K', { ehKit: true, componentesKit: KIT_2A_1B }),
      canonica('K', { quantidade: 3 }),
      [canonica('A', { quantidade: 9 }), canonica('B', { quantidade: 5 })],
    );
    expect(
      quantidadeDoMembroCore(membro, {
        ...opcoesEstoqueAmazon(),
        incluirEstoqueProprioDoKit: true,
      }),
    ).toBe(7);
    expect(quantidadeEstoqueAmazon(membro)).toBe(4);
  });

  it('★ the same kit whose component rows carry parentId: null ⇒ still 4 (the produto comes from the PATH)', () => {
    expect(
      kit({}, [
        canonica('A', { quantidade: 9, parentId: null }),
        canonica('B', { quantidade: 5, parentId: null }),
      ]),
    ).toBe(4);
  });

  it('★ …and with no parentId at all ⇒ still 4', () => {
    expect(kit({}, [canonica('A', { quantidade: 9 }), canonica('B', { quantidade: 5 })])).toBe(4);
  });

  it('★ …and with a stored parentId naming ANOTHER produto ⇒ still 4: the path wins', () => {
    expect(
      kit({}, [
        canonica('A', { quantidade: 9, parentId: 'B' }),
        canonica('B', { quantidade: 5, parentId: 'A' }),
      ]),
    ).toBe(4);
  });

  it('NEAR-MISS: read verbatim, a parentId: null row would floor the kit to 0', () => {
    const verbatim = membroParaEstoqueAmazon(
      unidade('K', { ehKit: true, componentesKit: KIT_2A_1B }),
      canonica('K', { quantidade: 3 }),
      [],
    );
    const comLinhasCruas = {
      ...verbatim,
      componentEstoques: [
        { quantidade: 9, parentId: null },
        { quantidade: 5, parentId: null },
      ],
    };
    expect(quantidadeDoMembroCore(comLinhasCruas, opcoesEstoqueAmazon())).toBe(0);
  });

  it('a kit with a missing component (no row for B) ⇒ 0 (a missing component counts 0)', () => {
    expect(kit({}, [canonica('A', { quantidade: 9 })])).toBe(0);
  });

  it('a kit no component constrains (an empty or absent composition) ⇒ its own stock', () => {
    expect(kit({ componentesKit: {} })).toBe(3);
    expect(kit({ componentesKit: null })).toBe(3);
  });

  it('a kit the core cannot verify (no component row at all) ⇒ 0, never its own stock', () => {
    const membro = membroParaEstoqueAmazon(
      unidade('K', { ehKit: true, componentesKit: KIT_2A_1B }),
      canonica('K', { quantidade: 20 }),
      [],
    );
    expect(kitNaoVerificavel(membro)).toBe(true);
    expect(quantidadeEstoqueAmazon(membro)).toBe(0);
  });

  it('★ a virtual kit is computed as a kit ⇒ 4, never skipped', () => {
    expect(kit({ ehKitVirtual: true })).toBe(4);
  });

  it('★ …and so is a unit carrying ONLY the virtual flag (ehKit false or absent): both flags are read raw, the core ORs them', () => {
    expect(kit({ ehKit: false, ehKitVirtual: true })).toBe(4);
    expect(
      quantidade(
        unidade('K', { componentesKit: KIT_2A_1B, ehKitVirtual: true }),
        canonica('K', { quantidade: 3 }),
        [canonica('A', { quantidade: 9 }), canonica('B', { quantidade: 5 })],
      ),
    ).toBe(4);
    // NEAR-MISS: neither flag ⇒ its own stock.
    expect(kit({ ehKit: false })).toBe(3);
  });

  it('NEAR-MISS: with pularKitVirtual on, the core would answer null for it', () => {
    const membro = membroParaEstoqueAmazon(
      unidade('K', { ehKit: true, ehKitVirtual: true, componentesKit: KIT_2A_1B }),
      canonica('K', { quantidade: 3 }),
      [canonica('A', { quantidade: 9 }), canonica('B', { quantidade: 5 })],
    );
    expect(
      quantidadeDoMembroCore(membro, { ...opcoesEstoqueAmazon(), pularKitVirtual: true }),
    ).toBeNull();
    expect(quantidadeEstoqueAmazon(membro)).toBe(4);
  });

  it('NEAR-MISS: a ceiling of 0 would zero a produto that has 7', () => {
    const membro = membroParaEstoqueAmazon(
      unidade('P'),
      canonica('P', { quantidade: 10, quantidadeReservada: 3 }),
      [],
    );
    expect(quantidadeDoMembroCore(membro, { ...opcoesEstoqueAmazon(), estoqueMax: 0 })).toBe(0);
    expect(quantidadeEstoqueAmazon(membro)).toBe(7);
  });

  it('the core helper’s contract this module relies on: a family-of-one wrapper’s unit is its member, whose row is the one read', () => {
    const unidadeId = unidadeVendavelDaRaiz({
      ehKit: false,
      produtoId: 'W',
      familia: { id: 'W', paiId: null, filhoUnicoId: 'M' },
    });
    expect(unidadeId).toBe('M');
    const linhas: Record<string, DocEstoqueLidoAmazon> = {
      W: canonica('W', { quantidade: 50 }),
      M: canonica('M', { quantidade: 7 }),
    };
    expect(quantidade(unidade(unidadeId), linhas[unidadeId] ?? null)).toBe(7);
  });

  it('NEAR-MISS: a KIT wrapper of one stays on itself', () => {
    expect(
      unidadeVendavelDaRaiz({
        ehKit: true,
        produtoId: 'W',
        familia: { id: 'W', paiId: null, filhoUnicoId: 'M' },
      }),
    ).toBe('W');
  });

  it('no row at the depósito ⇒ 0', () => {
    const estoque = linhaEstoqueNoDepositoAmazon({
      produtoId: 'P',
      depositoId: DEP,
      canonica: null,
      particao: [
        linha('P', 'outro', { depositoOuterRef: 'documents/depositos/dep-2', quantidade: 9 }),
      ],
    });
    expect(estoque).toBeNull();
    expect(quantidade(unidade('P'), estoque)).toBe(0);
  });

  it('a row under an auto-id (not the canonical id) is found through the partition listing', () => {
    const autoId = linha('P', 'Xq81AutoId', { quantidade: 6 });
    const estoque = linhaEstoqueNoDepositoAmazon({
      produtoId: 'P',
      depositoId: DEP,
      canonica: null,
      particao: [autoId],
    });
    expect(estoque).toBe(autoId);
    expect(quantidade(unidade('P'), estoque)).toBe(6);
  });

  it('a kit whose component rows come by canonical id AND through a partition ⇒ 4', () => {
    const a = linhaEstoqueNoDepositoAmazon({
      produtoId: 'A',
      depositoId: DEP,
      canonica: canonica('A', { quantidade: 9 }),
      particao: null,
    });
    const b = linhaEstoqueNoDepositoAmazon({
      produtoId: 'B',
      depositoId: DEP,
      canonica: null,
      particao: [linha('B', 'legadoB', { depositoOuterRef: NUA, quantidade: 5, parentId: null })],
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(
      kit(
        {},
        [a, b].filter((x): x is DocEstoqueLidoAmazon => x !== null),
      ),
    ).toBe(4);
  });

  it('★ publicado is never a gate: an unpublished or flagless unit publishes its stock', () => {
    const estoque = canonica('P', { quantidade: 10, quantidadeReservada: 3 });
    expect(quantidade(unidade('P', { publicado: false }), estoque)).toBe(7);
    expect(quantidade(unidade('P', { publicado: true }), estoque)).toBe(7);
    expect(quantidade(unidade('P'), estoque)).toBe(7);
  });
});

describe('the row at the depósito', () => {
  it('★ the canonical id wins over every partition row', () => {
    const c = canonica('P', { quantidade: 2 });
    expect(
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: c,
        particao: [linha('P', 'aaa', { quantidade: 99 })],
      }),
    ).toBe(c);
  });

  it('★ both stored ref forms of the conta’s depósito match (an EQUAL pair)', () => {
    for (const ref of [CANONICA, NUA]) {
      const r = linha('P', 'auto', { depositoOuterRef: ref, quantidade: 4 });
      expect(
        linhaEstoqueNoDepositoAmazon({
          produtoId: 'P',
          depositoId: DEP,
          canonica: null,
          particao: [r],
        }),
        ref,
      ).toBe(r);
    }
  });

  it('★ NEAR-MISSES: another depósito, a case or space change, a prefix, a deeper path or a non-string stay DISTINCT', () => {
    for (const ref of [
      'documents/depositos/dep-2',
      'depositos/dep-10',
      'documents/depositos/DEP-1',
      'documents/depositos/dep-1 ',
      ' depositos/dep-1',
      '/depositos/dep-1',
      'documents/documents/depositos/dep-1',
      'documents/depositos/dep-1/x/y',
      'documents/outros/dep-1',
      'dep-1',
      null,
      42,
    ]) {
      const r = linha('P', 'auto', { depositoOuterRef: ref, quantidade: 4 });
      expect(
        linhaEstoqueNoDepositoAmazon({
          produtoId: 'P',
          depositoId: DEP,
          canonica: null,
          particao: [r],
        }),
        String(ref),
      ).toBeNull();
    }
  });

  it('another depósito’s row is ignored, the conta’s is taken', () => {
    const outro = linha('P', 'a-outro', {
      depositoOuterRef: 'documents/depositos/dep-2',
      quantidade: 50,
    });
    const nosso = linha('P', 'b-nosso', { depositoOuterRef: NUA, quantidade: 5 });
    expect(
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: null,
        particao: [outro, nosso],
      }),
    ).toBe(nosso);
  });

  it('two auto-id rows at the depósito ⇒ the smallest doc id, whatever the listing order', () => {
    const z = linha('P', 'zzz', { quantidade: 1 });
    const a = linha('P', 'aaa', { quantidade: 2 });
    for (const particao of [
      [z, a],
      [a, z],
    ]) {
      expect(
        linhaEstoqueNoDepositoAmazon({ produtoId: 'P', depositoId: DEP, canonica: null, particao }),
      ).toBe(a);
    }
  });

  it('the ref forms: canonical first, the bare second; the canonical one is what the stock docs store', () => {
    expect(formasRefDepositoEstoqueAmazon(DEP)).toEqual([CANONICA, NUA]);
    expect(REF_DEPOSITO_ESTOQUE_AMAZON_REGEX.test(formasRefDepositoEstoqueAmazon(DEP)[0])).toBe(
      true,
    );
    expect(() => formasRefDepositoEstoqueAmazon('a/b')).toThrow(RangeError);
    expect(() => formasRefDepositoEstoqueAmazon('')).toThrow(RangeError);
  });

  it('a wiring bug is thrown, never read as a quantity', () => {
    // A canonical document from another path.
    expect(() =>
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: linha('P', 'auto'),
        particao: null,
      }),
    ).toThrow(TypeError);
    // ★ A canonical document of ANOTHER produto, even at P's canonical id.
    expect(() =>
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: {
          caminho: `produtos/Q/estoques/${makeEstoqueUid('P', DEP)}`,
          raw: { depositoOuterRef: CANONICA, quantidade: 9 },
        },
        particao: null,
      }),
    ).toThrow(TypeError);
    // A partition row of another produto.
    expect(() =>
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: null,
        particao: [linha('Q', 'auto')],
      }),
    ).toThrow(TypeError);
    // No partition when the canonical row is absent.
    expect(() =>
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: null,
        particao: null,
      }),
    ).toThrow(TypeError);
    // A path that is not an estoque path.
    expect(() =>
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: null,
        particao: [{ caminho: 'produtos/P/prodAmazon/x', raw: { depositoOuterRef: CANONICA } }],
      }),
    ).toThrow(TypeError);
  });

  it('a path is read as a DocumentReference carries it: a documents/-prefixed one is a wiring bug (the one estoque-path grammar)', () => {
    const uid = makeEstoqueUid('P', DEP);
    const c = { caminho: `produtos/P/estoques/${uid}`, raw: { quantidade: 1 } };
    expect(
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: c,
        particao: null,
      }),
    ).toBe(c);
    expect(() =>
      linhaEstoqueNoDepositoAmazon({
        produtoId: 'P',
        depositoId: DEP,
        canonica: { caminho: `documents/produtos/P/estoques/${uid}`, raw: { quantidade: 1 } },
        particao: null,
      }),
    ).toThrow(TypeError);
    expect(partesDoCaminhoEstoqueAmazon(`produtos/P/estoques/${uid}`)).toEqual({
      produtoId: 'P',
      docId: uid,
    });
    expect(partesDoCaminhoEstoqueAmazon(`documents/produtos/P/estoques/${uid}`)).toBeNull();
  });
});

describe('the member projection', () => {
  it('every component row gets its produto and doc id from its path, the stored parentId overwritten', () => {
    const membro = membroParaEstoqueAmazon(
      unidade('K', { ehKit: true, componentesKit: KIT_2A_1B, timestamp: 1_700_000_000_000 }),
      canonica('K', { quantidade: 3 }),
      [linha('A', 'legado-a', { quantidade: 9, parentId: null })],
    );
    expect(membro.componentEstoques).toEqual([
      { depositoOuterRef: CANONICA, quantidade: 9, parentId: 'A', estoqueDocId: 'legado-a' },
    ]);
    expect(membro.estoque).toEqual({
      depositoOuterRef: CANONICA,
      quantidade: 3,
      estoqueDocId: makeEstoqueUid('K', DEP),
    });
    expect(membro.produtoId).toBe('K');
    expect(membro.timestampMs).toBe(1_700_000_000_000);
  });

  it('flags are strict: only a literal true is a kit, a virtual kit, published', () => {
    const membro = membroParaEstoqueAmazon(
      unidade('P', { ehKit: 'true', ehKitVirtual: 1, publicado: 'sim' }),
      null,
      [],
    );
    expect(membro.ehKit).toBe(false);
    expect(membro.ehKitVirtual).toBe(false);
    expect(membro.publicado).toBe(false);
    expect(membro.estoque).toBeNull();
  });

  it('a wiring bug is thrown: the own row of another produto, two rows of one component, a non-estoque path', () => {
    expect(() => membroParaEstoqueAmazon(unidade('P'), canonica('Q'), [])).toThrow(TypeError);
    expect(() =>
      membroParaEstoqueAmazon(unidade('K', { ehKit: true }), null, [
        canonica('A'),
        linha('A', 'outro'),
      ]),
    ).toThrow(TypeError);
    expect(() =>
      membroParaEstoqueAmazon(unidade('K'), null, [{ caminho: 'produtos/A', raw: {} }]),
    ).toThrow(TypeError);
    // A `documents/` prefix, single or doubled, is not an estoque path.
    expect(() =>
      membroParaEstoqueAmazon(unidade('K'), null, [
        { caminho: 'documents/produtos/A/estoques/x', raw: {} },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      membroParaEstoqueAmazon(unidade('K'), null, [
        { caminho: 'documents/documents/produtos/A/estoques/x', raw: {} },
      ]),
    ).toThrow(TypeError);
    expect(() => membroParaEstoqueAmazon(unidade(''), null, [])).toThrow(RangeError);
  });

  it('★ the declared fields are all it reads: a projection to them changes no quantity', () => {
    const projetar = (raw: Readonly<Record<string, unknown>>, campos: readonly string[]) =>
      Object.fromEntries(Object.entries(raw).filter(([k]) => campos.includes(k)));
    const ruidoUnidade = {
      nome: 'x',
      paiId: 'pai',
      publicado: false,
      statusProdutosMarketplace: {},
    };
    const ruidoLinha = { localizacao: 'A1', ultimaModificacao: 5, variacoes: { a: 1 } };
    const casos: [Record<string, unknown>, DocEstoqueLidoAmazon, DocEstoqueLidoAmazon[]][] = [
      [{}, canonica('K', { quantidade: 10, quantidadeReservada: 3 }), []],
      [
        { ehKit: true, componentesKit: KIT_2A_1B },
        canonica('K', { quantidade: 3 }),
        [canonica('A', { quantidade: 9 }), canonica('B', { quantidade: 5 })],
      ],
      [
        { ehKit: true, ehKitVirtual: true, componentesKit: KIT_2A_1B },
        canonica('K', { quantidade: 3 }),
        [canonica('A', { quantidade: 9 })],
      ],
    ];
    for (const [rawUnidade, propria, componentes] of casos) {
      const cheio = quantidade(
        unidade('K', { ...ruidoUnidade, ...rawUnidade }),
        { caminho: propria.caminho, raw: { ...ruidoLinha, ...propria.raw } },
        componentes.map((c) => ({ caminho: c.caminho, raw: { ...ruidoLinha, ...c.raw } })),
      );
      const projetado = quantidade(
        unidade('K', projetar({ ...ruidoUnidade, ...rawUnidade }, CAMPOS_UNIDADE_ESTOQUE_AMAZON)),
        { caminho: propria.caminho, raw: projetar(propria.raw, CAMPOS_LINHA_ESTOQUE_AMAZON) },
        componentes.map((c) => ({
          caminho: c.caminho,
          raw: projetar(c.raw, CAMPOS_LINHA_ESTOQUE_AMAZON),
        })),
      );
      expect(projetado).toBe(cheio);
    }
  });
});
