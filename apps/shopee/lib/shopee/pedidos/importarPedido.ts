/**
 * `importarPedidoShopee` — one Shopee order becomes one ERP pedido (#1513,
 * step 5, plan W2/W10 + R5's contract).
 *
 * This is the code-3 arm's whole body: the push says only "something changed",
 * and everything below is re-fetched from Shopee. **The push body is never
 * trusted** — not its status, not its `update_time`, not its `items`.
 *
 * ## The sequence, and why it is this order
 *
 *  1. ONE clock read (`nowMs` → `nowUs`, converted ONCE here and handed DOWN —
 *     nothing below this module converts a clock);
 *  2. `get_order_detail` — the authority for every field;
 *  3. `get_escrow_detail`, **CONTAINED**: it refines PRICES, and losing a
 *     refinement must not lose the pedido;
 *  4. produto resolution, memoised per `(item_id, model_id)` across the order;
 *  5. the freight block, then the items (the items' cross-check log needs the
 *     freight figure, and only the freight mapper knows a Shopee `0` from an
 *     absence);
 *  6. the buyer — `findOrCreateCliente` is a blind `add` and cannot join a
 *     transaction, so the cliente and the endereço are resolved HERE and only
 *     their outer-refs ride the pedido write, as fill-once fields the
 *     transaction re-checks against its own snapshot;
 *  7. the ONE transaction;
 *  8. the per-line incidentes, AFTER the write, so a line the stored pedido
 *     already binds raises nothing.
 *
 * ## Errors (rule 6 — narrow `instanceof`, rethrow the rest)
 *
 * ⚠️ **This module converts NO error into a disposition.** A throw is the
 * transient path and the queue owns the ladder; the error → `throw`/`defer`/
 * `park` table is the notification arm's (`notificacoes/notificacao.ts`), where
 * the pipeline's vocabulary lives. The only non-throwing wire branch is
 * `order_not_found`, which is a permanent provider fact about ONE order and
 * therefore an OUTCOME (`ignorado-inexistente`) rather than a failure — the arm
 * decides what to do with it.
 *
 * ⚠️ The escrow containment must NOT swallow a reauth or a rate limit.
 * `ShopeeReauthRequiredError` and `ShopeeRateLimitError` both EXTEND
 * `ShopeeApiError`, so the subclass checks come first: containing a dead grant
 * would import the order at detail-only prices and report success, and
 * containing a burst limit would spend the retry on a payload we already know is
 * incomplete.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import { type ViaCepClient, createViaCepClient } from '@delfrance/core/cep';
import { findOrCreateCliente } from '@delfrance/data/admin/clientes';
import { ensureEndereco } from '@delfrance/data/admin/enderecos';
import {
  clienteCollection,
  integracaoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  idFromRef,
  recoverEnderecoFromCep,
  toOuterRef,
  type EnderecoForcado,
  type Pedido,
} from '@delfrance/schemas';
import {
  ShopeeApiError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeClient,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetailRow,
  type ShopeeOrderItem,
} from '@delfrance/integrations-shopee';

import { readConta } from '../core/contaCache';
import { loadShopeeContext } from '../core/shopee';
import { avaliarCapturaComprador, clienteDeShopee, enderecoDeShopee } from './comprador';
import { registrarLinhasSemProduto, type LinhaSemProdutoShopee } from './incidentesProduto';
import { mapearItensShopee } from './itens';
import { mapearFreteInicialShopee } from './orderFreteMapping';
import { makePedidoIdShopee } from './orderIds';
import {
  mapearPedidoShopee,
  microsDeSegundosShopee,
  segundosShopeeUtilizaveis,
} from './orderMapping';
import { criarResolvedorDeLinhasShopee } from './produtoResolve';
import { salvarPedidoShopee, type AcaoPedidoShopee } from './orderPedidoTx';

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

/** Shopee's own error code for "this shop has no such order". */
export const SHOPEE_ERRO_ORDER_NOT_FOUND = 'order_not_found';

