/**
 * The Shopee **authorization**-expiry sweep (master plan P8).
 *
 * A Shopee consent lasts 7–365 days and, unlike the 4-hour access token, nothing
 * renews it: when it lapses every order import, stock push and label stops at
 * once. The legacy Flutter app never read that clock at all, so the first signal
 * was the day everything went quiet. This walks the partner's authorized shops
 * on a weekly schedule and raises an operator aviso while there is still time to
 * act.
 *
 * ## Why it is enumeration-driven, not conta-driven
 *
 * `get_shops_by_partner` is PUBLIC-signed: it answers with `expire_time` per
 * shop **without a token**, which is exactly the state this sweep cares about —
 * a conta whose token is long dead still has a readable authorization clock.
 * Iterating shops rather than integrações also means a main-account-only conta
 * (`shop_id == null`) can never enter the loop: it names no shop, so nothing
 * enumerates it. That is structural, and pinned by a test anyway.
 *
 * ## ⚠️ No token is read here, at all
 *
 * The only Firestore reads are the `integracao` document and the `shop_id`
 * lookup, both through `core/contaCache`, which is token-free by construction.
 * The `integracao/{id}/credenciais` subcollection is never touched — the sweep's
 * test asserts that over a fake that records every path.
 *
 * ## Two triggers, one body
 *
 * Shopee's `push 12` (`shop_expire_soon`) describes the same expiry from the
 * other side, in a paginated batch keyed on a cutoff rather than per shop. The
 * push arm re-enumerates and runs THIS body scoped to the named shops
 * ({@link ExpiracaoSweepDeps.apenasShopIds}), so `dias` and `prazo` always come
 * from each shop's real `expire_time` and both triggers collapse onto one aviso
 * row. The push arm also carries its envelope clock in
 * {@link ExpiracaoSweepDeps.relogioEventoMs}; the cron omits it, because it has
 * none.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ShopeeError, type ShopeePartnerClient } from '@delfrance/integrations-shopee';

import {
  avisarExpiracaoAutorizacao,
  resolverDesautorizacao,
  resolverExpiracao,
} from '../avisos/autorizacao';
import { findIntegracaoByShopId, readConta } from '../core/contaCache';
import { listarLojasAutorizadas } from './shops';
import { diasParaExpirar } from './status';

/**
 * Raise the aviso at or below this many whole days of authorization left, and
 * resolve it above.
 *
 * 30 days is deliberately generous: re-consent is a manual browser round trip
 * the operator has to schedule, and the aviso does not nag — a repeat bumps
 * `ocorrencias` and refreshes `params.dias` without moving `criadoEm`, so an
 * early warning costs one row that quietly counts up.
 */
export const DIAS_LIMITE_EXPIRACAO = 30;

export interface SweepLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ExpiracaoSweepDeps {
  /** Public-signed client. The ONLY provider call is the shop enumeration. */
  readonly partnerClient: ShopeePartnerClient;
  /** `(by) => FieldValue.increment(by)` — see `avisos/autorizacao.ts`. */
  readonly increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. */
  readonly nowMs: number;
  readonly logger?: SweepLogger;
  /**
   * Restrict the walk to these shops — Shopee's `push 12` arm, which knows which
   * shops the batch named but not their real `expire_time`.
   *
   * ⚠️ It filters the ENUMERATION, it does not replace it: the sweep still reads
   * each shop's own `expire_time` from `get_shops_by_partner`, because the
   * push's `expire_before` is a batch cutoff and not a per-shop value.
   */
  readonly apenasShopIds?: ReadonlySet<number>;
  /**
   * Shopee's own envelope clock, in MILLISECONDS — `push 12`'s delivery stamp,
   * forwarded onto every aviso this run writes so the event-clock watermark
   * (rule 7 tier 2) can drop a stale redelivery.
   *
   * ⚠️ **OMIT it for the weekly cron.** The cron has no provider delivery and
   * therefore no clock: an absent optional means "I do not know" and leaves the
   * stored watermark alone, whereas a `null` would RESET it — and a reset
   * watermark is a guard that never rejects anything again, so the next stale
   * `push 12` redelivery would be applied instead of dropped.
   */
  readonly relogioEventoMs?: number;
}

