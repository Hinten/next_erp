/**
 * The producers and resolvers of the four Amazon avisos, and the µs boundary of
 * this app:
 *
 * | tipo | key | severity | clock |
 * | --- | --- | --- | --- |
 * | `amazonReconexaoPendente` | per conta | `critico` | the credential doc's commit time (µs) |
 * | `amazonReautorizacaoExpirando` | per conta, no `janela` | `atencao` | none |
 * | `amazonSegredoLwaExpirando` | per app | `atencao` | none |
 * | `amazonSegredoLwaRecusado` | per app | `critico` | none |
 *
 * Every raise is in-app only: no `escalar` is ever passed. Every param is
 * structured (a name, a number, a civil date) — the wording lives in
 * `apps/web/lib/avisos/mensagens.ts` and reads exactly these.
 *
 * ## ⚠️ The ONE module in `apps/amazon` that speaks MICROSECONDS
 *
 * Every other signature in this app is milliseconds: the credential's
 * `expirationDate` / `autorizadoEmMs`, the park's `desdeMs`, every `nowMs`. The
 * `avisos` collection is µs, so the conversion happens here and only here, at
 * exactly three sites:
 *
 *  - {@link agoraUsDe} — "now", ms → µs. Every writer and every resolver below
 *    funnels through it;
 *  - {@link prazoUsDe} — a deadline instant, ms → µs, for the aviso's `prazo`;
 *  - {@link relogioDoDocumentoUs} — a Firestore commit `Timestamp` → µs, the
 *    app's only Timestamp conversion (the credential store's versions and read
 *    times, the conta enumeration's read time, the park's aviso clock).
 *
 * `avisos.test.ts` counts them as raw source text, so the promise cannot
 * quietly become four.
 *
 * ## Why a document commit time is the reconexão clock
 *
 * The park, every consent and every access-token persist write the SAME
 * credential document, and commit times on one document strictly increase. So
 * `relogioEvento` = µs of the credential write that produced the observation:
 * `escreverAviso` drops a raise whose clock is `<=` the stored one, and a
 * clocked `resolverAviso` stamps its clock (seeding a resolved row when none
 * exists). A late raise from a park that lost to a newer consent therefore
 * cannot reopen the row the consent closed — no wall clock involved.
 *
 * ⚠️ **The reconexão aviso is NEVER resolved clockless.** A clockless resolve
 * can close a row a park opened AFTER the observation it acts on, and nothing
 * reopens it: every later raise for that park carries the same commit time,
 * which is `<=` the stored one. An observation of ABSENCE has no document stamp,
 * so it is clocked by the snapshot's `readTime` instead — the credential read's
 * when the conta holds no credential, the conta enumeration's when the conta is
 * gone. Any park committed after that read is stamped later, so the stale
 * resolve is the one dropped.
 *
 * ⚠️ µs and not ms: two commits inside the same millisecond would look equal,
 * and an equal clock is dropped.
 *
 * ## The other three are CLOCKLESS on purpose
 *
 *  - the two expiry tipos: their event is time passing, which no document write
 *    records, and a document clock would freeze reopening after the next
 *    resolve (the Shopee precedent). No `janela` on the reauthorization row: a
 *    reconnect moves the date, and must refresh the SAME row;
 *  - the secret refusal: it repeats on every exchange, so a lost race in either
 *    direction heals at the next one (step-2 plan §3 decision 5).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { fimDoDiaNoFuso, millisToMicros } from '@delfrance/core/datetime';
import {
  type ResolverAvisoOpts,
  type ResultadoAviso,
  escreverAviso,
  resolverAviso,
} from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  FUSO_FISCAL,
  LIMIAR_AVISO_AMAZON_DIAS,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  diasAteDataCivilAmazon,
  diasParaReautorizarAmazon,
  reautorizarAteAmazon,
} from '@delfrance/schemas';

import { type LoggerAmazon, warnNaoTipado } from '../core/log';

/** The motivos every machine resolution of these tipos is stamped with. */
export const MOTIVO_AVISO_AMAZON = {
  /** A consent stored a new grant just now (the callback). */
  consentimento: 'consentimento',
  /** An LWA exchange accepted the app's credentials (callback or refresh). */
  trocaAceita: 'troca-aceita',
  /** The sweep found more than 30 days left on the authorization. */
  autorizacaoEmDia: 'autorizacao-em-dia',
  /** The sweep found the credential not parked. */
  semReconexaoPendente: 'sem-reconexao-pendente',
  /** The conta holds no credential. */
  credencialAusente: 'credencial-ausente',
  /** The conta no longer exists as an Amazon conta. */
  contaRemovida: 'conta-removida',
  /** The sweep found more than 30 days left on the app secret. */
  segredoEmDia: 'segredo-em-dia',
} as const;
export type MotivoAvisoAmazon = (typeof MOTIVO_AVISO_AMAZON)[keyof typeof MOTIVO_AVISO_AMAZON];

