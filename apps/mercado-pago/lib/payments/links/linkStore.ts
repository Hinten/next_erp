import type {
  DocumentData,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';
import type { z } from 'zod';
import { coerceToMicros, nowMicros } from '@delfrance/core/datetime';
import { centavosDeReais } from '@delfrance/core/money';
import { canalDecideOEstado, isAlreadyExists } from '@delfrance/data/admin';
import {
  linkPgtoMercadoPagoCollection,
  nfev4Collection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  MOTIVO_RECUSA_LINK,
  STATUS_LINK_PAGAMENTO,
  estadoAoGerarLinkPagamento,
  estadoPedidoSchema,
  type EstadoPedido,
  type LinkPgtoMercadoPago,
  type MotivoRecusaLink,
  type StatusLinkPagamento,
  type linkPgtoMercadoPagoSchema,
} from '@delfrance/schemas';

import { avaliarElegibilidade, nfeMaisRecenteTravaPagamentos } from './elegibilidade';
import { lerLink } from './leitura';

/*
 * The ONLY place that writes the `pedidos/{id}/linkPgtoMercadoPago` documents of a
 * Mercado Pago payment link (#367) — and, with them, the one pedido `estado` flip
 * the feature makes. Both writes are decisions about money, so each is taken
 * against THIS transaction's own reads and never against a value captured before
 * an `await` (root CLAUDE.md rule 7).
 *
 * ⚠️ The Mercado Pago preferences are POSTed BEFORE this runs, never inside it: an
 * optimistic-concurrency retry re-runs the callback, and a network call in there
 * would mint a second preference on every retry. That is why the caller has to be
 * able to throw its preferences away when this refuses (see `criarLinks`), and why
 * the guard runs twice — once advisory up there, once deciding down here.
 */

/** A link the caller wants written. The doc is the shape the link collection stores. */
export interface NovoLink {
  /** The doc id — minted by the CLIENT, so a retried request reuses it. */
  linkId: string;
  /** Payments the link accepts: `1` individual, `quantidadeMaxima` shared. */
  quantidade: number;
  doc: z.input<typeof linkPgtoMercadoPagoSchema>;
}

export type ResultadoPersistencia =
  /** Every link was written; `transicao` is the estado the pedido moved to, if any. */
  | { kind: 'criado'; transicao: EstadoPedido | null }
  /** Every requested id already existed for this caller: nothing was written. */
  | { kind: 'reaproveitado'; links: Array<{ id: string; data: LinkPgtoMercadoPago }> }
  | { kind: 'recusado'; motivo: MotivoRecusaLink }
  | { kind: 'pedidoInexistente' };

/** A plain-object view of a raw value; anything else reads as empty. */
function comoRegistro(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** A snapshot as the `{ id, data }` view the pure guard takes. */
function comoLinha(snap: DocumentSnapshot): { id: string; data: unknown } {
  return { id: snap.id, data: snap.data() };
}

interface NovoLinkValidado {
  linkId: string;
  quantidade: number;
  dados: LinkPgtoMercadoPago;
}

/**
 * The verdict for requests whose ids already exist: an IDENTICAL replay (every id
 * present, each stored link created by this caller for the same amount) is handed
 * back untouched; anything else — a partial overlap, an id another operator minted,
 * a different amount — is `conflitoLinkId`. Without the ownership check a reused or
 * colliding id would return someone else's link.
 */
function veredictoDeReplay(
  armazenados: ReadonlyArray<{ id: string; data: unknown }>,
  pedidoId: string,
  criadoPorOuterRef: string,
  novos: ReadonlyArray<NovoLinkValidado>,
): ResultadoPersistencia {
  const porId = new Map<string, unknown>(armazenados.map((link) => [link.id, link.data] as const));
  const identicos = novos.every((novo) => {
    if (!porId.has(novo.linkId)) return false;
    const guardado = comoRegistro(porId.get(novo.linkId));
    return (
      guardado.criadoPorOuterRef === criadoPorOuterRef &&
      typeof guardado.valorCobrado === 'number' &&
      centavosDeReais(guardado.valorCobrado) === centavosDeReais(novo.dados.valorCobrado)
    );
  });
  if (!identicos) return { kind: 'recusado', motivo: MOTIVO_RECUSA_LINK.conflitoLinkId };
  return {
    kind: 'reaproveitado',
    links: novos.map((novo) => ({
      id: novo.linkId,
      data: linkPgtoMercadoPagoCollection.parseRead(
        porId.get(novo.linkId),
        linkPgtoMercadoPagoCollection.docPath({ pedidoId }, novo.linkId),
      ),
    })),
  };
}

/** A finite number read off a raw snapshot field, or `null` when it is anything else. */
function numeroOuNull(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * One attempt of {@link persistirLinks}. ALL reads come first (the Admin SDK
 * forbids a read after a write, and every decision must come from a read): the
 * pedido, every link, every pagamento, the integração behind the pedido's channel,
 * every NF-e. Only then are the verdict and the writes decided.
 */
async function tentarPersistir(
  tx: Transaction,
  db: Firestore,
  i: {
    pedidoId: string;
    criadoPorOuterRef: string;
    valorCobradoEsperado: number;
    agoraMs: number;
  },
  novos: ReadonlyArray<NovoLinkValidado>,
): Promise<ResultadoPersistencia> {
  const pedidoRef = pedidoCollection.docRef(db, {}, i.pedidoId);
  const pedidoSnap = await tx.get(pedidoRef);
  if (!pedidoSnap.exists) return { kind: 'pedidoInexistente' };

  const ctxLinks = { pedidoId: i.pedidoId };
  const linksSnap = await tx.get(linkPgtoMercadoPagoCollection.ref(db, ctxLinks));

  // Replay / collision. The client mints the ids, so a request that reaches us
  // twice (a lost response, a double click) names ids that already exist: an
  // identical one is answered from what is stored, and NOTHING is written.
  const idsNovos = new Set(novos.map((novo) => novo.linkId));
  const jaExistentes = linksSnap.docs.filter((d) => idsNovos.has(d.id));
  if (jaExistentes.length > 0) {
    return veredictoDeReplay(jaExistentes.map(comoLinha), i.pedidoId, i.criadoPorOuterRef, novos);
  }

  const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId: i.pedidoId }));
  // Re-derived HERE, from this transaction's read of the integração, on every
  // attempt — a value read before the transaction is exactly what a race makes stale.
  const canalMarketplace = await canalDecideOEstado(tx, db, pedidoSnap);
  const nfesSnap = await tx.get(nfev4Collection.ref(db, { pedidoId: i.pedidoId }));

  // An estado we cannot read is one we cannot say allows a link: refuse.
  const estado = estadoPedidoSchema.safeParse(pedidoSnap.get('estado'));
  if (!estado.success) return { kind: 'recusado', motivo: MOTIVO_RECUSA_LINK.estado };

  const ehSaida: unknown = pedidoSnap.get('ehSaida');
  const motivo = avaliarElegibilidade({
    pedido: {
      ehSaida: typeof ehSaida === 'boolean' ? ehSaida : null,
      estado: estado.data,
      valorCobrado: numeroOuNull(pedidoSnap.get('valorCobrado')),
      itensDevolvidos: pedidoSnap.get('itensDevolvidos'),
    },
    pagamentos: pagamentosSnap.docs.map(comoLinha),
    links: linksSnap.docs.map(comoLinha),
    canalMarketplace,
    pagamentosTravadosPorNFe: nfeMaisRecenteTravaPagamentos(
      nfesSnap.docs.map(comoLinha),
      estado.data,
    ),
    novos: novos.map((novo) => ({ valor: novo.dados.valorCobrado, quantidade: novo.quantidade })),
    valorCobradoEsperado: i.valorCobradoEsperado,
    agoraMs: i.agoraMs,
  });
  if (motivo !== null) return { kind: 'recusado', motivo };

  // `create`, never `set`: a link doc is never overwritten. Two identical requests
  // racing for the same client-minted ids contend on the same document paths.
  for (const novo of novos) {
    tx.create(
      linkPgtoMercadoPagoCollection.docRef(db, ctxLinks, novo.linkId),
      novo.dados as DocumentData,
    );
  }

  // The estado flip (owner decision): `iniciado` → `aguardandoConfirmacaoDePagamento`
  // on the FIRST link, decided on the estado this transaction just read. ONLY
  // `estado` and `ultimaModificacao` are written. The pedido editor re-baselines
  // its estado from the live snapshot, but any other field written here would be
  // read by the operator's next save as a concurrent edit (`PedidoConflictError`).
  // `ultimaModificacao` is µs and monotonic: `max(stored, now)`, so a stored value
  // in the future (or a legacy ms/ISO value, normalised by `coerceToMicros`) is
  // never moved backwards.
  //
  // Side effects, intended: `aguardandoConfirmacaoDePagamento` is a stock-RESERVING
  // estado and locks the items, and the write is made by the Admin SDK, so the
  // history trigger records a null actor ("Sistema", issue #711) — the operator is
  // kept on the link doc as `criadoPorOuterRef`.
  const transicao = estadoAoGerarLinkPagamento(estado.data);
  if (transicao !== null) {
    tx.update(pedidoRef, {
      estado: transicao,
      ultimaModificacao: Math.max(
        coerceToMicros(pedidoSnap.get('ultimaModificacao')) ?? 0,
        nowMicros(),
      ),
    });
  }
  return { kind: 'criado', transicao };
}

