/**
 * The Loja Integrada order import (master plan steps 5 and 6, PR 5-c): ONE
 * notification ⇒ the `pedidos/{id}` document and one `pagamentos/{id}` per
 * payment of the order. It writes NOTHING to Loja Integrada (D4), and every
 * read goes through the step-3 context, which refuses unless the read switch is
 * exactly `on` (D17). The only other network call is the CEP recovery of an
 * endereço, which runs only after a Loja Integrada read.
 *
 * ⚠️ PR 5-c builds the importer; the seam (`DESTINO_TIPO_LI` in
 * `notificacoes/notificacao.ts`) stays EMPTY until 5-d fills it.
 *
 * Every rule lives in the PURE mappers beside this file — `estadoPedidoLi.ts`,
 * `pedidoMapeamento.ts`, `itensMapeamento.ts`, `clienteMapeamento.ts`,
 * `freteMapeamento.ts`, `pagamentoMapeamento.ts`, `orderIdsLi.ts` — and this
 * module only reads, calls them, and writes what they answer, in this order:
 *
 *  1. **The detail GET.** The answer must name the numero asked for and its
 *     stamp must read (`dataLiParaMicros`) — {@link conferirDetalheLi}. The
 *     rest of step 1 waits for the hub guard (a hub's order is never keyed, so
 *     a foreign payment shape on it must not park it as a schema problem), and
 *     still runs before the first write (step 6):
 *     {@link conferirEscritasDoDetalheLi} — every key a write is built from is
 *     present and names ONE write: each line's `id` (distinct), `envios[0].id`,
 *     each payment's `id` (positive, distinct) — checked in one place
 *     (`exigirChaveDeEscritaLi`, `exigirIdPagamentoLi`), so no key is ever
 *     built out of a missing one (`String(null)` is the key `'null'`) — and the
 *     money refusals of the line and payment mappers (a line with no quantity
 *     or price, a payment with no `valor`), whose verdict depends on nothing
 *     read later. Each is a `LiSchemaError`, which parks. The notification's
 *     own stamp never decides anything.
 *  2. **The history GET**, read by `lerHistoricoLi`: STRICT on the queue's
 *     attempts 0 and 1 (a hole throws {@link LiHistoricoIncompletoError}: the
 *     task retries), degraded from attempt 2 and in every sweep run (a WARNING,
 *     an underivable date left null). So a permanent hole costs two backoffs,
 *     never a parked order.
 *  3. **The pedido snapshot `S`.** A stored watermark strictly newer ⇒
 *     `obsoleto`, with ZERO writes of any kind (avisos included).
 *  4. **The hub guard** (D5): a hub marker ⇒ `hub` — no pedido, no pagamento,
 *     the `lojaIntegradaPedidoHub` aviso (raised; resolved on a dead sale).
 *     Then the rest of step 1, for every other order.
 *  5. **The produtos** (`vinculoProdutoLi.ts`), reads only; a line the
 *     `id_externo` fallback cannot name is left unbound, never the order.
 *  6. **The freight:** the conta's Loja Integrada `int_frete`
 *     (`buscarIntFreteDaConta`, active only, through the app's one binding),
 *     step 20's `mapa` registration with `envios[0]`, the routing decision, and
 *     one read of the mapped target by id. ⚠️ An order without an endereço
 *     gets its freight amount but no carrier route, so no label is bought to an
 *     unknown address (`freteMapeamento.ts`, "No endereço, no route") — except
 *     a PICKUP (an active `retiradaNaLoja` target), which ships to nobody's
 *     address and keeps its route: the route is decided per attempt from the
 *     endereço the pedido will carry (`mapearPedido`, re-derived from `S′`), so
 *     a lost precondition never leaves a route beside another person's
 *     endereço — or beside none; a pedido whose stored endereços step 7 cannot
 *     pair with its cliente counts as one without an endereço. A route already
 *     stored is never cleared; an empty one fills once an import finds the
 *     endereço. The registration and the freight aviso
 *     (`lojaIntegradaFreteNaoSuportado`, clocked by this routing read) run
 *     HERE, on every attempt that routed — one refused at 6b, or one whose
 *     batch fails later, included — because they are about the conta's
 *     configuration, not this pedido.
 *  6b. **A PAID order with no usable delivery address** (owner decision,
 *     2026-10-19; `pedidoPagoSemEndereco.ts`): a paid codigo, a shipment, a
 *     delivery block with no CEP the endereço builder reads (exactly when step
 *     7 would store no endereço), no pickup route, and a pedido `S` that
 *     stores no endereço ⇒ {@link LiPedidoPagoSemEnderecoError}, BEFORE step
 *     7. The step-3 classifier answers `null` for it, so the run rethrows and
 *     the queue's backoff, then the hot sweep, retry it — the platform may fill
 *     the address. Step 6's registration and freight aviso are the only writes
 *     a refused attempt leaves. ⚠️ Rule 7: the last clause reads a snapshot, so
 *     the batch asks it again of EVERY attempt's (`mapearPedido`): an endereço
 *     another writer cleared since `S` refuses there, with no write. When the
 *     shared pipeline parks the row at its cap — its signal for a thrown
 *     failure parked, no counter of ours — `onRetriesExhausted` logs an ERROR
 *     line and raises the open `lojaIntegradaPedidoPagoSemEndereco` aviso,
 *     clocked by the order's stamp; step 11 of any later import that gets past
 *     this check resolves it. An unpaid order, a pickup, an order with no
 *     shipment, or a pedido that already stores an endereço imports as before.
 *  7. **The cliente and the endereço**, each only while `S` holds none: the
 *     cliente step while `S` has no cliente, the endereço step while it has no
 *     endereço and a readable cliente is known (stored, or just resolved — an
 *     endereço is always stored UNDER the cliente the pedido will carry, one an
 *     operator linked by hand included). A buyer with no strong identity and no
 *     match imports without either, plus an incidente — raised at step 11 only
 *     while the pedido the winning attempt kept still holds no cliente (another
 *     writer may have linked one).
 *     ⚠️ **Never a cliente beside another cliente's endereço**
 *     ({@link parClienteEnderecoLi}). An endereço path names its owner
 *     (`clientes/{id}/enderecos/{id}`, read by {@link clienteDoEnderecoLi};
 *     the cliente by {@link clienteCanonicoLi}). The cliente the pedido carries
 *     is the stored one — never replaced — else the one step 7 resolved, and
 *     EVERY endereço the pedido stores must be that cliente's: the fiscal one,
 *     and the freight block's delivery one, which is where a label ships (the
 *     web save checks the same two). One that is not — another owner, an owner
 *     or a stored cliente nobody can read, or no cliente at all — fails safe:
 *     no cliente is filled over it, nothing stored is replaced or deleted, no
 *     carrier route is filled (the block keeps its amount, as for a pedido
 *     without an endereço; a stored route is still never cleared), and the
 *     `li-endereco-de-outro-cliente` incidente names each endereço and why.
 *     The pairing is decided against each attempt's snapshot and the winning
 *     one, never against `S` alone, so another writer's cliente or endereço
 *     landing between the read and the batch is judged as it stands.
 *  8–10. **The pedido and its pagamentos, in ONE atomic batch**
 *     (`escritaPedido.ts`, whose header is the rule-7 contract): every write
 *     parsed before the batch, each under its own precondition; a lost one
 *     aborts the whole batch, and the retry re-reads `S′` and every pagamento
 *     and re-derives everything (at most 3 attempts). Steps 5–7 are not redone.
 *  11. **The incidentes and the order's avisos** (`incidentesPedidoLi.ts`,
 *     `avisosPedidoLi.ts`; the freight aviso ran at step 6), on `importado` and
 *     `sem-mudanca` alike — never on `obsoleto` — so a retry after a crash
 *     between 10 and 11 still writes them.
 *     The paid-without-address row resolves here on every such import.
 *     ⚠️ **A reversal on a pedido whose label was bought** (owner decision A7,
 *     2026-10-19): when the order's codigo is one of the four reversal rungs
 *     (`motivoReversaoLi`: cancelled, refunded, charged back, refunded without
 *     return) and the snapshot the WINNING attempt decided from holds a
 *     non-empty `freteInicial.printLabelId`, the
 *     `lojaIntegradaReversaoComEtiqueta` aviso is raised (plus a WARNING with
 *     ids and the code), telling the operator to cancel the Melhor Envio label
 *     and the NF-e. The estado is exactly the table's — the reversal, which
 *     the stock sync restocks, for a cancellation; the "keep both" arm and its
 *     contestado row for a refund after an applied removal — nothing here
 *     changes it. Every other import resolves the row, clocked. Residue: a
 *     label bought between that snapshot and these avisos is not seen by this
 *     import; the label step's paid re-check (master plan step 15) is the
 *     guard on that side, refusing a label for an order that is not paid.
 *
 * Steps 6 and 7 may write (the `mapa` row and the freight aviso, the cliente,
 * the endereço) before a refusal at step 8 — step 6 alone before the one at
 * 6b; each of those writes is idempotent (the aviso clocked) and safe to
 * repeat, and no pagamento is ever written without its pedido.
 *
 * ## Units
 *
 * µs end to end, as the pedido and pagamento schemas store them; ms only for
 * the cliente seam (`findOrCreateCliente`) and the avisos' "now", which
 * `avisos/avisos.ts` converts. "Now" is read ONCE per import. No unit is
 * converted here: `dataLi.ts` and `avisos/avisos.ts` are the app's two
 * converting modules (`avisos.test.ts` counts them).
 *
 * ## Logs
 *
 * Ids, codes and counts only — never a buyer's datum, a name or a value.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  clienteCollection,
  enderecoCollection,
  intFreteCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  ClienteSemIdentidadeForteError,
  findOrCreateCliente,
} from '@delfrance/data/admin/clientes';
import { ensureEndereco } from '@delfrance/data/admin/enderecos';
import {
  LiSchemaError,
  buscarPedidoLi,
  listarHistoricoSituacaoLi,
  type PedidoLi,
} from '@delfrance/integrations-loja-integrada';
import {
  STATUS_PAGAMENTO,
  idFromRef,
  recoverEnderecoFromCep,
  toOuterRef,
  toOuterRefOrNull,
  type ModalidadeFrete,
  type OuterRef,
} from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import type { ContextoLojaIntegrada } from '../core/contexto';
import { registrarFormaEnvioNoMapaLi } from '../frete/mapaFrete';
import { syncIntFreteLi } from '../frete/intFrete';
import type {
  DepsImportadorLi,
  PayloadNotificacaoLi,
  ResultadoImportacaoLi,
} from '../notificacoes/notificacao';
import {
  sincronizarAvisoDeFreteLi,
  sincronizarAvisoDeHubLi,
  sincronizarAvisosDoPedidoLi,
  type PedidoDoAvisoLi,
} from './avisosPedidoLi';
import { clienteDoPedidoLi, comRecebedorLi, enderecoDoPedidoLi } from './clienteMapeamento';
import { dataLiParaMicros, microsDeMillisLi } from './dataLi';
import {
  gravarPedidoEPagamentosLi,
  type GravacaoPedidoLi,
  type PedidoArmazenadoLi,
} from './escritaPedido';
import {
  ESTADOS_LI_TERMINAIS,
  MOTIVO_ESTADO_LI,
  alvoEstadoLi,
  lerHistoricoLi,
  modoHistoricoLi,
  motivoReversaoLi,
  type LacunaHistoricoLi,
  type LeituraHistoricoLi,
} from './estadoPedidoLi';
import {
  decidirMapaLi,
  mapearFreteLi,
  rotearFreteLi,
  type AlvoLidoLi,
  type RoteamentoFreteLi,
} from './freteMapeamento';
import {
  registrarIncidentesDoPedidoLi,
  type EnderecoNaoPareadoLi,
  type LinhaSemProdutoLi,
  type UsoEnderecoLi,
} from './incidentesPedidoLi';
import { mapearItensLi, referenciasDeProdutoLi, type ResolucaoLinhaLi } from './itensMapeamento';
import {
  CAMPO_DE_CHAVE_LI,
  exigirChaveDeEscritaLi,
  exigirIdPagamentoLi,
  idPedidoLi,
  type RespostaDoDetalheLi,
} from './orderIdsLi';
import { mapearPagamentosLi, type PagamentoMapeadoLi } from './pagamentoMapeamento';
import { LiPedidoPagoSemEnderecoError, pedidoPagoSemEnderecoLi } from './pedidoPagoSemEndereco';
import {
  idsDasLinhasLi,
  itensGuardadosLi,
  linhasJaVinculadasLi,
  mapearPedidoLi,
  watermarkArmazenadoMaisNovoLi,
  type PedidoMapeadoLi,
} from './pedidoMapeamento';
import { vazioArmazenadoLi } from './vazioArmazenado';
import { criarResolvedorDeLinhasLi, type ResolucaoProdutoLi } from './vinculoProdutoLi';

const ROTULO_LOG = '[loja-integrada/importacao]';

/** The detail GET's operation label (`buscarPedidoLi`), for a refusal's context. */
const OPERACAO_DETALHE_LI = 'buscarPedido';

