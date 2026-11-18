/**
 * The DRIFT BLOCKS of a stock reconcile run (step 12, PR 12-f): the I/O of
 * `reconciliacaoEstoqueAmazon/{contaId}/divergenciasEstoqueAmazon/{execucaoId}-{n}`,
 * through the drift handle (`divergenciaEstoqueAmazonCollection`). A block is
 * what walk page `n` of one run found in drift — `{ sku, unidadeId,
 * quantidadeAmazon, quantidadeErp }` per SKU, at most 300 — with the depósito
 * the walk read.
 *
 * ## The write: an OVERWRITE by the page that holds the run
 *
 * {@link gravarBlocoDivergenciaEstoqueAmazon} is a full `set` at the
 * deterministic id `idDivergenciaEstoqueAmazon(execucaoId, n)`, made by the
 * page BEFORE its state update. A block's content comes from live reads, so it
 * is not deterministic: a retried page that recomputed it must REPLACE the
 * block it is about to count (a `create` would keep the old block under the
 * new counters). The page's run check (step 0) and the jobs queue's concurrency 1
 * make that writer unique, and a stale dispatch of an old run writes only its
 * own run's ids. Every block is written, an empty one included, so a retry that
 * finds no drift overwrites what a crashed attempt found. `expiraEm` is the TTL
 * stamp, {@link RETENCAO_DIVERGENCIA_ESTOQUE_AMAZON_DIAS} after the page ran (the
 * `divergenciasEstoqueAmazon` policy in `firestore.indexes.json`).
 *
 * ## The read: by id, never a query
 *
 * {@link lerBlocosDivergenciaEstoqueAmazon} reads blocks `0…partes−1` of ONE
 * run by their ids, in `getAll` calls of at most 300 ids (one call for any run
 * of up to 300 pages). `partes` comes from the CALLER — the decide step's own
 * page count, or the `feed-enviar` payload, fixed when the run decided — and
 * never from the run's document, which the next run may already have
 * reclaimed. A missing id reads as an EMPTY block. Never a query: an
 * `execucaoId` filter would be unindexed, and a key-prefix range is not
 * index-bounded on Enterprise.
 *
 * A stored block's depósito is read through the ONE parse's storable filter
 * (`depositoIdGravavelDaContaEstoqueAmazon`): a send compares it with the
 * conta's, and hands it, as the walk's depósito, to the patch tasks it writes.
 * The block schema already keeps only that grammar, so a parsed block always
 * answers its id. The writer stores the canonical ref of the id its caller read
 * through the same filter.
 *
 * ## Rule 7
 *
 * The block's tier is the page's overwrite above; no other module writes the
 * group. Units: `expiraEm` is the one non-number instant (a `Date` on write).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { divergenciaEstoqueAmazonCollection } from '@delfrance/data/admin/collections';
import {
  CONTA_ID_AMAZON_REGEX,
  type ItemDivergenciaEstoqueAmazon,
  divergenciaEstoqueAmazonSchema,
  expiraEmApos,
  idDivergenciaEstoqueAmazon,
} from '@delfrance/schemas';

import {
  depositoIdGravavelDaContaEstoqueAmazon,
  formasRefDepositoEstoqueAmazon,
} from './familiaEstoque';

/** How long a drift block lives (module header): a week outlives its run's sends. */
export const RETENCAO_DIVERGENCIA_ESTOQUE_AMAZON_DIAS = 7;

/** The most ids one `getAll` of blocks carries. */
export const MAX_BLOCOS_POR_LEITURA_ESTOQUE_AMAZON = 300;

/** One block to write: the page that found it, the walk's depósito, its drift. */
export interface BlocoDivergenciaEstoqueAmazon {
  readonly contaId: string;
  readonly execucaoId: string;
  /** The walk page the run check confirmed. */
  readonly pagina: number;
  /** The walk's depósito, as a document id (the caller's storable parse). */
  readonly depositoId: string;
  readonly itens: readonly ItemDivergenciaEstoqueAmazon[];
  /** ms — the page's clock: the TTL counts from it. */
  readonly agoraMs: number;
}

/** One block as read back. */
export interface BlocoDivergenciaLidoEstoqueAmazon {
  readonly pagina: number;
  /** The id held a block; a missing one reads as an empty block. */
  readonly existe: boolean;
  /** The walk's depósito id (the ONE parse's storable filter); `null` for a missing block. */
  readonly depositoId: string | null;
  readonly itens: readonly ItemDivergenciaEstoqueAmazon[];
}

/**
 * A stored block no longer parses, or names another run than its id: only a
 * hand edit makes one (every write here goes through the schema). Never read
 * as empty: a send would silently drop its drift.
 */
