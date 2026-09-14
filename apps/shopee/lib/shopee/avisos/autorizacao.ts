/**
 * The producer of the two Shopee **authorization** avisos, and their resolver.
 *
 * Two triggers, ONE producer: the weekly `sweepShopeeAuthorizationExpiry` walks
 * `get_shops_by_partner` and Shopee's `push 12` describes the same expiry from
 * the other side. They must collapse onto one row, which is what
 * {@link chaveExpiracao} buys — the dedup key IS the document id, so nothing has
 * to be compared and nothing can be lost (root `CLAUDE.md` rule 7, tier 0).
 *
 * ## ⚠️ This is the ONE module in `apps/shopee` that speaks MICROSECONDS
 *
 * Every other Shopee signature in this app is milliseconds — `expireTime`,
 * `authTime`, the envelope stamp, `diasParaExpirar`. The `avisos` collection is
 * µs (`microsSinceEpoch`), so the conversion happens here and only here, through
 * `millisToMicros`, at exactly two call sites: {@link agoraUsDe} — which every
 * writer AND every resolver funnels through, so the seam cannot multiply — and
 * `prazo`. A cross-unit comparison is a guard that never fires; keeping the
 * boundary to one module, and to two call sites inside it, is what makes it
 * reviewable.
 *
 * ⚠️ And it is the seam `avisos/pushSaude.ts` funnels through — that module
 * holds no conversion of its own, which is why the "exactly two call sites"
 * count above still stands with a second producer module in the app. Anything
 * new that writes an aviso here imports {@link agoraUsDe} / {@link depsDeEscrita}
 * rather than reaching for `millisToMicros`.
 *
 * ## ⚠️ No `janela`
 *
 * The chave carries `(tipo, conta, entidade)` and deliberately no window. Keying
 * the window on the expiry DATE would make the resolver compute a key that was
 * never created — a re-consent moves the date, so the row raised under the old
 * date would stand forever, past the 90-day retention sweep, telling the
 * operator about an authorization that was renewed weeks ago. One row per
 * `(conta, shop)`, raised at ≤ 30 days, repeated without moving `criadoEm`,
 * resolved the moment the shop is authorized further out again, and reopened
 * with a fresh `criadoEm` if it lapses back.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import { type ResultadoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { diasParaExpirar } from '../conta/status';

/** The motivo every machine resolution of these two tipos is stamped with. */
export const MOTIVO_REAUTORIZADA = 'reautorizada';

export interface AvisoDeps {
  /**
   * `(by) => FieldValue.increment(by)` — injected because
   * `packages/data/src/admin/**` may only `import type` from firebase-admin, so
   * the sentinel has to come from a caller that can make the runtime import.
   */
  increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. Converted to µs at the seam, never before. */
  nowMs: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface EventoExpiracao {
  readonly integracaoId: string;
  readonly shopId: number;
  /** Milliseconds — when the AUTHORIZATION lapses, not the access token. */
  readonly expireTimeMs: number;
  /**
   * The operator-facing store name. `null` falls back to the shop id: the conta
   * document's `nome` is the only name reachable WITHOUT a token, and the sweep
   * deliberately reads none (`get_shop_info` is Shop-signed).
   */
  readonly lojaNome: string | null;
  /**
   * Shopee's own delivery clock, in milliseconds.
   *
   * ⚠️ **OMIT it for the sweep** — the sweep has no provider delivery and
   * therefore no clock. An absent optional means "I do not know" and leaves the
   * stored watermark alone; passing `null` would RESET it, and a reset watermark
   * is a guard that never rejects anything again, so the next stale `push 12`
   * redelivery would be applied instead of dropped.
   */
  readonly relogioEventoMs?: number;
}

export interface EventoDesautorizacao {
  readonly integracaoId: string;
  readonly shopId: number;
  readonly lojaNome: string | null;
  /**
   * Shopee's `authorize_type` — WHY the authorization ended. Five documented
   * reasons, five different operator remedies, which is why it is stored beside
   * the tipo rather than folded into it.
   */
  readonly motivo: string;
  /** See {@link EventoExpiracao.relogioEventoMs}. */
  readonly relogioEventoMs?: number;
}

/** The dedup identity — and the Firestore document id — of the expiry aviso. */
export function chaveExpiracao(integracaoId: string, shopId: number): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
    conta: integracaoId,
    entidade: String(shopId),
  });
}

/** The dedup identity of the de-authorization aviso. One open row per shop. */
export function chaveDesautorizacao(integracaoId: string, shopId: number): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.shopeeDesautorizado,
    conta: integracaoId,
    entidade: String(shopId),
  });
}

/**
 * The ms → µs seam for "now". Every writer and every resolver in this module
 * goes through it, so there is exactly one place to review.
 */
export function agoraUsDe(deps: { nowMs: number }): number {
  return millisToMicros(deps.nowMs);
}

/** `escreverAviso`'s deps, from ours. One place, so the µs seam cannot drift. */
export function depsDeEscrita(deps: AvisoDeps): {
  increment: (by: number) => unknown;
  agoraUs: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
} {
  return {
    increment: deps.increment,
    agoraUs: agoraUsDe(deps),
    logger: deps.logger,
  };
}