export interface AlvoDeImportacaoShopee {
  readonly integracaoId: string;
  readonly shopId: number;
  readonly orderSn: string;
  /** The task's ONE clock read, in MILLISECONDS. The µs conversion is inside. */
  readonly nowMs: number;
}

export type AcaoImportacaoPedidoShopee =
  | AcaoPedidoShopee
  /**
   * Shopee denies the order — `order_not_found`, or an `order_list` that came
   * back without the row we asked for. A permanent fact about ONE order, so it
   * is an OUTCOME rather than a throw; the notification arm decides the
   * disposition (R5 parks it).
   */
  | 'ignorado-inexistente';

export interface ResultadoImportacaoPedidoShopee {
  readonly kind: 'pedido';
  readonly acao: AcaoImportacaoPedidoShopee;
  readonly orderSn: string;
  /** `null` only on `ignorado-inexistente`. */
  readonly pedidoId: string | null;
  /** Shopee's `order_status`, VERBATIM. `null` only on `ignorado-inexistente`. */
  readonly orderStatus: string | null;
  /** Lines that resolved to no produto AND were not already stored bound. */
  readonly itensSemProduto: number;
  /**
   * A short machine-readable tail for the log filter — the action, so a Cloud
   * Logging query separates "we created a pedido" from "Shopee denied the
   * order" without opening a document.
   */
  readonly detail: string;
}

export interface ShopeeImportarPedidoDeps {
  /**
   * The client seam. Default: `loadShopeeContext(db, id).createShopClient()` —
   * the same chain the order backfill uses, and the token rides as a FUNCTION so
   * one that lapses mid-import is renewed rather than replayed dead.
   */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /** The ViaCEP client used to recover an unmappable UF. Shared per process. */
  readonly viaCep?: ViaCepClient;
}

/**
 * Process-wide ViaCEP client, built on first use so its memo (and its in-flight
 * dedup) spans every import this instance serves.
 */
let viaCepPadrao: ViaCepClient | undefined;

/* -------------------------------------------------------------------------- */
/*                                the wire reads                               */
/* -------------------------------------------------------------------------- */

async function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: ShopeeImportarPedidoDeps,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/**
 * The escrow, or `null` — the ONE contained wire failure in this module.
 *
 * ⚠️ Order matters: the two subclasses that must NEVER be contained are checked
 * first (see the module header).
 */
async function lerEscrowContido(
  client: ShopeeClient,
  orderSn: string,
): Promise<ShopeeEscrowDetail | null> {
  try {
    return await client.getEscrowDetail({ orderSn });
  } catch (err) {
    if (err instanceof ShopeeReauthRequiredError) throw err;
    if (err instanceof ShopeeRateLimitError) throw err;
    if (err instanceof ShopeeSchemaError) {
      // ⚠️ Shopee's own doc sample sends `0.1` for every `kit_items` id, and the
      // wire schema declares them as integers — so a genuinely fractional id
      // fails the WHOLE escrow parse and every kit order silently prices from
      // the detail. Naming the path here is what makes that visible on the first
      // real BR kit order instead of six months later.
      const kit = err.campos.some((c) => c.includes('kit_items'));
      console.warn('[shopee/pedidos] escrow ilegível — preços virão do detalhe', {
        orderSn,
        campos: err.campos,
        kitItems: kit,
      });
      return null;
    }
    if (
      err instanceof ShopeeApiError ||
      err instanceof ShopeeHttpError ||
      err instanceof ShopeeNetworkError
    ) {
      console.warn('[shopee/pedidos] escrow indisponível — preços virão do detalhe', {
        orderSn,
        classe: err.name,
        codigo: err instanceof ShopeeApiError ? err.code : null,
      });
      return null;
    }
    throw err;
  }
}

/**
 * The SKU this line resolves on — `model_sku` first, then `item_sku`, VERBATIM.
 *
 * ⚠️ It must answer exactly what `mapearItensShopee` stores on the line, or the
 * produto would be resolved on one string and the pedido would remember another.
 * `importarPedido.test.ts` pins the two against each other over the empty /
 * whitespace / both-empty vectors rather than trusting this comment.
 */