/**
 * The payment-form codigo that marks a hub order (D5) — EXACT, like every
 * codigo comparison of this import.
 */
export const CODIGO_PAGAMENTO_HUB_LI = 'PAGAMENTOEXTERNO';

/* -------------------------------------------------------------------------- */
/*                                  errors                                     */
/* -------------------------------------------------------------------------- */

/**
 * Strict mode found a hole in the order's situação history (import step 2):
 * the task rethrows it — the step-3 classifier answers `null` — and the queue
 * retries, from attempt 2 in degraded mode.
 *
 * A plain `Error` (the step-3 non-route shape): about this import, never about
 * a conta. Names the holes, never a value.
 */
export class LiHistoricoIncompletoError extends Error {
  readonly integracaoId: string;
  readonly numero: number;
  readonly lacunas: readonly LacunaHistoricoLi[];

  constructor(integracaoId: string, numero: number, lacunas: readonly LacunaHistoricoLi[]) {
    super(
      `O histórico de situações do pedido ${String(numero)} da conta ${integracaoId} da Loja ` +
        `Integrada está incompleto (${lacunas.join(', ')}); a tarefa tenta de novo.`,
    );
    this.name = 'LiHistoricoIncompletoError';
    this.integracaoId = integracaoId;
    this.numero = numero;
    this.lacunas = lacunas;
  }
}