/**
 * Persist a batch of payment links and, on the pedido's first link, flip its
 * estado — all or nothing, in one transaction. The Mercado Pago preferences the
 * docs point at already exist; if this refuses or throws, the CALLER expires them.
 *
 * Verdicts (see {@link ResultadoPersistencia}):
 *  - `criado`         — written; `transicao` is the new estado or `null`;
 *  - `reaproveitado`  — every id already existed, created by this caller for the
 *                       same amount (a replay, or an identical twin that won the
 *                       race): the stored links are returned and nothing is written;
 *  - `recusado`       — `avaliarElegibilidade` refused on the transaction's own
 *                       reads (or an id collides with a link that is not this
 *                       caller's, or overlaps only partly);
 *  - `pedidoInexistente`.
 *
 * ⚠️ Two identical concurrent requests: the loser either retries (its read of the
 * links was overtaken) and lands on `reaproveitado`, or — if the SDK reports the
 * contention as ALREADY_EXISTS at commit instead — the narrow `isAlreadyExists`
 * catch below re-reads the winner's docs and adopts them. Anything else rethrows.
 * The pedido is not touched on either path, so the flip cannot happen twice.
 *
 * `criadoPorOuterRef` is `documents/usuarios/<uid>`; `valorCobradoEsperado` is the
 * pedido total the operator split; `agoraMs` decides which stored links have lapsed.
 */
