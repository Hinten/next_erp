/**
 * `rastrearPedidoShopee` — one shipment push becomes one `freteInicial` merge
 * (#1515, step 7, plan §3.0-P P3).
 *
 * This is the codes-4/30/47 arm's whole body, and it is the `importarPedido.ts`
 * shape with a smaller waist: the push says only *a package changed* and names
 * it, and **nothing on the push body is ever written**. The handler re-fetches
 * `get_package_detail` for that package and applies THAT, which is what makes a
 * replayed delivery, an out-of-order delivery and a code 4 — whose page
 * documents no `update_time` at all — idempotent.
 *
 * ## The sequence, and why it is this order
 *
 *  1. `makePedidoIdShopee(integracaoId, orderSn)` — the digest, never a query;
 *  2. a CHEAP existence read of that pedido, **before** the pull. A pedido that
 *     is not here yet spends ZERO Shopee calls, on every one of the seven daily
 *     re-drives. ⚠️ It is a SKIP, never the guard: `salvarFreteShopee` re-reads
 *     inside its own transaction and answers `ignorado-sem-pedido` itself if the
 *     pedido vanishes in between (root CLAUDE.md rule 7 — a predicate re-checked
 *     against a binding read outside the transaction is not a guard);
 *  3. ONE `get_package_detail` for the named package;
 *  4. the row is reconciled **by `package_number`, never by position** — this
 *     page may answer with fewer rows than were asked for, exactly as
 *     `get_order_detail` may, and the per-element `.catch(null)` means a sibling
 *     row can be illegible without costing this one;
 *  5. `salvarFreteShopee` — the class-B transaction, which owns every write;
 *  6. ONE synthetic code 3 when the pedido is missing (see the bound below);
 *  7. one `console.info` line.
 *
 * ## Microseconds — this module is µs **SITE 6**
 *
 * It performs the single `millisToMicros(nowMs)` of the push path and hands
 * `nowUs` DOWN as a parameter, exactly as `importarPedido.ts` (site 2) does for
 * the import path. There is no other clock read anywhere on this path: `nowMs`
 * arrives from the pipeline's injectable clock. `freteTx.ts` (site 7) is where
 * the wire SECONDS of the package cross into µs; `fretePushShopee.ts` and
 * `freteShopeeMapping.ts` convert nothing at all.
 *
 * ## The synthetic code 3, and its bound
 *
 * A code 4/30/47 can legitimately arrive before the code 3 that creates the
 * pedido: no Shopee page states an ordering between push codes and
 * `push_guarantee = 0`. So a missing pedido enqueues ONE synthetic code 3
 * (`origem: 'rastreio'`) — the step-6 settlement sweep's `origem: 'liquidacao'`
 * is the live precedent — and the delivery DEFERS.
 *
 * **≤ 1 + `MAX_TENTATIVAS_DEFERRED` = 8 synthetics per delivery**, proven:
 *
 *  1. a `defer` disposition does **not** retry on the Cloud Tasks queue — the
 *     pipeline writes the row `deferred` and returns, so the task path
 *     contributes exactly ONE invocation;
 *  2. the deferred lane re-drives that document once a day, capped at
 *     `MAX_TENTATIVAS_DEFERRED` (7), and then parks;
 *  3. this module enqueues at most ONE synthetic per invocation — one call site,
 *     no loop, gated on `acao === 'ignorado-sem-pedido'`;
 *  4. ⇒ ≤ 8, and the sequence stops the moment the pedido exists, because step 2
 *     of the sequence above is what gates it. The realistic figure for a
 *     multi-package order is 8 and not 8·N: the FIRST successful synthetic
 *     imports the whole order, so every sibling delivery's next re-drive finds
 *     the pedido.
 *
 * ⚠️ "Only on the last retry" is NOT implementable and its absence is a
 * decision: the shared pipeline's `process(db, payload)` carries no attempt
 * count and `toDisposition` ignores `phase` deliberately, so it would mean
 * widening that contract for one channel — and the row that would have created
 * the pedido on day 0 would instead be created on day 7.
 *
 * ## Errors (rule 6 — narrow `instanceof`, rethrow the rest)
 *
 * ⚠️ This module converts NO wire failure into a disposition: the
 * error → `throw`/`defer`/`park` table is the notification arm's
 * (`disposicaoDaFalhaDeRastreio` in `notificacoes/notificacao.ts`), where the
 * pipeline's vocabulary lives. The ONE contained failure here is
 * {@link ShopeeTasksDisabledError} on the synthetic enqueue — a configured mode,
 * not a failure.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import type { EstadoFrete } from '@delfrance/schemas';
import type { ShopeeClient } from '@delfrance/integrations-shopee';

import { loadShopeeContext } from '../core/shopee';
import { notificacaoSinteticaDePedido } from '../notificacoes/notificacaoSintetica';
import {
  ShopeeTasksDisabledError,
  createShopeeTaskScheduler,
  type ShopeeTaskScheduler,
} from '../shopeeTasks';
import {
  observadoDoPacoteDetalhe,
  type CodigoPushFrete,
  type DiagnosticoPushFrete,
  type PacoteObservadoShopee,
} from './fretePushShopee';
import { salvarFreteShopee, type AcaoFreteShopee } from './freteTx';
import { makePedidoIdShopee } from './orderIds';

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

export interface AlvoDeRastreioShopee {
  readonly integracaoId: string;
  readonly shopId: number;
  readonly orderSn: string;
  readonly packageNumber: string;
  readonly code: CodigoPushFrete;
  /** The task's ONE clock read, in MILLISECONDS. The µs conversion is inside. */
  readonly nowMs: number;
  /** LOGGED, never written — see `fretePushShopee.ts`. */
  readonly diagnostico: DiagnosticoPushFrete;
}