/* -------------------------------------------------------------------------- */
/*                              pure decisions                                 */
/* -------------------------------------------------------------------------- */

/**
 * A hub marker (D5): an `id_anymarket` (the wire reads `''` as `null`, so the
 * provider's "nothing" is never a marker), or a payment through the hub's form.
 * Neither `integration_data` nor the order's own `id_externo` is one.
 */
export function ehPedidoDeHubLi(pedido: PedidoLi): boolean {
  return (
    pedido.id_anymarket != null ||
    pedido.pagamentos.some((p) => p.forma_pagamento?.codigo === CODIGO_PAGAMENTO_HUB_LI)
  );
}

/** A dead sale: the shared table sends the codigo to a cancelled or refunded estado. */
export function vendaEncerradaLi(codigo: string, capturado: boolean): boolean {
  const alvo = alvoEstadoLi(codigo, capturado);
  return alvo.tipo === 'conhecido' && ESTADOS_LI_TERMINAIS.has(alvo.estado);
}

/** A placeholder decision: the payment mapper's money refusal reads none of it. */
const DECISAO_SEM_EFEITO = {
  criacao: STATUS_PAGAMENTO.pendente,
  atualizacao: { tipo: 'manter' },
} as const;

function recusaDoDetalhe(resposta: RespostaDoDetalheLi, campos: readonly string[]): LiSchemaError {
  return new LiSchemaError({ ...resposta, motivo: 'formato', campos });
}

/**
 * Import step 1, first half (module header): the answer names the numero asked
 * for and its stamp reads — the watermark in µs. Everything else of the order
 * may still be a hub's (step 4), so nothing more is refused yet.
 *
 * @throws {LiSchemaError} naming the field path, never a value.
 */
export function conferirDetalheLi(
  pedido: PedidoLi,
  numeroPedido: string,
  resposta: RespostaDoDetalheLi,
): number {
  if (String(pedido.numero) !== numeroPedido) throw recusaDoDetalhe(resposta, ['numero']);
  const watermarkUs = dataLiParaMicros(pedido.data_modificacao);
  if (watermarkUs === null) throw recusaDoDetalhe(resposta, ['data_modificacao']);
  return watermarkUs;
}

/**
 * Import step 1, second half (module header), for an order past the hub guard
 * and before its first write: every key a write is built from is present AND
 * names one write only, and the mappers' own money refusals pass.
 *
 * Two lines with one id would be one `ensureUniqueId` — the second taking the
 * first's produto — and two payments with one id one document written twice in
 * the batch, which loses its own precondition on every attempt: a retry that
 * never ends instead of a deterministic refusal.
 *
 * @throws {LiSchemaError} naming the field path, never a value.
 */