function skuDaLinhaShopee(linha: ShopeeOrderItem): string | null {
  return naoVazio(linha.model_sku) ?? naoVazio(linha.item_sku);
}

function naoVazio(v: string | null | undefined): string | null {
  return v != null && v !== '' ? v : null;
}

/* -------------------------------------------------------------------------- */
/*                                  the buyer                                  */
/* -------------------------------------------------------------------------- */

interface CompradorResolvido {
  readonly clienteOuterRef: string | null;
  readonly enderecoOuterRef: string | null;
  readonly camposRecusadosExtra: readonly string[];
}

/**
 * Resolve the cliente and the endereço BEFORE the transaction, honouring
 * fill-once per FIELD.
 *
 * ⚠️ The stored refs are read OUTSIDE the transaction here, and that read is a
 * CHEAP SKIP, never the guard: it saves a `findOrCreateCliente` round trip for a
 * pedido that is already linked. The guard is the fill-once re-check inside
 * `salvarPedidoShopee`, against that transaction's own snapshot (rule 7 — a
 * predicate re-checked against a binding read outside the transaction is not a
 * guard).
 *
 * ⚠️ A masked import returns all-null and stamps nothing: there is no partial
 * write, no placeholder, and structurally nothing that could unlink an
 * already-linked cliente.
 */
async function resolverComprador(
  db: Firestore,
  args: {
    readonly detalhe: ShopeeOrderDetailRow;
    readonly armazenado: Record<string, unknown> | null;
    readonly nowMs: number;
    readonly viaCep: ViaCepClient;
  },
): Promise<CompradorResolvido> {
  const { detalhe, armazenado, nowMs } = args;
  const orderSn = detalhe.order_sn;
  const camposRecusadosExtra: string[] = [];

  const refClienteArmazenado =
    typeof armazenado?.clientePedidoOuterRef === 'string' ? armazenado.clientePedidoOuterRef : null;
  const refEnderecoArmazenado =
    typeof armazenado?.enderecoFiscalOuterRef === 'string'
      ? armazenado.enderecoFiscalOuterRef
      : null;

  let clienteOuterRef: string | null = null;
  let clienteId: string | null = refClienteArmazenado ? idFromRef(refClienteArmazenado) : null;

  if (refClienteArmazenado == null) {
    const campos = clienteDeShopee(detalhe);
    if (campos !== null) {
      const resultado = await findOrCreateCliente(db, { fields: campos, nowMs });
      clienteId = resultado.clienteId;
      clienteOuterRef = toOuterRef(clienteCollection.docPath({}, resultado.clienteId));
      if (resultado.rejected.length > 0) {
        // A telefone/e-mail hit whose document contradicts this buyer's. Ids and
        // match KEYS only — never the values that were compared.
        console.warn('[shopee/pedidos] candidatos a cliente recusados por documento divergente', {
          orderSn,
          recusados: resultado.rejected.map((r) => ({ id: r.id, chave: r.matchedBy })),
        });
      }
      if (resultado.dropped.length > 0) {
        console.warn('[shopee/pedidos] campos do cliente descartados', {
          orderSn,
          campos: resultado.dropped,
        });
      }
    }
  }

  // The endereço lives UNDER the cliente, so it needs one — either the stored
  // link or the one just resolved.
  if (refEnderecoArmazenado == null && clienteId != null) {
    const resultado = enderecoDeShopee(detalhe.recipient_address, detalhe.region);
    if (resultado != null) {
      let campos: EnderecoForcado | null = null;
      if (resultado.kind === 'sem-cep') {
        // ⚠️ NOT harmless: without an `enderecoFiscalOuterRef` the pedido can
        // never be fiscalizado. It used to be swallowed in total silence.
        camposRecusadosExtra.push('endereco:sem-cep');
        console.warn('[shopee/pedidos] endereço sem CEP — o pedido fica sem endereço fiscal', {
          orderSn,
        });
      } else if (resultado.kind === 'uf-desconhecida') {
        const recuperado = await recoverEnderecoFromCep(resultado, args.viaCep);
        campos = recuperado.fields;
        if (!recuperado.ufResolvida) {
          // ViaCEP could not answer, so the endereço keeps the builder's `AC`. It
          // is still worth storing: a wrong UF cannot reach a signed XML (the
          // município code is null, so emission throws), whereas no endereço at
          // all strands the pedido short of an NF-e for ever.
          camposRecusadosExtra.push('endereco:uf-desconhecida');
          console.warn('[shopee/pedidos] UF não resolvida pelo CEP — endereço gravado com AC', {
            orderSn,
          });
        }
      } else {
        campos = resultado.fields;
      }

      if (campos != null) {
        const enderecoId = await ensureEndereco(db, clienteId, campos);
        return {
          clienteOuterRef,
          enderecoOuterRef: toOuterRef(`clientes/${clienteId}/enderecos/${enderecoId}`),
          camposRecusadosExtra,
        };
      }
    }
  }

  return { clienteOuterRef, enderecoOuterRef: null, camposRecusadosExtra };
}

