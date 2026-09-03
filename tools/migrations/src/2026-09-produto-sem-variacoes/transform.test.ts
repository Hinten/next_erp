import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { resumirEstoques, type EstoqueBruto } from './predicate';
import {
  idCanonicoEstoque,
  idDoMembroUnico,
  movimentosDeEstoque,
  planejarConversao,
  planejarPonteiro,
  unidadesPresasSemDeposito,
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

  // ...and the near-miss that keeps the arithmetic honest: the floor is at the
  // RESERVE, not at zero-movement. A parent holding more than its reserve still
  // has units to move, and the split is computed, never remembered.
  //
  // ⛔ This test used to be called "moves units booked on the parent after a
  // previous run", and that name was FALSE at the pipeline level: `migrate.ts`
  // skips an already-converted produto as `ja-tem-filho` before reading any
  // estoque row, so this function is never reached a second time for it. The
  // fixture (`temFilhos: false`) could not occur on a re-run — the test exercised
  // a state the pipeline cannot produce, while its name asserted a recovery
  // property the script does not have.
  it('moves whatever exceeds the reserve, computed rather than remembered', () => {
    const parcial = resumirEstoques(PRODUTO, [linha({ quantidade: 9, quantidadeReservada: 4 })]);
    const plano = planejarConversao(entrada({ estoque: parcial }));
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
    const [mov] = movimentosDeEstoque(CHILD, resumo.linhas);
    expect(mov!.docIdNoPai).toBe('auto-id-legado');
    // ...while the CHILD's row is canonical, because this script is creating it.
    expect(mov!.docIdNoFilho).toBe(idCanonicoEstoque(CHILD, 'dep-1'));
  });

  // A row with no resolvable depósito has nowhere to move TO, and inventing one
  // would attribute stock to a depósito that does not exist. It stays put and the
  // census counts it.
  it('leaves a row whose depositoOuterRef resolves to nothing', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ depositoOuterRef: 'documents/clientes/c1' })]);
    expect(movimentosDeEstoque(CHILD, resumo.linhas)).toEqual([]);
  });

  it('leaves a zero row alone rather than writing a no-op increment', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ quantidade: 0 })]);
    expect(movimentosDeEstoque(CHILD, resumo.linhas)).toEqual([]);
  });

  // A negative available (the #931 shape) must not move a negative quantity onto
  // the child — `moveria` floors at 0 and this pins that it reaches here.
  it('never moves a negative quantity', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ quantidade: 2, quantidadeReservada: 5 })]);
    expect(movimentosDeEstoque(CHILD, resumo.linhas)).toEqual([]);
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
    expect(movimentosDeEstoque(CHILD, resumo.linhas).map((m) => m.depositoId)).toEqual([
      'dep-1',
      'dep-2',
    ]);
  });
});

/**
 * ⛔ Units on an unresolvable-depósito row are counted somewhere.
 *
 * `moveria` is computed from the quantities alone and never consults
 * `depositoId`, so such a row contributes to the census's `moveriaTotal` while
 * `movimentosDeEstoque` drops it — and `ficaNoPai` only ever holds
 * `reservaEfetiva`. Without its own accumulator the run's summary claimed "every
 * number is either work done or work LEFT" while those units appeared in neither.
 *
 * ⚠️ The line count in the warning is not a substitute: one unresolvable row can
 * hold any number of units.
 */
