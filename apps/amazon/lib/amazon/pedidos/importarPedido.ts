/**
 * The Amazon order import (master plan step 5, PR 5-d; step 6, PR 6): ONE task
 * payload ⇒ the `pedidos/{digest}` document and its pagamento, the cliente and
 * its endereço, the pedido's incidentes and its avisos. It writes NOTHING to
 * Amazon; its one Amazon call (`getOrder`) goes through the context, which
 * refuses unless the read switch is exactly `on` (D11). Its only other network
 * call is the ViaCEP recovery of an endereço whose UF is unknown, through the
 * injected `deps.viaCep`.
 *
 * WIRED in PR 5-e: the seam (`DESTINO_TIPO_AMAZON` in
 * `notificacoes/destinos.ts`, read only by the functions codebase's roots)
 * holds it. This module imports its dependency and result types FROM
 * `notificacoes/notificacao.ts`, never the reverse, so the receiver's import
 * closure never reaches it (plan §3 decision 48; `estrutura.test.ts` walks that
 * closure, type edges included). A function DECLARATION, so an import cycle
 * through the seam would stay safe.
 *
 * Every rule lives in the PURE mappers beside this file (`pedidoMapeamento.ts`
 * and its modules); this one reads, calls them, and writes what they answer, in
 * this order:
 *
 *  0. **Now, ONCE**: `nowUs = agoraUsDe({ nowMs: deps.agora() })`, handed to
 *     every mapper and writer (the µs boundary keeps its three conversion sites
 *     in `avisos/avisos.ts`).
 *  1. **The read** (`lerPedidoAmazon.ts`): `getOrder`, its identity, its
 *     watermark, its lines, a lagging poll read, the BR marketplace — every
 *     refusal before any Firestore read. A foreign marketplace ⇒
 *     `marketplace-estrangeiro` (dropped).
 *  2. **The conta, UNCACHED** (`lerContaAmazon`): the operação, the freight
 *     modalidade and the document the intermediador check compares against
 *     (plan §3 decision 21: the context's 15-min copy would stamp a stale
 *     operação forever, and fill-once never corrects it). Its read time clocks
 *     the per-conta avisos.
 *  3. **The pedido and its pagamento, one `getAll`** (`S`), and the decision
 *     over `S`: a strictly newer stored watermark on a pedido this importer
 *     wrote ⇒ `obsoleto`; a first-seen order that is not imported ⇒ its motivo
 *     — each with ZERO writes of any kind (no cliente, no incidente, no aviso).
 *     A first-seen CANCELLED waits out {@link JANELA_CANCELAMENTO_RECENTE_AMAZON_US}
 *     (plan §3 decision 12): younger ⇒ `AmazonCancelamentoRecenteError`
 *     (retryable; every retry re-fetches the order and re-reads `S`, so a
 *     concurrent importer's PENDING create landing meanwhile is then cancelled
 *     by this one), older ⇒ `cancelado-nao-importado`. A first-seen order with
 *     any other reversal signal (plan §3 decision 44) waits out the SAME window
 *     for the same reason — a skip is a no-write decision no precondition can
 *     guard, and an importer still holding an older, pre-reversal read could
 *     otherwise create the pedido after the skip, with nothing re-importing the
 *     order — then ⇒ `reversao-nao-importada`. An order reversed long ago (the
 *     cutover look-back) is past the window and skipped at once.
 *  4. **The produtos** (`vinculoProdutoAmazon.ts`), reads only, for the
 *     incoming lines `S` does not already hold bound — never a SKU fallback.
 *  5. **The freight doc**: the conta's ACTIVE `amz` `int_frete`, through the
 *     app's one binding (`syncIntFreteAmazon`), raw and uncached.
 *  6. **The cliente and the endereço**, each only while `S` holds none and only
 *     for an order Amazon approved (`UNSHIPPED`, `PARTIALLY_SHIPPED`,
 *     `SHIPPED`): a PENDING order's buyer data is withheld, and the PENDING →
 *     UNSHIPPED re-fetch fills them. `findOrCreateCliente` (its own transaction
 *     in `packages/data`, inventoried there); `ClienteSemIdentidadeForteError`
 *     caught NARROWLY. The endereço: `buildEnderecoForcado`, the ViaCEP
 *     recovery for an unknown UF, then `ensureEndereco` (tier 0, never an
 *     overwrite) UNDER the cliente the pedido will carry — the stored one when
 *     there is one (an operator's included), else the one just resolved.
 *  7. **The pedido and its pagamento in ONE batch** (`escritaPedido.ts`, the
 *     rule-7 contract; the pagamento's writes from `escritaPagamento.ts`):
 *     every group re-derived from each attempt's snapshot; a lost precondition
 *     aborts and re-derives (at most 3 attempts). Steps 4–6 are NOT redone:
 *     their results reach every attempt as inputs, and the fill-once group and
 *     the PAIRING keep them only while that attempt's snapshot allows —
 *     ⚠️ never a cliente beside another cliente's endereço: the endereço is
 *     filled only when it is stored under the cliente the pedido will carry,
 *     and the cliente only when the pedido's stored freight endereço (if any) is
 *     that cliente's.
 *  8. **Incidentes, then avisos**, after the commit, on `importado` AND
 *     `sem-mudanca` (so a crash between 7 and 8 converges on the retry), NEVER
 *     on `obsoleto`; each decided from the WINNING attempt's snapshot and
 *     decision, never from `S`. Per-pedido avisos are clocked by the batch's
 *     commit `writeTime` (`importado`) or the winning snapshot's `readTime`
 *     (`sem-mudanca`); per-conta avisos by the conta read's `readTime` (plan §3
 *     decision 40).
 *  9. **The result**, with the counts for the task line.
 *
 * Steps 4–6 may write (the cliente, the endereço) before a lost race at step 7
 * ends the import; each of those writes is idempotent and pairs with nothing
 * until a batch carries it.
 *
 * ## Logs
 *
 * `evento: 'pedido'` lines (`core/log.ts`), each a CLOSED code with ids and
 * counts only — never a buyer datum, a price, a `cancelReason` or an
 * `AmazonError`'s message. The mappers' events (`decisao.eventos`) are logged
 * one line per code, so `cancelamento-parcial` (plan §3 decision 6) is countable
 * on its own; a freight event also carries the package counts, and a money
 * event (`desconto-nao-detalhado`, `imposto-destacado`, PR 5-f) the counts of
 * what the order money cannot state.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  clienteCollection,
  enderecoCollection,
  integracaoCollection,
  intFreteCollection,
} from '@delfrance/data/admin/collections';
import {
  ClienteSemIdentidadeForteError,
  findOrCreateCliente,
} from '@delfrance/data/admin/clientes';
import { ensureEndereco } from '@delfrance/data/admin/enderecos';
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  MOTIVO_CONTA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  buildEnderecoForcado,
  idFromRef,
  recoverEnderecoFromCep,
  toOuterRef,
  toOuterRefOrNull,
  type EnderecoForcado,
  type EstadoPedido,
  type MotivoContaAmazon,
  type MotivoPedidoAmazon,
  type OuterRef,
} from '@delfrance/schemas';

import {
  agoraUsDe,
  sincronizarAvisosDaContaAmazon,
  sincronizarAvisosDoPedidoAmazon,
} from '../avisos/avisos';
import { lerContaAmazon } from '../core/contas';
import type { ContextoAmazon } from '../core/contexto';
import { ContaAmazonNaoEncontradaError } from '../core/erros';
import { registrarEventoAmazon, type CamposLogAmazon, type SeveridadeAmazon } from '../core/log';
import { syncIntFreteAmazon } from '../frete/intFrete';
import type {
  DepsImportadorAmazon,
  DetalheImportacaoAmazon,
  PayloadNotificacaoAmazon,
  ResultadoImportacaoAmazon,
} from '../notificacoes/notificacao';
import {
  identidadeCompradorAmazon,
  enderecoBrutoAmazon,
  intermediadorConfere,
  registroMarketplaceAmazon,
} from './clienteAmazon';
import {
  EVENTOS_DINHEIRO_AMAZON,
  EVENTOS_FRETE_AMAZON,
  MOTIVO_NAO_IMPORTADO_AMAZON,
  type EventoPedidoAmazon,
  type MotivoNaoImportadoAmazon,
} from './codigosPedidoAmazon';
import { AmazonCancelamentoRecenteError } from './erros';
import {
  dadosDoSnapshotAmazon,
  gravarPedidoAmazon,
  lerPedidoEPagamentoAmazon,
  type DocumentoArmazenadoAmazon,
  type GravacaoPedidoAmazon,
} from './escritaPedido';
import {
  ESTADOS_TERMINAIS_AMAZON,
  MOTIVO_ESTADO_AMAZON,
  lerResumoArmazenadoAmazon,
} from './estadoPedidoAmazon';
import {
  registrarIncidentesDoPedidoAmazon,
  type LinhaSemProdutoAmazon,
} from './incidentesPedidoAmazon';
import { linhasArmazenadasAmazon, linhasRecebidasAmazon } from './itensAmazon';
import { lerPedidoAmazon } from './lerPedidoAmazon';
import { makePedidoIdAmazon } from './orderIds';
import {
  mapearPedidoAmazon,
  montarEscritaPedidoAmazon,
  type DecisaoPedidoAmazon,
  type EntradasPedidoAmazon,
} from './pedidoMapeamento';
import { faseVendaAmazon, type FaseVendaAmazon } from './vendaAmazon';
import { criarResolvedorDeVinculosAmazon, type FalhaVinculoAmazon } from './vinculoProdutoAmazon';

/**
 * How long a first-seen CANCELLED or otherwise reversed order is waited out
 * before it is skipped (plan §3 decisions 12 and 44): 15 min, above the longest fetch → commit any importer
 * can hold (the reprocess sweep's 540-s timeout; the queue's is 120 s) plus
 * margin. `functions/src/index.test.ts` pins the arithmetic against the deployed
 * options (PR 5-e).
 */