/**
 * The transaction's own "there is no pedido yet" verdict, typed against
 * {@link AcaoFreteShopee} rather than written as a bare literal, so the day that
 * member is renamed this file fails to compile instead of silently never
 * matching. It is what the arm turns into `frete-adiado`.
 */
export const ACAO_FRETE_SEM_PEDIDO: AcaoFreteShopee = 'ignorado-sem-pedido';

/**
 * Shopee answered without the package we asked for — a split/unsplit, or a
 * number that never existed.
 *
 * ⚠️ It is the HANDLER's action and deliberately NOT a member of
 * {@link AcaoFreteShopee}: the transaction never runs on this path, so widening
 * its union would make a value that can never come out of a transaction look as
 * if it could.
 */
export const ACAO_FRETE_PACOTE_AUSENTE = 'ignorado-pacote-ausente';

export interface ResultadoRastreioShopee {
  readonly kind: 'frete';
  readonly acao: AcaoFreteShopee | typeof ACAO_FRETE_PACOTE_AUSENTE;
  readonly orderSn: string;
  readonly packageNumber: string;
  /** `null` only on {@link ACAO_FRETE_PACOTE_AUSENTE}. */
  readonly pedidoId: string | null;
  /** The RAW wire token the pull answered, or `null` when it answered none. */
  readonly statusMarketplace: string | null;
  readonly estadoEscrito: EstadoFrete | null;
  readonly campos: readonly string[];
  /** Whether the ONE synthetic code 3 really reached the queue (the valve). */
  readonly sinteticaEnfileirada: boolean;
  /** A short machine-readable tail for the log filter. */
  readonly detail: string;
}

export interface ShopeeRastrearPedidoDeps {
  /**
   * The client seam. Default: `loadShopeeContext(db, id).createShopClient()` —
   * the same chain the order import uses, and the token rides as a FUNCTION so
   * one that lapses mid-call is renewed rather than replayed dead.
   */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /** The synthetic-code-3 enqueue seam. Default: the real Cloud Tasks scheduler. */
  readonly scheduler?: ShopeeTaskScheduler;
}

/* -------------------------------------------------------------------------- */
/*                              the wire read                                  */
/* -------------------------------------------------------------------------- */

async function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: ShopeeRastrearPedidoDeps,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/* -------------------------------------------------------------------------- */
/*                             the synthetic code 3                            */
/* -------------------------------------------------------------------------- */

/**
 * ONE synthetic code 3 per invocation, so the pedido is created by the SAME
 * step-5 path a real push would take.
 *
 * ⚠️ **Contained on the VALVE only.** `SHOPEE_TASKS_DISABLED=1` (or an unset
 * region) makes the enqueue throw BY DESIGN; that is a configured mode, not a
 * failure, and letting it fail the delivery would turn sweep-only mode into a
 * `failed` row per shipment push. Everything else propagates (rule 6) — and it
 * is cheap to retry, because no Shopee call has been spent at this point.
 */
