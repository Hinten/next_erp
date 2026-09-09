/**
 * The ONE Firestore write of the Shopee order import (#1513, step 5, plan
 * W2/W3/W6/W9) — create-or-update, in a single `db.runTransaction`.
 *
 * ## Why ONE transaction, where Mercado Livre needs four
 *
 * ML's data comes from four resources with four clocks, and its split also
 * serves the pack fan-out (N orders → 1 pedido). Shopee's comes from ONE
 * `get_order_detail` with ONE clock, and `consolidaPacote: 'nao'` means one
 * order → one pedido. Four transactions here would open four windows in which
 * halves of the same payload disagree, plus three more watermark comparisons
 * that can only ever disagree with the first.
 *
 * The consequence the caller must honour: `findOrCreateCliente` is a blind `add`
 * and cannot join a transaction, so the cliente and the endereço are resolved
 * BEFORE this call and only their outer-refs ride the single pedido write, as
 * fill-once fields re-checked against this transaction's own snapshot.
 *
 * ## The race class — **C**, and the honest reason
 *
 * The WHOLE mapped body is built outside the callback and re-applied verbatim on
 * an OCC retry. That is class B by the inventory's own definition, widened by
 * two network calls (`get_order_detail` + `get_escrow_detail`). ML's own
 * `orderPedidoTx.ts` is filed A because it maps INSIDE the callback; this one
 * deliberately does not, so a retry cannot re-run a mapper over a payload that
 * no longer matches the clock it was fetched with.
 *
 * The named guard, ADR 0011 tier 2, in **microseconds**:
 *
 *  - re-read the pedido with the callback's own `tx.get`;
 *  - compare the stored `lastMarketplaceUpdate` — read through `coerceToMicros`,
 *    because the legacy corpus holds ms ints and ISO strings — against the
 *    incoming watermark;
 *  - DROP with the named outcome `ignorado-obsoleto` when strictly older;
 *  - re-derive EVERY written value from that same snapshot: the estado through
 *    `estadoShopeeAplicavel`, the `hasUserInteraction` freeze, the fill-once
 *    refs, the item merge and the freight merge.
 *
 * ⚠️ **The unit IS the guard.** `get_order_detail.update_time` is SECONDS and is
 * converted ONCE, by `microsDeSegundosShopee`. Never by `coerceToMicros`, which
 * classifies by magnitude and reads `1.78e9` as MILLISECONDS — 1970, and a
 * comparison that answers "older" for ever (ADR 0011: a cross-unit comparison is
 * a guard that never fires).
 *
 * ⚠️ **Accept is `>=`, not `>`**, for two independent reasons: ML's convergence
 * argument (a crash between the accepted write and a later step leaves the
 * watermark already at this payload's value, and `>` could then never converge),
 * and Shopee's 1-second resolution (`UNPAID → PENDING → READY_TO_SHIP` inside
 * one second share one stamp, so `>` would drop the last two for ever).
 * Re-mapping an EQUAL stamp is safe because the mapper is pure over the wire
 * payload: a replay is byte-identical, every comparison below answers "same",
 * the patch comes out EMPTY and nothing is written (`ignorado-sem-mudanca`).
 *
 * ⚠️ The absent-document branch is `tx.create`, never `tx.set`. OCC turns a
 * concurrent create into an abort-and-retry that falls through to the update
 * path, and if the engine ever failed to detect it, `create` fails loudly
 * instead of clobbering the winner.
 *
 * ⚠️ This module moves NO stock. `onPedidoEstoqueSync` owns that and reacts to
 * the `estado` this transaction writes.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { coerceToMicros } from '@delfrance/core/datetime';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  CAPTURA_COMPRADOR_ESTADO,
  ESTADO_PEDIDO,
  flattenPedidoItens,
  type CapturaComprador,
  type EstadoPedido,
  type FreteDoPedido,
  type ItemDoPedido,
  type MarketplacePedido,
  type Pedido,
  type Volume,
} from '@delfrance/schemas';

import { mesclarFreteInicialShopee } from './orderFreteMapping';
import type { PedidoMapeadoShopee } from './orderMapping';
import {
  ALVO_ESTADO_SHOPEE,
  PREFIXO_ERRO_SHOPEE,
  estadoShopeeAplicavel,
  type MotivoEstadoShopee,
} from './orderStatusMaps';

/* -------------------------------------------------------------------------- */
/*                                  outcomes                                   */
/* -------------------------------------------------------------------------- */

