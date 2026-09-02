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
  it('with nothing reserved, the WHOLE quantity moves off the parent', () => {
    const p = plano();
    expect(p.estoques).toHaveLength(1);
    expect(p.estoques[0]!.data).toMatchObject({ parentId: p.childProdutoId, quantidade: 7 });
    expect(p.parentEstoqueSaidas).toEqual([{ docId: 'est-dep1', movido: 7 }]);
  });

  it('⚠️ moves only the AVAILABLE units — the reserved ones stay on the parent', () => {
    // 10 in the warehouse, 2 owed to an open pedido whose release decrements the
    // PARENT. Moving those 2 with the rest would land the release on an emptied row
    // and leave the child a phantom reserve for ever.
    const p = plano({
      estoques: [{ docId: 'est-dep1', depositoId: 'dep1', quantidade: 10, quantidadeReservada: 2 }],
    });
    expect(p.estoques[0]!.data.quantidade).toBe(8);
    expect(p.parentEstoqueSaidas[0]!.movido).toBe(8);
  });

  it('⚠️ the parent side is a DELTA, not a resulting quantity (rule 7)', () => {
    // The writer applies it as `increment(-movido)`, so an entrada booked between
    // the read and the write survives. An absolute quantity would erase it.
    const p = plano({
      estoques: [{ docId: 'est-dep1', depositoId: 'dep1', quantidade: 10, quantidadeReservada: 3 }],
    });
    expect(p.parentEstoqueSaidas[0]).toEqual({ docId: 'est-dep1', movido: 7 });
    // What leaves the parent is exactly what the child gains — nothing is created
    // or destroyed by the reshape.
    expect(p.parentEstoqueSaidas[0]!.movido).toBe(Number(p.estoques[0]!.data.quantidade));
  });

  it('a fully reserved produto moves nothing and still plans (publish is never blocked)', () => {
    const p = plano({
      estoques: [{ docId: 'est-dep1', depositoId: 'dep1', quantidade: 2, quantidadeReservada: 2 }],
    });
    expect(p.estoques[0]!.data.quantidade).toBe(0);
    expect(p.parentEstoqueSaidas[0]!.movido).toBe(0);
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
    expect(p.parentEstoqueSaidas.map((s) => s.movido)).toEqual([7, 3]);
  });

  it('a produto with no estoque at all still plans cleanly', () => {
    const p = plano({ estoques: [] });
    expect(p.estoques).toEqual([]);
    expect(p.parentEstoqueSaidas).toEqual([]);
  });

  it('the parent link patch carries NO clock — the writer stamps a monotonic one', () => {
    // `ultimaModificacao` here would be a plain write of a `now` captured at the top
    // of `publishProduto`, which can move the field BACKWARDS over a later commit.
    expect(plano().parentLinkPatch).toEqual({ userProductId: null });
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

/**
 * The parent's pointer (#1398, found by adversarial review of #1436).
 *
 * ⛔ This materialisation MOVES the produto's available units onto the child. Without
 * `filhoUnicoId` on the parent, `unidadeVendavel` resolves that parent to ITSELF —
 * so the badge, the pedido line, the Balanço scan and the print all read the row
 * this reshape just emptied, while the units the live Mercado Livre listing is
 * advertising sit on a child no ERP surface reaches.
 *
 * It shipped that way: publish minted the child, moved the stock, and patched only
 * the ML LINK document. The stack that introduced the pointer changed the readers
 * and left the one materialisation publish still performs writing nothing.
 */
describe('planejarMembroUnico — the parent points at its member', () => {
  it('stamps filhoUnicoId with the child it just created', () => {
    expect(plano().parentProdutoPatch).toEqual({ filhoUnicoId: plano().childProdutoId });
  });

  // ⚠️ The pointer is about IDENTITY, not about units. A produto whose every
  // depósito is fully reserved moves nothing — and still becomes a family of one,
  // so the readers must still be told where its sellable unit is.
  it('stamps it on the creation arm too, where no stock moves', () => {
    const criar = { acao: 'criar' as const, link: { ...args().link, id: null } };
    expect(plano(criar).parentProdutoPatch).toEqual({
      filhoUnicoId: plano(criar).childProdutoId,
    });
  });

  // ⚠️ Through `derivarFilhoUnico`, never a bare `childId`. That function is the one
  // producer of the value, so publish, the ERP's own create path and the conversion
  // script cannot drift into disagreeing about what "exactly one member" means.
  it('produces a bare doc id, the shape every reader resolves', () => {
    const { filhoUnicoId } = plano().parentProdutoPatch as { filhoUnicoId: unknown };
    expect(typeof filhoUnicoId).toBe('string');
    expect(filhoUnicoId).not.toContain('/');
  });

  // The link patch is a DIFFERENT document, and conflating them is how the pointer
  // went missing in the first place: `parentLinkPatch` looks like "the parent patch"
  // and is not.
  it('is separate from the parent LINK patch', () => {
    expect(plano().parentLinkPatch).toEqual({ userProductId: null });
  });
});