async function enfileirarSinteticaDeRastreio(
  scheduler: ShopeeTaskScheduler,
  p: { shopId: number; orderSn: string; packageNumber: string; nowMs: number },
): Promise<boolean> {
  try {
    await scheduler.enqueue(
      notificacaoSinteticaDePedido({
        shopId: p.shopId,
        orderSn: p.orderSn,
        nowMs: p.nowMs,
        origem: 'rastreio',
      }),
    );
    return true;
  } catch (err) {
    if (!(err instanceof ShopeeTasksDisabledError)) throw err;
    console.warn('[shopee/frete] code 3 sintético não enfileirado (válvula)', {
      orderSn: p.orderSn,
      packageNumber: p.packageNumber,
    });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 the handler                                 */
/* -------------------------------------------------------------------------- */

export async function rastrearPedidoShopee(
  db: Firestore,
  alvo: AlvoDeRastreioShopee,
  deps: ShopeeRastrearPedidoDeps = {},
): Promise<ResultadoRastreioShopee> {
  const { integracaoId, shopId, orderSn, packageNumber, code, nowMs, diagnostico } = alvo;

  const pedidoId = makePedidoIdShopee(integracaoId, orderSn);

  // (2) the cheap skip. See the module header: a SKIP, never the guard.
  const existe = (await pedidoCollection.docRef(db, {}, pedidoId).get()).exists;

  let acao: ResultadoRastreioShopee['acao'] = ACAO_FRETE_SEM_PEDIDO;
  let detail = `${ACAO_FRETE_SEM_PEDIDO}:pedido ${orderSn} ainda não existe`;
  let campos: readonly string[] = [];
  let estadoEscrito: EstadoFrete | null = null;
  let observado: PacoteObservadoShopee | null = null;
  let ilegiveis = 0;
  let pedidoIdDoResultado: string | null = pedidoId;

  if (existe) {
    const client = await clienteShopee(db, integracaoId, deps);
    const detalhe = await client.getPackageDetail({ packageNumbers: [packageNumber] });

    // The per-ELEMENT `.catch(null)` of `shopeePackageDetailPayloadSchema` is
    // what makes an illegible sibling row cost a COUNT rather than the delivery.
    ilegiveis = detalhe.package_list.filter((r) => r === null).length;
    // ⚠️ By `package_number`, NEVER by position.
    const linha = detalhe.package_list.find(
      (r) => r !== null && r.package_number === packageNumber,
    );

    if (linha == null) {
      acao = ACAO_FRETE_PACOTE_AUSENTE;
      pedidoIdDoResultado = null;
      detail = `pacote ${packageNumber} não veio na resposta (linhas ilegíveis: ${String(ilegiveis)})`;
    } else {
      observado = observadoDoPacoteDetalhe(linha);
      if (observado === null) {
        acao = ACAO_FRETE_PACOTE_AUSENTE;
        pedidoIdDoResultado = null;
        detail = `pacote sem package_number utilizável na resposta (linhas ilegíveis: ${String(ilegiveis)})`;
      } else {
        const resultado = await salvarFreteShopee(db, {
          pedidoId,
          orderSn,
          observados: [observado],
          // ⚠️ BOTH null on the push path, and that is the wire's own shape: there
          // is no order payload here, so there is no order clock to fall back to
          // and no order-level deadline to fold. The package carries its own.
          relogioDaOrdemUs: null,
          prazoDaOrdemUs: null,
          // µs SITE 6 — the ONE conversion of this path (see the module header).
          nowUs: millisToMicros(nowMs),
        });
        acao = resultado.acao;
        campos = resultado.campos;
        estadoEscrito = resultado.estadoEscrito;
        detail = resultado.acao;
      }
    }
  }

  // (6) ONE call site, and it covers BOTH ways the pedido can be missing — the
  // cheap skip above, and the transaction's own verdict when it vanished
  // mid-flight.
  const sintetica =
    acao === ACAO_FRETE_SEM_PEDIDO
      ? await enfileirarSinteticaDeRastreio(deps.scheduler ?? createShopeeTaskScheduler(), {
          shopId,
          orderSn,
          packageNumber,
          nowMs,
        })
      : false;

  // ONE line per delivery. Ids, counts, enum tokens and BOOLEANS only.
  //
  // ⚠️ Neither tracking number is logged as a VALUE, only as PRESENCE: the pair
  // of booleans is what answers "did the push and the pull agree that there is
  // one", which is the question, and a carrier code plus a public tracking site
  // is more than a task log needs. `recipient_address`, `driver_info` and
  // `virtual_contact_number` are unreachable from the typed row (they are
  // deliberately undeclared on `shopeePackageDetailRowSchema`), so no line here
  // can name them.
  //
  // ⚠️ It says nothing about the MERGE itself — `freteTx.ts` already logs at
  // most three lines per call (the applied delivery, the unknown tokens, the
  // resurrection warn), and repeating them here would double every one of them.
  // What this line adds is the PUSH-vs-PULL comparison, which nothing else sees:
  // settle-live register item 28.
  // eslint-disable-next-line no-console -- expected on every healthy delivery; a warn nobody can act on is what hides the real ones
  console.info('[shopee/frete] entrega de rastreio', {
    integracaoId,
    shopId,
    orderSn,
    pedidoId,
    packageNumber,
    code,
    acao,
    estadoEscrito,
    campos,
    statusMarketplace: observado?.fulfillmentStatus ?? null,
    statusDoPush: diagnostico.statusDoPush,
    camposMudados: diagnostico.camposMudados,
    divergePushVsPull:
      diagnostico.statusDoPush != null &&
      observado != null &&
      diagnostico.statusDoPush !== observado.fulfillmentStatus,
    temTrackingNoPush: diagnostico.trackingNoDoPush != null,
    temTrackingNoPull: observado?.trackingNumber != null,
    relogioDoPushS: diagnostico.relogioDoPushS,
    relogioDoPacoteS: observado?.updateTimeS ?? null,
    ilegiveis,
    sintetica,
  });

  return {
    kind: 'frete',
    acao,
    orderSn,
    packageNumber,
    pedidoId: pedidoIdDoResultado,
    statusMarketplace: observado?.fulfillmentStatus ?? null,
    estadoEscrito,
    campos,
    sinteticaEnfileirada: sintetica,
    detail,
  };
}