export async function persistirLinks(
  db: Firestore,
  i: {
    pedidoId: string;
    criadoPorOuterRef: string;
    valorCobradoEsperado: number;
    agoraMs: number;
    novos: ReadonlyArray<NovoLink>;
  },
): Promise<ResultadoPersistencia> {
  // Pure checks first. An empty batch would still pass every gate below and flip
  // the estado with no link behind it: that is a bug in the caller, not a verdict.
  if (i.novos.length === 0) {
    throw new TypeError('persistirLinks needs at least one link to write.');
  }
  // A batch naming one id twice can never be written whole.
  const ids = i.novos.map((novo) => novo.linkId);
  if (new Set(ids).size !== ids.length) {
    return { kind: 'recusado', motivo: MOTIVO_RECUSA_LINK.conflitoLinkId };
  }
  // The strict write parse runs ONCE, before any read: an invalid doc is a bug in
  // the caller, and it should not spend a transaction attempt to surface.
  const novos: NovoLinkValidado[] = i.novos.map((novo) => ({
    linkId: novo.linkId,
    quantidade: novo.quantidade,
    dados: linkPgtoMercadoPagoCollection.parse(novo.doc),
  }));

  try {
    return await db.runTransaction((tx) => tentarPersistir(tx, db, i, novos));
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // An identical request won the commit race. Adopt what it wrote — if it is
    // ours to adopt — instead of reporting a failure for a link that exists.
    const docs = await Promise.all(
      novos.map((novo) =>
        linkPgtoMercadoPagoCollection.docRef(db, { pedidoId: i.pedidoId }, novo.linkId).get(),
      ),
    );
    return veredictoDeReplay(
      docs.filter((d) => d.exists).map(comoLinha),
      i.pedidoId,
      i.criadoPorOuterRef,
      novos,
    );
  }
}