export const JANELA_CANCELAMENTO_RECENTE_AMAZON_US = 15 * 60 * 1_000_000;

/**
 * The per-pedido aviso motivos THIS import raises and resolves — all eight of
 * the tipo. The two freight motivos arrived with the package fold that derives
 * them (PR 7): `pacote-status-desconhecido` while some package is unknown or
 * unkeyed, `coleta-cancelada` while some package is `LABEL_CANCELLED` on an
 * order Amazon has not cancelled (`frete/estadoFreteAmazon.ts`), each derived
 * from the order alone so its resolve is exactly its condition ending.
 */
export const MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON: readonly MotivoPedidoAmazon[] = [
  MOTIVO_PEDIDO_AMAZON.divergenciaItens,
  MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida,
  MOTIVO_PEDIDO_AMAZON.aceitarCancelamento,
  MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp,
  MOTIVO_PEDIDO_AMAZON.statusDesconhecido,
  MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado,
  MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido,
  MOTIVO_PEDIDO_AMAZON.coletaCancelada,
];

/** The importer's OWN log codes (closed), beside the mappers' `EventoPedidoAmazon`. */
export const CODIGO_LOG_PEDIDO_AMAZON = {
  /** A sweep re-drive imported a read older than its poll payload (plan §3 decision 3). */
  leituraDefasadaAceita: 'leitura-defasada-aceita',
  /** A first-seen CANCELLED or reversed order inside the window: the import waits (a retryable throw). */
  cancelamentoRecente: 'cancelamento-recente',
  /** At least one batch lost a precondition and the import re-derived. */
  precondicaoPerdida: 'precondicao-perdida',
  /** The delivery address carries no usable CEP: no endereço stored. */
  enderecoSemCep: 'endereco-sem-cep',
  /** ViaCEP did not resolve an unknown UF: the endereço was stored as built. */
  ufNaoResolvida: 'uf-nao-resolvida',
  /** The shared cliente resolver rejected candidates or dropped fields (counts). */
  clienteComRessalvas: 'cliente-com-ressalvas',
} as const satisfies Record<string, string>;