export type AcaoPedidoShopee =
  | 'criado'
  | 'atualizado'
  /** The stored watermark is NEWER: this payload is a stale redelivery. */
  | 'ignorado-obsoleto'
  /** Accepted, re-mapped, and nothing came out different. */
  | 'ignorado-sem-mudanca';

/** Which of the four field groups actually reached the document. */
export type GrupoAplicadoShopee = 'estado' | 'watermark' | 'sempre' | 'dados' | 'preencher-uma-vez';

export interface ResultadoPedidoShopee {
  readonly pedidoId: string;
  readonly acao: AcaoPedidoShopee;
  /** The estado this write stored, or `null` when none was written. */
  readonly estadoEscrito: EstadoPedido | null;
  /** Why no estado was written, or `null` when one was. */
  readonly motivoEstado: MotivoEstadoShopee | null;
  /** A terminal estado was left. Logged loudly; see `estadoShopeeAplicavel`. */
  readonly estadoRessuscitado: boolean;
  /** The watermark now STORED — the accepted one, or the stored one on a drop. */
  readonly watermarkUs: number;
  readonly gruposAplicados: readonly GrupoAplicadoShopee[];
  /**
   * The pedido's `itens` as this transaction FOUND them (`null` on a create) —
   * handed to the incidente writer so a line already stored WITH a produto,
   * whoever bound it, raises nothing.
   */
  readonly itensGravados: Pedido['itens'] | null;
}

export interface SalvarPedidoShopeeArgs {
  /** `makePedidoIdShopee(contaId, orderSn)` — computed by the caller. */
  readonly pedidoId: string;
  readonly mapeado: PedidoMapeadoShopee;
  /** The order clock, µs. Compared with `>=` against the stored one. */
  readonly watermarkUs: number;
  /** The importer's ONE clock read, µs. Never a clock read in here. */
  readonly nowUs: number;
}

/* -------------------------------------------------------------------------- */
/*                          explicit, typed comparisons                        */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Every comparison below is FIELD BY FIELD and STRICT, deliberately — there
 * is no generic deep-equal in this module.
 *
 * A generic fold is the #1372 shape: it decides which edits count as "no change"
 * and therefore which ones are silently never written, and its SCOPE is what
 * goes wrong (that one folded `value_name` to a number, so `'90,5'` ≡ `'90,50'`
 * and real edits reached neither the provider nor Firestore, behind a 200).
 * Writing the fields out means a new field is a compile-time decision rather
 * than something a generic structural comparison quietly absorbs, and every one
 * of these is pinned with an equal pair AND a near-miss in
 * `orderPedidoTx.test.ts`.
 *
 * (⚠️ Naming the shared helper here — even in prose — would pull this file into
 * `equivalence-fold-inventory`'s scope, which greps raw TEXT. It matches the
 * SHARED helpers only, and a hand-rolled strict `===` is invisible to it by
 * design; the doctrine still binds, and the tests are how it is honoured.)
 */