export interface ExpiracaoSweepErro {
  readonly shopId: number;
  readonly erro: string;
}

export interface ExpiracaoSweepResult {
  /** Shops `get_shops_by_partner` returned, after the cross-page dedup. */
  readonly lojasEnumeradas: number;
  readonly paginasLidas: number;
  /** The enumeration hit the page cap — `lojasEnumeradas` is a PREFIX. */
  readonly truncado: boolean;
  /**
   * Shops with no active Shopee integração, or whose integração document is
   * gone. ⚠️ Never sum this with `avisados`: it counts shops we deliberately did
   * NOT act on, and adding the two would read as coverage.
   */
  readonly semIntegracao: number;
  /** Shops whose aviso was raised or bumped (a stale drop does not count). */
  readonly avisados: number;
  /** Shops where a standing aviso was actually closed. */
  readonly resolvidos: number;
  /** The full `escreverAviso` breakdown behind `avisados`. */
  readonly resultados: Record<'criado' | 'repetido' | 'reaberto' | 'ignorado', number>;
  readonly erros: readonly ExpiracaoSweepErro[];
}

/**
 * Admin-SDK Firestore failures surface as `Error`s carrying a numeric gRPC
 * status `code`. Narrowed to the actual status range (integers 1–16; 0 = OK
 * never rides an error) so that a coding-bug `Error` exposing some other numeric
 * `code` is NOT contained. Mirrors `apps/mercado-livre`'s sweeps.
 */
function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * The per-shop containment boundary: an expected failure family is recorded in
 * `erros` and the walk continues to the next shop; anything else rethrows out of
 * the sweep.
 *
 * ⚠️ `escreverAviso`'s persistent-contention `Error` is deliberately NOT in the
 * set. It is thrown only after three lost preconditions in a row on ONE aviso
 * row, which its own message calls "a real problem rather than something to spin
 * on", and a failed execution is a louder signal than one more entry in `erros`
 * (which the weekly trigger DOES log — `functions/src/index.ts` warns on
 * `result.erros`). The trade is explicit: the abort costs the shops after the
 * contended one their weekly check, which the next Monday tick — and, for a shop
 * Shopee itself flags, `push 12` — walks again.
 *
 * ⚠️ The `ShopeeError` half cannot fire from the loop TODAY:
 * `listarLojasAutorizadas` runs once, before it, and nothing inside the try
 * touches the network. It stays because the boundary names a failure FAMILY, not
 * today's call graph — a provider call moved into the loop must not turn one
 * shop's 5xx into a lost tick.
 */
function contidoPorLoja(err: unknown): err is Error {
  return err instanceof ShopeeError || isGrpcCodedError(err);
}

function loggerDe(deps: ExpiracaoSweepDeps): SweepLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

/**
 * Walk every authorized shop and keep its expiry aviso in step with reality.
 *
 * Per shop: resolve the integração, read its conta, close
 * `shopeeDesautorizado` (enumeration IS the proof it is authorized again), then
 * compare the authorization clock against {@link DIAS_LIMITE_EXPIRACAO} and
 * either raise the expiry aviso or close it too. Both resolves run
 * **unconditionally** rather than only when a row is known to exist: the
 * alternative — remembering whether we raised one — is exactly the kind of state
 * that goes stale across weekly runs on different instances, and `resolverAviso`
 * answers `true` only on a real transition, so `resolvidos` cannot inflate on a
 * quiet week.
 */
