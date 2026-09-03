import { createHash } from 'node:crypto';

import { montarMembroUnico, type ParentParaMembroUnico } from '@delfrance/schemas';

import type { LinhaDeposito, ResumoEstoque } from './predicate';

/**
 * The pure decision behind the #1398 conversion: turn a legacy **Produto
 * Simples** — a root produto with no children, holding its own stock — into a
 * **family of one**: parent + a single child, with the available units on the
 * child.
 *
 * `migrate.ts` does the Firestore I/O and nothing else. Everything that decides
 * what changes lives here, so it can be unit-tested in `ci.yml` against shapes
 * that are awkward to seed and impossible to rehearse safely: a reserved
 * remainder, an estoque row at a non-canonical doc id, a depósito ref that
 * resolves to nothing.
 *
 * ## Why a produto that already sells on Mercado Livre is SKIPPED
 *
 * ⛔ Converting one would break a live listing, in both models.
 *
 * Under **User Products**, publish's `'adotar'` arm is what seeds the sole
 * member's link with the existing item id. Give the produto a child here and
 * publish sees `childrenCount > 0`, answers `'nenhum'`, and the family fan-out
 * finds a member with **no** link — so it POSTs a *second* item, and
 * `sweepRemovedMembers` then confirms the original as an orphan and
 * pauses-then-closes it. A live, selling listing with its sales history and its
 * ranking, gone, because a backfill was tidy.
 *
 * Under the **legacy** model the failure is quieter and just as real: a childless
 * produto publishes through `buildItemPayload` as a simple item, and one child
 * turns its next republish into a `variations[]` payload for a listing that has
 * none.
 *
 * So the rule is one line and covers both: **a produto carrying any
 * `produtoMercadoLivre` link is not this script's.** Those keep the shape they
 * have, which read-tolerance already handles correctly — a childless produto
 * resolves to itself — and publish converts them when it next runs. The count of
 * them is reported, because "the script skipped 300 produtos" must be a number a
 * human reads, not an inference.
 */

/* -------------------------------------------------------------------------- */
/*                                  The plan                                  */
/* -------------------------------------------------------------------------- */

/** Why a candidate is not converted. Every one is reported, never silent. */
export type MotivoPular =
  /** Already a family — the conversion ran, or publish/the importer got there first. */
  | 'ja-tem-filho'
  /** Carries a `paiId`: it is a child, not a root. */
  | 'nao-e-raiz'
  /** ⛔ Has a Mercado Livre link. See the module header — publish owns this one. */
  | 'tem-vinculo-mercado-livre';

/** One estoque move: off the parent's row, onto the child's canonical row. */
export interface MovimentoEstoque {
  /** The PARENT row to decrement — enumerated, never re-derived (see below). */
  docIdNoPai: string;
  depositoId: string;
  /** The child's canonical row id, `est-<childId>-<depositoId>`. */
  docIdNoFilho: string;
  /** Units moved: `max(0, quantidade − reservaEfetiva)`. Always > 0. */
  quantidade: number;
}

export type PlanoDeConversao =
  | { tipo: 'pular'; motivo: MotivoPular }
  | {
      tipo: 'converter';
      childId: string;
      /** The child produto document, full. */
      childDoc: Record<string, unknown>;
      /** The parent patch — the pointer, and nothing else. */
      parentPatch: Record<string, unknown>;
      movimentos: MovimentoEstoque[];
      /**
       * Units left on the parent because they are RESERVED. Not a rounding
       * artefact — see {@link MovimentoEstoque} and the note below.
       */
      ficaNoPai: number;
      /**
       * Units stranded on a row whose depósito does not resolve — see
       * {@link unidadesPresasSemDeposito}. Reported separately because they are
       * neither moved nor reserved, so no other total contains them.
       */
      presasSemDeposito: number;
    };

export interface EntradaConversao {
  produtoId: string;
  /** The parent's stored document, raw. */
  produto: Record<string, unknown>;
  /** Does it already have at least one child? */
  temFilhos: boolean;
  /** Does it carry any `produtoMercadoLivre` link doc? */
  temVinculoMercadoLivre: boolean;
  /** The parent's own estoque rows, already summarised by `predicate.ts`. */
  estoque: ResumoEstoque;
}

/* -------------------------------------------------------------------------- */
/*                                 Doc ids                                    */
/* -------------------------------------------------------------------------- */

/**
 * The sole member's produto id.
 *
 * This is the string publish used to mint before #1398 turned its `'criar'` arm
 * into a refusal (`upSoleMember.ts`'s `membroUnicoChildId`), reproduced here on
 * purpose: a produto publish already converted in production resolves to the
 * SAME document, so this script finds it rather than minting a second one beside
 * it. That is belt-and-braces — the `ja-tem-filho` skip catches it first — but
 * the two agreeing costs nothing and disagreeing would cost a duplicate produto.
 *
 * ⚠️ It is NOT shared through `packages/schemas`, which `apps/web` reaches in the
 * browser: `node:crypto` has no place in that bundle. The equality is pinned by a
 * literal in `transform.test.ts` instead, which is what a reader can check.
 */
export function idDoMembroUnico(produtoId: string): string {
  return createHash('sha256').update(`${produtoId}|up-sole-member`).digest('hex');
}

/** `est-<produtoId>-<depositoId>` — the canonical estoque row id. */
export function idCanonicoEstoque(produtoId: string, depositoId: string): string {
  return `est-${produtoId}-${depositoId}`;
}

/* -------------------------------------------------------------------------- */
/*                                 The decision                               */
/* -------------------------------------------------------------------------- */

