/**
 * `importarDevolucaoShopee` — one code-29 delivery becomes one return incidente
 * (#1525, step 17). The devolução arm's whole body, reached ONLY through the
 * lazy `await import('../devolucoes/importarDevolucao')` in
 * `notificacoes/notificacao.ts` (static value imports from `../pedidos/*` are
 * therefore fine here).
 *
 * The push is a POINTER (`push 32` names a return and four fields), and
 * **nothing on it is ever written**: the handler re-fetches `get_return_detail`
 * and applies THAT — which is what makes a replayed, an out-of-order and a
 * synthetic delivery (the poller's `reconciliacao`, the action route's
 * `acao-vendedor`) all idempotent. The push's own claims ride the log line only
 * (`DiarioPushDevolucao`), and where they disagree with the pull, the PULL wins.
 *
 * ## The sequence, and why it is this order
 *
 *  1. `makePedidoIdShopee(integracaoId, orderSn)` — the digest, never a query —
 *     and `idIncidenteDevolucaoShopee(returnSn)`, which refuses a malformed
 *     return_sn with a `RangeError` BEFORE any read;
 *  2. a CHEAP existence read of that pedido. Absent ⇒ ONE synthetic code 3 and
 *     ZERO Shopee calls (below). ⚠️ A SKIP, never the guard: the transaction
 *     re-reads the pedido itself (root CLAUDE.md rule 7);
 *  3. ONE `get_return_detail`. A refusal `classificarRecusaDevolucaoShopee`
 *     reads as `devolucao-inexistente` returns {@link ACAO_DEVOLUCAO_INEXISTENTE}
 *     (the arm parks it); EVERY other failure propagates to the arm's class
 *     table — ⚠️ `error_permission` included, which is NOT "not found";
 *  4. the detail must describe THIS delivery's order and return, else
 *     {@link ACAO_DEVOLUCAO_OUTRO_PEDIDO} with ZERO writes — a cheap integrity
 *     check, never a re-key (the arm parks it);
 *  5. `mapearDevolucaoShopee` → `salvarIncidenteDevolucaoShopee`, the class-B
 *     transaction that owns every incidente write;
 *  6. the aviso, from the transaction's CONFIRMED state
 *     (`aplicarAvisoDeDevolucao` — which outcomes project, and why the
 *     equal-clock replay does, is that module's docblock);
 *  7. ONE synthetic code 3 when the pedido is missing, on either path;
 *  8. ONE `console.info` line.
 *
 * ## The synthetic code 3, and its bound
 *
 * A return can be announced before the order exists here (a never-imported
 * order, a code 3 still in flight). The step-5 importer is the single writer of
 * pedidos, so this module never creates one: it enqueues ONE synthetic code 3
 * (`origem: 'devolucao'`) and the arm DEFERS (`devolucao-adiada`).
 *
 * - **One per delivery invocation**: one call site, no loop, gated on
 *   `ignorado-sem-pedido` — which covers BOTH the cheap skip and the
 *   transaction's own verdict when the pedido vanished mid-flight.
 * - **Stamped `carimboDoDiaUtcMs(nowMs)`**, never `nowMs`: the code-3 doc id
 *   carries the envelope stamp, so the deferred lane's daily re-drives of one
 *   return land on ONE code-3 row per order per UTC day, not one per attempt
 *   (the step-15b bound, `3685867cc`). Flooring is safe because the code-3 arm
 *   never reads the envelope stamp as a clock (its watermark is
 *   `get_order_detail.update_time`).
 * - **Contained on the VALVE only** — {@link ShopeeTasksDisabledError} is a
 *   configured mode (`SHOPEE_TASKS_DISABLED=1`), and letting it fail the
 *   delivery would turn sweep-only mode into a `failed` row per return push.
 *   Everything else propagates (rule 6); no Shopee call was spent yet on the
 *   cheap-skip path, so a retry is cheap.
 *
 * No age gate (R-8): a REAL code 3 at `TO_RETURN` already creates the same
 * `pago` pedido for a never-imported order, so this adds only a strict subset
 * of an existing step-5 behaviour.
 *
 * ## Units
 *
 * This module converts NOTHING and reads no clock: `nowMs` arrives from the
 * pipeline's injectable clock, the detail's SECONDS cross into µs inside
 * `devolucaoMapping.ts` (by calling µs site 3), and the aviso's "now" crosses
 * through `avisos/autorizacao.ts`. The µs site list in `apps/shopee/CLAUDE.md`
 * still says eight.
 *
 * ## The log line — ids, tokens, counts and booleans only
 *
 * Never an amount, a reason TEXT or any buyer field (the package's returns
 * schemas strip those before they reach here). Shopee's status, reason and
 * logistics TOKENS ride it once per delivery — the only record of a token no
 * table here knows — and anything that is not a plain token is replaced by a
 * marker rather than logged (`tokenParaLog.ts`, the ONE token rule).
 * `erroEnvelope` is the envelope's raw `error` on a success (`''`/`' '`/`'-'`
 * — settle-live register 231's instrument, and the transport admits nothing
 * else as a success), and on the one refusal this module turns into an outcome
 * it is Shopee's code through `codigoSeguro` (`nfe/redacaoNfe.ts`), never raw.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  ShopeeApiError,
  type ShopeeClient,
  type ShopeeReturnDetail,
} from '@delfrance/integrations-shopee';

import type { AvisoDeps } from '../avisos/autorizacao';
import { loadShopeeContext } from '../core/shopee';
import { codigoSeguro } from '../nfe/redacaoNfe';
import {
  carimboDoDiaUtcMs,
  notificacaoSinteticaDePedido,
} from '../notificacoes/notificacaoSintetica';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import {
  ShopeeTasksDisabledError,
  createShopeeTaskScheduler,
  type ShopeeTaskScheduler,
} from '../shopeeTasks';
import { aplicarAvisoDeDevolucao, type ResultadoAvisoDevolucao } from './avisoDevolucao';
import { STATUS_DEVOLUCAO_CONHECIDOS, mapearDevolucaoShopee } from './devolucaoMapping';
import {
  salvarIncidenteDevolucaoShopee,
  type AcaoDevolucaoTx,
  type PrevisaoDevolucao,
} from './devolucaoTx';
import { idIncidenteDevolucaoShopee } from './idsDevolucao';
import type { DiarioPushDevolucao, OrigemImportacaoDevolucao } from './pushDevolucao';
import { MOTIVO_RECUSA_DEVOLUCAO, classificarRecusaDevolucaoShopee } from './recusaDevolucao';
import { tokenParaLog } from './tokenParaLog';

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

/**
 * The transaction's own "there is no pedido yet" verdict — typed against
 * {@link AcaoDevolucaoTx}, so the day that member is renamed this file fails to
 * compile instead of silently never matching. The cheap skip answers it too.
 */
