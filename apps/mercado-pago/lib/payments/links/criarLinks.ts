/**
 * `criar` — the orchestration behind `POST …/links/criar` (#367): turn a batch of
 * payers into Mercado Pago Checkout Pro preferences and persist them as
 * `linkPgtoMercadoPago` docs, flipping the pedido to `aguardandoConfirmacaoDePagamento`.
 *
 * Order matters, and it is the design:
 *
 *  1. The ACCOUNT gates come first (it must issue links, shared mode must be
 *     switched on, it must have a collector `user_id` the webhook can attribute
 *     payments by) — they cost no Mercado Pago call.
 *  2. An ADVISORY pre-check reads the pedido, its pagamentos and its links
 *     OUTSIDE any transaction: it answers a replay (every link id already
 *     exists for this caller → 200, ZERO Mercado Pago calls) and turns away the
 *     obviously ineligible before a preference is minted. It cannot decide: the
 *     marketplace channel and the NF-e lock are re-derived only inside the
 *     transaction, and everything else is re-derived there too.
 *  3. The preferences are POSTed SEQUENTIALLY, one per link, BEFORE the
 *     transaction and never inside it — an OCC retry would mint another. If link
 *     k fails, links 1..k-1 are expired (best effort) and the error goes on to
 *     the route's mapper.
 *  4. `persistirLinks` decides and writes in ONE transaction. Whatever it answers
 *     other than `criado`, the preferences minted in step 3 are expired: nobody
 *     was given them, and a live one would be payable — but ONLY those no
 *     persisted link doc carries. A preference a stored link names is reachable
 *     from the tab, and expiring it kills a link the operator already sees as
 *     payable. Two paths make that real: the Admin SDK re-running the callback
 *     after an ambiguous commit that in fact LANDED (the retry then reads our own
 *     docs as a replay), and a throw from such a commit. A throw is therefore
 *     never taken as "nothing was written": the requested docs are re-read first,
 *     and when that re-read fails nothing is expired at all.
 *
 * ⚠️ Deliberately NOT sent to Mercado Pago (see `buildPreferenceRequest`):
 * `notification_url` (it overrides the panel webhook), `back_urls`,
 * `binary_mode`, and `X-Idempotency-Key` — with step 4's cleanup an honoured key
 * could hand a retry back an already-EXPIRED preference to persist as `aberto`.
 * Idempotency lives in the ERP instead: the client mints the link ids, and a
 * retried request is a replay.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { dataCivilNoFuso, fimDoDiaNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import { centavosDeReais } from '@delfrance/core/money';
import {
  clienteCollection,
  linkPgtoMercadoPagoCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  buildPreferenceRequest,
  type MpPreference,
  type PreferenceInput,
} from '@delfrance/integrations-mercado-pago';
import {
  FUSO_FISCAL,
  LIMITES_LINK_PAGAMENTO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  STATUS_LINK_PAGAMENTO,
  TIPO_CLIENTE,
  estadoPedidoSchema,
  idFromRef,
  type CriarLinksPagamentoBodyParsed,
  type CriarLinksPagamentoResposta,
  type EstadoPedido,
  type LinkCriado,
} from '@delfrance/schemas';

import { loadMercadoPagoContext } from '../mercadoPago';
import { invalidateMercadoPagoMetodo } from '../metodoCache';
import { type FabricaApi, fabricaApiPadrao } from './api';
import { avaliarElegibilidade } from './elegibilidade';
import { expirarPreferencias } from './expirar';
import {
  comoRegistro,
  contaOuterRef,
  linkCriadoDoDoc,
  numeroOuZero,
  textoOuNull,
  userIdDaConta,
  usuarioOuterRef,
} from './leitura';
import { type NovoLink, persistirLinks, type ResultadoPersistencia } from './linkStore';
import {
  corpoInvalido,
  pedidoNaoEncontrado,
  recusaLink,
  respostaOk,
  type RespostaLink,
} from './respostas';

// Re-exported so the create flow stays the one import site for the expire body.
export { expirePatch } from './expirar';

/** Test seam: the Mercado Pago client, built from the account's live token. */
export interface CriarLinksDeps {
  api?: FabricaApi;
}