/**
 * Raise (or refresh) "the Shopee authorization is about to lapse".
 *
 * `severidade: atencao` — the shop still works today, and `critico` is the only
 * tier that escalates out of the app, which in a three-person team must stay
 * rare enough that nobody learns to ignore it.
 */
export function avisarExpiracaoAutorizacao(
  db: Firestore,
  evento: EventoExpiracao,
  deps: AvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: evento.integracaoId,
      entidade: String(evento.shopId),
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      // Structured params, never a rendered sentence: the pt-BR wording lives in
      // `apps/web/lib/avisos/mensagens.ts` and reads exactly `loja` and `dias`.
      params: {
        loja: evento.lojaNome ?? String(evento.shopId),
        dias: diasParaExpirar(evento.expireTimeMs, deps.nowMs),
      },
      urlInterna: {
        rota: ROTAS_AVISO.canalShopee.build(evento.integracaoId),
        campo: null,
      },
      // The provider's own deadline, copied rather than computed.
      prazo: millisToMicros(evento.expireTimeMs),
      // ⚠️ Spread-or-nothing, never `relogioEvento: undefined` and never `null`:
      // see the field's docblock above.
      ...(evento.relogioEventoMs === undefined ? {} : { relogioEvento: evento.relogioEventoMs }),
    },
    depsDeEscrita(deps),
  );
}

/**
 * Raise "this shop is no longer authorized" — Shopee `push 2`
 * (`shop_authorization_canceled_push`), whose `authorize_type` becomes `motivo`.
 *
 * No `prazo`: the deadline already passed, and inventing one is worse than
 * leaving the field unstated. No `janela` either — one open row per shop, so a
 * second cancel notification for the same shop is a repeat rather than a second
 * alert.
 */
export function avisarDesautorizacao(
  db: Firestore,
  evento: EventoDesautorizacao,
  deps: AvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.shopeeDesautorizado,
      conta: evento.integracaoId,
      entidade: String(evento.shopId),
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      params: { loja: evento.lojaNome ?? String(evento.shopId) },
      motivo: evento.motivo,
      urlInterna: {
        rota: ROTAS_AVISO.canalShopee.build(evento.integracaoId),
        campo: null,
      },
      ...(evento.relogioEventoMs === undefined ? {} : { relogioEvento: evento.relogioEventoMs }),
    },
    depsDeEscrita(deps),
  );
}

/** Which of the two rows a resolution actually closed. */
export interface ResolucaoAutorizacao {
  readonly expiracao: boolean;
  readonly desautorizacao: boolean;
}

/**
 * Close the expiry warning alone. `true` only when a row was actually OPEN and
 * this call closed it — see {@link resolverAviso}.
 */
export function resolverExpiracao(
  db: Firestore,
  alvo: { integracaoId: string; shopId: number },
  deps: { nowMs: number },
): Promise<boolean> {
  return resolverAviso(db, chaveExpiracao(alvo.integracaoId, alvo.shopId), MOTIVO_REAUTORIZADA, {
    agoraUs: agoraUsDe(deps),
  });
}

/**
 * Close "this shop is no longer authorized" alone.
 *
 * ⚠️ Exported separately because the sweep resolves it on BOTH branches. Being
 * enumerated in `get_shops_by_partner` is positive proof the shop IS authorized,
 * whatever the remaining days are — a de-authorized shop leaves the list
 * entirely. Tying this row's resolution to the healthy branch left a re-consent
 * shorter than the sweep's 30-day threshold telling the operator "nenhum
 * pedido, estoque ou etiqueta será sincronizado" about a shop that is syncing,
 * on a `serverOwned` collection nobody can dismiss by hand.
 */
export function resolverDesautorizacao(
  db: Firestore,
  alvo: { integracaoId: string; shopId: number },
  deps: { nowMs: number },
): Promise<boolean> {
  return resolverAviso(
    db,
    chaveDesautorizacao(alvo.integracaoId, alvo.shopId),
    MOTIVO_REAUTORIZADA,
    { agoraUs: agoraUsDe(deps) },
  );
}

/**
 * The machine resolver both tipos name: the shop is authorized again.
 *
 * Called by the sweep whenever a shop's `expire_time` is further out than the
 * threshold, and by `push 1` (`shop_authorization_push`). Both rows are resolved
 * because a re-authorization ends both problems at once, and `resolverAviso`
 * reports a TRANSITION — an already-resolved row answers `false`, so a caller's
 * counter reads "closed" rather than "the document was there".
 *
 * ⚠️ The keys it computes MUST be the keys the producers above created. They are
 * the same two functions, which is the point of exporting them: a resolver that
 * derives its own key is how a row ends up standing forever.
 */
export async function resolverAvisosDeAutorizacao(
  db: Firestore,
  alvo: { integracaoId: string; shopId: number },
  deps: { nowMs: number },
): Promise<ResolucaoAutorizacao> {
  const expiracao = await resolverExpiracao(db, alvo, deps);
  const desautorizacao = await resolverDesautorizacao(db, alvo, deps);
  return { expiracao, desautorizacao };
}