export const ACAO_DEVOLUCAO_SEM_PEDIDO = 'ignorado-sem-pedido' as const satisfies AcaoDevolucaoTx;

/**
 * Shopee says the return does not exist (`devolucao-inexistente`).
 *
 * ⚠️ The HANDLER's action and deliberately NOT a member of
 * {@link AcaoDevolucaoTx}: the transaction never runs on this path.
 */
export const ACAO_DEVOLUCAO_INEXISTENTE = 'ignorado-inexistente' as const;

/**
 * The detail describes another order — or another return — than the delivery
 * named. ZERO writes; the handler's action, never the transaction's.
 */
export const ACAO_DEVOLUCAO_OUTRO_PEDIDO = 'ignorado-outro-pedido' as const;

export interface AlvoDeImportacaoDevolucaoShopee {
  readonly integracaoId: string;
  readonly shopId: number;
  readonly orderSn: string;
  /** ALPHANUMERIC — `ehReturnSnShopee`; the arm already refused anything else. */
  readonly returnSn: string;
  /** The task's ONE clock read, in MILLISECONDS. Nothing here converts it. */
  readonly nowMs: number;
  readonly origem: OrigemImportacaoDevolucao;
  /** What the push CLAIMED — LOGGED, never written. `null` for a caller with no push. */
  readonly diario: DiarioPushDevolucao | null;
}

