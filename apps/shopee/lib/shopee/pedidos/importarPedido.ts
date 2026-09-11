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
 *  7. the pedido transaction;
 *  8. the PAGAMENTO transaction (#1514, step 6) — a second, separate one, run
 *     unless the pedido write came out `ignorado-obsoleto`. ⚠️ It is NOT skipped
 *     by `ignorado-sem-mudanca`: the escrow has no clock of its own, so the fees
 *     can move while the order row does not;
 *  9. the per-line incidentes, AFTER the writes, so a line the stored pedido
 *     already binds raises nothing.
 *
 * ## The split: steps 1–5 + the conta read are a SEPARATE, read-only function
 *
 * `prepararImportacaoPedidoShopee` does everything above that only READS, and
 * `mapearPreparoPedidoShopee` turns its output plus the buyer refs into the four
 * write groups. `importarPedidoShopee` is the composition of the two plus the
 * writes (6, 7, 8) — so the dev rehearsal script can print what an import would
 * store without a second copy of the sequence. See
 * {@link PreparoPedidoShopee} for why that copy is the thing to avoid.
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
  type FreteDoPedido,
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
import {
  avaliarCapturaComprador,
  clienteDeShopee,
  enderecoDeShopee,
  type CapturaComprador,
} from './comprador';
import { registrarLinhasSemProduto, type LinhaSemProdutoShopee } from './incidentesProduto';
import { mapearItensShopee, type ItensMapeadosShopee } from './itens';
import { mapearFreteInicialShopee, type PesoBrutoObservado } from './orderFreteMapping';
import { makePedidoIdShopee } from './orderIds';
import {
  REGIAO_BR_PEDIDO,
  mapearPedidoShopee,
  microsDeSegundosShopee,
  segundosShopeeUtilizaveis,
  type ContaBagShopee,
  type PedidoMapeadoShopee,
} from './orderMapping';
import { criarResolvedorDeLinhasShopee } from './produtoResolve';
import { salvarPedidoShopee, type AcaoPedidoShopee } from './orderPedidoTx';
import {
  mapearPagamentosShopee,
  statusPagamentoDeOrderStatus,
  type PagamentosMapeadosShopee,
} from './pagamentoMapping';
import {
  salvarPagamentosShopee,
  type AcaoPagamentosShopee,
  type ResultadoPagamentosShopee,
} from './pagamentoTx';

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
   * The pagamento transaction's own outcome (#1514, step 6), or `null` when it
   * did not run — `ignorado-inexistente`, and a pedido write that came out
   * `ignorado-obsoleto`.
   */
  readonly acaoPagamentos: AcaoPagamentosShopee | null;
  /** Pagamento documents created or updated by this import. */
  readonly pagamentosGravados: number;
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

export interface CompradorResolvido {
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
/*                        the READ-ONLY half of an import                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything one import READS from Shopee and from Firestore, plus everything
 * the pure mappers derive from it — and **not one write**.
 *
 * ⚠️ It exists so the dev rehearsal script (`scripts/importar-pedido.ts`, root
 * CLAUDE.md rule 8) can show what an import WOULD store without a second copy of
 * this composition. The root CLAUDE.md names that copy by its failure: #1369
 * shipped a panel whose header called itself a "line-for-line mirror" of a
 * resolver and which had already drifted in two places, both green, both
 * commented. Reviewers cannot diff two files by eye; the compiler can, once
 * there is only one — so the script calls THIS function and
 * {@link mapearPreparoPedidoShopee}, exactly as {@link importarPedidoShopee}
 * does, and a change here reaches both callers or neither.
 *
 * ⚠️ **The no-write property is STRUCTURAL, not a promise in a comment**: the
 * four writers on the pedido path (`findOrCreateCliente`, `ensureEndereco`,
 * `salvarPedidoShopee`, `registrarLinhasSemProduto`) are all called from
 * {@link importarPedidoShopee} and none of them appears in this body. The
 * `pedidoCollection` read below is a `.get()`; the produto cascade and
 * `readConta` are reads. Keep it that way — a write added here would silently
 * make `--dry-run` write.
 */
export interface PreparoPedidoShopee {
  /** The reconciled `get_order_detail` row — the authority for every field. */
  readonly linha: ShopeeOrderDetailRow;
  /** `null` when the escrow call was CONTAINED, or the order is unpaid. */
  readonly escrow: ShopeeEscrowDetail | null;
  readonly pedidoId: string;
  /** The stored pedido as it was read BEFORE the write, or `null`. */
  readonly armazenado: Record<string, unknown> | null;
  /** The order-clock watermark, µs. */
  readonly watermarkUs: number;
  /** The caller's ONE clock read, µs. */
  readonly nowUs: number;
  readonly frete: FreteDoPedido;
  readonly pesosObservados: readonly PesoBrutoObservado[];
  readonly mapeados: ItensMapeadosShopee;
  readonly captura: CapturaComprador;
  readonly conta: ContaBagShopee;
}

export type PreparoImportacaoPedidoShopee =
  | { readonly kind: 'preparo'; readonly preparo: PreparoPedidoShopee }
  /** Shopee denies the order — the importer's own `ignorado-inexistente`. */
  | { readonly kind: 'inexistente'; readonly resultado: ResultadoImportacaoPedidoShopee };

export async function prepararImportacaoPedidoShopee(
  db: Firestore,
  alvo: AlvoDeImportacaoShopee,
  deps: ShopeeImportarPedidoDeps = {},
): Promise<PreparoImportacaoPedidoShopee> {
  const { integracaoId, orderSn, nowMs } = alvo;
  // ⚠️ The ONE CLOCK read in this channel's pedido path, converted once and
  // handed down — nothing below re-reads a clock. It is not the only unit
  // conversion: `orderMapping.ts` converts Shopee's SECONDS and
  // `orderFreteMapping.ts` the cutoff helper's MILLISECONDS, both from wire
  // values rather than from a clock. The four seams are listed in
  // `apps/shopee/CLAUDE.md`.
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
      return { kind: 'inexistente', resultado: inexistente(orderSn, 'order_not_found') };
    }
    throw err;
  }

  // ⚠️ Shopee may answer with FEWER rows than were asked for. Reconcile by
  // `order_sn`, never by position.
  const linha = detalhe.order_list.find((r) => r.order_sn === orderSn);
  if (linha === undefined) {
    return { kind: 'inexistente', resultado: inexistente(orderSn, 'ausente-no-order_list') };
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

  const conta = await readConta(db, integracaoId);

  return {
    kind: 'preparo',
    preparo: {
      linha,
      escrow,
      pedidoId,
      armazenado,
      watermarkUs,
      nowUs,
      frete,
      pesosObservados,
      mapeados,
      captura: avaliarCapturaComprador({ detail: linha, statusObservado: linha.order_status }),
      conta: {
        integracaoPedidoOuterRef: toOuterRef(integracaoCollection.docPath({}, integracaoId)),
        // ⚠️ A conta with no tabela/operação writes NULL rather than a guess — and
        // a pedido with no operação reserves no stock, which is the honest
        // consequence of an unconfigured conta rather than a hidden one.
        listaDePrecosOuterRef: conta?.tabelaNormalOuterRef ?? null,
        operacaoPedidoOuterRef: conta?.operacaoOuterRef ?? null,
      },
    },
  };
}

/**
 * The four write groups for one prepared order, given the buyer refs the CALLER
 * resolved. Pure.
 *
 * ⚠️ The dry-run passes all-null: it resolves no buyer, because resolving one
 * means `findOrCreateCliente`, which is a write. So a dry-run's
 * `clientePedidoOuterRef` is `null` for an order the live run WOULD link, and
 * the script says so rather than letting the reader infer a refusal. The capture
 * VERDICT is not affected — it is derived from the wire payload alone.
 */
export function mapearPreparoPedidoShopee(
  preparo: PreparoPedidoShopee,
  comprador: CompradorResolvido,
): PedidoMapeadoShopee {
  return mapearPedidoShopee({
    detalhe: preparo.linha,
    escrow: preparo.escrow,
    itens: preparo.mapeados.itens,
    conferencia: preparo.mapeados.conferencia,
    frete: preparo.frete,
    conta: preparo.conta,
    captura: preparo.captura,
    camposRecusadosExtra: comprador.camposRecusadosExtra,
    clientePedidoOuterRef: comprador.clienteOuterRef,
    enderecoFiscalOuterRef: comprador.enderecoOuterRef,
    watermarkUs: preparo.watermarkUs,
  });
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

  const preparado = await prepararImportacaoPedidoShopee(db, alvo, deps);
  if (preparado.kind === 'inexistente') return preparado.resultado;
  const { linha, escrow, pedidoId, armazenado, watermarkUs, nowUs, frete, pesosObservados } =
    preparado.preparo;
  const mapeados = preparado.preparo.mapeados;

  const comprador = await resolverComprador(db, {
    detalhe: linha,
    armazenado,
    nowMs,
    viaCep: deps.viaCep ?? (viaCepPadrao ??= createViaCepClient()),
  });

  const mapeado = mapearPreparoPedidoShopee(preparado.preparo, comprador);

  const resultado = await salvarPedidoShopee(db, { pedidoId, mapeado, watermarkUs, nowUs });

  // Step 6 (#1514) — the SECOND transaction, gated on the pedido write's own
  // outcome. `ignorado-obsoleto` means a NEWER delivery already landed, so this
  // payload's money is stale too; `ignorado-inexistente` never reaches here.
  // ⚠️ `ignorado-sem-mudanca` does NOT skip: the escrow carries no clock of its
  // own and `escrow_amount` is documented to move until the order completes, so
  // the fees change while the order row does not.
  let mapeadosPag: PagamentosMapeadosShopee | null = null;
  let pagamentos: ResultadoPagamentosShopee | null = null;
  if (resultado.acao !== 'ignorado-obsoleto') {
    mapeadosPag = mapearPagamentosShopee({
      linha,
      escrow,
      // The PEDIDO's own figure, never recomputed and never `escrow_amount`.
      valorCobrado: mapeado.dados.valorCobrado,
      watermarkUs,
      nowUs,
      contaId: integracaoId,
      orderSn,
    });
    pagamentos = await salvarPagamentosShopee(db, {
      pedidoId,
      contaId: integracaoId,
      orderSn,
      watermarkUs,
      nowUs,
      mapeados: mapeadosPag,
      // ⚠️ Supplied separately because the mapper's creation gate empties `docs`
      // whenever `pay_time` is unusable, and a `CANCELLED` re-read whose
      // `pay_time` came back `0` must still reverse a stored `aprovado`. Same
      // pure function the mapper calls — one implementation, two callers.
      alvoStatus: statusPagamentoDeOrderStatus(linha.order_status),
    });
  }

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
    // ── step 6: the pagamentos. Counts, enum tokens and money only — never a
    // `payment_processor_register` (a CNPJ), never a `transaction_id` (an
    // authorization code), never a buyer field.
    acaoPagamentos: pagamentos?.acao ?? null,
    pagamentos: pagamentos == null ? 0 : pagamentos.criados + pagamentos.atualizados,
    gruposPagamento: pagamentos?.gruposAplicados ?? null,
    somaPagante: pagamentos?.somaPagante ?? null,
    // ⚠️ Must be 0: on a marketplace `canalDevolveTroco` is false, so an excess
    // is cStat 866 and a shortfall 865 — no nota at all, for ever.
    divergenciaDeSoma: pagamentos?.divergenciaDeSoma ?? null,
    // Both readings side by side, so the first real BR orders settle the
    // composition as DATA: `tarifas` is the clamped figure the ERP charges,
    // `tarifasBrutas` its pre-clamp raw.
    tarifas: mapeadosPag?.docs[0]?.sempre.tarifas ?? null,
    tarifasBrutas: mapeadosPag?.diagnosticos.tarifasBrutas ?? null,
    // ⚠️ BR only, and a COUNT — settle-live register item 22 asks whether
    // `payment_info` is really provided from READY_TO_SHIP and whether it
    // survives past it. On any other region the key is absent rather than 0,
    // because "not applicable" and "none arrived" are different facts.
    ...(linha.region === REGIAO_BR_PEDIDO
      ? { entradasPaymentInfo: mapeadosPag?.diagnosticos.entradasPaymentInfo ?? 0 }
      : {}),
  });

  return {
    kind: 'pedido',
    acao: resultado.acao,
    orderSn,
    pedidoId,
    orderStatus: linha.order_status,
    itensSemProduto: semProduto.length,
    acaoPagamentos: pagamentos?.acao ?? null,
    pagamentosGravados: pagamentos == null ? 0 : pagamentos.criados + pagamentos.atualizados,
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
    acaoPagamentos: null,
    pagamentosGravados: 0,
    detail: `ignorado-inexistente:${motivo}`,
  };
}