export type CodigoLogPedidoAmazon =
  | (typeof CODIGO_LOG_PEDIDO_AMAZON)[keyof typeof CODIGO_LOG_PEDIDO_AMAZON]
  | EventoPedidoAmazon
  | MotivoNaoImportadoAmazon;

const ROTULO_LOG = '[amazon/pedido]';

/* -------------------------------------------------------------------------- */
/*                             pure decisions                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which per-pedido motivos the WINNING decision raises, and which it resolves
 * (each motivo's machine resolver, the tipo's docblock in `@delfrance/schemas`,
 * as amended 2026-10-22):
 *
 *  - every motivo the decision DERIVED is raised;
 *  - of {@link MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON}, every motivo NOT derived is
 *    resolved (the two freight motivos included: the decision derives each
 *    exactly while its condition holds — every package token known and keyed;
 *    no package `LABEL_CANCELLED`, or the order `CANCELLED`) — except:
 *     - `divergencia-itens`, which resolves ONLY on an import that judged the
 *       lines and found them agreeing with Amazon's, or found them `congelado`
 *       (`decisao.itensConferem`, PR 5-f — its documented resolver). An import
 *       that moves the estado without judging the lines resolves nothing: a
 *       reversal (D17 row 4: a `SHIPPED` read with a line cancellation still
 *       on it takes our block error to `pago`), a `SHIPPED` read whose lines
 *       still differ (row 11), a regression (row 12), an `UNFULFILLABLE` or an
 *       unknown status, a CANCELLED (the residue: a cancelled order keeps the
 *       row until an operator's edit is seen, or retention). And not while the
 *       import KEPT the stored estado either (`motivoEstado === 'manter'`: an
 *       unknown status or logistics, an AFN read, a cancellation with the goods
 *       out), whatever the lines: our block text may still stand on the pedido
 *       — past that read too: a status this code does not know never replaces
 *       the stored known one (PR 5-f, `pedidoMapeamento.ts`), so the next
 *       approved read re-judges the block as approved (D17 row 10 or 11),
 *       never as the approval moment (row 9);
 *     - `cancelado-so-no-erp` unless Amazon reports `CANCELLED` or `SHIPPED`,
 *       or the pedido is no longer terminal after this import (reopened by an
 *       operator, or resurrected by Amazon's own newer read). A PENDING, an
 *       unknown status or a request opened meanwhile leaves it as it is.
 */