function mesmasStrings(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a == null || b == null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function mesmoMarketplace(
  armazenado: MarketplacePedido | null | undefined,
  novo: MarketplacePedido,
): boolean {
  if (armazenado == null) return false;
  return (
    armazenado.tipo === novo.tipo &&
    armazenado.status === novo.status &&
    armazenado.statusEm === novo.statusEm &&
    mesmasStrings(armazenado.pendingTerms ?? null, novo.pendingTerms ?? null) &&
    armazenado.completedScenario === novo.completedScenario &&
    armazenado.cancelReason === novo.cancelReason &&
    armazenado.cancelBy === novo.cancelBy
  );
}

function mesmosVolumes(a: readonly Volume[] | null, b: readonly Volume[] | null): boolean {
  if (a == null || b == null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((v, i) => {
    const o = b[i]!;
    return (
      v.quantidade === o.quantidade &&
      v.especie === o.especie &&
      v.marca === o.marca &&
      v.numero === o.numero &&
      v.pesoBruto === o.pesoBruto &&
      v.pesoLiquido === o.pesoLiquido &&
      mesmasDimensoes(v.dimensoes, o.dimensoes) &&
      mesmasStrings(v.lacres ?? null, o.lacres ?? null)
    );
  });
}

function mesmasDimensoes(a: Volume['dimensoes'], b: Volume['dimensoes']): boolean {
  if (a == null || b == null) return a === b;
  return a.altura === b.altura && a.largura === b.largura && a.comprimento === b.comprimento;
}

/**
 * Did the freight merge change anything?
 *
 * ⚠️ It compares ONLY the eight fields `mesclarFreteInicialShopee` can refresh —
 * which is sound BECAUSE that is the exact set the merge writes: everything else
 * is copied from `existente` by the spread and cannot differ. A ninth refreshed
 * field must be added in both places, and `orderFreteMapping.test.ts` pins the
 * set against the merge itself.
 */
function mesmoFrete(armazenado: FreteDoPedido | null | undefined, novo: FreteDoPedido): boolean {
  if (armazenado == null) return false;
  return (
    armazenado.externalId === novo.externalId &&
    armazenado.externalOptionId === novo.externalOptionId &&
    armazenado.valorCobrado === novo.valorCobrado &&
    armazenado.custoCalculado === novo.custoCalculado &&
    armazenado.prazoDespacho === novo.prazoDespacho &&
    armazenado.dataPrevisaoEntrega === novo.dataPrevisaoEntrega &&
    armazenado.ultimaModificacao === novo.ultimaModificacao &&
    mesmosVolumes(armazenado.volumes ?? null, novo.volumes ?? null)
  );
}

/** The larger of two µs stamps (either may be absent). */
function maiorUs(a: number | null, b: number): number {
  return a == null || b > a ? b : a;
}

/** The item fields Shopee owns — the ones a re-read could disagree on. */
const CAMPOS_ITEM_DA_SHOPEE = [
  'quantidade',
  'precoDeVenda',
  'descontoUnitario',
  'nomeDeVenda',
  'sku',
] as const satisfies ReadonlyArray<keyof ItemDoPedido>;

/**
 * OBSERVABILITY ONLY — changes nothing.
 *
 * `ensureUniqueId` is `sha256(order_sn, mktplaceId, index)`: it carries no
 * quantity and no price, so the merge is APPEND-ONLY and a line already stored
 * is never rewritten. That is the Mercado Livre trade taken deliberately — the
 * alternative, replacing the line set on every delivery, would overwrite a
 * produto binding an operator made by hand and would make a partially cancelled
 * line indistinguishable from a re-priced one. This log turns the assumption
 * into data: if it never fires, append-only is provably right for Shopee too; if
 * it does, the follow-up has its evidence and its exact field list.
 *
 * Ids, field NAMES and numbers only — never a `nomeDeVenda` on the diverging
 * side, which would put a product title in a log for no gain.
 */
function reportarDivergenciaItem(
  orderSn: string,
  armazenado: ItemDoPedido | undefined,
  recebido: ItemDoPedido,
): void {
  if (armazenado == null) return;
  const divergentes = CAMPOS_ITEM_DA_SHOPEE.filter((c) => armazenado[c] !== recebido[c]);
  if (divergentes.length === 0) return;
  console.warn(
    '[shopee/pedidos] linha já importada difere do payload atual — merge é append-only',
    {
      orderSn,
      ensureUniqueId: recebido.ensureUniqueId,
      campos: divergentes,
    },
  );
}

/** `Record<produtoUid | 'NONE', ItemDoPedido[]>` + its `itensIds` projection. */
function agruparItens(itens: readonly ItemDoPedido[]): {
  itens: Pedido['itens'];
  itensIds: string[];
} {
  const registro: Pedido['itens'] = {};
  for (const item of itens) {
    const chave = item.produtoUid ?? 'NONE';
    (registro[chave] ??= []).push(item);
  }
  return { itens: registro, itensIds: Object.keys(registro) };
}

/**
 * The capture diary as stored, read tolerantly.
 *
 * ⚠️ A DIARY, never a GUARD — nothing here branches on the stored verdict. The
 * only thing read back is `tentativas` (a counter) and whether the record
 * already says `expirado`, which is a LATCH: once the unmask window closed with
 * nothing captured, a later delivery must not reopen it as `pendente` and invite
 * an operator to wait for something that will never arrive.
 */
function capturaArmazenada(raw: Record<string, unknown>): Partial<CapturaComprador> | null {
  const bruto = raw.capturaComprador;
  return typeof bruto === 'object' && bruto !== null ? (bruto as Partial<CapturaComprador>) : null;
}

/** A stored value that counts as "nothing here yet" for a fill-once field. */
function vazio(valor: unknown): boolean {
  return valor === null || valor === undefined || valor === '';
}

/**
 * The estado a CREATE opens with.
 *
 * `{ tipo: 'manter' }` (`TO_RETURN`) has nothing to keep when the document does
 * not exist, so it seeds `pago`: the rung every returning order passed through,
 * since Shopee only returns what was delivered. `marketplace.status` carries the
 * truth. Refusing to create instead would leave a backfill-discovered returning
 * order with no pedido at all.
 */
function estadoDeCriacao(mapeado: PedidoMapeadoShopee): EstadoPedido {
  const { alvo } = mapeado;
  if (alvo.tipo === ALVO_ESTADO_SHOPEE.estado) return alvo.estado;
  if (alvo.tipo === ALVO_ESTADO_SHOPEE.erro) return ESTADO_PEDIDO.error;
  return ESTADO_PEDIDO.pago;
}

/* -------------------------------------------------------------------------- */
/*                               the transaction                               */
/* -------------------------------------------------------------------------- */

export async function salvarPedidoShopee(
  db: Firestore,
  args: SalvarPedidoShopeeArgs,
): Promise<ResultadoPedidoShopee> {
  const { pedidoId, mapeado, watermarkUs, nowUs } = args;
  const orderSn = mapeado.numero;

  return db.runTransaction(async (tx: Transaction) => {
    /* ------------------------------- READ (one) ------------------------------ */
    const ref = pedidoCollection.docRef(db, {}, pedidoId);
    const snap = await tx.get(ref);

    /* --------------------------------- CREATE -------------------------------- */
    if (!snap.exists) {
      const estado = estadoDeCriacao(mapeado);
      const { itens, itensIds } = agruparItens(mapeado.dados.itens);
      const corpo = {
        ehSaida: mapeado.criacao.ehSaida,
        estado,
        numero: mapeado.preencherUmaVez.numero,
        integracaoPedidoOuterRef: mapeado.preencherUmaVez.integracaoPedidoOuterRef,
        listaDePrecosOuterRef: mapeado.preencherUmaVez.listaDePrecosOuterRef,
        operacaoPedidoOuterRef: mapeado.preencherUmaVez.operacaoPedidoOuterRef,
        clientePedidoOuterRef: mapeado.preencherUmaVez.clientePedidoOuterRef,
        enderecoFiscalOuterRef: mapeado.preencherUmaVez.enderecoFiscalOuterRef,
        itens,
        itensIds,
        freteInicial: mapeado.dados.freteInicial,
        valorCobrado: mapeado.dados.valorCobrado,
        descontoTotal: mapeado.dados.descontoTotal,
        observacoesInternas: mapeado.dados.observacoesInternas,
        bloquearEmissaoNFe: mapeado.criacao.bloquearEmissaoNFe,
        marketplace: mapeado.sempre.marketplace,
        capturaComprador: {
          ...mapeado.sempre.capturaComprador,
          camposRecusados: [...mapeado.sempre.capturaComprador.camposRecusados],
          em: nowUs,
          tentativas: 1,
        },
        error: mapeado.sempre.erro.tipo === 'definir' ? mapeado.sempre.erro.mensagem : null,
        // ⚠️ The wall clock is the fallback, not a fabricated zero: Shopee
        // zero-fills `create_time` on some orders and a pedido with no
        // `timestamp` sorts to the bottom of `/pedidos` for ever (the list orders
        // by `timestamp desc`). "When we first saw it" is the honest answer.
        timestamp: mapeado.preencherUmaVez.timestamp ?? nowUs,
        ultimaModificacao: nowUs,
        lastMarketplaceUpdate: watermarkUs,
      };
      // `tx.create`, never `tx.set` — see the module header.
      tx.create(ref, pedidoCollection.parse(corpo));
      return {
        pedidoId,
        acao: 'criado',
        estadoEscrito: estado,
        motivoEstado: null,
        estadoRessuscitado: false,
        watermarkUs,
        gruposAplicados: ['estado', 'watermark', 'sempre', 'dados', 'preencher-uma-vez'],
        itensGravados: null,
      } satisfies ResultadoPedidoShopee;
    }

    /* --------------------------------- UPDATE -------------------------------- */
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    const atual = pedidoCollection.parseRead(raw, pedidoCollection.docPath({}, pedidoId));
    const itensGravados = (atual.itens ?? {}) as Pedido['itens'];

    // The watermark gate. `coerceToMicros` on the STORED side only — the legacy
    // corpus holds ms ints and ISO strings there.
    const armazenadoUs = coerceToMicros(raw.lastMarketplaceUpdate);
    if (armazenadoUs != null && watermarkUs < armazenadoUs) {
      // ADR 0011: a server-side handler drops AND says so.
      // eslint-disable-next-line no-console -- one line per dropped redelivery; ids and numbers only
      console.info('[shopee/pedidos] payload obsoleto descartado', {
        orderSn,
        pedidoId,
        armazenadoUs,
        recebidoUs: watermarkUs,
      });
      return {
        pedidoId,
        acao: 'ignorado-obsoleto',
        estadoEscrito: null,
        motivoEstado: null,
        estadoRessuscitado: false,
        watermarkUs: armazenadoUs,
        gruposAplicados: [],
        itensGravados,
      } satisfies ResultadoPedidoShopee;
    }

    const novaEntrega = armazenadoUs == null || watermarkUs > armazenadoUs;
    const congelado = atual.hasUserInteraction === true;
    const patch: Record<string, unknown> = {};
    const grupos = new Set<GrupoAplicadoShopee>();

    /* -- estado: re-derived from THIS snapshot, never from the wire alone ----- */
    const veredito = estadoShopeeAplicavel(atual.estado, mapeado.alvo);
    if (veredito.escrever) {
      patch.estado = veredito.estado;
      grupos.add('estado');
      if (veredito.ressuscitado) {
        console.warn('[shopee/pedidos] estado ressuscitado — um pedido cancelado voltou a viver', {
          orderSn,
          pedidoId,
          de: atual.estado,
          para: veredito.estado,
          status: mapeado.orderStatus,
        });
      }
    }

    /* -- the watermark: the ACCEPTED value, never max(stored, incoming) ------- */
    if (armazenadoUs !== watermarkUs) {
      patch.lastMarketplaceUpdate = watermarkUs;
      grupos.add('watermark');
    }

    /* -- ALWAYS ---------------------------------------------------------------- */
    if (!mesmoMarketplace(atual.marketplace, mapeado.sempre.marketplace)) {
      patch.marketplace = mapeado.sempre.marketplace;
      grupos.add('sempre');
    }

    const capturaAnterior = capturaArmazenada(raw);
    const capturaEstado =
      capturaAnterior?.estado === CAPTURA_COMPRADOR_ESTADO.expirado
        ? CAPTURA_COMPRADOR_ESTADO.expirado
        : mapeado.sempre.capturaComprador.estado;
    const camposRecusados = [...mapeado.sempre.capturaComprador.camposRecusados];
    const vereditoMudou =
      capturaAnterior == null ||
      capturaAnterior.estado !== capturaEstado ||
      capturaAnterior.statusObservado !== mapeado.sempre.capturaComprador.statusObservado ||
      !mesmasStrings(capturaAnterior.camposRecusados ?? null, camposRecusados);
    // ⚠️ `tentativas` counts DISTINCT order updates we tried to capture on, not
    // deliveries: a Cloud Tasks retry and the hourly sweep re-drive the SAME
    // payload, and counting those would both inflate the number and make a
    // byte-identical replay impossible to recognise as a no-op.
    if (novaEntrega || vereditoMudou) {
      patch.capturaComprador = {
        estado: capturaEstado,
        statusObservado: mapeado.sempre.capturaComprador.statusObservado,
        em: nowUs,
        tentativas:
          (typeof capturaAnterior?.tentativas === 'number' ? capturaAnterior.tentativas : 0) + 1,
        camposRecusados,
      };
      grupos.add('sempre');
    }

    if (mapeado.sempre.erro.tipo === 'definir') {
      if (atual.error !== mapeado.sempre.erro.mensagem) {
        patch.error = mapeado.sempre.erro.mensagem;
        grupos.add('sempre');
      }
    } else if (typeof atual.error === 'string' && atual.error.startsWith(PREFIXO_ERRO_SHOPEE)) {
      // ⚠️ The prefix is what makes the CLEAR provably OURS: an error another
      // writer left (an NF-e failure, a manual note) is never erased.
      patch.error = null;
      grupos.add('sempre');
    }

    /* -- ONLY WHILE hasUserInteraction !== true -------------------------------- */
    if (!congelado) {
      const plano = flattenPedidoItens(itensGravados);
      const vistos = new Set(
        plano.map((i) => i.ensureUniqueId).filter((id): id is string => id != null),
      );
      const porId = new Map(
        plano.filter((i) => i.ensureUniqueId != null).map((i) => [i.ensureUniqueId!, i]),
      );
      const merged = [...plano];
      let itensMudaram = false;
      for (const item of mapeado.dados.itens) {
        if (item.ensureUniqueId != null && vistos.has(item.ensureUniqueId)) {
          reportarDivergenciaItem(orderSn, porId.get(item.ensureUniqueId), item);
          continue;
        }
        if (item.ensureUniqueId != null) vistos.add(item.ensureUniqueId);
        merged.push(item);
        itensMudaram = true;
      }
      if (itensMudaram) {
        const agrupado = agruparItens(merged);
        patch.itens = agrupado.itens;
        patch.itensIds = agrupado.itensIds;
        grupos.add('dados');
      }

      if (atual.valorCobrado !== mapeado.dados.valorCobrado) {
        patch.valorCobrado = mapeado.dados.valorCobrado;
        grupos.add('dados');
      }
      if (atual.descontoTotal !== mapeado.dados.descontoTotal) {
        patch.descontoTotal = mapeado.dados.descontoTotal;
        grupos.add('dados');
      }
      if (atual.observacoesInternas !== mapeado.dados.observacoesInternas) {
        patch.observacoesInternas = mapeado.dados.observacoesInternas;
        grupos.add('dados');
      }
      const freteMesclado = mesclarFreteInicialShopee(
        atual.freteInicial ?? null,
        mapeado.dados.freteInicial,
      );
      if (!mesmoFrete(atual.freteInicial, freteMesclado)) {
        patch.freteInicial = freteMesclado;
        grupos.add('dados');
      }
    }

    /* -- FILL-ONCE: only where the STORED document holds nothing ---------------- */
    // ⚠️ Checked against the RAW snapshot, per field and per delivery. A masked
    // import supplies `null` for both buyer refs, so it writes nothing here and
    // structurally CANNOT unlink an already-linked cliente.
    const preencher: ReadonlyArray<[keyof typeof mapeado.preencherUmaVez, string]> = [
      ['numero', 'numero'],
      ['timestamp', 'timestamp'],
      ['integracaoPedidoOuterRef', 'integracaoPedidoOuterRef'],
      ['listaDePrecosOuterRef', 'listaDePrecosOuterRef'],
      ['operacaoPedidoOuterRef', 'operacaoPedidoOuterRef'],
      ['clientePedidoOuterRef', 'clientePedidoOuterRef'],
      ['enderecoFiscalOuterRef', 'enderecoFiscalOuterRef'],
    ];
    for (const [chave, campo] of preencher) {
      const valor = mapeado.preencherUmaVez[chave];
      if (valor != null && vazio(raw[campo])) {
        patch[campo] = valor;
        grupos.add('preencher-uma-vez');
      }
    }
    // ⚠️ `bloquearEmissaoNFe` is deliberately NOT in that list: it is written on
    // CREATE only. The field is operator-owned and client-writable, and an
    // importer that also filled it later could not tell an operator's own block
    // apart from its own — see `orderMapping.ts`'s docblock.

    if (Object.keys(patch).length === 0) {
      return {
        pedidoId,
        acao: 'ignorado-sem-mudanca',
        estadoEscrito: null,
        motivoEstado: veredito.escrever ? null : veredito.motivo,
        estadoRessuscitado: false,
        watermarkUs,
        gruposAplicados: [],
        itensGravados,
      } satisfies ResultadoPedidoShopee;
    }

    // Wall clock, monotonic and NEVER null: `parseMergePatch` keeps a null and
    // would erase the stamp. Other writers (a human save, the estoque sync) may
    // already have set it ahead of us.
    patch.ultimaModificacao = maiorUs(coerceToMicros(raw.ultimaModificacao), nowUs);

    tx.update(ref, pedidoCollection.parseMerge(patch));
    return {
      pedidoId,
      acao: 'atualizado',
      estadoEscrito: veredito.escrever ? veredito.estado : null,
      motivoEstado: veredito.escrever ? null : veredito.motivo,
      estadoRessuscitado: veredito.escrever && veredito.ressuscitado,
      watermarkUs,
      gruposAplicados: [...grupos],
      itensGravados,
    } satisfies ResultadoPedidoShopee;
  });
}