export class DivergenciaEstoqueInvalidaError extends Error {
  readonly contaId: string;
  readonly id: string;
  /** The top-level field names Zod blamed (or `execucaoId`) — never a value. */
  readonly campos: readonly string[];

  constructor(contaId: string, id: string, campos: readonly string[]) {
    super(
      `O bloco de divergência ${id} da conta ${contaId} não é válido (campos: ${campos.join(', ')}).`,
    );
    this.name = 'DivergenciaEstoqueInvalidaError';
    this.contaId = contaId;
    this.id = id;
    this.campos = campos;
  }
}

/** Code-unit order (a SKU is compared as exact bytes). */
function porTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A conta id under its grammar, or a `RangeError` naming the rule. */
function exigirConta(contaId: string): void {
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('divergenciasFirestore.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
}

/**
 * Write block `pagina` of the run (module header): a full OVERWRITE, its items
 * sorted by SKU, its TTL stamp counted from `agoraMs`.
 *
 * @throws {RangeError} a conta, run or page outside its grammar, or a depósito
 *   id that is not a document id (nothing written).
 * @throws a `ZodError` for a block the schema refuses (more than 300 items, a
 *   negative quantity): nothing written.
 */
export async function gravarBlocoDivergenciaEstoqueAmazon(
  db: Firestore,
  bloco: BlocoDivergenciaEstoqueAmazon,
): Promise<void> {
  exigirConta(bloco.contaId);
  const id = idDivergenciaEstoqueAmazon(bloco.execucaoId, bloco.pagina);
  const [canonica] = formasRefDepositoEstoqueAmazon(bloco.depositoId);
  await divergenciaEstoqueAmazonCollection.set(db, { contaId: bloco.contaId }, id, {
    execucaoId: bloco.execucaoId,
    depositoOuterRef: canonica,
    itens: [...bloco.itens].sort((a, b) => porTexto(a.sku, b.sku)),
    expiraEm: expiraEmApos(bloco.agoraMs, RETENCAO_DIVERGENCIA_ESTOQUE_AMAZON_DIAS),
  });
}

/**
 * Blocks `0…partes−1` of one run, by id (module header), in page order. A
 * missing id is an empty block.
 *
 * @throws {RangeError} a conta or run outside its grammar, or `partes` that is
 *   not a positive safe integer (nothing read).
 * @throws {DivergenciaEstoqueInvalidaError} a stored block that does not parse
 *   or names another run.
 */
export async function lerBlocosDivergenciaEstoqueAmazon(
  db: Firestore,
  e: { readonly contaId: string; readonly execucaoId: string; readonly partes: number },
): Promise<readonly BlocoDivergenciaLidoEstoqueAmazon[]> {
  exigirConta(e.contaId);
  if (!Number.isSafeInteger(e.partes) || e.partes < 1) {
    throw new RangeError('divergenciasFirestore.ts: partes deve ser um inteiro seguro >= 1');
  }
  const ids = Array.from({ length: e.partes }, (_v, n) =>
    idDivergenciaEstoqueAmazon(e.execucaoId, n),
  );
  const saida: BlocoDivergenciaLidoEstoqueAmazon[] = [];
  for (let inicio = 0; inicio < ids.length; inicio += MAX_BLOCOS_POR_LEITURA_ESTOQUE_AMAZON) {
    const fatia = ids.slice(inicio, inicio + MAX_BLOCOS_POR_LEITURA_ESTOQUE_AMAZON);
    const snaps = await db.getAll(
      ...fatia.map((id) =>
        divergenciaEstoqueAmazonCollection.docRef(db, { contaId: e.contaId }, id),
      ),
    );
    for (const [i, id] of fatia.entries()) {
      const pagina = inicio + i;
      const snap = snaps[i];
      if (snap?.exists !== true) {
        saida.push({ pagina, existe: false, depositoId: null, itens: [] });
        continue;
      }
      const lido = divergenciaEstoqueAmazonSchema.safeParse(snap.data());
      if (!lido.success) {
        const campos = new Set(lido.error.issues.map((x) => String(x.path[0] ?? '(raiz)')));
        throw new DivergenciaEstoqueInvalidaError(e.contaId, id, [...campos].sort());
      }
      const bloco = lido.data;
      if (bloco.execucaoId !== e.execucaoId) {
        throw new DivergenciaEstoqueInvalidaError(e.contaId, id, ['execucaoId']);
      }
      saida.push({
        pagina,
        existe: true,
        depositoId: depositoIdGravavelDaContaEstoqueAmazon(bloco.depositoOuterRef),
        itens: bloco.itens,
      });
    }
  }
  return saida;
}
