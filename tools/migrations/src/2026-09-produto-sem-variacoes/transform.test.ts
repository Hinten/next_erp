import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { resumirEstoques, type EstoqueBruto } from './predicate';
import {
  idCanonicoEstoque,
  idDoMembroUnico,
  movimentosDeEstoque,
  planejarConversao,
  type EntradaConversao,
} from './transform';

const PRODUTO = 'prod-1';
const CHILD = idDoMembroUnico(PRODUTO);

function linha(over: Partial<EstoqueBruto> = {}): EstoqueBruto {
  return {
    docId: idCanonicoEstoque(PRODUTO, 'dep-1'),
    depositoOuterRef: 'documents/depositos/dep-1',
    quantidade: 10,
    quantidadeReservada: 0,
    ...over,
  };
}

function entrada(over: Partial<EntradaConversao> = {}): EntradaConversao {
  return {
    produtoId: PRODUTO,
    produto: { nome: 'Bandeja', sku: 'BAN-1', paiId: null, ehKit: false },
    temFilhos: false,
    temVinculoMercadoLivre: false,
    estoque: resumirEstoques(PRODUTO, [linha()]),
    ...over,
  };
}

describe('idDoMembroUnico', () => {
  // ⚠️ Pinned against the literal formula, not against another call of itself.
  // This is the string publish used to mint before #1398 turned its `'criar'` arm
  // into a refusal (`upSoleMember.ts`), so a produto publish already converted in
  // production resolves to the SAME document instead of gaining a second one.
  it('is sha256(`<produtoId>|up-sole-member`), byte for byte', () => {
    expect(idDoMembroUnico('prod-1')).toBe(
      createHash('sha256').update('prod-1|up-sole-member').digest('hex'),
    );
  });

  it('is stable and produto-specific', () => {
    expect(idDoMembroUnico('a')).toBe(idDoMembroUnico('a'));
    expect(idDoMembroUnico('a')).not.toBe(idDoMembroUnico('b'));
  });
});

describe('planejarConversao — what is skipped, and why it must be', () => {
  // ⛔ The skip that protects a live listing. Converting a produto that sells on
  // ML makes publish's fan-out find a member with no link, POST a SECOND item,
  // and `sweepRemovedMembers` then close the original.
  it('skips a produto that carries a Mercado Livre link', () => {
    expect(planejarConversao(entrada({ temVinculoMercadoLivre: true }))).toEqual({
      tipo: 'pular',
      motivo: 'tem-vinculo-mercado-livre',
    });
  });

  it('skips a produto that already has a child — this is the re-run guard', () => {
    expect(planejarConversao(entrada({ temFilhos: true }))).toEqual({
      tipo: 'pular',
      motivo: 'ja-tem-filho',
    });
  });

  it('skips a variation child that reached the walk', () => {
    const filho = entrada({ produto: { nome: 'P', paiId: 'outro' } });
    expect(planejarConversao(filho)).toEqual({ tipo: 'pular', motivo: 'nao-e-raiz' });
  });

  // ⚠️ Order matters: a child of a produto that also has a link must report the
  // ROOT reason, or the log says "ML" about a document that was never a candidate.
  it('reports nao-e-raiz first, whatever else is true', () => {
    expect(
      planejarConversao(
        entrada({ produto: { paiId: 'outro' }, temFilhos: true, temVinculoMercadoLivre: true }),
      ),
    ).toEqual({ tipo: 'pular', motivo: 'nao-e-raiz' });
  });
});