/** The four tipos of this channel. */
export const TIPOS_AVISO_AMAZON: ReadonlySet<string> = new Set([
  TIPO_AVISO.amazonReconexaoPendente,
  TIPO_AVISO.amazonReautorizacaoExpirando,
  TIPO_AVISO.amazonSegredoLwaExpirando,
  TIPO_AVISO.amazonSegredoLwaRecusado,
]);

/** The two PER-CONTA tipos — what the sweep's orphan pass may close. */
export const TIPOS_AVISO_AMAZON_POR_CONTA: ReadonlySet<string> = new Set([
  TIPO_AVISO.amazonReconexaoPendente,
  TIPO_AVISO.amazonReautorizacaoExpirando,
]);

export interface AvisoDepsAmazon {
  /**
   * `(by) => FieldValue.increment(by)` — injected because
   * `packages/data/src/admin/**` may only `import type` from firebase-admin.
   */
  readonly increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. Converted to µs at the seam, never before. */
  readonly nowMs: number;
  /**
   * The app's logger, `warn` only, primitive campos only. `escreverAviso`
   * (`packages/data`) calls it untyped, which is why the sink re-checks every
   * campo at run time (`camposSeguros`, `core/log.ts`).
   */
  readonly logger?: Pick<LoggerAmazon, 'warn'>;
}

/* -------------------------------------------------------------------------- */
/*                     The three conversion sites (header)                     */
/* -------------------------------------------------------------------------- */

/** "Now", ms → µs. Every writer and resolver here goes through it. */
export function agoraUsDe(deps: { readonly nowMs: number }): number {
  return millisToMicros(deps.nowMs);
}

/** A deadline instant (ms) → the aviso's `prazo` (µs). */
export function prazoUsDe(ms: number): number {
  return millisToMicros(ms);
}

/**
 * A Firestore commit stamp → whole microseconds since the epoch. Commit times
 * carry µs precision, so this identifies ONE write exactly.
 */
export function relogioDoDocumentoUs(ts: {
  readonly seconds: number;
  readonly nanoseconds: number;
}): number {
  return ts.seconds * 1_000_000 + Math.floor(ts.nanoseconds / 1000);
}

/* -------------------------------------------------------------------------- */
/*                                   Keys                                     */
/* -------------------------------------------------------------------------- */

/** The "refresh token refused, conta parked" aviso of one conta. */
export function chaveReconexao(integracaoId: string): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.amazonReconexaoPendente, conta: integracaoId });
}

/** The reauthorization-expiry aviso of one conta. No `janela` (header). */
export function chaveReautorizacao(integracaoId: string): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.amazonReautorizacaoExpirando, conta: integracaoId });
}

/** The app-secret expiry aviso: ONE row for the whole channel. */
export function chaveSegredoExpirando(): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.amazonSegredoLwaExpirando });
}

