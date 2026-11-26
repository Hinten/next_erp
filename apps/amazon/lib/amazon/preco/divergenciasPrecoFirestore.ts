/**
 * The PARTS of a price run (step 13, PR 13-e): the I/O of
 * `precosAmazon/{contaId}/divergenciasPrecoAmazon/{execucaoId}-{n}`, through
 * the parts handle (`divergenciaPrecoAmazonCollection`). A part is what one
 * walk page found SENDABLE — per SKU its link path, its unit, the offer and
 * the faixa the page saw, the listing's `productType` and the read instant —
 * at most 300 SKUs. The parts are DENSE: only a page with a sendable SKU writes
 * one, as part `proximaParte` of its run.
 *
 * ## The write: the HOLDING page’s overwrite by id
 *
 * {@link gravarParteDivergenciaPrecoAmazon} is a full `set` at
 * `idDivergenciaPrecoAmazon(execucaoId, n)`, made by the page that holds the
 * run, BEFORE its run update. A part's content comes from live reads, so it is
 * not deterministic: a page re-run after a crash between its part and its run
 * update must REPLACE the part it is about to count (a `create` would keep the
 * old part under the new counters), and it rewrites the SAME id. The page's
 * run check and the jobs queue's concurrency 1 make that writer unique;
 * a stale dispatch of an older run writes only its own run's ids. The members
 * are stored in SKU order (code units), so the same read writes the same part.
 * `expiraEm` is the TTL stamp, {@link RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS}
 * after the page ran: a real `Date`, a `Timestamp` on the server, because the
 * `divergenciasPrecoAmazon` policy ignores a number.
 *
 * ## The reads: by id, masked, never a query
 *
 * {@link lerParteDivergenciaPrecoAmazon} reads ONE part; {@link lerPartesDivergenciaPrecoAmazon}
 * a range `parteInicial … parteInicial + partes − 1` of one run, in `getAll`
 * calls of at most {@link MAX_PARTES_POR_LEITURA_PRECO_AMAZON} ids (a part
 * holds up to 300 members). Each read is masked to the run id and the members:
 * the TTL stamp never comes back. The run, the first part and the count come
 * from the CALLER, never from the run document a later run may already have
 * reclaimed. A missing id reads `existe: false`, no member: the caller counts
 * it (a part past its TTL), never a throw. A stored part that does not parse,
 * or that names another run than its id, throws {@link DivergenciaPrecoInvalidaError}:
 * read as empty, a send would silently drop its SKUs. Never a query: an
 * `execucaoId` filter would be unindexed, and a key-prefix range is not
 * index-bounded on Enterprise.
 *
 * ## Rule 7
 *
 * The part's tier is the holding page's overwrite above; no other module writes the
 * group. No transaction, no batch.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { divergenciaPrecoAmazonCollection } from '@delfrance/data/admin/collections';
import {
  CONTA_ID_AMAZON_REGEX,
  type ItemDivergenciaPrecoAmazon,
  RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS,
  divergenciaPrecoAmazonSchema,
  expiraEmApos,
  idDivergenciaPrecoAmazon,
} from '@delfrance/schemas';

/** The most part ids one `getAll` carries (a part holds up to 300 members). */
export const MAX_PARTES_POR_LEITURA_PRECO_AMAZON = 50;

/** The fields a reader asks for: the run the part names, and its members. */
export const CAMPOS_LEITURA_PARTE_PRECO_AMAZON = ['execucaoId', 'itens'] as const;

/** A part's fields as a reader parses them. */
const parteLidaSchema = divergenciaPrecoAmazonSchema.pick({ execucaoId: true, itens: true });

/** One part to write: the run, its number, the page's sendable SKUs and the page's clock. */
export interface ParteDivergenciaPrecoAmazon {
  readonly contaId: string;
  readonly execucaoId: string;
  /** The part's number: the run's `proximaParte` the page read. */
  readonly parte: number;
  /** At least one: a page with no sendable SKU writes no part. */
  readonly itens: readonly ItemDivergenciaPrecoAmazon[];
  /** ms — the page's clock: the TTL counts from it. */
  readonly agoraMs: number;
}

/** One part as read back. */
export interface ParteLidaPrecoAmazon {
  readonly parte: number;
  /** The id held a part; a missing one (its TTL passed) reads with no member. */
  readonly existe: boolean;
  readonly itens: readonly ItemDivergenciaPrecoAmazon[];
}

/** A stored part that no longer parses, or names another run than its id. */
export class DivergenciaPrecoInvalidaError extends Error {
  readonly contaId: string;
  readonly id: string;
  /** The top-level field names Zod blamed (or `execucaoId`) — never a value. */
  readonly campos: readonly string[];

  constructor(contaId: string, id: string, campos: readonly string[]) {
    super(
      `A parte de divergência de preço ${id} da conta ${contaId} não é válida (campos: ${campos.join(', ')}).`,
    );
    this.name = 'DivergenciaPrecoInvalidaError';
    this.contaId = contaId;
    this.id = id;
    this.campos = campos;
  }
}

