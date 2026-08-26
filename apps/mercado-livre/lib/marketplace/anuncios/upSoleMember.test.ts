/**
 * Both controls for the sole-member planner (#1087).
 *
 * ⚠️ The assertions that matter are the ones about `itemId` and the child doc id.
 * A planner that returns a plausible-looking plan with `itemId: null` in the
 * adoption case is INDISTINGUISHABLE from a correct one at a glance, and it is the
 * defect that closes a live listing — so it is asserted directly, twice, from both
 * sides (adoption carries the id, creation does not).
 *
 * Mutation check — this file is only worth its runtime if it goes red on a real
 * regression. Flip `args.acao === 'adotar' ? args.link.id : null` to `null` in
 * `upSoleMember.ts` and "adoption carries the existing item id" must fail; drop the
 * `reservaEfetiva` term from `disponivelDe` and "moves only the AVAILABLE units"
 * must fail.
 */
import { describe, expect, it } from 'vitest';

import { membroUnicoChildId, planejarMembroUnico } from './upSoleMember';
import type { PlanejarMembroUnicoArgs } from './upSoleMember';

const NOW = 1_750_000_000_000;

function args(over: Partial<PlanejarMembroUnicoArgs> = {}): PlanejarMembroUnicoArgs {
  return {
    acao: 'adotar',
    produtoId: 'prod1',
    parentLinkDocId: 'link1',
    integracaoId: 'int1',
    produto: {
      nome: 'Porta-lápis de madeira',
      sku: 'band123',
      ehKit: false,
      ehUsado: false,
      precos: { tabela1: 10 },
      pesoLiquidoKg: 0.25,
      pesoBrutoKg: 0.3,
      alturaCm: 12,
      larguraCm: 8,
      profundidadeCm: 8,
      categoriaProdutoOuterRef: 'documents/categorias/cat1',
    },
    link: {
      id: 'MLB5125183715',
      status: 'active',
      sub_status: [],
      userProductId: 'MLBU4903167333',
      moderacoes: null,
    },
    estoques: [{ docId: 'est-dep1', depositoId: 'dep1', quantidade: 7, quantidadeReservada: 0 }],
    now: NOW,
    ...over,
  };
}

function plano(over: Partial<PlanejarMembroUnicoArgs> = {}) {
  const r = planejarMembroUnico(args(over));
  if (!r.ok) throw new Error(`esperava um plano, veio recusa: ${r.recusas.join('; ')}`);
  return r.plano;
}

describe('planejarMembroUnico — adoption (the produto was already published)', () => {
  it('⛔ carries the EXISTING item id onto the member link, so the fan-out PUTs', () => {
    // Without this the fan-out POSTs a second item and `sweepRemovedMembers` then
    // pauses-then-closes the original, live, selling listing.
    expect(plano().link.itemId).toBe('MLB5125183715');
  });

  it('mints the child at the id the IMPORTER would have used, so a re-import converges', () => {
    // `importVariations.ts:137-138`, verbatim — produto id and link doc id alike.
    const esperado = 'XMLB000000000000000link1vMLBMLB5125183715';
    expect(plano().childProdutoId).toBe(esperado);
    expect(plano().childLinkDocId).toBe(esperado);
  });

  it('keeps the human SKU on the child — it is what ML holds as SELLER_SKU', () => {
    expect(plano().produto.sku).toBe('band123');
    expect(plano().link.sku).toBe('band123');
  });

  it('gives the sole member NO variation taxonomy: there is nothing to vary', () => {
    expect(plano().produto.grupoDeVariacoesUid).toBeNull();
    expect(plano().produto.variacoesUid).toBeNull();
    expect(plano().link.attributes).toEqual([]);
  });

  it('seeds status, sub_status and moderações from the parent in ONE patch', () => {
    const p = plano({
      link: {
        id: 'MLB1',
        status: 'paused',
        sub_status: ['suspended'],
        userProductId: 'MLBU1',
        moderacoes: [{ codigo: 'x' }] as never,
      },
    });
    expect(p.link.status).toBe('paused');
    expect(p.link.sub_status).toEqual(['suspended']);
    expect(p.link.moderacoes).toEqual([{ codigo: 'x' }]);
  });

  it('moves the MLBU to the member and nulls it on the family parent (#706/#1142)', () => {
    expect(plano().link.userProductId).toBe('MLBU4903167333');
    expect(plano().parentLinkPatch.userProductId).toBeNull();
  });

  it('points the member link back at BOTH the child produto and the parent link', () => {
    const p = plano();
    expect(p.link.produtoVariacaoOuterRef).toBe(`documents/produtos/${p.childProdutoId}`);
    expect(p.link.produtoMercadoLivreOuterRef).toBe(
      'documents/produtos/prod1/produtoMercadoLivre/link1',
    );
    expect(p.link.contaOuterRef).toBe('documents/integracao/int1');
  });

  it('leaves the numeric legacy `id` null — a UP member is not a variations[] entry', () => {
    expect(plano().link.id).toBeNull();
  });
});