export function conferirEscritasDoDetalheLi(
  pedido: PedidoLi,
  contaId: string,
  resposta: RespostaDoDetalheLi,
  watermarkUs: number,
  nowUs: number,
): void {
  // The write keys, in ONE place — an explicit `== null` inside each helper.
  const linhas = new Set<number>();
  for (const item of pedido.itens) {
    const id = exigirChaveDeEscritaLi(item.id, CAMPO_DE_CHAVE_LI.item, resposta);
    if (linhas.has(id)) throw recusaDoDetalhe(resposta, [CAMPO_DE_CHAVE_LI.item]);
    linhas.add(id);
  }
  const envio = pedido.envios[0];
  if (envio !== undefined) exigirChaveDeEscritaLi(envio.id, CAMPO_DE_CHAVE_LI.envio, resposta);
  const pagamentosVistos = new Set<number>();
  for (const p of pedido.pagamentos) {
    const id = exigirIdPagamentoLi(p.id, resposta);
    if (pagamentosVistos.has(id)) throw recusaDoDetalhe(resposta, [CAMPO_DE_CHAVE_LI.pagamento]);
    pagamentosVistos.add(id);
  }

  // The mappers' own money refusals: neither depends on anything read later.
  const mapeadas = mapearItensLi({
    itens: pedido.itens,
    valorSubtotal: pedido.valor_subtotal,
    resolucoes: new Map(),
    nowUs,
  });
  if (!mapeadas.ok) throw recusaDoDetalhe(resposta, mapeadas.campos);
  const pagamentos = mapearPagamentosLi({
    contaId,
    pedido,
    statusPagamento: DECISAO_SEM_EFEITO,
    dataAprovacao: { derivavel: false },
    dataCancelamento: { derivavel: false },
    watermarkUs,
  });
  if (!pagamentos.ok) throw recusaDoDetalhe(resposta, pagamentos.campos);
}

/** The operator-facing store name: the conta's `nome`, else its id. */
function lojaNomeDe(contexto: ContextoLojaIntegrada): string {
  return contexto.conta.nome === '' ? contexto.integracaoId : contexto.conta.nome;
}

/* -------------------------------------------------------------------------- */
/*                         one-per-process log lines                           */
/* -------------------------------------------------------------------------- */

/** Contas already warned about the modalidade override on this instance. */
const contasComModalidadeAvisada = new Set<string>();
/** Payment codigos already logged as an unknown forma on this instance. */
const codigosDeFormaDesconhecidaLogados = new Set<string>();

/** Test-only: the two once-per-instance log memos start empty again. */
export function __limparRegistrosUnicosParaTestes(): void {
  contasComModalidadeAvisada.clear();
  codigosDeFormaDesconhecidaLogados.clear();
}

/* -------------------------------------------------------------------------- */
/*                              steps 5, 6 and 7                               */
/* -------------------------------------------------------------------------- */

/** Step 6's result: what the freight mapper needs, and the aviso's clock. */
interface FreteResolvidoLi {
  readonly roteamento: RoteamentoFreteLi;
  /** The µs `readTime` the routing decided from, or `null` when nothing was read by id. */
  readonly relogioUs: number | null;
  /** The conta's Loja Integrada `int_frete` `horarioDeCorte`, raw. */
  readonly horarioDeCorte: unknown;
}

async function resolverFreteLi(
  db: Firestore,
  contexto: ContextoLojaIntegrada,
  pedido: PedidoLi,
  deps: DepsImportadorLi,
): Promise<FreteResolvidoLi | null> {
  const envio = pedido.envios[0];
  if (envio === undefined) return null;
  const integracaoId = contexto.integracaoId;
  const achado = await syncIntFreteLi.buscarIntFreteDaConta(db, integracaoId, {
    apenasAtivo: true,
  });
  const registro =
    achado === null
      ? null
      : await registrarFormaEnvioNoMapaLi(
          db,
          {
            integracaoId,
            intFreteId: achado.id,
            formaEnvio: envio.forma_envio,
            numero: pedido.numero,
          },
          { arrayUnion: deps.arrayUnion, logger: deps.logger },
        );
  const decisao = decidirMapaLi({
    intFreteLiId: achado?.id ?? null,
    registro,
    formaEnvio: envio.forma_envio,
  });
  let alvo: AlvoLidoLi | null = null;
  let relogioUs = registro?.lidoEmUs ?? null;
  if (decisao.tipo === 'mapeado') {
    const snap = await intFreteCollection.docRef(db, {}, decisao.alvoId).get();
    alvo = {
      existe: snap.exists,
      dados: snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
    };
    // The target read IS the observation the routing decides from.
    relogioUs = relogioDoDocumentoUs(snap.readTime);
  }
  const roteamento = rotearFreteLi({ intFreteLiId: achado?.id ?? null, decisao, alvo });
  if (roteamento.deliberado) {
    deps.logger?.info?.(`${ROTULO_LOG} forma de envio mapeada para fob/outros; frete da conta`, {
      integracaoId,
      numero: pedido.numero,
    });
  }
  return { roteamento, relogioUs, horarioDeCorte: achado?.data.horarioDeCorte ?? null };
}

/** Step 7's result. */
export interface ClienteResolvidoLi {
  /** The cliente THIS run resolved (`null`: none ran, or no identity). */
  readonly clienteRef: string | null;
  /** The endereço THIS run stored (canonical), under the cliente its path names. */
  readonly endereco: { readonly ref: string } | null;
  /** The buyer had no strong identity and matched no cliente. */
  readonly semIdentidade: boolean;
}

/** A stored ref read as present text, absent (`null`), or present but unusable (`undefined`). */
function refArmazenada(valor: unknown): string | null | undefined {
  if (vazioArmazenadoLi(valor)) return null;
  return typeof valor === 'string' ? valor : undefined;
}

/** The freight block's stored delivery endereço (the one a label ships to), raw. */
function entregaArmazenada(armazenado: PedidoArmazenadoLi | null): unknown {
  const frete = armazenado?.freteInicial;
  return typeof frete === 'object' && frete !== null && !Array.isArray(frete)
    ? (frete as Readonly<Record<string, unknown>>).enderecoFreteOuterReference
    : null;
}

/**
 * The pedido holds a BOUGHT label: its freight block's `printLabelId` is
 * stored and not empty (`vazioArmazenadoLi`) — the Melhor Envio purchase's own
 * write, which this import never makes nor clears.
 */
function etiquetaCompradaLi(armazenado: PedidoArmazenadoLi | null): boolean {
  const frete = armazenado?.freteInicial;
  return (
    typeof frete === 'object' &&
    frete !== null &&
    !Array.isArray(frete) &&
    !vazioArmazenadoLi((frete as Readonly<Record<string, unknown>>).printLabelId)
  );
}

/**
 * The canonical ref of a stored cliente ref (`clientes/{id}`, in either stored
 * form), or `null` when the value names no cliente — one nobody can read,
 * which owns NO endereço (step 7).
 */