export function motivosDoPedidoAmazon(e: {
  readonly decisao: Pick<DecisaoPedidoAmazon, 'avisos' | 'motivoEstado' | 'itensConferem'>;
  readonly fase: FaseVendaAmazon;
  /** The pedido's estado once this import landed (`null`: outside the enum). */
  readonly estadoFinal: EstadoPedido | null;
}): { readonly levantar: MotivoPedidoAmazon[]; readonly resolver: MotivoPedidoAmazon[] } {
  const levantar = [...e.decisao.avisos];
  const resolve = (motivo: MotivoPedidoAmazon): boolean => {
    if (motivo === MOTIVO_PEDIDO_AMAZON.divergenciaItens) {
      return e.decisao.itensConferem && e.decisao.motivoEstado !== MOTIVO_ESTADO_AMAZON.manter;
    }
    if (motivo === MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp) {
      return (
        e.fase === 'cancelado' ||
        e.fase === 'env' ||
        e.estadoFinal === null ||
        !ESTADOS_TERMINAIS_AMAZON.has(e.estadoFinal)
      );
    }
    return true;
  };
  const resolver = MOTIVOS_PEDIDO_DO_IMPORTADOR_AMAZON.filter(
    (m) => !levantar.includes(m) && resolve(m),
  );
  return { levantar, resolver };
}

/** A stored ref field: `null` when empty (absent, `null`, `''`), else the raw value. */
function armazenadoOuNulo(valor: unknown): unknown {
  return valor === null || valor === undefined || valor === '' ? null : valor;
}

/** The canonical cliente ref a stored value names, or `null` (not a `clientes/{id}`). */
export function clienteCanonicoAmazon(ref: unknown): OuterRef | null {
  const canonica = toOuterRefOrNull(ref);
  if (canonica === null) return null;
  const clienteId = idFromRef(canonica);
  if (clienteId === '') return null;
  const doCliente = toOuterRef(clienteCollection.docPath({}, clienteId));
  return doCliente === canonica ? doCliente : null;
}

/** The canonical cliente an endereço ref is stored under, or `null`. */
export function clienteDoEnderecoAmazon(ref: unknown): OuterRef | null {
  const endereco = toOuterRefOrNull(ref);
  if (endereco === null) return null;
  // `documents/clientes/<clienteId>/enderecos/<id>`.
  const clienteId = endereco.split('/')[2] ?? '';
  const enderecoId = idFromRef(endereco);
  if (clienteId === '' || enderecoId === '') return null;
  if (toOuterRef(enderecoCollection.docPath({ clienteId }, enderecoId)) !== endereco) return null;
  return toOuterRef(clienteCollection.docPath({}, clienteId));
}