export type ResultadoTerminal = 'marcado' | 'ja-terminal' | 'inexistente';

/**
 * Move a link out of `aberto` — to `concluido` (auto-closed after its quota) or
 * `cancelado` (the operator withdrew it). The Mercado Pago preference has already
 * been expired by the caller; this only records it.
 *
 * Monotonic: the transition is decided on the transaction's own read of the
 * stored status, so two racing closers (the operator's cancel and the webhook's
 * auto-close) leave ONE winner and the loser gets `ja-terminal` without writing.
 * A READABLE stored status other than `aberto` is terminal: a closed link is never
 * re-opened and never re-stamped. A doc with no `status` at all (a legacy link) —
 * or one whose `status` cannot be read — reads as `aberto`, the schema default,
 * through `lerLink`: the SAME reader the cancel and the auto-close decide on, and
 * how the tab's summary shows it (open, payable). Reading a corrupt status as
 * terminal here would split that seam: the closers would expire the preference,
 * then stand down while the doc kept looking open. Instead it is overwritten with
 * the terminal status.
 *
 * Writes ONLY `status`, `encerradoEm`, `encerradoPorOuterRef` and
 * `erroEncerramento` — a partial `update`, never a full write built from the
 * stored doc (its strict write parse would throw on a key the read parse dropped).
 * `encerradoEm` is epoch MILLISECONDS, the link collection's unit.
 */
export async function marcarLinkTerminal(
  db: Firestore,
  i: {
    pedidoId: string;
    linkId: string;
    status: Exclude<StatusLinkPagamento, typeof STATUS_LINK_PAGAMENTO.aberto>;
    encerradoEm: number;
    encerradoPorOuterRef: string | null;
    erroEncerramento: string | null;
  },
): Promise<ResultadoTerminal> {
  if ((i.status as StatusLinkPagamento) === STATUS_LINK_PAGAMENTO.aberto) {
    throw new TypeError('marcarLinkTerminal never re-opens a link: status must be terminal.');
  }
  const ref = linkPgtoMercadoPagoCollection.docRef(db, { pedidoId: i.pedidoId }, i.linkId);
  const patch = linkPgtoMercadoPagoCollection.parseMerge({
    status: i.status,
    encerradoEm: i.encerradoEm,
    encerradoPorOuterRef: i.encerradoPorOuterRef,
    erroEncerramento: i.erroEncerramento,
  }) as DocumentData;

  return db.runTransaction<ResultadoTerminal>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'inexistente';
    // Absent or unreadable ⇒ `aberto` (see the docblock): only a readable terminal
    // status stands this closer down.
    if (lerLink(snap.data()).status !== STATUS_LINK_PAGAMENTO.aberto) return 'ja-terminal';
    tx.update(ref, patch);
    return 'marcado';
  });
}
