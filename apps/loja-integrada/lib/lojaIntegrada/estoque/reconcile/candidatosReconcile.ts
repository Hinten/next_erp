/**
 * The daily stock reconcile's CANDIDATE LIST as one slice holds it (master plan step 12, PR 12-g):
 * the rows of the store's stock list the diff found out of step with the snapshot, kept in the run
 * document's `candidatos` until the queue phase enqueues them. Pure: no clock, no I/O.
 *
 * ## One candidate per (conta, store id)
 *
 * The store's list is read by OFFSET, and a row inserted or removed while it is read shifts the
 * rows after it, so one row may be read twice. A candidate is keyed by its conta index and store
 * id (`c`, `i`): a second sighting REPLACES the first (its `d` is the newer reading), never adds a
 * second send of one product.
 *
 * ## A byte budget, over-advertising first
 *
 * The list lives in ONE document, which the kit fan-out also reads whole for its slot, and a
 * Firestore document stops at 1 MiB. So the list is held to {@link MAX_BYTES_CANDIDATOS_RECONCILE_LI},
 * counted by Firestore's own storage formula ({@link bytesDoCandidatoLi}). A list at the budget
 * drops its LAST member in the queue's own order (`compararCandidatosEstoqueLi`: `d` descending,
 * then conta, store id, produto) — the most UNDER-advertising row — and a newcomer that would be
 * that last member is the one dropped. So an over-advertising row is never displaced by an
 * under-advertising one. Every drop is counted (`descartados`); the next night re-finds what was
 * dropped, since nothing of it was sent.
 */
import type { CandidatoReconcileEstoqueLi } from '@delfrance/schemas';

import { compararCandidatosEstoqueLi } from '../planoEstoqueLi';

/**
 * The most bytes the stored list may take: 600 000, so the run document stays far from 1 MiB even
 * with the longest ids a document may carry (about 13 000 candidates at the measured id widths).
 */
export const MAX_BYTES_CANDIDATOS_RECONCILE_LI = 600_000;

/** UTF-8 bytes of a string. */
function bytesUtf8(texto: string): number {
  return new TextEncoder().encode(texto).length;
}

/**
 * One candidate's size in a Firestore document: a map of four fields, each its name (one letter +
 * 1 byte) and its value — an integer 8 bytes, a string its UTF-8 bytes + 1. So
 * `4 × 2 + 8 + 8 + (|i| + 1) + (|p| + 1)` = 26 + |i| + |p|.
 */
export function bytesDoCandidatoLi(c: CandidatoReconcileEstoqueLi): number {
  return 26 + bytesUtf8(c.i) + bytesUtf8(c.p);
}

/** What {@link ListaCandidatosReconcileLi.adicionar} did. */
export type AdicaoCandidatoLi = 'adicionado' | 'substituido' | 'descartado';

function chave(c: Pick<CandidatoReconcileEstoqueLi, 'c' | 'i'>): string {
  return `${String(c.c)}:${c.i}`;
}

/** The list in memory (module header). */
export class ListaCandidatosReconcileLi {
  private readonly porChave = new Map<string, CandidatoReconcileEstoqueLi>();
  private readonly orcamentoBytes: number;
  private bytes = 0;
  private alterada = false;
  private descartes = 0;

  /**
   * `iniciais`: the stored list, as the slice read it (it was held to the budget when written).
   * `orcamentoBytes`: the budget (a test shrinks it).
   */
  constructor(
    iniciais: readonly CandidatoReconcileEstoqueLi[],
    orcamentoBytes: number = MAX_BYTES_CANDIDATOS_RECONCILE_LI,
  ) {
    this.orcamentoBytes = orcamentoBytes;
    for (const c of iniciais) {
      const anterior = this.porChave.get(chave(c));
      if (anterior !== undefined) this.bytes -= bytesDoCandidatoLi(anterior);
      this.porChave.set(chave(c), c);
      this.bytes += bytesDoCandidatoLi(c);
    }
  }

  /** Whether the list changed since it was read. */
  get sujo(): boolean {
    return this.alterada;
  }

  /** How many candidates this slice dropped for the budget. */
  get descartados(): number {
    return this.descartes;
  }

  /** The stored size, in bytes (module header). */
  get tamanhoBytes(): number {
    return this.bytes;
  }

  /** The list, in the order the candidates were first added (or as {@link substituir} left it). */
  lista(): CandidatoReconcileEstoqueLi[] {
    return [...this.porChave.values()];
  }

  /**
   * Replaces the whole list, in the given order — the queue phase's (`filaReconcile.ts`): sorted
   * once at its start, then shortened by what each batch enqueued. Never grows the list (the
   * queue phase only removes), so the budget holds; a repeated (conta, store id) keeps its FIRST
   * place.
   */
  substituir(nova: readonly CandidatoReconcileEstoqueLi[]): void {
    this.porChave.clear();
    this.bytes = 0;
    for (const c of nova) {
      if (this.porChave.has(chave(c))) continue;
      this.porChave.set(chave(c), c);
      this.bytes += bytesDoCandidatoLi(c);
    }
    this.alterada = true;
  }

  /** The current LAST member in the queue's order: the first to drop. */
  private ultimo(): CandidatoReconcileEstoqueLi | undefined {
    let pior: CandidatoReconcileEstoqueLi | undefined;
    for (const c of this.porChave.values()) {
      if (pior === undefined || compararCandidatosEstoqueLi(c, pior) > 0) pior = c;
    }
    return pior;
  }

  /**
   * Adds one candidate — or replaces the one of the same (conta, store id) — and then, while the
   * list is over the budget, drops its last member in the queue's order, which may be the newcomer
   * itself (module header).
   */
  adicionar(novo: CandidatoReconcileEstoqueLi): AdicaoCandidatoLi {
    const k = chave(novo);
    const anterior = this.porChave.get(k);
    if (anterior !== undefined) {
      this.porChave.delete(k);
      this.bytes -= bytesDoCandidatoLi(anterior);
    }
    this.porChave.set(k, novo);
    this.bytes += bytesDoCandidatoLi(novo);
    let resultado: AdicaoCandidatoLi = anterior === undefined ? 'adicionado' : 'substituido';
    let outrosDescartados = 0;
    while (this.bytes > this.orcamentoBytes) {
      const pior = this.ultimo();
      if (pior === undefined) break;
      this.porChave.delete(chave(pior));
      this.bytes -= bytesDoCandidatoLi(pior);
      this.descartes += 1;
      if (pior === novo) resultado = 'descartado';
      else outrosDescartados += 1;
    }
    if (resultado !== 'descartado' || anterior !== undefined || outrosDescartados > 0) {
      this.alterada = true;
    }
    return resultado;
  }
}