export function clienteCanonicoLi(ref: unknown): OuterRef | null {
  const canonica = toOuterRefOrNull(ref);
  if (canonica === null) return null;
  const clienteId = idFromRef(canonica);
  if (clienteId === '') return null;
  // Rebuilt through the collection's own path: any other shape is no cliente.
  const doCliente = toOuterRef(clienteCollection.docPath({}, clienteId));
  return doCliente === canonica ? doCliente : null;
}

/**
 * The canonical ref of the cliente an endereço ref is stored under
 * (`clientes/{clienteId}/enderecos/{id}`, in either stored form), or `null`
 * when the value names no cliente's endereço — an owner nobody can read, which
 * matches NO cliente (step 7).
 */
export function clienteDoEnderecoLi(ref: unknown): OuterRef | null {
  const endereco = toOuterRefOrNull(ref);
  if (endereco === null) return null;
  // `documents/<collection>/<id>/…`: the first document id is the candidate owner.
  const clienteId = endereco.split('/')[2] ?? '';
  const enderecoId = idFromRef(endereco);
  if (clienteId === '' || enderecoId === '') return null;
  // Rebuilt through the collections' own paths: any other shape is no cliente's endereço.
  if (toOuterRef(enderecoCollection.docPath({ clienteId }, enderecoId)) !== endereco) return null;
  return toOuterRef(clienteCollection.docPath({}, clienteId));
}

/** The refs the pedido carries against ONE snapshot (step 7), and the endereço a label may use. */
export interface ParClienteEnderecoLi {
  /** The cliente ref this import may FILL (fill-once: a stored one always wins). */
  readonly clientePedidoOuterRef: string | null;
  /** The endereço ref this import may FILL (fill-once: a stored one always wins). */
  readonly enderecoFiscalOuterRef: string | null;
  /** The endereço the freight may route to, or `null`: no carrier route (`freteMapeamento.ts`). */
  readonly enderecoDaRota: string | null;
  /**
   * A stored endereço (fiscal or delivery) that does not pair with the cliente
   * the pedido carries: the `li-endereco-de-outro-cliente` incidente.
   */
  readonly enderecoNaoPareado: EnderecoNaoPareadoLi | null;
}

/**
 * Step 7's pairing against one snapshot (module header): an endereço the
 * pedido stores — the fiscal one, or the freight block's delivery one, which
 * is where a label ships — and the cliente it carries may never belong to two
 * different clientes. PURE, and asked of EVERY attempt's snapshot and of the
 * winning one — nothing here is captured before the batch loop.
 *
 * The cliente the pedido carries is the stored one (never replaced), else the
 * one step 7 resolved. Each stored endereço must be stored under THAT cliente,
 * read through {@link clienteDoEnderecoLi} and {@link clienteCanonicoLi}; a
 * value either reader cannot read matches nothing. When every stored endereço
 * pairs: the cliente, the stored fiscal endereço or else the one step 7 stored
 * under that cliente, and a route to it in canonical form (the freight
 * schema's). When one does not — another owner, an owner or a cliente nobody
 * can read, or no cliente at all — the import fails SAFE: no cliente is filled
 * over it, nothing stored is replaced, no carrier route is filled (exactly as
 * a pedido without an endereço; a stored route is still never cleared), and
 * the operator gets the incidente. The one thing still filled is step 7's
 * fiscal endereço beside a STORED cliente: it is stored under that cliente, so
 * it pairs.
 */
export function parClienteEnderecoLi(
  armazenado: PedidoArmazenadoLi | null,
  resolvido: Pick<ClienteResolvidoLi, 'clienteRef' | 'endereco'>,
): ParClienteEnderecoLi {
  const clienteArm = refArmazenada(armazenado?.clientePedidoOuterRef);
  const fiscalArm = refArmazenada(armazenado?.enderecoFiscalOuterRef);
  const entregaArm = refArmazenada(entregaArmazenada(armazenado));

  // The cliente the pedido carries: the stored one, else the one step 7 resolved.
  const clienteGuardado = clienteArm !== null;
  const cliente = clienteGuardado ? (clienteArm ?? null) : resolvido.clienteRef;
  const clienteLido = clienteCanonicoLi(cliente);
  /** An endereço is the carried cliente's only when both are read and its path names that cliente. */
  const doCliente = (endereco: unknown): boolean =>
    clienteLido !== null && clienteDoEnderecoLi(endereco) === clienteLido;
  /** Step 7's endereço, only beside the cliente its path names. */
  const enderecoResolvido =
    resolvido.endereco !== null && doCliente(resolvido.endereco.ref)
      ? resolvido.endereco.ref
      : null;

  const guardados: [UsoEnderecoLi, string | undefined][] = [];
  if (fiscalArm !== null) guardados.push(['fiscal', fiscalArm]);
  if (entregaArm !== null) guardados.push(['entrega', entregaArm]);
  const naoPareados = guardados.filter(([, endereco]) => !doCliente(endereco));

  if (naoPareados.length === 0) {
    // Every stored endereço pairs; the route goes to the fiscal one in canonical form.
    const fiscal = fiscalArm !== null ? toOuterRefOrNull(fiscalArm) : enderecoResolvido;
    return {
      clientePedidoOuterRef: cliente,
      enderecoFiscalOuterRef: fiscal,
      enderecoDaRota: fiscal,
      enderecoNaoPareado: null,
    };
  }
  return {
    // Fill-once keeps the stored cliente; none is filled over another cliente's endereço.
    clientePedidoOuterRef: clienteGuardado ? cliente : null,
    enderecoFiscalOuterRef: fiscalArm !== null || !clienteGuardado ? null : enderecoResolvido,
    enderecoDaRota: null,
    enderecoNaoPareado: {
      cliente:
        clienteLido !== null
          ? clienteGuardado
            ? 'armazenado'
            : 'resolvido'
          : clienteGuardado
            ? 'ilegivel'
            : 'ausente',
      enderecos: naoPareados.map(([uso, endereco]) => ({
        uso,
        donoLegivel: clienteDoEnderecoLi(endereco) !== null,
      })),
    },
  };
}