function objetoOuNulo(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/** The pedido's stored freight delivery endereço, raw. */
function enderecoFreteArmazenado(armazenado: DocumentoArmazenadoAmazon | null): unknown {
  return objetoOuNulo(armazenado?.freteInicial)?.enderecoFreteOuterReference ?? null;
}

/** What steps 4–6 resolved, handed to every attempt. */
interface ResolvidoAntesDoLote {
  readonly vinculos: ReadonlyMap<string, string>;
  readonly integracaoFreteOuterRef: string | null;
  readonly clienteRef: string | null;
  readonly enderecoRef: string | null;
}

/**
 * The cliente and the endereço this import may FILL against ONE snapshot (step
 * 7's pairing, module header). PURE; asked of every attempt's snapshot.
 */
export function parClienteEnderecoAmazon(
  armazenado: DocumentoArmazenadoAmazon | null,
  resolvido: { readonly clienteRef: string | null; readonly enderecoRef: string | null },
): { readonly cliente: string | null; readonly endereco: string | null } {
  const clienteArm = armazenadoOuNulo(armazenado?.clientePedidoOuterRef);
  const enderecoArm = armazenadoOuNulo(enderecoFreteArmazenado(armazenado));
  // The cliente: only when none is stored, and only when the stored delivery
  // endereço (if any) is THAT cliente's.
  const clienteResolvido = clienteCanonicoAmazon(resolvido.clienteRef);
  const cliente =
    clienteArm === null &&
    clienteResolvido !== null &&
    (enderecoArm === null || clienteDoEnderecoAmazon(enderecoArm) === clienteResolvido)
      ? clienteResolvido
      : null;
  // The endereço: only when none is stored, and only under the cliente the
  // pedido will carry (the stored one, else the one filled above).
  const clienteDoPedido = clienteArm === null ? cliente : clienteCanonicoAmazon(clienteArm);
  const endereco =
    enderecoArm === null &&
    resolvido.enderecoRef !== null &&
    clienteDoPedido !== null &&
    clienteDoEnderecoAmazon(resolvido.enderecoRef) === clienteDoPedido
      ? resolvido.enderecoRef
      : null;
  return { cliente, endereco };
}

/** The lines the pedido holds once the winning attempt landed (its write, else its snapshot). */
function linhasFinais(gravacao: Extract<GravacaoPedidoAmazon, { escrita: unknown }>) {
  const { escrita, armazenado } = gravacao;
  if (escrita.tipo === 'criar') return linhasArmazenadasAmazon(escrita.corpo.itens);
  if (escrita.tipo === 'atualizar' && Object.hasOwn(escrita.patch, 'itens')) {
    return linhasArmazenadasAmazon(escrita.patch.itens);
  }
  return linhasArmazenadasAmazon(armazenado?.itens);
}

/** The cliente ref the pedido holds once the winning attempt landed. */
function clienteFinal(gravacao: Extract<GravacaoPedidoAmazon, { escrita: unknown }>): unknown {
  const { escrita, armazenado } = gravacao;
  if (escrita.tipo === 'criar') return escrita.corpo.clientePedidoOuterRef;
  if (escrita.tipo === 'atualizar' && Object.hasOwn(escrita.patch, 'clientePedidoOuterRef')) {
    return escrita.patch.clientePedidoOuterRef;
  }
  return armazenado?.clientePedidoOuterRef;
}

/* -------------------------------------------------------------------------- */
/*                                   logs                                     */
/* -------------------------------------------------------------------------- */

const MENSAGEM_DO_CODIGO: Readonly<Record<CodigoLogPedidoAmazon, string>> = {
  [CODIGO_LOG_PEDIDO_AMAZON.leituraDefasadaAceita]:
    'leitura mais antiga que a do poll importada na varredura',
  [CODIGO_LOG_PEDIDO_AMAZON.cancelamentoRecente]:
    'cancelamento recente de pedido nunca visto; a importação espera',
  [CODIGO_LOG_PEDIDO_AMAZON.precondicaoPerdida]:
    'o lote do pedido perdeu uma precondição e foi refeito',
  [CODIGO_LOG_PEDIDO_AMAZON.enderecoSemCep]: 'endereço de entrega sem CEP utilizável',
  [CODIGO_LOG_PEDIDO_AMAZON.ufNaoResolvida]: 'UF do endereço não resolvida pelo CEP',
  [CODIGO_LOG_PEDIDO_AMAZON.clienteComRessalvas]:
    'cliente resolvido com candidatos rejeitados ou campos descartados',
  'cancelamento-parcial': 'linha cancelada em pedido ainda a enviar; pedido bloqueado',
  ressuscitado: 'pedido cancelado pela Amazon voltou a valer',
  'preco-preenchido': 'preço zero gravado foi preenchido pela Amazon',
  'divergencia-pos-envio': 'valor de linha diferente após o envio; não aplicado',
  'medida-nao-unitaria': 'linha vendida por peso ou volume',
  'itens-armazenados-ilegiveis': 'linhas gravadas ilegíveis; mantidas como estavam',
  'frete-armazenado-ilegivel': 'frete gravado ilegível; mantido como estava',
  'pagamento-ressuscitado': 'pagamento estornado voltou a aprovado com o pedido',
  'cnpj-instituicao-recusado': 'CNPJ da instituição de pagamento recusado; gravado vazio',
  'pacote-nao-mapeado':
    'pacote com situação desconhecida ou sem referência; nenhuma situação de pacote aplicada ao frete',
  'nota-fiscal-nao-informada': 'situação da nota fiscal não informada; frete não movido',
  'nota-fiscal-nao-exigida': 'nota fiscal não exigida em pacote aguardando agendamento',
  'codRastreio-divergente': 'código de rastreio gravado substituído pelo da Amazon',
  'frete-ressuscitado': 'frete com falha voltou a um estado de envio',
  'desconto-nao-detalhado':
    'desconto sem a parte do frete separada em item com frete; confira a NF-e antes de emitir',
  'imposto-destacado': 'imposto destacado nos valores da Amazon; confira a NF-e antes de emitir',
  'cancelado-nao-importado': 'pedido nunca visto já cancelado; não importado',
  'reversao-nao-importada': 'pedido nunca visto já revertido; não importado',
};

/** One `evento: 'pedido'` line (module header): a closed code, ids and counts only. */
function registrar(
  deps: DepsImportadorAmazon,
  contaId: string,
  orderId: string,
  severidade: SeveridadeAmazon,
  codigo: CodigoLogPedidoAmazon,
  contagens: CamposLogAmazon = {},
): void {
  registrarEventoAmazon(
    deps.logger,
    'pedido',
    severidade,
    `${ROTULO_LOG} ${MENSAGEM_DO_CODIGO[codigo]}`,
    { codigo, pedido: orderId, ...contagens },
    {
      conta: contaId,
      fluxo: deps.registro.fluxo,
      tentativa: deps.registro.tentativa,
      idTarefa: deps.registro.idTarefa,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                              steps 4, 5, 6                                 */
/* -------------------------------------------------------------------------- */

/** Step 4: the link docs for the incoming lines `S` does not already hold bound. */
async function resolverProdutos(
  db: Firestore,
  contaId: string,
  order: PedidoWireAmazon,
  armazenado: DocumentoArmazenadoAmazon | null,
): Promise<{
  readonly vinculos: Map<string, string>;
  readonly falhas: Map<string, FalhaVinculoAmazon>;
}> {
  const vinculadas = new Set(
    linhasArmazenadasAmazon(armazenado?.itens)
      .filter((l) => l.produtoUid !== null && l.mktplaceId !== null)
      .map((l) => l.mktplaceId),
  );
  const resolvedor = criarResolvedorDeVinculosAmazon(db, contaId);
  const vinculos = new Map<string, string>();
  const falhas = new Map<string, FalhaVinculoAmazon>();
  for (const linha of linhasRecebidasAmazon(order)) {
    if (vinculadas.has(linha.orderItemId)) continue;
    const r = await resolvedor.resolver(linha.sku);
    if (r.produtoId === null) falhas.set(linha.orderItemId, r.via);
    else vinculos.set(linha.orderItemId, r.produtoId);
  }
  return { vinculos, falhas };
}

/** Step 6: the cliente and its endereço (module header). */
async function resolverClienteEEndereco(
  db: Firestore,
  contaId: string,
  order: PedidoWireAmazon,
  armazenado: DocumentoArmazenadoAmazon | null,
  nowMs: number,
  deps: DepsImportadorAmazon,
): Promise<{ readonly clienteRef: string | null; readonly enderecoRef: string | null }> {
  let clienteRef: string | null = null;
  const clienteArm = armazenadoOuNulo(armazenado?.clientePedidoOuterRef);
  if (clienteArm === null) {
    const identidade = identidadeCompradorAmazon(order);
    if (identidade.ok) {
      try {
        const r = await findOrCreateCliente(db, { fields: identidade.campos, nowMs });
        clienteRef = toOuterRef(clienteCollection.docPath({}, r.clienteId));
        if (r.rejected.length > 0 || r.dropped.length > 0) {
          registrar(deps, contaId, order.orderId, 'WARNING', 'cliente-com-ressalvas', {
            rejeitados: r.rejected.length,
            descartados: r.dropped.length,
          });
        }
      } catch (err) {
        // Rule 6: only the shared resolver's "no strong identity" is ours to absorb.
        if (!(err instanceof ClienteSemIdentidadeForteError)) throw err;
      }
    }
  }

  if (armazenadoOuNulo(enderecoFreteArmazenado(armazenado)) !== null) {
    return { clienteRef, enderecoRef: null };
  }
  // Stored UNDER the cliente the pedido will carry: the stored one, else this one.
  const dono =
    clienteArm === null ? clienteCanonicoAmazon(clienteRef) : clienteCanonicoAmazon(clienteArm);
  const bruto = enderecoBrutoAmazon(order);
  if (dono === null || bruto === null) return { clienteRef, enderecoRef: null };
  const construido = buildEnderecoForcado(bruto.bruto);
  if (construido.kind === 'sem-cep') {
    registrar(deps, contaId, order.orderId, 'WARNING', 'endereco-sem-cep');
    return { clienteRef, enderecoRef: null };
  }
  let campos: EnderecoForcado = construido.fields;
  if (construido.kind === 'uf-desconhecida') {
    const recuperado = await recoverEnderecoFromCep(construido, deps.viaCep);
    campos = recuperado.fields;
    if (!recuperado.ufResolvida) {
      registrar(deps, contaId, order.orderId, 'WARNING', 'uf-nao-resolvida');
    }
  }
  const clienteId = idFromRef(dono);
  const enderecoId = await ensureEndereco(db, clienteId, {
    ...campos,
    // The recipient's name for the endereço only — never the cliente's, never a document.
    nome: bruto.nomeRecebedor,
    cpf_cnpj: null,
    telefone: null,
  });
  return {
    clienteRef,
    enderecoRef: toOuterRef(enderecoCollection.docPath({ clienteId }, enderecoId)),
  };
}

/* -------------------------------------------------------------------------- */
/*                                the import                                  */
/* -------------------------------------------------------------------------- */

/** A first-seen order that is not imported: the result, after the window (step 3). */
function naoImportado(
  deps: DepsImportadorAmazon,
  contaId: string,
  orderId: string,
  motivo: MotivoNaoImportadoAmazon,
  idadeUs: number,
): ResultadoImportacaoAmazon {
  // Both motivos wait: a skip writes nothing, so no precondition can stop an
  // importer still holding an older read from creating the pedido afterwards.
  if (idadeUs < JANELA_CANCELAMENTO_RECENTE_AMAZON_US) {
    const idadeS = Math.max(0, Math.floor(idadeUs / 1_000_000));
    registrar(deps, contaId, orderId, 'WARNING', 'cancelamento-recente', { idadeS });
    throw new AmazonCancelamentoRecenteError(contaId, orderId, idadeS);
  }
  if (motivo === MOTIVO_NAO_IMPORTADO_AMAZON.canceladoNaoImportado) {
    registrar(deps, contaId, orderId, 'INFO', motivo);
    return { kind: 'cancelado-nao-importado' };
  }
  registrar(deps, contaId, orderId, 'WARNING', motivo);
  return { kind: 'reversao-nao-importada' };
}

/**
 * One Amazon order, start to finish (module header). Deterministic outcomes
 * RETURN; a refusal throws its class (`PedidoAmazonIlegivelError` parks;
 * `AmazonLeituraDefasadaError`, `AmazonPedidoEmConflitoError` and
 * `AmazonCancelamentoRecenteError` retry; anything transient rethrows).
 */
export async function importarPedidoAmazon(
  db: Firestore,
  contexto: ContextoAmazon,
  payload: PayloadNotificacaoAmazon,
  deps: DepsImportadorAmazon,
): Promise<ResultadoImportacaoAmazon> {
  // 0. Now, ONCE.
  const nowMs = deps.agora();
  const nowUs = agoraUsDe({ nowMs });
  const contaId = contexto.integracaoId;

  // 1. The read.
  const leitura = await lerPedidoAmazon(contexto, payload, deps.registro);
  if (leitura.tipo === 'marketplace-estrangeiro') return { kind: 'marketplace-estrangeiro' };
  const { order, watermarkUs } = leitura;
  const orderId = order.orderId;
  if (leitura.defasadaAceita) {
    registrar(deps, contaId, orderId, 'WARNING', 'leitura-defasada-aceita');
  }

  // 2. The conta, uncached.
  const contaLida = await lerContaAmazon(db, contaId);
  if (contaLida === null) throw new ContaAmazonNaoEncontradaError(contaId);
  const { conta } = contaLida;

  // 3. S, and the decisions that write nothing at all.
  const pedidoId = makePedidoIdAmazon(contaId, orderId);
  const primeiraLeitura = await lerPedidoEPagamentoAmazon(db, pedidoId);
  const armazenadoS = dadosDoSnapshotAmazon(primeiraLeitura.pedido);
  const integracaoPedidoOuterRef = toOuterRef(integracaoCollection.docPath({}, contaId));
  const entradasBase: Omit<
    EntradasPedidoAmazon,
    'clientePedidoOuterRef' | 'enderecoFreteOuterReference' | 'integracaoFreteOuterRef' | 'vinculos'
  > = {
    integracaoPedidoOuterRef,
    operacaoPedidoOuterRef: conta.operacaoOuterRef ?? null,
    modalidadeFreteImportacao: conta.modalidadeFreteImportacao ?? null,
  };
  const previa = montarEscritaPedidoAmazon(
    armazenadoS,
    dadosDoSnapshotAmazon(primeiraLeitura.pagamento),
    mapearPedidoAmazon(order, {
      ...entradasBase,
      clientePedidoOuterRef: null,
      enderecoFreteOuterReference: null,
      integracaoFreteOuterRef: null,
      vinculos: new Map(),
    }),
    { nowUs },
  );
  if (previa.tipo === 'obsoleto') return { kind: 'obsoleto' };
  if (previa.tipo === 'nao-importado') {
    return naoImportado(deps, contaId, orderId, previa.motivo, nowUs - watermarkUs);
  }

  // 4. The produtos.
  const produtos = await resolverProdutos(db, contaId, order, armazenadoS);
  // 5. The freight doc.
  const intFrete = await syncIntFreteAmazon.buscarIntFreteDaConta(db, contaId, {
    apenasAtivo: true,
  });
  // 6. The cliente and the endereço: an order Amazon approved, while S holds none.
  const fase = faseVendaAmazon(order.fulfillment?.fulfillmentStatus);
  const aprovadoNaAmazon = fase === 'apr' || fase === 'env';
  const clienteEEndereco = aprovadoNaAmazon
    ? await resolverClienteEEndereco(db, contaId, order, armazenadoS, nowMs, deps)
    : { clienteRef: null, enderecoRef: null };
  const resolvido: ResolvidoAntesDoLote = {
    vinculos: produtos.vinculos,
    integracaoFreteOuterRef:
      intFrete === null ? null : toOuterRef(intFreteCollection.docPath({}, intFrete.id)),
    clienteRef: clienteEEndereco.clienteRef,
    enderecoRef: clienteEEndereco.enderecoRef,
  };

  // 7. The batch — every attempt re-pairs against its own snapshot.
  const gravacao = await gravarPedidoAmazon(db, {
    contaId,
    orderId,
    pedidoId,
    primeiraLeitura,
    nowUs,
    mapear: (armazenado) => {
      const par = parClienteEnderecoAmazon(armazenado, resolvido);
      return mapearPedidoAmazon(order, {
        ...entradasBase,
        clientePedidoOuterRef: par.cliente,
        enderecoFreteOuterReference: par.endereco,
        integracaoFreteOuterRef: resolvido.integracaoFreteOuterRef,
        vinculos: resolvido.vinculos,
      });
    },
  });
  if (gravacao.tipo === 'obsoleto') return { kind: 'obsoleto' };
  if (gravacao.tipo === 'nao-importado') {
    return naoImportado(deps, contaId, orderId, gravacao.motivo, nowUs - watermarkUs);
  }
  if (gravacao.tentativas > 1) {
    registrar(deps, contaId, orderId, 'WARNING', 'precondicao-perdida', {
      tentativas: gravacao.tentativas,
    });
  }
  const { decisao } = gravacao.escrita;
  for (const evento of decisao.eventos) {
    registrar(deps, contaId, orderId, 'WARNING', evento, {
      linhasDivergentes: decisao.contagens.linhasDivergentes,
      linhasPreservadas: decisao.contagens.linhasPreservadas,
      // A freight event (PR 7) also counts the packages: counts and Amazon's
      // closed status codes only — never a token, never a tracking number.
      ...(EVENTOS_FRETE_AMAZON.has(evento)
        ? {
            pacotes: decisao.pacotes.pacotes,
            pacotesNaoMapeados: decisao.pacotes.naoMapeados,
            pacotesSemChave: decisao.pacotes.semChave,
            statusPacotes: decisao.pacotes.statusPacotes,
          }
        : {}),
      // A money event (PR 5-f) also counts what the order money cannot state:
      // lines and TAX rows — never an amount.
      ...(EVENTOS_DINHEIRO_AMAZON.has(evento)
        ? {
            linhasDescontoNaoDetalhado: decisao.ressalvasDinheiro.linhasDescontoNaoDetalhado,
            quebrasImposto: decisao.ressalvasDinheiro.quebrasImposto,
          }
        : {}),
    });
  }

  // 8. Incidentes, then avisos — from the WINNING attempt, never from S.
  const semProduto = new Map<string, LinhaSemProdutoAmazon>();
  for (const linha of linhasFinais(gravacao)) {
    if (linha.produtoUid !== null || linha.mktplaceId === null) continue;
    semProduto.set(linha.mktplaceId, {
      orderItemId: linha.mktplaceId,
      via: produtos.falhas.get(linha.mktplaceId) ?? 'unresolved',
    });
  }
  await registrarIncidentesDoPedidoAmazon(db, {
    pedidoId,
    orderId,
    linhasSemProduto: [...semProduto.values()],
    // Step 6 found no usable buyer (this import resolved none) AND the pedido the
    // winning attempt leaves holds none: another writer may have linked one, and a
    // cliente the pairing rule withheld had an identity (the text would be false).
    clienteSemIdentidade:
      aprovadoNaAmazon &&
      clienteEEndereco.clienteRef === null &&
      armazenadoOuNulo(clienteFinal(gravacao)) === null,
    codigos: decisao.incidentes,
    nowUs,
  });

  const depsDoAviso = { increment: deps.increment, nowMs, logger: deps.logger };
  const estadoFinal =
    decisao.estadoEscrito ??
    (gravacao.armazenado === null ? null : lerResumoArmazenadoAmazon(gravacao.armazenado).estado);
  const motivos = motivosDoPedidoAmazon({ decisao, fase, estadoFinal });
  await sincronizarAvisosDoPedidoAmazon(db, depsDoAviso, {
    integracaoId: contaId,
    orderId,
    pedidoId,
    levantar: motivos.levantar,
    resolver: motivos.resolver,
    // The batch's commit time, else the winning snapshot's read time (plan §3 decision 40).
    relogio: gravacao.writeTime ?? gravacao.leitura.pedido.readTime,
  });
  const motivosDaConta = motivosDaContaAmazon(
    conta.operacaoOuterRef ?? null,
    intermediadorConfere(registroMarketplaceAmazon(order), conta.cpf_cnpj ?? null),
  );
  await sincronizarAvisosDaContaAmazon(db, depsDoAviso, {
    integracaoId: contaId,
    levantar: motivosDaConta.levantar,
    resolver: motivosDaConta.resolver,
    relogio: contaLida.readTime,
  });

  // 9. The result.
  const detalhe: DetalheImportacaoAmazon = {
    acao:
      gravacao.escrita.tipo === 'criar'
        ? 'criado'
        : gravacao.escrita.tipo === 'atualizar'
          ? 'atualizado'
          : null,
    itens: decisao.itens,
    linhasPreservadas: decisao.contagens.linhasPreservadas,
    linhasDivergentes: decisao.contagens.linhasDivergentes,
    linhasSemProduto: semProduto.size,
  };
  return { kind: gravacao.tipo === 'gravado' ? 'importado' : 'sem-mudanca', detalhe };
}

/**
 * The per-conta motivos one import raises and resolves: `conta-sem-operacao`
 * by the conta read; `intermediador-divergente` by this order's verdict (no
 * verdict — the registration is absent after shipping, by design — touches
 * nothing).
 */
export function motivosDaContaAmazon(
  operacaoOuterRef: string | null,
  intermediador: ReturnType<typeof intermediadorConfere>,
): { readonly levantar: MotivoContaAmazon[]; readonly resolver: MotivoContaAmazon[] } {
  const levantar: MotivoContaAmazon[] = [];
  const resolver: MotivoContaAmazon[] = [];
  (operacaoOuterRef === null ? levantar : resolver).push(MOTIVO_CONTA_AMAZON.contaSemOperacao);
  if (intermediador === 'diverge') levantar.push(MOTIVO_CONTA_AMAZON.intermediadorDivergente);
  if (intermediador === 'confere') resolver.push(MOTIVO_CONTA_AMAZON.intermediadorDivergente);
  return { levantar, resolver };
}