/** The app-secret refusal aviso: ONE row for the whole channel. */
export function chaveSegredoRecusado(): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.amazonSegredoLwaRecusado });
}

/**
 * The shared writer's deps. Its `logger` is typed `Record<string, unknown>` and
 * logs a Firestore message untyped, so the app's `warn` crosses into it only
 * through `warnNaoTipado`, which narrows every campo at run time.
 */
function depsDeEscrita(deps: AvisoDepsAmazon): {
  increment: (by: number) => unknown;
  agoraUs: number;
  logger?: ReturnType<typeof warnNaoTipado>;
} {
  return {
    increment: deps.increment,
    agoraUs: agoraUsDe(deps),
    logger: deps.logger === undefined ? undefined : warnNaoTipado(deps.logger),
  };
}

function urlDaConta(integracaoId: string): { rota: string; campo: null } {
  return { rota: ROTAS_AVISO.canalAmazon.build(integracaoId), campo: null };
}

function urlDaLista(): { rota: string; campo: null } {
  return { rota: ROTAS_AVISO.canalAmazonLista.build(), campo: null };
}

/* -------------------------------------------------------------------------- */
/*                     amazonReconexaoPendente (clocked)                       */
/* -------------------------------------------------------------------------- */

export interface ReconexaoAmazon {
  readonly integracaoId: string;
  /** The conta's `nome`. */
  readonly lojaNome: string;
  /** The HTTP status of the refusal that parked it. */
  readonly status: number;
  /** The LWA code of that refusal, or `null` when it carried none. */
  readonly codigoLwa: string | null;
  /** µs — the commit time of the credential write that parked the conta. */
  readonly relogioUs: number;
}

/** Raise "Amazon refused the authorization; the conta is parked". In-app only. */
export function avisarReconexaoPendente(
  db: Firestore,
  e: ReconexaoAmazon,
  deps: AvisoDepsAmazon,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.amazonReconexaoPendente,
      conta: e.integracaoId,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: { loja: e.lojaNome, status: e.status },
      motivo: e.codigoLwa,
      urlInterna: urlDaConta(e.integracaoId),
      relogioEvento: e.relogioUs,
    },
    depsDeEscrita(deps),
  );
}

/**
 * The complete seed of a RESOLVED reconexão row, for a clocked resolve that
 * finds none — the raise's metadata minus what this observation does not know
 * (the status always; the name when the conta is gone).
 */
function sementeReconexao(
  integracaoId: string,
  relogioUs: number,
  lojaNome: string | null,
): ResolverAvisoOpts {
  return {
    tipo: TIPO_AVISO.amazonReconexaoPendente,
    conta: integracaoId,
    severidade: SEVERIDADE_AVISO.critico,
    canal: CANAL_AVISO.amazon,
    ...(lojaNome === null ? {} : { params: { loja: lojaNome } }),
    urlInterna: urlDaConta(integracaoId),
    relogioEvento: relogioUs,
  };
}

/**
 * Close the reconexão aviso — ALWAYS clocked (header). `relogioUs` is when the
 * observation was true: a consent's `writeTime`, the sweep's view of an
 * unparked document (its `updateTime`), or the credential read's `readTime`
 * when the conta holds none. `true` only on a real open → resolved transition.
 */
export function resolverReconexaoPendente(
  db: Firestore,
  integracaoId: string,
  motivo: MotivoAvisoAmazon,
  deps: { readonly nowMs: number },
  relogio: { readonly relogioUs: number; readonly lojaNome: string | null },
): Promise<boolean> {
  return resolverAviso(
    db,
    chaveReconexao(integracaoId),
    motivo,
    { agoraUs: agoraUsDe(deps) },
    sementeReconexao(integracaoId, relogio.relogioUs, relogio.lojaNome),
  );
}

/* -------------------------------------------------------------------------- */
/*                  amazonReautorizacaoExpirando (clockless)                   */
/* -------------------------------------------------------------------------- */