/** A preference already minted at Mercado Pago, with the request link it belongs to. */
interface PreferenciaCriada {
  link: CriarLinksPagamentoBodyParsed['links'][number];
  indice: number;
  pref: MpPreference;
}

/** The least a link's deadline may lie ahead of now: 60 minutes. */
const ANTECEDENCIA_MINIMA_MS = 60 * 60_000;

/**
 * The link deadline as epoch ms (`23:59:59` on `expiraEm` in São Paulo), or
 * `null` when the day is outside `[today, today + expiracaoDiasMax]`. Civil dates
 * are `YYYY-MM-DD`, so plain string comparison IS chronological order.
 */
function prazoDoLink(expiraEm: string, agoraMs: number): number | null {
  const hoje = dataCivilNoFuso(agoraMs, FUSO_FISCAL);
  const limite = somarDiasCivis(hoje, LIMITES_LINK_PAGAMENTO.expiracaoDiasMax);
  if (limite === null || expiraEm < hoje || expiraEm > limite) return null;
  return fimDoDiaNoFuso(expiraEm, FUSO_FISCAL);
}

/**
 * The stored links of a replay, in request order — or `null` when any of them is
 * NOT one this caller created with these amounts. A replay must never hand back
 * someone else's link (a colliding or reused id): it has to have been created by
 * the same operator, for the same amount, and be describable as a created link.
 */
function linksDeReplay(
  corpo: CriarLinksPagamentoBodyParsed,
  existentes: ReadonlyArray<{ id: string; data: unknown }>,
  criadoPorOuterRef: string,
): LinkCriado[] | null {
  const dadosPorId = new Map(
    existentes.map((existente): [string, unknown] => [existente.id, existente.data]),
  );
  const links: LinkCriado[] = [];
  for (const solicitado of corpo.links) {
    const data = dadosPorId.get(solicitado.linkId);
    if (data === undefined) return null;
    const dados = comoRegistro(data);
    if (dados.criadoPorOuterRef !== criadoPorOuterRef) return null;
    if (centavosDeReais(numeroOuZero(dados.valorCobrado)) !== centavosDeReais(solicitado.valor)) {
      return null;
    }
    const criado = linkCriadoDoDoc(solicitado.linkId, data);
    if (criado === null) return null;
    links.push(criado);
  }
  return links;
}

/**
 * Our minted preference ids that NO stored link in `links` carries (its `id`
 * FIELD, read raw) — the only ones it is safe to expire. A preference a persisted
 * doc names is a link the tab shows as payable; expiring it would kill it.
 */
function preferenciasSemLink(
  preferenceIds: ReadonlyArray<string>,
  links: ReadonlyArray<{ data: unknown }>,
): string[] {
  const guardadas = new Set<unknown>(links.map((link) => comoRegistro(link.data).id));
  return preferenceIds.filter((preferenceId) => !guardadas.has(preferenceId));
}

/**
 * Whether `guardados` is OUR OWN commit: every link of this request is stored and
 * carries the preference id THIS call minted for it. Mercado Pago mints a fresh
 * preference id on every POST, so no other request — an identical twin included —
 * can have stored one of ours: a match means the write holding it is this one.
 */
function ehNossoCommit(
  criadas: ReadonlyArray<PreferenciaCriada>,
  guardados: ReadonlyArray<{ id: string; data: unknown }>,
): boolean {
  const preferenciaPorLink = new Map(
    guardados.map((guardado): [string, unknown] => [guardado.id, comoRegistro(guardado.data).id]),
  );
  return criadas.every(({ link, pref }) => preferenciaPorLink.get(link.linkId) === pref.id);
}

/**
 * The requested link docs as they stand NOW (`{ id, data }` for each that exists),
 * plain reads outside any transaction — used only after `persistirLinks` threw, to
 * learn whether its commit landed anyway.
 */
async function lerLinksSolicitados(
  db: Firestore,
  pedidoId: string,
  linkIds: ReadonlyArray<string>,
): Promise<Array<{ id: string; data: unknown }>> {
  const snaps = await Promise.all(
    linkIds.map((linkId) => linkPgtoMercadoPagoCollection.docRef(db, { pedidoId }, linkId).get()),
  );
  return snaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, data: snap.data() }));
}