/* -------------------------------------------------------------------------- */
/*                                 the importer                                */
/* -------------------------------------------------------------------------- */

export async function importarPedidoShopee(
  db: Firestore,
  alvo: AlvoDeImportacaoShopee,
  deps: ShopeeImportarPedidoDeps = {},
): Promise<ResultadoImportacaoPedidoShopee> {
  const { integracaoId, shopId, orderSn, nowMs } = alvo;
  // ⚠️ The ONE conversion in this channel's pedido path, done ONCE and handed
  // down. Nothing below re-reads a clock or re-converts a unit.
  const nowUs = millisToMicros(nowMs);

  const client = await clienteShopee(db, integracaoId, deps);

  let detalhe;
  try {
    detalhe = await client.getOrderDetail({
      orderSnList: [orderSn],
      // Without this a PENDING order's status is undocumented and
      // `pending_terms` never comes back at all.
      requestOrderStatusPending: true,
    });
  } catch (err) {
    // ⚠️ `order_not_found` classifies as kind `other`, so no reauth or rate-limit
    // subclass can carry that code — but the check is on the CODE, so widening
    // this catch later cannot silently absorb one.
    if (err instanceof ShopeeApiError && err.code === SHOPEE_ERRO_ORDER_NOT_FOUND) {
      return inexistente(orderSn, 'order_not_found');
    }
    throw err;
  }

  // ⚠️ Shopee may answer with FEWER rows than were asked for. Reconcile by
  // `order_sn`, never by position.
  const linha = detalhe.order_list.find((r) => r.order_sn === orderSn);
  if (linha === undefined) {
    return inexistente(orderSn, 'ausente-no-order_list');
  }

  // The order clock, in µs — ONE named conversion from SECONDS. A zero-filled
  // `update_time` falls back to the wall clock, which is the same unit and the
  // honest "we saw it now" answer.
  const atualizadoEm = segundosShopeeUtilizaveis(linha.update_time);
  const watermarkUs = atualizadoEm == null ? nowUs : microsDeSegundosShopee(atualizadoEm);

  const escrow = await lerEscrowContido(client, orderSn);

  // Produto resolution first: the item mapper is synchronous and reads the map.
  const resolvedor = criarResolvedorDeLinhasShopee(db, integracaoId);
  for (const item of linha.item_list ?? []) {
    await resolvedor.resolver({
      itemId: item.item_id,
      modelId: item.model_id ?? null,
      sku: skuDaLinhaShopee(item),
    });
  }

  const { frete, pesosObservados } = mapearFreteInicialShopee({
    detalhe: linha,
    escrow,
    watermarkUs,
  });
  const mapeados = mapearItensShopee({
    detalhe: linha,
    escrow,
    resolucoes: resolvedor.resultados(),
    freteCobrado: frete.valorCobrado,
    nowUs,
  });

  const pedidoId = makePedidoIdShopee(integracaoId, orderSn);
  // The cheap skip — see `resolverComprador`. The transaction re-checks.
  const snapshot = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const armazenado = snapshot.exists ? ((snapshot.data() ?? {}) as Record<string, unknown>) : null;

  const comprador = await resolverComprador(db, {
    detalhe: linha,
    armazenado,
    nowMs,
    viaCep: deps.viaCep ?? (viaCepPadrao ??= createViaCepClient()),
  });

  const conta = await readConta(db, integracaoId);
  const mapeado = mapearPedidoShopee({
    detalhe: linha,
    escrow,
    itens: mapeados.itens,
    conferencia: mapeados.conferencia,
    frete,
    conta: {
      integracaoPedidoOuterRef: toOuterRef(integracaoCollection.docPath({}, integracaoId)),
      // ⚠️ A conta with no tabela/operação writes NULL rather than a guess — and
      // a pedido with no operação reserves no stock, which is the honest
      // consequence of an unconfigured conta rather than a hidden one.
      listaDePrecosOuterRef: conta?.tabelaNormalOuterRef ?? null,
      operacaoPedidoOuterRef: conta?.operacaoOuterRef ?? null,
    },
    captura: avaliarCapturaComprador({ detail: linha, statusObservado: linha.order_status }),
    camposRecusadosExtra: comprador.camposRecusadosExtra,
    clientePedidoOuterRef: comprador.clienteOuterRef,
    enderecoFiscalOuterRef: comprador.enderecoOuterRef,
    watermarkUs,
  });

  const resultado = await salvarPedidoShopee(db, { pedidoId, mapeado, watermarkUs, nowUs });

  // AFTER the write, and driven by the snapshot the transaction actually saw: a
  // line already stored WITH a produto — bound by an operator, or by the legacy
  // importer before the cutover — is not a problem and must not raise a row.
  const semProduto: LinhaSemProdutoShopee[] = mapeados.itens
    .map((item, i) => ({
      item,
      itemId: mapeados.diagnosticos[i]?.itemId ?? 0,
      modelId: mapeados.diagnosticos[i]?.modelId ?? null,
      via: mapeados.diagnosticos[i]?.via ?? null,
    }))
    .filter((l) => l.item.produtoUid == null);
  const incidentes = await registrarLinhasSemProduto(db, {
    pedidoId,
    orderSn,
    linhas: semProduto,
    itensGravados: resultado.itensGravados as Pedido['itens'] | null,
    nowUs,
  });

  // ONE line per import. Ids, counts and numbers only — never a name, an
  // address, a document or a product title.
  // eslint-disable-next-line no-console -- expected on every healthy import; a warn nobody can act on is what hides the real ones
  console.info('[shopee/pedidos] pedido importado', {
    integracaoId,
    shopId,
    orderSn,
    pedidoId,
    acao: resultado.acao,
    orderStatus: linha.order_status,
    estadoEscrito: resultado.estadoEscrito,
    motivoEstado: resultado.motivoEstado,
    grupos: resultado.gruposAplicados,
    escrow: escrow !== null,
    itens: mapeados.itens.length,
    itensSemProduto: semProduto.length,
    incidentesCriados: incidentes,
    valorCobrado: mapeado.dados.valorCobrado,
    freteCobrado: frete.valorCobrado,
    prazoDespachoUs: frete.prazoDespacho,
    // ⚠️ `parcel_chargeable_weight`'s unit is undocumented, so the RAW grams ride
    // beside the converted kilos for the first deliveries.
    pesos: pesosObservados,
    diferencaDeTotais: mapeados.conferencia.diferenca,
  });

  return {
    kind: 'pedido',
    acao: resultado.acao,
    orderSn,
    pedidoId,
    orderStatus: linha.order_status,
    itensSemProduto: semProduto.length,
    detail: resultado.acao,
  };
}

function inexistente(orderSn: string, motivo: string): ResultadoImportacaoPedidoShopee {
  console.warn('[shopee/pedidos] a Shopee não conhece esta order', { orderSn, motivo });
  return {
    kind: 'pedido',
    acao: 'ignorado-inexistente',
    orderSn,
    pedidoId: null,
    orderStatus: null,
    itensSemProduto: 0,
    detail: `ignorado-inexistente:${motivo}`,
  };
}