export interface ResultadoImportacaoDevolucaoShopee {
  readonly acao:
    | AcaoDevolucaoTx
    | typeof ACAO_DEVOLUCAO_INEXISTENTE
    | typeof ACAO_DEVOLUCAO_OUTRO_PEDIDO;
  /** The derived pedido id — the one this delivery looked at, on every path. */
  readonly pedidoId: string | null;
  /**
   * The status the PULL answered — never the push's claim. `null` only where no
   * detail was read (the cheap skip, a return Shopee does not know).
   */
  readonly statusDevolucao: string | null;
  /** The aviso effect, or `null` when the transaction did not run. */
  readonly aviso: ResultadoAvisoDevolucao | null;
  /** Whether the ONE synthetic code 3 really reached the queue (the valve). */
  readonly sinteticaEnfileirada: boolean;
  /** A short machine-readable tail for the log filter. */
  readonly detail: string;
}

export interface ShopeeImportarDevolucaoDeps {
  /**
   * The client seam. Default: `loadShopeeContext(db, id).createShopClient()` —
   * the token rides as a FUNCTION, renewed rather than replayed dead.
   */
  readonly clientFor?: (
    db: Firestore,
    integracaoId: string,
  ) => Promise<Pick<ShopeeClient, 'getReturnDetail'>>;
  /** The synthetic-code-3 enqueue seam. Default: the real Cloud Tasks scheduler. */
  readonly scheduler?: ShopeeTaskScheduler;
  /**
   * The aviso seam. Default: `FieldValue.increment` and the delivery's own
   * `nowMs` — never a second clock read.
   */
  readonly aviso?: AvisoDeps;
}

/* -------------------------------------------------------------------------- */
/*                                   helpers                                   */
/* -------------------------------------------------------------------------- */

async function clienteShopee(
  db: Firestore,
  integracaoId: string,
  deps: ShopeeImportarDevolucaoDeps,
): Promise<Pick<ShopeeClient, 'getReturnDetail'>> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/**
 * ONE synthetic code 3 per invocation (module docblock: the bound, the day
 * stamp, the valve-only containment).
 */