export interface ReautorizacaoAmazon {
  readonly integracaoId: string;
  readonly lojaNome: string;
  /** ms — the stored `autorizadoEmMs`: the 365-day clock. */
  readonly autorizadoEmMs: number;
}

/**
 * Raise (or refresh) "the authorization nears its 365 days". A repeat replaces
 * `dias`, `expiraEm` and `prazo` without moving `criadoEm`, so the row never
 * nags — and a reconnect's new date refreshes the SAME row.
 *
 * `prazo` is the END of the São Paulo civil day `expiraEm` (`fimDoDiaNoFuso`),
 * so it reads back as that same date.
 */
export function avisarReautorizacao(
  db: Firestore,
  e: ReautorizacaoAmazon,
  deps: AvisoDepsAmazon,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  const expiraEm = reautorizarAteAmazon(e.autorizadoEmMs);
  const fimMs = fimDoDiaNoFuso(expiraEm, FUSO_FISCAL);
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.amazonReautorizacaoExpirando,
      conta: e.integracaoId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.amazon,
      params: {
        loja: e.lojaNome,
        dias: diasParaReautorizarAmazon(e.autorizadoEmMs, deps.nowMs),
        expiraEm,
      },
      urlInterna: urlDaConta(e.integracaoId),
      prazo: fimMs === null ? null : prazoUsDe(fimMs),
      // No `relogioEvento`: clockless (header).
    },
    depsDeEscrita(deps),
  );
}

/** Close the reauthorization aviso, clockless. `true` only on a real transition. */
export function resolverReautorizacao(
  db: Firestore,
  integracaoId: string,
  motivo: MotivoAvisoAmazon,
  deps: { readonly nowMs: number },
): Promise<boolean> {
  return resolverAviso(db, chaveReautorizacao(integracaoId), motivo, { agoraUs: agoraUsDe(deps) });
}

/** What {@link sincronizarAvisoDeReautorizacao} did. */
export type SincroniaReautorizacao =
  | { readonly acao: 'avisado'; readonly dias: number; readonly resultado: ResultadoAviso }
  | { readonly acao: 'resolvido'; readonly dias: number; readonly fechou: boolean };

/**
 * The ONE threshold decision: raise at or below `LIMIAR_AVISO_AMAZON_DIAS` São
 * Paulo civil days left (29 and 30 warn, a past date too), resolve above it (31
 * is silent).
 */
export async function sincronizarAvisoDeReautorizacao(
  db: Firestore,
  e: ReautorizacaoAmazon,
  motivoSeResolver: MotivoAvisoAmazon,
  deps: AvisoDepsAmazon,
): Promise<SincroniaReautorizacao> {
  const dias = diasParaReautorizarAmazon(e.autorizadoEmMs, deps.nowMs);
  if (dias <= LIMIAR_AVISO_AMAZON_DIAS) {
    const { resultado } = await avisarReautorizacao(db, e, deps);
    return { acao: 'avisado', dias, resultado };
  }
  const fechou = await resolverReautorizacao(db, e.integracaoId, motivoSeResolver, deps);
  return { acao: 'resolvido', dias, fechou };
}

/* -------------------------------------------------------------------------- */
/*                   amazonSegredoLwaExpirando (clockless)                     */
/* -------------------------------------------------------------------------- */

/**
 * Raise (or refresh) "the app secret nears its recorded expiry".
 *
 * `dataCivil` is the recorded `YYYY-MM-DD`, or `null` when it is unrecorded or
 * invalid — then `dias` and `expiraEm` are BOTH ABSENT and `prazo` is `null`:
 * the aviso is still raised, because an unknown deadline is the riskier state.
 */