describe('unidadesPresasSemDeposito', () => {
  it('counts the units on a row whose depósito does not resolve', () => {
    const resumo = resumirEstoques(PRODUTO, [
      linha({ depositoOuterRef: 'documents/clientes/c1', quantidade: 10 }),
    ]);
    expect(unidadesPresasSemDeposito(resumo.linhas)).toBe(10);
    // ...and they are in NEITHER of the other two totals, which is the point.
    expect(movimentosDeEstoque(CHILD, resumo.linhas)).toEqual([]);
    expect(resumo.ficariaNoPaiTotal).toBe(0);
  });

  it('counts only the AVAILABLE units, matching what a movement would have moved', () => {
    const resumo = resumirEstoques(PRODUTO, [
      linha({ depositoOuterRef: 'documents/clientes/c1', quantidade: 10, quantidadeReservada: 4 }),
    ]);
    expect(unidadesPresasSemDeposito(resumo.linhas)).toBe(6);
  });

  // The near-miss: a resolvable row is NOT stranded, however many units it holds.
  it('ignores a row whose depósito resolves', () => {
    const resumo = resumirEstoques(PRODUTO, [linha({ quantidade: 10 })]);
    expect(unidadesPresasSemDeposito(resumo.linhas)).toBe(0);
  });

  it('is carried on the plan, so the run can report it', () => {
    const resumo = resumirEstoques(PRODUTO, [
      linha({ depositoOuterRef: 'documents/clientes/c1', quantidade: 10 }),
    ]);
    const plano = planejarConversao(entrada({ estoque: resumo }));
    expect(plano.tipo === 'converter' && plano.presasSemDeposito).toBe(10);
  });
});

/**
 * `planejarPonteiro` — the arm that stops a family which ALREADY exists from
 * surviving its own migration.
 *
 * Nothing else backfills `filhoUnicoId`: its four writers (ML publish, the ML
 * importer, `VariationManager`, produto creation) all fire on a WRITE, and
 * `apps/functions` only reads it. So a family publish created before #1398 keeps
 * a null pointer for ever, `unidadeVendavel` resolves it to the PARENT whose
 * available stock publish already moved to the child, and every kit naming it
 * reads 0 — #1398's opening symptom.
 */
describe('planejarPonteiro', () => {
  const planejar = (filhos: string[], armazenado: string | null = null) =>
    planejarPonteiro({
      produtoId: PRODUTO,
      filhoUnicoIdArmazenado: armazenado,
      filhos: filhos.map((id) => ({ id })),
    });

  it('stamps the pointer on a family of one that has none', () => {
    expect(planejar(['unico'])).toEqual({
      tipo: 'estampar',
      filhoUnicoId: 'unico',
      substituiu: null,
    });
  });

  // A stored pointer that disagrees with the LIVE child set is drift, and the
  // live set wins — `derivarFilhoUnico` is the only producer of this value.
  it('replaces a pointer that disagrees with the live child set, and says so', () => {
    expect(planejar(['unico'], 'fantasma')).toEqual({
      tipo: 'estampar',
      filhoUnicoId: 'unico',
      substituiu: 'fantasma',
    });
  });

  // ⚠️ The re-run case, and the one that must not cost a write: this runs over
  // every family in the corpus and most of them are already correct.
  it('writes nothing when the pointer already matches', () => {
    expect(planejar(['unico'], 'unico')).toEqual({ tipo: 'nada', motivo: 'ja-correto' });
  });

  // ⚠️ The near-miss that bounds the whole arm. A family of MANY has no single
  // sellable unit, and stamping one anyway would send every stock reader to an
  // arbitrary variation — the exact drift the pointer exists to prevent.
  it('refuses a family of many, whatever is stored', () => {
    expect(planejar(['a', 'b'])).toEqual({ tipo: 'nada', motivo: 'muitos-filhos' });
    expect(planejar(['a', 'b'], 'a')).toEqual({ tipo: 'nada', motivo: 'muitos-filhos' });
  });

  it('refuses when the fresh re-read found no child after all', () => {
    expect(planejar([])).toEqual({ tipo: 'nada', motivo: 'sem-filhos' });
  });

  /**
   * ⛔ A produto whose only child names IT as its own parent. `derivarFilhoUnico`
   * cannot catch this — it takes a child set and has no parent to compare against
   * — and a pointer to self makes every stock read resolve in a circle.
   */
  it('refuses a produto whose only child is itself', () => {
    expect(planejar([PRODUTO])).toEqual({ tipo: 'nada', motivo: 'filho-e-o-proprio-pai' });
  });
});