/** Code-unit order (a SKU is compared as exact text). */
function porTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A conta id under its grammar, or a `RangeError` naming the rule (never the value). */
function exigirConta(contaId: string): void {
  if (typeof contaId !== 'string' || !CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('divergenciasPrecoFirestore.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
}

/**
 * Write part `parte` of the run (module header, "The write"): a full
 * OVERWRITE, its members in SKU order, its TTL stamp counted from `agoraMs`.
 *
 * @throws {RangeError} a conta or run outside its grammar, or a part number
 *   outside `0 … MAX_PARTES_EXECUCAO_PRECO_AMAZON − 1` (nothing written).
 * @throws a `ZodError` for a part the schema refuses (no member, more than 300,
 *   a member out of its shape): nothing written.
 */
export async function gravarParteDivergenciaPrecoAmazon(
  db: Firestore,
  p: ParteDivergenciaPrecoAmazon,
): Promise<void> {
  exigirConta(p.contaId);
  const id = idDivergenciaPrecoAmazon(p.execucaoId, p.parte);
  await divergenciaPrecoAmazonCollection.set(db, { contaId: p.contaId }, id, {
    execucaoId: p.execucaoId,
    itens: [...p.itens].sort((a, b) => porTexto(a.sku, b.sku)),
    expiraEm: expiraEmApos(p.agoraMs, RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS),
  });
}

/**
 * Parts `parteInicial … parteInicial + partes − 1` of one run, by id (module
 * header, "The reads"), in part order. A missing id reads `existe: false`.
 *
 * @throws {RangeError} a conta or run outside its grammar, or a range outside
 *   the run's part numbers (nothing read).
 * @throws {DivergenciaPrecoInvalidaError} a stored part that does not parse or
 *   names another run.
 */
export async function lerPartesDivergenciaPrecoAmazon(
  db: Firestore,
  e: {
    readonly contaId: string;
    /** The RUN whose parts are read. */
    readonly execucaoId: string;
    readonly parteInicial: number;
    readonly partes: number;
  },
): Promise<readonly ParteLidaPrecoAmazon[]> {
  exigirConta(e.contaId);
  if (!Number.isSafeInteger(e.partes) || e.partes < 1) {
    throw new RangeError('divergenciasPrecoFirestore.ts: partes deve ser um inteiro seguro >= 1');
  }
  if (!Number.isSafeInteger(e.parteInicial) || e.parteInicial < 0) {
    throw new RangeError(
      'divergenciasPrecoFirestore.ts: parteInicial deve ser um inteiro seguro não negativo',
    );
  }
  // Every id first: one past the run's last part refuses the whole range, nothing read.
  const ids = Array.from({ length: e.partes }, (_v, n) =>
    idDivergenciaPrecoAmazon(e.execucaoId, e.parteInicial + n),
  );
  const saida: ParteLidaPrecoAmazon[] = [];
  for (let inicio = 0; inicio < ids.length; inicio += MAX_PARTES_POR_LEITURA_PRECO_AMAZON) {
    const fatia = ids.slice(inicio, inicio + MAX_PARTES_POR_LEITURA_PRECO_AMAZON);
    const snaps = await db.getAll(
      ...fatia.map((id) => divergenciaPrecoAmazonCollection.docRef(db, { contaId: e.contaId }, id)),
      { fieldMask: [...CAMPOS_LEITURA_PARTE_PRECO_AMAZON] },
    );
    for (const [i, id] of fatia.entries()) {
      const parte = e.parteInicial + inicio + i;
      const snap = snaps[i];
      if (snap?.exists !== true) {
        saida.push({ parte, existe: false, itens: [] });
        continue;
      }
      const lido = parteLidaSchema.safeParse(snap.data());
      if (!lido.success) {
        const campos = new Set(lido.error.issues.map((x) => String(x.path[0] ?? '(raiz)')));
        throw new DivergenciaPrecoInvalidaError(e.contaId, id, [...campos].sort());
      }
      if (lido.data.execucaoId !== e.execucaoId) {
        throw new DivergenciaPrecoInvalidaError(e.contaId, id, ['execucaoId']);
      }
      saida.push({ parte, existe: true, itens: lido.data.itens });
    }
  }
  return saida;
}

/**
 * Part `parte` of one run, by id (module header, "The reads"): ONE masked read.
 *
 * @throws as {@link lerPartesDivergenciaPrecoAmazon}.
 */
export async function lerParteDivergenciaPrecoAmazon(
  db: Firestore,
  e: { readonly contaId: string; readonly execucaoId: string; readonly parte: number },
): Promise<ParteLidaPrecoAmazon> {
  const [lida] = await lerPartesDivergenciaPrecoAmazon(db, {
    contaId: e.contaId,
    execucaoId: e.execucaoId,
    parteInicial: e.parte,
    partes: 1,
  });
  if (lida === undefined) {
    throw new TypeError('divergenciasPrecoFirestore.ts: a leitura não devolveu a parte');
  }
  return lida;
}