/**
 * The payer to prefill from the pedido's cliente, or `null` when there is no
 * cliente to read. Only the fields a checkout can use are copied; the foreigner
 * flag lets the builder leave out a Brazilian CPF / DDD it cannot honestly send.
 */
async function pagadorDoCliente(
  db: Firestore,
  clienteRef: string | null,
): Promise<PreferenceInput['pagador']> {
  if (clienteRef === null) return null;
  const clienteId = idFromRef(clienteRef);
  if (clienteId === '') return null;
  const snap = await clienteCollection.docRef(db, {}, clienteId).get();
  if (!snap.exists) return null;
  // Raw field reads, not a schema parse: a legacy cliente may not satisfy the
  // schema, and every part of the prefill is optional and validated by the builder.
  return {
    nome: textoOuNull(snap.get('nome')),
    email: textoOuNull(snap.get('email')),
    cpfCnpj: textoOuNull(snap.get('cpf_cnpj')),
    telefone: textoOuNull(snap.get('telefone')),
    estrangeiro: snap.get('tipo') === TIPO_CLIENTE.estrangeiro,
  };
}

export async function criarLinks(
  db: Firestore,
  i: { uid: string; corpo: CriarLinksPagamentoBodyParsed; agoraMs: number },
  deps: CriarLinksDeps = {},
): Promise<RespostaLink<CriarLinksPagamentoResposta>> {
  const { uid, corpo, agoraMs } = i;
  const criadoPorOuterRef = usuarioOuterRef(uid);

  // 1. The account. `loadMercadoPagoContext`'s own errors (no such account, not
  // a Mercado Pago one, server misconfigured) propagate to the route's mapper.
  let ctx = await loadMercadoPagoContext(db, corpo.metodoId);
  if (ctx.conta.hasLinkPagamento !== true) {
    // The account document is read through a 15-minute cache: a toggle the
    // operator just flipped may be invisible to this warm instance. Evict and
    // read once more before refusing.
    invalidateMercadoPagoMetodo(corpo.metodoId);
    ctx = await loadMercadoPagoContext(db, corpo.metodoId);
    if (ctx.conta.hasLinkPagamento !== true) return recusaLink(MOTIVO_RECUSA_LINK.metodoSemLink);
  }

  // The shared link is paid N times by people this app cannot tell apart, and
  // whether Mercado Pago accepts a second payment on one preference is settled
  // only by the live probe (P2): switched off until then, read on every call so
  // flipping the flag needs no redeploy of this code.
  if (
    corpo.modo === MODO_LINK_PAGAMENTO.compartilhado &&
    process.env.MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED !== '1'
  ) {
    return recusaLink(MOTIVO_RECUSA_LINK.compartilhadoDesabilitado);
  }

  // The webhook attributes a payment to its account by the collector `user_id`;
  // without one a paid link could never be reconciled.
  if (userIdDaConta(ctx.conta) === null) return recusaLink(MOTIVO_RECUSA_LINK.contaSemUsuario);

  // The body schema checks the date exists; only the clock can say it is in range.
  const expiraEmMs = prazoDoLink(corpo.expiraEm, agoraMs);
  if (expiraEmMs === null) {
    const dias = LIMITES_LINK_PAGAMENTO.expiracaoDiasMax;
    return corpoInvalido(`A data de expiração deve estar entre hoje e ${dias} dias.`);
  }
  // "Today" late in the evening would hand the payer a link that dies within the
  // hour — and a deadline that close to now may be refused by Mercado Pago for Pix
  // (`date_of_expiration`). Exactly `ANTECEDENCIA_MINIMA_MS` still passes.
  if (expiraEmMs - agoraMs < ANTECEDENCIA_MINIMA_MS) {
    return corpoInvalido('Escolha uma data de expiração a partir de amanhã.');
  }

  // 2. ADVISORY pre-check — plain reads, no transaction, no `where` (so no index).
  const pedidoSnap = await pedidoCollection.docRef(db, {}, corpo.pedidoId).get();
  if (!pedidoSnap.exists) return pedidoNaoEncontrado();
  const [pagamentosSnap, linksSnap] = await Promise.all([
    pagamentoCollection.ref(db, { pedidoId: corpo.pedidoId }).get(),
    linkPgtoMercadoPagoCollection.ref(db, { pedidoId: corpo.pedidoId }).get(),
  ]);
  const pagamentos = pagamentosSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const links = linksSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));

  // A request whose link ids already exist is a REPLAY (the client retried after
  // losing the response): answer with the stored links and call Mercado Pago
  // ZERO times. Anything short of "all of them, this caller's, same amounts" is a
  // collision, never a partial replay.
  const idsPedidos = new Set(corpo.links.map((link) => link.linkId));
  const existentes = links.filter((link) => idsPedidos.has(link.id));
  if (existentes.length > 0) {
    const replay =
      existentes.length === corpo.links.length
        ? linksDeReplay(corpo, existentes, criadoPorOuterRef)
        : null;
    if (replay === null) return recusaLink(MOTIVO_RECUSA_LINK.conflitoLinkId);
    return respostaOk({ links: replay, estado: null, reaproveitado: true });
  }

  // The pedido facts are read RAW and normalised exactly as the transaction does
  // (`linkStore`): the two verdicts must never disagree on how an odd document reads.
  // An estado that cannot be read cannot be said to allow a link.
  const estado = estadoPedidoSchema.safeParse(pedidoSnap.get('estado'));
  if (!estado.success) return recusaLink(MOTIVO_RECUSA_LINK.estado);
  const ehSaida: unknown = pedidoSnap.get('ehSaida');
  const valorCobrado: unknown = pedidoSnap.get('valorCobrado');

  const quantidadeMaxima =
    corpo.modo === MODO_LINK_PAGAMENTO.individual ? 1 : corpo.quantidadeMaxima;
  const motivo = avaliarElegibilidade({
    pedido: {
      ehSaida: typeof ehSaida === 'boolean' ? ehSaida : null,
      estado: estado.data,
      valorCobrado:
        typeof valorCobrado === 'number' && Number.isFinite(valorCobrado) ? valorCobrado : null,
      itensDevolvidos: pedidoSnap.get('itensDevolvidos'),
    },
    pagamentos,
    links,
    // Both are re-derived INSIDE the transaction (the integração and the newest
    // NF-e are read there); guessing them here would only produce a wrong refusal.
    canalMarketplace: false,
    pagamentosTravadosPorNFe: false,
    novos: corpo.links.map((link) => ({ valor: link.valor, quantidade: quantidadeMaxima ?? 1 })),
    valorCobradoEsperado: corpo.valorCobradoEsperado,
    agoraMs,
  });
  if (motivo !== null) return recusaLink(motivo);

  // Only a single individual link may prefill the payer (the body schema
  // enforces it). No cliente on the pedido — or none found — just means no prefill.
  const pagador = corpo.preencherPagador
    ? await pagadorDoCliente(db, textoOuNull(pedidoSnap.get('clientePedidoOuterRef')))
    : null;

  // 3. The preferences, one at a time. Sequential on purpose: a failure at link k
  // leaves exactly k-1 preferences to expire, and Mercado Pago rate-limits bursts.
  const token = await ctx.resolveAccessToken();
  const api = (deps.api ?? fabricaApiPadrao)(token);
  const criadas: PreferenciaCriada[] = [];
  for (const [indice, link] of corpo.links.entries()) {
    try {
      const pref = await api.createPreference(
        buildPreferenceRequest({
          pedidoId: corpo.pedidoId,
          numeroPedido: textoOuNull(pedidoSnap.get('numero')),
          linkId: link.linkId,
          valor: link.valor,
          nomePagador: link.nomePagador,
          expiraEmMs,
          fuso: FUSO_FISCAL,
          tiposExcluidos: corpo.tiposExcluidos,
          parcelasMaximas: corpo.parcelasMaximas,
          pagador,
        }),
      );
      criadas.push({ link, indice, pref });
    } catch (err) {
      await expirarPreferencias(
        api,
        criadas.map((criada) => criada.pref.id),
        agoraMs,
      );
      throw err;
    }
  }
  const preferenceIds = criadas.map((criada) => criada.pref.id);

  // 4. Persist — the transaction re-derives every rule this request depends on.
  const grupoId = corpo.links[0]?.linkId ?? null;
  const novos: NovoLink[] = criadas.map(({ link, indice, pref }) => ({
    linkId: link.linkId,
    quantidade: quantidadeMaxima ?? 1,
    doc: {
      contaMercadoPagoOuterRef: contaOuterRef(corpo.metodoId),
      valorCobrado: link.valor,
      link: pref.init_point,
      id: pref.id,
      dataCriacao: agoraMs,
      dataExpiracao: expiraEmMs,
      modo: corpo.modo,
      nomePagador: link.nomePagador,
      quantidadeMaxima,
      grupoId,
      ordem: indice,
      status: STATUS_LINK_PAGAMENTO.aberto,
      criadoPorOuterRef,
      tiposExcluidos: corpo.tiposExcluidos.length > 0 ? corpo.tiposExcluidos : null,
      parcelasMaximas: corpo.parcelasMaximas,
    },
  }));
  /** The 201 of a creation: the links minted HERE, and the estado the pedido moved to. */
  const respostaCriada = (estado: EstadoPedido | null): RespostaLink<CriarLinksPagamentoResposta> =>
    respostaOk(
      {
        links: criadas.map(({ link, pref }) => ({
          linkId: link.linkId,
          preferenceId: pref.id,
          link: pref.init_point,
          valorCobrado: link.valor,
          nomePagador: link.nomePagador,
          dataExpiracao: expiraEmMs,
          modo: corpo.modo,
          quantidadeMaxima,
        })),
        estado,
        reaproveitado: false,
      },
      201,
    );

  let resultado: ResultadoPersistencia;
  try {
    resultado = await persistirLinks(db, {
      pedidoId: corpo.pedidoId,
      criadoPorOuterRef,
      valorCobradoEsperado: corpo.valorCobradoEsperado,
      agoraMs,
      novos,
    });
  } catch (err) {
    // A throw is NOT proof that nothing was written: an ambiguous commit
    // (DEADLINE_EXCEEDED / UNAVAILABLE) may have landed. Look before expiring.
    let persistidos: Array<{ id: string; data: unknown }>;
    try {
      const linkIds = corpo.links.map((link) => link.linkId);
      persistidos = await lerLinksSolicitados(db, corpo.pedidoId, linkIds);
    } catch (releitura) {
      // Whether the commit landed is unknowable: expire NOTHING. An orphan
      // preference nobody holds is harmless; a dead persisted link is not.
      console.error(
        '[mercado-pago] could not re-read the links after a failed persist — expiring nothing',
        {
          pedidoId: corpo.pedidoId,
          motivo: releitura instanceof Error ? releitura.message : 'erro desconhecido',
        },
      );
      throw err;
    }
    // The commit landed: this IS the creation. Whether it flipped the estado
    // cannot be re-derived here, so it is reported as `null` — the flip, if any,
    // already happened in that commit, and the tab reads the live estado.
    if (ehNossoCommit(criadas, persistidos)) return respostaCriada(null);
    await expirarPreferencias(api, preferenciasSemLink(preferenceIds, persistidos), agoraMs);
    throw err;
  }

  switch (resultado.kind) {
    case 'criado':
      return respostaCriada(resultado.transicao);
    case 'reaproveitado': {
      // Expire only what no stored link carries (see `preferenciasSemLink`).
      await expirarPreferencias(api, preferenciasSemLink(preferenceIds, resultado.links), agoraMs);
      // The stored links carry OUR preferences: our own first commit landed, the
      // Admin SDK re-ran the transaction callback after an ambiguous commit, and
      // that second attempt read our own docs as a replay. This IS the creation.
      // The flip, if any, already happened in the landed commit and is not guessed
      // here — `estado: null`; the tab reads the live estado.
      if (ehNossoCommit(criadas, resultado.links)) return respostaCriada(null);
      // An identical twin won the race: its links are the answer, ours were surplus.
      const replay = linksDeReplay(corpo, resultado.links, criadoPorOuterRef);
      if (replay === null) return recusaLink(MOTIVO_RECUSA_LINK.conflitoLinkId);
      return respostaOk({ links: replay, estado: null, reaproveitado: true });
    }
    case 'recusado':
      await expirarPreferencias(api, preferenceIds, agoraMs);
      return recusaLink(resultado.motivo);
    case 'pedidoInexistente':
      await expirarPreferencias(api, preferenceIds, agoraMs);
      return pedidoNaoEncontrado();
  }
}