describe('planejarConversao — the conversion', () => {
  it('mints the child from the SAME builder a produto born as a family uses', () => {
    const plano = planejarConversao(entrada());
    expect(plano).toMatchObject({ tipo: 'converter', childId: CHILD });
    // `montarMembroUnico`'s output, so the two shapes cannot drift apart.
    expect(plano.tipo === 'converter' && plano.childDoc).toMatchObject({
      nome: 'Bandeja',
      sku: 'BAN-1',
      paiId: PRODUTO,
      variacoesUid: null,
    });
  });

  it('patches the parent with the pointer and NOTHING else', () => {
    const plano = planejarConversao(entrada());
    expect(plano.tipo === 'converter' && plano.parentPatch).toEqual({ filhoUnicoId: CHILD });
  });

  it('moves the available units onto the child’s canonical row', () => {
    const plano = planejarConversao(entrada());
    expect(plano.tipo === 'converter' && plano.movimentos).toEqual([
      {
        docIdNoPai: idCanonicoEstoque(PRODUTO, 'dep-1'),
        depositoId: 'dep-1',
        docIdNoFilho: idCanonicoEstoque(CHILD, 'dep-1'),
        quantidade: 10,
      },
    ]);
  });

  // ⚠️ The residual, and it is deliberate. A reservation is keyed on the produto
  // the pedido LINE names — the parent — so moving it would make the eventual
  // release decrement a document this script emptied while the child keeps a
  // phantom reserve for ever.
  it('moves only the AVAILABLE units and leaves the reserve on the parent', () => {
    const plano = planejarConversao(
      entrada({
        estoque: resumirEstoques(PRODUTO, [linha({ quantidade: 10, quantidadeReservada: 4 })]),
      }),
    );
    expect(plano.tipo === 'converter' && plano.movimentos[0]!.quantidade).toBe(6);
    expect(plano.tipo === 'converter' && plano.ficaNoPai).toBe(4);
  });

  // ⚠️ IDEMPOTENCE, and it is arithmetic rather than a flag. After a successful
  // run the parent's quantidade equals its reserve, so recomputing
  // `max(0, quantidade − reserva)` yields 0 and a second pass moves nothing.
  // There is no stored delta that could be applied twice.
  it('moves nothing on a second pass over an already-converted parent', () => {
    const depois = resumirEstoques(PRODUTO, [linha({ quantidade: 4, quantidadeReservada: 4 })]);
    const plano = planejarConversao(entrada({ estoque: depois }));
    expect(plano.tipo === 'converter' && plano.movimentos).toEqual([]);
    expect(plano.tipo === 'converter' && plano.ficaNoPai).toBe(4);
  });

  // ...and the near-miss that proves the idempotence is not just "it stops": an
  // entrada booked on the parent between two runs SHOULD move, because those
  // units belong on the child.
  it('moves units booked on the parent after a previous run', () => {
    const depois = resumirEstoques(PRODUTO, [linha({ quantidade: 9, quantidadeReservada: 4 })]);
    const plano = planejarConversao(entrada({ estoque: depois }));
    expect(plano.tipo === 'converter' && plano.movimentos[0]!.quantidade).toBe(5);
  });
});

describe('movimentosDeEstoque — the rows it refuses to touch', () => {
  // ⚠️ The parent row is addressed by its STORED doc id. The migrated corpus
  // holds rows at auto-ids, and `.old/…/tasks.dart:92` mints
  // `est-<depositoId>-<produtoId>` with the arguments transposed — re-deriving
  // would patch a document that does not exist and leave the real row untouched,
  // silently DOUBLING the stock.
  it('decrements the row that exists, not the one the id formula would predict', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ docId: 'auto-id-legado' })]);
    const [mov] = movimentosDeEstoque(PRODUTO, CHILD, resumo.linhas);
    expect(mov!.docIdNoPai).toBe('auto-id-legado');
    // ...while the CHILD's row is canonical, because this script is creating it.
    expect(mov!.docIdNoFilho).toBe(idCanonicoEstoque(CHILD, 'dep-1'));
  });

  // A row with no resolvable depósito has nowhere to move TO, and inventing one
  // would attribute stock to a depósito that does not exist. It stays put and the
  // census counts it.
  it('leaves a row whose depositoOuterRef resolves to nothing', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ depositoOuterRef: 'documents/clientes/c1' })]);
    expect(movimentosDeEstoque(PRODUTO, CHILD, resumo.linhas)).toEqual([]);
  });

  it('leaves a zero row alone rather than writing a no-op increment', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ quantidade: 0 })]);
    expect(movimentosDeEstoque(PRODUTO, CHILD, resumo.linhas)).toEqual([]);
  });

  // A negative available (the #931 shape) must not move a negative quantity onto
  // the child — `moveria` floors at 0 and this pins that it reaches here.
  it('never moves a negative quantity', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ quantidade: 2, quantidadeReservada: 5 })]);
    expect(movimentosDeEstoque(PRODUTO, CHILD, resumo.linhas)).toEqual([]);
  });

  it('produces one movement per depósito that has units', () => {
    const resumo = resumirEstoques(PRODUTO, [
      linha(),
      linha({
        docId: idCanonicoEstoque(PRODUTO, 'dep-2'),
        depositoOuterRef: 'depositos/dep-2',
        quantidade: 3,
      }),
    ]);
    expect(movimentosDeEstoque(PRODUTO, CHILD, resumo.linhas).map((m) => m.depositoId)).toEqual([
      'dep-1',
      'dep-2',
    ]);
  });
});