export function avisarSegredoLwaExpirando(
  db: Firestore,
  e: { readonly dataCivil: string | null },
  deps: AvisoDepsAmazon,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  const fimMs = e.dataCivil === null ? null : fimDoDiaNoFuso(e.dataCivil, FUSO_FISCAL);
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.amazonSegredoLwaExpirando,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.amazon,
      // `params: {}` (not absent) when unrecorded: a repeat must REPLACE a
      // previous dated pair, never keep it.
      params:
        e.dataCivil === null
          ? {}
          : { dias: diasAteDataCivilAmazon(e.dataCivil, deps.nowMs), expiraEm: e.dataCivil },
      urlInterna: urlDaLista(),
      prazo: fimMs === null ? null : prazoUsDe(fimMs),
    },
    depsDeEscrita(deps),
  );
}

/** Close the app-secret expiry aviso, clockless. */
export function resolverSegredoLwaExpirando(
  db: Firestore,
  motivo: MotivoAvisoAmazon,
  deps: { readonly nowMs: number },
): Promise<boolean> {
  return resolverAviso(db, chaveSegredoExpirando(), motivo, { agoraUs: agoraUsDe(deps) });
}

/* -------------------------------------------------------------------------- */
/*                   amazonSegredoLwaRecusado (clockless)                      */
/* -------------------------------------------------------------------------- */

/**
 * Raise "LWA refused the APP's credentials" (`invalid_client` /
 * `unauthorized_client`). Never parks anything: the fault is the app's.
 * `params` none; `motivo` = the LWA code.
 */
export function avisarSegredoLwaRecusado(
  db: Firestore,
  e: { readonly codigoLwa: string },
  deps: AvisoDepsAmazon,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.amazonSegredoLwaRecusado,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: {},
      motivo: e.codigoLwa,
      urlInterna: urlDaLista(),
    },
    depsDeEscrita(deps),
  );
}

/** Close the app-secret refusal aviso — any accepted LWA exchange. Clockless. */
export function resolverSegredoLwaRecusado(
  db: Firestore,
  deps: { readonly nowMs: number },
): Promise<boolean> {
  return resolverAviso(db, chaveSegredoRecusado(), MOTIVO_AVISO_AMAZON.trocaAceita, {
    agoraUs: agoraUsDe(deps),
  });
}

/* -------------------------------------------------------------------------- */
/*                          The sweep's orphan pass                            */
/* -------------------------------------------------------------------------- */

/**
 * The conta a reconexão chave was computed for, or `null` when `chave` is not
 * one {@link chaveReconexao} could have produced. Checked by recomputing the
 * key, never by trusting the split.
 */
function contaDaChaveDeReconexao(chave: string): string | null {
  const prefixo = `${TIPO_AVISO.amazonReconexaoPendente}:`;
  if (!chave.startsWith(prefixo)) return null;
  const conta = chave.slice(prefixo.length);
  return conta !== '' && chaveReconexao(conta) === chave ? conta : null;
}

/**
 * Close an open per-conta row BY ITS DOCUMENT ID as `conta-removida` — for a
 * conta that no longer exists as an Amazon conta.
 *
 *  - A **reconexão** row is resolved CLOCKED by `relogioListaUs`, the read time
 *    of the conta enumeration that did not contain the conta (header): a conta
 *    created after that read and then parked raised at a later clock, and its
 *    row stays open. The seed carries no name: the conta is gone.
 *  - A **reauthorization** row stays clockless, like every resolve of that tipo.
 *  - A reconexão-prefixed id no producer here could have computed has no write
 *    to race, so it is resolved clockless too.
 */
export function resolverAvisoDeContaRemovida(
  db: Firestore,
  chave: string,
  relogioListaUs: number,
  deps: { readonly nowMs: number },
): Promise<boolean> {
  const agora = { agoraUs: agoraUsDe(deps) };
  const conta = contaDaChaveDeReconexao(chave);
  if (conta === null) return resolverAviso(db, chave, MOTIVO_AVISO_AMAZON.contaRemovida, agora);
  return resolverAviso(
    db,
    chave,
    MOTIVO_AVISO_AMAZON.contaRemovida,
    agora,
    sementeReconexao(conta, relogioListaUs, null),
  );
}