async function resolverClienteEEnderecoLi(
  db: Firestore,
  armazenado: PedidoArmazenadoLi | null,
  pedido: PedidoLi,
  nowMs: number,
  deps: DepsImportadorLi,
  log: Readonly<Record<string, unknown>>,
): Promise<ClienteResolvidoLi> {
  let clienteRef: string | null = null;
  let semIdentidade = false;
  const clienteArmazenado = refArmazenada(armazenado?.clientePedidoOuterRef);
  if (clienteArmazenado === null) {
    try {
      const r = await findOrCreateCliente(db, {
        fields: clienteDoPedidoLi(pedido.cliente).campos,
        nowMs,
      });
      clienteRef = toOuterRef(clienteCollection.docPath({}, r.clienteId));
      if (r.rejected.length > 0 || r.dropped.length > 0) {
        deps.logger?.warn(`${ROTULO_LOG} candidatos a cliente rejeitados ou campos descartados`, {
          ...log,
          rejeitados: r.rejected.length,
          descartados: r.dropped.length,
        });
      }
    } catch (err) {
      if (!(err instanceof ClienteSemIdentidadeForteError)) throw err;
      semIdentidade = true;
    }
  }

  // The endereço: while none is stored, under the cliente the pedido will carry — one
  // whose ref reads as a cliente (an unreadable stored one owns no endereço).
  let endereco: ClienteResolvidoLi['endereco'] = null;
  const clienteDoEndereco = clienteCanonicoLi(
    clienteArmazenado === null ? clienteRef : clienteArmazenado,
  );
  if (refArmazenada(armazenado?.enderecoFiscalOuterRef) === null && clienteDoEndereco !== null) {
    const clienteId = idFromRef(clienteDoEndereco);
    const outcome = enderecoDoPedidoLi(pedido.endereco_entrega);
    if (outcome.kind === 'sem-cep') {
      deps.logger?.warn(`${ROTULO_LOG} endereço sem CEP; pedido sem endereço fiscal por ora`, log);
    } else {
      let campos = outcome.fields;
      if (outcome.kind === 'uf-desconhecida') {
        const recuperado = await recoverEnderecoFromCep(outcome, deps.viaCep);
        campos = recuperado.fields;
        if (!recuperado.ufResolvida) {
          deps.logger?.warn(`${ROTULO_LOG} UF não resolvida pelo CEP; endereço gravado assim`, log);
        }
      }
      const enderecoId = await ensureEndereco(
        db,
        clienteId,
        comRecebedorLi(campos, pedido.endereco_entrega),
      );
      endereco = { ref: toOuterRef(enderecoCollection.docPath({ clienteId }, enderecoId)) };
    }
  }
  return { clienteRef, endereco, semIdentidade };
}

/* -------------------------------------------------------------------------- */
/*                                the import                                   */
/* -------------------------------------------------------------------------- */

/**
 * One Loja Integrada order, start to finish (module header). Deterministic
 * outcomes RETURN; a refusal throws its class for the step-3 classifier
 * (`LiSchemaError` and `ZodError` park; {@link LiHistoricoIncompletoError},
 * `LiPedidoEmConflitoError` and {@link LiPedidoPagoSemEnderecoError} retry;
 * anything transient rethrows).
 */