/**
 * Which parent rows have units to move.
 *
 * ⚠️ **The parent row is addressed by its STORED doc id, never re-derived.**
 * `upSoleMember.ts:53-60` records why: the migrated corpus holds rows at auto-ids
 * matched by `depositoOuterRef`, and `.old/…/tasks.dart:92` mints
 * `est-<depositoId>-<produtoId>` with the arguments transposed. Re-deriving would
 * patch a document that does not exist and leave the real row untouched —
 * silently doubling the stock. `predicate.ts` enumerated them; this reads what it
 * found.
 *
 * ⚠️ A row whose `depositoOuterRef` resolves to nothing is skipped: without a
 * depósito id there is no canonical child row to move it TO, and inventing one
 * would attribute stock to a depósito that does not exist. It stays on the parent,
 * visible in the Balanço, and {@link unidadesPresasSemDeposito} is what makes the
 * run REPORT it — those units are neither moved nor reserved, so without their own
 * accumulator they were counted nowhere.
 *
 * ⚠️ It takes only the CHILD id, deliberately. The parent's id was a parameter and
 * was never read — the row id comes from `linha.docId` and the child's from
 * `childId` — and in a module whose central warning is that `.old/…/tasks.dart:92`
 * passed `makeEstoqueUid`'s arguments TRANSPOSED, an unused `produtoId` sitting
 * immediately left of `childId` is that same mistake's shape, waiting.
 */
export function movimentosDeEstoque(
  childId: string,
  linhas: readonly LinhaDeposito[],
): MovimentoEstoque[] {
  const movimentos: MovimentoEstoque[] = [];
  for (const linha of linhas) {
    if (linha.depositoId == null) continue; // no depósito ⇒ nowhere to move it
    if (linha.moveria <= 0) continue;
    movimentos.push({
      docIdNoPai: linha.docId,
      depositoId: linha.depositoId,
      docIdNoFilho: idCanonicoEstoque(childId, linha.depositoId),
      quantidade: linha.moveria,
    });
  }
  return movimentos;
}

/**
 * Units the conversion can neither move nor account for as reserved: they sit on a
 * row whose `depositoOuterRef` resolves to no depósito.
 *
 * ⚠️ They are counted NOWHERE otherwise, and that is the one property the run's
 * summary promises — "every number is either work done or work LEFT". `moveria` is
 * computed from the quantities alone and never consults `depositoId`, so such a row
 * contributes to the census's `moveriaTotal` while `movimentosDeEstoque` drops it,
 * and `ficaNoPai` only ever holds `reservaEfetiva`. The line count in the warning
 * is not a substitute: one unresolvable row can hold any number of units.
 */
export function unidadesPresasSemDeposito(linhas: readonly LinhaDeposito[]): number {
  return linhas.reduce((acc, l) => (l.depositoId == null ? acc + l.moveria : acc), 0);
}

/**
 * Plan one produto's conversion, or say why it is skipped.
 *
 * ## ⚠️ Idempotence is arithmetic, not bookkeeping
 *
 * There is no "already migrated" flag, and there must not be one — a flag can
 * disagree with the data. `moveria` is `max(0, quantidade − reservaEfetiva)`
 * recomputed from the parent's CURRENT row, so after a successful run the
 * parent's quantidade equals its reserve and the same computation yields **0**:
 * a second pass moves nothing. A delta applied twice is impossible because no
 * delta is ever stored.
 *
 * ⛔ **What that does NOT buy, though the first version of this comment claimed
 * it did.** `migrate.ts` skips an already-converted produto as `ja-tem-filho`
 * BEFORE it reads any estoque row, so a second run never reaches this function
 * for that produto at all. Units booked on the parent AFTER the conversion are
 * therefore not swept up by re-running — they stay on a parent whose pointer now
 * routes every availability read to the child, which makes them invisible.
 *
 * The arithmetic below is genuinely idempotent; the PIPELINE short-circuits above
 * it. Both are correct, and only one of them was written down. Sweeping those
 * residuals is a separate pass over produtos that ALREADY have children — which
 * is exactly the census's `--target residuais` mode, and is a follow-up, not this
 * script's job.
 *
 * ## ⚠️ The reserved remainder STAYS on the parent, deliberately
 *
 * A reservation is keyed on the produto the pedido LINE names — the parent. Move
 * it and the eventual release decrements a document this script emptied, while
 * the child keeps a phantom reserve for ever (`upSoleMember.ts:243-257`). So the
 * invariant #1398 establishes is precisely *"no **available** stock on the
 * parent"*: a parent may hold a reserved remainder until its open pedido ships,
 * and moving it afterwards is a human step the report sizes.
 */
export function planejarConversao(entrada: EntradaConversao): PlanoDeConversao {
  if (entrada.produto.paiId != null) return { tipo: 'pular', motivo: 'nao-e-raiz' };
  if (entrada.temFilhos) return { tipo: 'pular', motivo: 'ja-tem-filho' };
  if (entrada.temVinculoMercadoLivre) {
    return { tipo: 'pular', motivo: 'tem-vinculo-mercado-livre' };
  }

  const childId = idDoMembroUnico(entrada.produtoId);
  return {
    tipo: 'converter',
    childId,
    // ⚠️ The SAME builder the ERP uses when a produto is born a family (#1424),
    // so a converted produto and a new one are the same shape. Writing the field
    // list again here is how the two would drift into disagreeing about what a
    // sole member carries.
    childDoc: montarMembroUnico(entrada.produtoId, entrada.produto as ParentParaMembroUnico),
    parentPatch: { filhoUnicoId: childId },
    movimentos: movimentosDeEstoque(childId, entrada.estoque.linhas),
    presasSemDeposito: unidadesPresasSemDeposito(entrada.estoque.linhas),
    ficaNoPai: entrada.estoque.ficariaNoPaiTotal,
  };
}