export async function runShopeeAuthorizationExpirySweep(
  db: Firestore,
  deps: ExpiracaoSweepDeps,
): Promise<ExpiracaoSweepResult> {
  const logger = loggerDe(deps);
  const { lojas, paginas, truncado } = await listarLojasAutorizadas(deps.partnerClient);

  const resultados = { criado: 0, repetido: 0, reaberto: 0, ignorado: 0 };
  const erros: ExpiracaoSweepErro[] = [];
  let semIntegracao = 0;
  let avisados = 0;
  let resolvidos = 0;

  for (const loja of lojas) {
    if (deps.apenasShopIds !== undefined && !deps.apenasShopIds.has(loja.shopId)) continue;

    try {
      const integracaoId = await findIntegracaoByShopId(db, loja.shopId);
      if (integracaoId == null) {
        // A shop authorized at Shopee that nothing in this ERP claims: another
        // system on the same partner account, or a conta an operator
        // deactivated. Not an error, and not something to raise an aviso about —
        // there is no conta screen to send anyone to.
        semIntegracao += 1;
        logger.warn('[shopee/expiracao] loja autorizada sem integração ativa', {
          shopId: loja.shopId,
        });
        continue;
      }

      const conta = await readConta(db, integracaoId);
      if (conta == null) {
        // The mapping named a document that is gone (a delete from apps/web's
        // browser client, which no server instance can be told about).
        semIntegracao += 1;
        logger.warn('[shopee/expiracao] integração resolvida mas documento ausente', {
          shopId: loja.shopId,
          integracaoId,
        });
        continue;
      }

      const dias = diasParaExpirar(loja.expireTime, deps.nowMs);

      // ⚠️ Resolved on BOTH branches, and BEFORE the expiry decision. Being
      // enumerated here is positive proof the shop is authorized again — a
      // de-authorized shop leaves `authed_shop_list` entirely, so the sweep can
      // never reach it. Tying this row to the healthy branch left a re-consent
      // shorter than DIAS_LIMITE_EXPIRACAO standing forever beside a correct
      // "expirando" row, on a `serverOwned` collection nobody can dismiss.
      let fechou = await resolverDesautorizacao(
        db,
        { integracaoId, shopId: loja.shopId },
        { nowMs: deps.nowMs },
      );

      if (dias <= DIAS_LIMITE_EXPIRACAO) {
        const { resultado } = await avisarExpiracaoAutorizacao(
          db,
          {
            integracaoId,
            shopId: loja.shopId,
            expireTimeMs: loja.expireTime,
            // The only store name reachable without a token.
            lojaNome: conta.nome,
            // ⚠️ Spread-or-nothing, never `?? null`: the weekly cron passes no
            // clock at all and an ABSENT optional is what leaves the stored
            // watermark alone. A `null` would reset it — see the field's
            // docblock on `ExpiracaoSweepDeps` and on `EventoExpiracao`.
            ...(deps.relogioEventoMs === undefined
              ? {}
              : { relogioEventoMs: deps.relogioEventoMs }),
          },
          { increment: deps.increment, nowMs: deps.nowMs, logger },
        );
        resultados[resultado] += 1;
        if (resultado !== 'ignorado') avisados += 1;
      } else if (
        await resolverExpiracao(db, { integracaoId, shopId: loja.shopId }, { nowMs: deps.nowMs })
      ) {
        fechou = true;
      }
      // One shop, one closure, however many of its two rows were open.
      if (fechou) resolvidos += 1;
    } catch (err) {
      // Per-shop containment: one shop's Firestore or Shopee failure must not
      // cost every other shop its weekly check. Anything unclassifiable is a
      // coding bug and fails the whole tick loudly.
      if (!contidoPorLoja(err)) throw err;
      erros.push({ shopId: loja.shopId, erro: err.message });
      logger.warn('[shopee/expiracao] loja contida após falha', {
        shopId: loja.shopId,
        erro: err.message,
      });
    }
  }

  return {
    lojasEnumeradas: lojas.length,
    paginasLidas: paginas,
    truncado,
    semIntegracao,
    avisados,
    resolvidos,
    resultados,
    erros,
  };
}