async function enfileirarSinteticaDePedido(
  scheduler: ShopeeTaskScheduler,
  p: { shopId: number; orderSn: string; returnSn: string; nowMs: number },
): Promise<boolean> {
  try {
    await scheduler.enqueue(
      notificacaoSinteticaDePedido({
        shopId: p.shopId,
        orderSn: p.orderSn,
        nowMs: carimboDoDiaUtcMs(p.nowMs),
        origem: 'devolucao',
      }),
    );
    return true;
  } catch (err) {
    if (!(err instanceof ShopeeTasksDisabledError)) throw err;
    console.warn('[shopee/devolucao] code 3 sintético não enfileirado (válvula)', {
      orderSn: p.orderSn,
      returnSn: p.returnSn,
    });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 the handler                                 */
/* -------------------------------------------------------------------------- */

export async function importarDevolucaoShopee(
  db: Firestore,
  alvo: AlvoDeImportacaoDevolucaoShopee,
  deps: ShopeeImportarDevolucaoDeps = {},
): Promise<ResultadoImportacaoDevolucaoShopee> {
  const { integracaoId, shopId, orderSn, returnSn, nowMs, origem, diario } = alvo;

  // (1) Both ids are derived; a malformed return_sn throws here, before any I/O.
  const pedidoId = makePedidoIdShopee(integracaoId, orderSn);
  const incidenteId = idIncidenteDevolucaoShopee(returnSn);

  // (2) The cheap skip — a SKIP, never the guard (module docblock).
  const existe = (await pedidoCollection.docRef(db, {}, pedidoId).get()).exists;

  let acao: ResultadoImportacaoDevolucaoShopee['acao'] = ACAO_DEVOLUCAO_SEM_PEDIDO;
  let detail = `${ACAO_DEVOLUCAO_SEM_PEDIDO}:pedido ${orderSn} ainda não existe`;
  let detalhe: ShopeeReturnDetail | null = null;
  let erroEnvelope: string | null = null;
  let previsao: PrevisaoDevolucao | null = null;
  let aviso: ResultadoAvisoDevolucao | null = null;

  if (existe) {
    const client = await clienteShopee(db, integracaoId, deps);

    // (3) ONE pull. Only Shopee's "this return does not exist" is an outcome;
    // every other failure is the arm's to classify.
    try {
      const envelope = await client.getReturnDetail({ returnSn });
      erroEnvelope = envelope.error;
      detalhe = envelope.response;
    } catch (err) {
      if (
        !(err instanceof ShopeeApiError) ||
        classificarRecusaDevolucaoShopee(err) !== MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente
      ) {
        throw err;
      }
      // Shopee's CODE, through the app's one gate — never raw: the classifier
      // folds a padded `' error_data\t'` to inexistente, and the log must not
      // carry what the fold forgave.
      erroEnvelope = codigoSeguro(err.code);
      acao = ACAO_DEVOLUCAO_INEXISTENTE;
      detail = `${ACAO_DEVOLUCAO_INEXISTENTE}:devolução ${returnSn} não existe na Shopee`;
    }

    if (detalhe !== null) {
      if (detalhe.order_sn !== orderSn || detalhe.return_sn !== returnSn) {
        // (4) The detail is not the one this delivery points at. Never written
        // under this delivery's ids — the incidente id and the pedido id are
        // both derived from the DELIVERY, so a write would file one return's
        // state under another's key.
        acao = ACAO_DEVOLUCAO_OUTRO_PEDIDO;
        detail =
          detalhe.order_sn !== orderSn
            ? `${ACAO_DEVOLUCAO_OUTRO_PEDIDO}:devolução ${returnSn} pertence a outro pedido`
            : `${ACAO_DEVOLUCAO_OUTRO_PEDIDO}:o detalhe pedido para ${returnSn} descreve outra devolução`;
      } else {
        // (5) The ONE write, then (6) the aviso from what it CONFIRMED.
        const mapeada = mapearDevolucaoShopee(detalhe);
        previsao = await salvarIncidenteDevolucaoShopee(db, { pedidoId, incidenteId, mapeada });
        acao = previsao.acao;
        detail = previsao.acao;
        aviso = await aplicarAvisoDeDevolucao(
          db,
          {
            integracaoId,
            pedidoId,
            orderSn,
            returnSn,
            previsao,
            relogioProvedorUs: mapeada.relogioProvedorUs,
          },
          deps.aviso ?? { increment: (by) => FieldValue.increment(by), nowMs },
        );
      }
    }
  }

  // (7) ONE call site — it covers BOTH ways the pedido can be missing.
  const sintetica =
    acao === ACAO_DEVOLUCAO_SEM_PEDIDO
      ? await enfileirarSinteticaDePedido(deps.scheduler ?? createShopeeTaskScheduler(), {
          shopId,
          orderSn,
          returnSn,
          nowMs,
        })
      : false;

  const status = detalhe?.status ?? null;
  // (8) ONE line per delivery — see the module docblock for what may ride it.
  // eslint-disable-next-line no-console -- expected on every healthy delivery; a warn nobody can act on is what hides the real ones
  console.info('[shopee/devolucao] entrega de devolução', {
    integracaoId,
    shopId,
    orderSn,
    returnSn,
    pedidoId,
    origem,
    acao,
    status: tokenParaLog(status),
    statusDesconhecido: status !== null && !STATUS_DEVOLUCAO_CONHECIDOS.has(status),
    motivoDevolucao: tokenParaLog(detalhe?.reason),
    statusLogistica: tokenParaLog(detalhe?.logistics_status),
    statusLogisticaReversa: tokenParaLog(detalhe?.reverse_logistics_status),
    erroEnvelope,
    camposMudados: diario?.camposMudados ?? [],
    relogioDoPushS: diario?.relogioDoPushS ?? null,
    relogioDaDevolucaoS: detalhe?.update_time ?? null,
    divergePushVsPull:
      diario?.statusNoPush != null && status !== null && diario.statusNoPush !== status,
    revisao: previsao?.confirmado.bloco?.revisao ?? null,
    mudouAviso: previsao?.mudouAviso ?? null,
    aviso,
    sintetica,
  });

  return {
    acao,
    pedidoId,
    statusDevolucao: status,
    aviso,
    sinteticaEnfileirada: sintetica,
    detail,
  };
}