export async function importarPedidoLi(
  db: Firestore,
  contexto: ContextoLojaIntegrada,
  payload: PayloadNotificacaoLi,
  deps: DepsImportadorLi,
): Promise<ResultadoImportacaoLi> {
  const { integracaoId, conta, cliente } = contexto;
  const nowMs = deps.agoraMs();
  const nowUs = microsDeMillisLi(nowMs);
  const log = { integracaoId, numero: payload.numero };

  // 1. The detail: its numero and its stamp (the rest after the hub guard).
  const resposta = await buscarPedidoLi(cliente, payload.numero);
  const pedido = resposta.dados;
  const doDetalhe: RespostaDoDetalheLi = {
    operacao: OPERACAO_DETALHE_LI,
    caminho: `/v1/pedido/${payload.numero}/`,
    correlationId: resposta.correlationId,
    refCredencial: resposta.refCredencial,
    status: resposta.status,
  };
  const watermarkUs = conferirDetalheLi(pedido, payload.numero, doDetalhe);

  // 2. The history.
  const historico = await listarHistoricoSituacaoLi(cliente, pedido.numero);
  const h: LeituraHistoricoLi = lerHistoricoLi({
    numero: pedido.numero,
    codigoDetalhe: pedido.situacao.codigo,
    linhas: historico.linhas,
    modo: modoHistoricoLi(deps.tentativa),
  });
  if (!h.ok) throw new LiHistoricoIncompletoError(integracaoId, pedido.numero, h.lacunas);
  if (h.lacunas.length > 0) {
    deps.logger?.warn(`${ROTULO_LOG} histórico com lacunas; datas não deriváveis ficam nulas`, {
      ...log,
      lacunas: h.lacunas,
    });
  }

  // 3. The pedido snapshot: a strictly newer stored stamp writes nothing at all.
  const pedidoId = idPedidoLi(integracaoId, pedido.numero);
  const primeiraLeitura = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const armazenado = primeiraLeitura.exists
    ? ((primeiraLeitura.data() ?? {}) as PedidoArmazenadoLi)
    : null;
  if (armazenado !== null && watermarkArmazenadoMaisNovoLi(armazenado, watermarkUs) !== null) {
    return { kind: 'obsoleto' };
  }
  const doAviso: PedidoDoAvisoLi = {
    integracaoId,
    lojaNome: lojaNomeDe(contexto),
    pedidoId,
    numero: String(pedido.numero),
    relogioUs: watermarkUs,
  };
  const depsDoAviso = { increment: deps.increment, nowMs, logger: deps.logger };

  // 4. The hub guard.
  if (ehPedidoDeHubLi(pedido)) {
    await sincronizarAvisoDeHubLi(
      db,
      doAviso,
      vendaEncerradaLi(pedido.situacao.codigo, h.capturado),
      depsDoAviso,
    );
    deps.logger?.warn(`${ROTULO_LOG} pedido com marca de hub; não importado`, log);
    return { kind: 'hub' };
  }

  // 1, second half: the write keys and the money, refused before the first write (step 6).
  conferirEscritasDoDetalheLi(pedido, integracaoId, doDetalhe, watermarkUs, nowUs);

  // 5. The produtos.
  const resolvedor = criarResolvedorDeLinhasLi(db, integracaoId, cliente);
  const resolucoes = new Map<string, ResolucaoProdutoLi>();
  for (const referencia of referenciasDeProdutoLi(pedido.itens)) {
    if (resolucoes.has(referencia.ensureUniqueId)) continue;
    resolucoes.set(referencia.ensureUniqueId, await resolvedor.resolver(referencia));
  }

  // 6. The freight — and its aviso, about the conta's configuration and clocked by this
  // routing read, so it runs on every attempt that routed: a refused one (6b) included.
  const frete = await resolverFreteLi(db, contexto, pedido, deps);
  if (frete !== null && frete.roteamento.aviso !== null) {
    await sincronizarAvisoDeFreteLi(
      db,
      {
        integracaoId,
        lojaNome: doAviso.lojaNome,
        aviso: frete.roteamento.aviso,
        relogioUs: frete.relogioUs,
      },
      depsDoAviso,
    );
  }

  // 6b. A PAID order with no usable delivery address: refused, and retried (A4). Asked
  // of S here, and again of every batch attempt's snapshot (`mapearPedido`, rule 7).
  const recusarSemEndereco = (arm: PedidoArmazenadoLi | null): boolean =>
    pedidoPagoSemEnderecoLi({
      codigo: pedido.situacao.codigo,
      enderecoEntrega: pedido.endereco_entrega,
      temEnvio: pedido.envios[0] !== undefined,
      dispensaEndereco: frete?.roteamento.dispensaEndereco ?? false,
      armazenado: arm,
    });
  if (recusarSemEndereco(armazenado)) {
    deps.logger?.warn(`${ROTULO_LOG} pedido pago sem endereço de entrega; tenta de novo`, log);
    throw new LiPedidoPagoSemEnderecoError(doAviso);
  }

  // 7. The cliente and the endereço.
  const partes = await resolverClienteEEnderecoLi(db, armazenado, pedido, nowMs, deps, log);

  // 8–10. The pedido and its pagamentos, in ONE batch.
  const resolucoesDasLinhas = new Map<string, ResolucaoLinhaLi>(
    [...resolucoes].map(([id, r]) => [id, { produtoUid: r.produtoId, idLi: r.idLi }]),
  );
  const itens = mapearItensLi({
    itens: pedido.itens,
    valorSubtotal: pedido.valor_subtotal,
    resolucoes: resolucoesDasLinhas,
    nowUs,
  });
  if (!itens.ok) {
    // Unreachable: step 1 asked the same mapper the same question.
    throw new RangeError('importarPedidoLi: as linhas passaram no passo 1 e falharam agora');
  }
  const dataAprovacaoUs = h.dataAprovacao.derivavel ? h.dataAprovacao.us : null;
  const modalidadeConta: ModalidadeFrete | null = conta.modalidadeFreteImportacao ?? null;

  /**
   * The order's fields against one snapshot: the refs it already holds win
   * (fill-once), and the cliente and the endereço are paired against THAT
   * snapshot (`parClienteEnderecoLi`) — never against `S` alone.
   */
  const mapearPedido = (arm: PedidoArmazenadoLi | null): PedidoMapeadoLi => {
    // 6b against THIS snapshot: an endereço another writer cleared since S refuses the
    // paid update (the batch aborts with no write) — unless the snapshot is newer than
    // the order, which the batch answers `obsoleto` for.
    const maisNovo = arm !== null && watermarkArmazenadoMaisNovoLi(arm, watermarkUs) !== null;
    if (!maisNovo && recusarSemEndereco(arm)) throw new LiPedidoPagoSemEnderecoError(doAviso);
    const par = parClienteEnderecoLi(arm, partes);
    const blocoFrete =
      frete === null
        ? null
        : mapearFreteLi({
            pedido,
            modalidadeConta,
            roteamento: frete.roteamento,
            horarioDeCorteConta: frete.horarioDeCorte,
            dataAprovacaoUs,
            enderecoFiscalOuterRef: par.enderecoDaRota,
          });
    return mapearPedidoLi({
      contaId: integracaoId,
      operacaoOuterRef: conta.operacaoOuterRef,
      pedido,
      watermarkUs,
      capturado: h.capturado,
      itens: itens.itens,
      descontoExtra: itens.descontoExtra,
      frete: blocoFrete,
      clientePedidoOuterRef: par.clientePedidoOuterRef,
      enderecoFiscalOuterRef: par.enderecoFiscalOuterRef,
    });
  };
  const mapearPagamentos = (
    decisao: Parameters<typeof mapearPagamentosLi>[0]['statusPagamento'],
  ): readonly PagamentoMapeadoLi[] => {
    const r = mapearPagamentosLi({
      contaId: integracaoId,
      pedido,
      statusPagamento: decisao,
      dataAprovacao: h.dataAprovacao,
      dataCancelamento: h.dataCancelamento,
      watermarkUs,
    });
    if (!r.ok) {
      // Unreachable: step 1 asked the same mapper the same question.
      throw new RangeError('importarPedidoLi: os pagamentos passaram no passo 1 e falharam agora');
    }
    return r.pagamentos;
  };

  const gravacao = await gravarPedidoEPagamentosLi(db, {
    pedidoId,
    primeiraLeitura,
    mapearPedido,
    mapearPagamentos: (decisao) => mapearPagamentos(decisao.statusPagamento),
    nowUs,
  });
  if (gravacao.tipo === 'obsoleto') return { kind: 'obsoleto' };
  const { decisao } = gravacao.escrita;
  const mapeadoFinal = mapearPedido(gravacao.armazenado);
  // The pairing the WINNING attempt decided from (its snapshot), for the incidente.
  const parFinal = parClienteEnderecoLi(gravacao.armazenado, partes);
  const naoPareado = parFinal.enderecoNaoPareado;
  if (naoPareado !== null) {
    deps.logger?.warn(
      `${ROTULO_LOG} endereço do pedido de outro dono ou ilegível; nenhum cliente vinculado a ele, frete sem rota`,
      {
        ...log,
        cliente: naoPareado.cliente,
        enderecos: naoPareado.enderecos.map(
          (e) => `${e.uso}:${e.donoLegivel ? 'outro' : 'ilegivel'}`,
        ),
      },
    );
  }
  registrarDecisoesLi(deps, log, gravacao, mapeadoFinal);
  registrarFormasDesconhecidasLi(deps, log, mapearPagamentos(decisao.statusPagamento));

  // 11. The incidentes, then the avisos — on `importado` and `sem-mudanca` alike.
  // A line incidente names a line the pedido HOLDS once the winning attempt
  // landed: a frozen pedido does not take a line Loja Integrada added later.
  const itensGuardados = itensGuardadosLi(gravacao.armazenado, gravacao.escrita);
  const guardadas = idsDasLinhasLi(itensGuardados);
  const linhasSemProduto: LinhaSemProdutoLi[] = itens.itens.flatMap((item) => {
    if (item.ensureUniqueId === null || !guardadas.has(item.ensureUniqueId)) return [];
    const r = resolucoes.get(item.ensureUniqueId);
    return item.produtoUid === null && r !== undefined && r.produtoId === null
      ? [{ item, via: r.via }]
      : [];
  });
  const blocoFinal = mapeadoFinal.frete;
  await registrarIncidentesDoPedidoLi(db, {
    pedidoId,
    numero: String(pedido.numero),
    linhasSemProduto,
    jaVinculadas: linhasJaVinculadasLi(itensGuardados),
    multiEnvio: blocoFinal?.multiEnvio ?? false,
    // Step 7 decided from S; the pedido holds what the WINNING attempt kept — a cliente
    // another writer linked meanwhile is no pedido "without a cliente".
    clienteSemIdentidade:
      partes.semIdentidade && mapeadoFinal.preencherUmaVez.clientePedidoOuterRef === null
        ? {
            comEndereco:
              refArmazenada(gravacao.armazenado?.enderecoFiscalOuterRef) !== null ||
              parFinal.enderecoFiscalOuterRef !== null,
          }
        : null,
    enderecoNaoPareado: naoPareado,
    totaisDivergentes:
      itens.divergente ||
      (blocoFinal?.valorDivergente ?? false) ||
      gravacao.escrita.totaisDivergentes,
    nowUs,
  });
  // A reversal on a pedido whose label was bought, read from the snapshot the WINNING
  // attempt decided from (the import never writes `printLabelId`) — A7.
  const reversaoComEtiqueta = etiquetaCompradaLi(gravacao.armazenado)
    ? motivoReversaoLi(pedido.situacao.codigo)
    : null;
  if (reversaoComEtiqueta !== null) {
    deps.logger?.warn(`${ROTULO_LOG} reversão em pedido com etiqueta comprada; aviso levantado`, {
      ...log,
      motivo: reversaoComEtiqueta,
    });
  }
  await sincronizarAvisosDoPedidoLi(
    db,
    doAviso,
    {
      situacaoDesconhecida: decisao.situacaoDesconhecida,
      contestacao: decisao.contestacao,
      reversaoComEtiqueta,
    },
    depsDoAviso,
  );

  if (decisao.situacaoDesconhecida !== null) return { kind: 'situacao-desconhecida' };
  return { kind: gravacao.tipo === 'gravado' ? 'importado' : 'sem-mudanca' };
}