describe('planejarMembroUnico — the estoque move', () => {
  it('with nothing reserved, the WHOLE quantity moves and the parent is left at 0', () => {
    const p = plano();
    expect(p.estoques).toHaveLength(1);
    expect(p.estoques[0]!.data).toMatchObject({ parentId: p.childProdutoId, quantidade: 7 });
    expect(p.parentEstoqueRestos).toHaveLength(1);
    expect(p.parentEstoqueRestos[0]!.data).toMatchObject({ quantidade: 0 });
  });

  it('⚠️ moves only the AVAILABLE units — the reserved ones stay on the parent', () => {
    // 10 in the warehouse, 2 owed to an open pedido whose release decrements the
    // PARENT. Moving those 2 with the rest would land the release on an emptied row
    // and leave the child a phantom reserve for ever.
    const p = plano({
      estoques: [{ docId: 'est-dep1', depositoId: 'dep1', quantidade: 10, quantidadeReservada: 2 }],
    });
    expect(p.estoques[0]!.data.quantidade).toBe(8);
    expect(p.parentEstoqueRestos[0]!.data.quantidade).toBe(2);
  });

  it('conserves the total: what the child gains plus what the parent keeps is unchanged', () => {
    const p = plano({
      estoques: [{ docId: 'est-dep1', depositoId: 'dep1', quantidade: 10, quantidadeReservada: 3 }],
    });
    const total =
      Number(p.estoques[0]!.data.quantidade) + Number(p.parentEstoqueRestos[0]!.data.quantidade);
    expect(total).toBe(10);
  });

  it('a fully reserved produto moves nothing and still plans (publish is never blocked)', () => {
    const p = plano({
      estoques: [{ docId: 'est-dep1', depositoId: 'dep1', quantidade: 2, quantidadeReservada: 2 }],
    });
    expect(p.estoques[0]!.data.quantidade).toBe(0);
    expect(p.parentEstoqueRestos[0]!.data.quantidade).toBe(2);
  });

  it('⚠️ never DELETES the parent row — that would cascade its historicoEstoque away', () => {
    // The plan has no delete channel at all; this asserts the shape stays that way.
    expect(Object.keys(plano())).not.toContain('parentEstoqueDeletes');
  });

  it('carries every depósito, not just the first', () => {
    const p = plano({
      estoques: [
        { docId: 'est-dep1', depositoId: 'dep1', quantidade: 7, quantidadeReservada: 0 },
        { docId: 'est-dep2', depositoId: 'dep2', quantidade: 3, quantidadeReservada: 0 },
      ],
    });
    expect(p.estoques.map((e) => e.data.quantidade)).toEqual([7, 3]);
    expect(p.parentEstoqueRestos).toHaveLength(2);
  });

  it('a produto with no estoque at all still plans cleanly', () => {
    const p = plano({ estoques: [] });
    expect(p.estoques).toEqual([]);
    expect(p.parentEstoqueRestos).toEqual([]);
  });
});

describe('planejarMembroUnico — creation (the produto was never published)', () => {
  const criar = { acao: 'criar' as const, link: { ...args().link, id: null } };

  it('leaves the member link itemId null: the fan-out has to POST', () => {
    expect(plano(criar).link.itemId).toBeNull();
  });

  it('derives a STABLE child id from the produto, since no item id exists yet', () => {
    expect(plano(criar).childProdutoId).toBe(membroUnicoChildId('criar', 'prod1', 'link1', null));
    expect(plano(criar).childProdutoId).toBe(plano(criar).childProdutoId);
  });

  it('the created and adopted ids are DIFFERENT — the fixtures must not coincide', () => {
    // ⚠️ #1142 was missed twice because both fixtures made the two behaviours
    // numerically equal. This pins them apart.
    expect(plano(criar).childProdutoId).not.toBe(plano().childProdutoId);
  });
});

describe('planejarMembroUnico — refusals', () => {
  it('⚠️ a reservation NEVER blocks the publish — it only splits the move', () => {
    const r = planejarMembroUnico(
      args({
        estoques: [
          { docId: 'est-dep1', depositoId: 'dep1', quantidade: 7, quantidadeReservada: 2 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('a NEGATIVE stored reserve is not a reserve (#931) — the whole quantity moves', () => {
    const r = planejarMembroUnico(
      args({
        estoques: [
          { docId: 'est-dep1', depositoId: 'dep1', quantidade: 7, quantidadeReservada: -3 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plano.estoques[0]!.data.quantidade).toBe(7);
  });

  it('a non-numeric stored reserve is not a reserve either', () => {
    const r = planejarMembroUnico(
      args({
        estoques: [
          { docId: 'est-dep1', depositoId: 'dep1', quantidade: 7, quantidadeReservada: null },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plano.estoques[0]!.data.quantidade).toBe(7);
  });

  it('refuses an adoption with no anúncio to adopt', () => {
    const r = planejarMembroUnico(args({ acao: 'adotar', link: { ...args().link, id: null } }));
    expect(r.ok).toBe(false);
  });
});