/** The decision's WARNING and INFO lines (ids and codes only). */
function registrarDecisoesLi(
  deps: DepsImportadorLi,
  log: Readonly<Record<string, unknown>>,
  gravacao: Extract<GravacaoPedidoLi, { tipo: 'gravado' | 'sem-mudanca' }>,
  mapeado: PedidoMapeadoLi,
): void {
  const { decisao } = gravacao.escrita;
  if (decisao.motivo === MOTIVO_ESTADO_LI.regressivo) {
    deps.logger?.warn(`${ROTULO_LOG} reversão de pago recusada pela escada; estado mantido`, {
      ...log,
      codigo: mapeado.codigo,
    });
  }
  if (decisao.ressuscitado) {
    deps.logger?.warn(`${ROTULO_LOG} venda encerrada reaberta pela Loja Integrada`, log);
  }
  for (const p of gravacao.pagamentos.escritas) {
    if (p.tipo === 'atualizar' && p.statusRessuscitado) {
      deps.logger?.warn(`${ROTULO_LOG} status de pagamento encerrado reaberto`, {
        ...log,
        pagamento: p.docId,
      });
    }
  }
  const integracaoId = String(log.integracaoId);
  if (
    mapeado.frete?.modalidadeSobrescrita === true &&
    !contasComModalidadeAvisada.has(integracaoId)
  ) {
    contasComModalidadeAvisada.add(integracaoId);
    deps.logger?.warn(
      `${ROTULO_LOG} pedido com frete importado como CIF; a modalidade da conta é outra`,
      log,
    );
  }
}

/** The INFO line for a payment codigo with no known forma (once per codigo per instance). */
function registrarFormasDesconhecidasLi(
  deps: DepsImportadorLi,
  log: Readonly<Record<string, unknown>>,
  pagamentos: readonly PagamentoMapeadoLi[],
): void {
  for (const p of pagamentos) {
    if (p.forma.origem !== 'outros') continue;
    const codigo = p.forma.codigo ?? '';
    if (codigosDeFormaDesconhecidaLogados.has(codigo)) continue;
    codigosDeFormaDesconhecidaLogados.add(codigo);
    deps.logger?.info?.(`${ROTULO_LOG} forma de pagamento sem mapeamento; gravada como outros`, {
      ...log,
      codigo: codigo.slice(0, 64),
    });
  }
}
