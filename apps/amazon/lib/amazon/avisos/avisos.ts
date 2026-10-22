/**
 * The producers and resolvers of the seven Amazon avisos, and the µs boundary of
 * this app:
 *
 * | tipo | key | severity | clock |
 * | --- | --- | --- | --- |
 * | `amazonReconexaoPendente` | per conta | `critico` | the credential doc's commit time (µs) |
 * | `amazonReautorizacaoExpirando` | per conta, no `janela` | `atencao` | none |
 * | `amazonSegredoLwaExpirando` | per app | `atencao` | none |
 * | `amazonSegredoLwaRecusado` | per app | `critico` | none |
 * | `amazonImportacaoParada` (step 4) | per conta | `critico` | the poll document's commit time (µs) |
 * | `amazonPedidoPrecisaAtencao` (step 5) | per (conta, order, motivo) | per motivo | a Firestore commit or read time (µs) |
 * | `amazonContaPrecisaAtencao` (step 5) | per (conta, motivo) | `atencao` | the conta read's read time (µs) |
 *
 * The two step-5 tipos: their keys and the orphan pass's handling (PR 5-b), and
 * their producers, {@link sincronizarAvisosDoPedidoAmazon} and
 * {@link sincronizarAvisosDaContaAmazon} (PR 5-d), called by the order import,
 * which decides which motivos to raise and which to resolve. Their motivos,
 * resolvers and residues are in the tipos' docblock entries
 * (`packages/schemas/src/aviso.ts`).
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
 *    times, the conta enumeration's read time, the park's aviso clock, and —
 *    called HERE, never by the poll or the order import — the poll document's
 *    and the order import's aviso clocks).
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
 * ## The import-stopped clock is the POLL document's commit time
 *
 * `amazonImportacaoParada` (step 4) is raised and resolved by the backstop poll,
 * clocked by the commit time of the run's FIRST write to `pollPedidosAmazon/{id}`
 * — its lease, or its refusal record. Every write to that document is
 * preconditioned, so the clocks of successive runs rise strictly: a late raise
 * from a run whose lease was taken over is dropped, and a resolve is always
 * clocked (it seeds a resolved row when none exists). The poll hands this module
 * the commit `Timestamp` itself, so the µs conversion stays here.
 *
 * Its OTHER resolver is the expiry sweep's orphan pass (PR 4-b), for a conta
 * that no longer exists: clocked by the conta enumeration's `readTime`, like the
 * reconexão row's. Commit and read times share one server timeline, so a conta
 * created after that read polls — and raises — at a later clock, and keeps its
 * row. A DEACTIVATED conta is still listed (the enumeration has no `ativo`
 * filter) and the poll skips it, so its open row stays open until the conta is
 * reactivated and polls cleanly, or is deleted (a documented residue).
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
  type PlanoAviso,
  type ResolverAvisoOpts,
  type ResultadoAviso,
  escreverAviso,
  resolverAviso,
} from '@delfrance/data/admin/avisos';
import { avisoCollection } from '@delfrance/data/admin/collections';
import {
  CANAL_AVISO,
  FUSO_FISCAL,
  LIMIAR_AVISO_AMAZON_DIAS,
  MOTIVO_PEDIDO_AMAZON,
  type MotivoContaAmazon,
  type MotivoImportacaoParadaAmazon,
  type MotivoPedidoAmazon,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  type SeveridadeAviso,
  TIPO_AVISO,
  chaveDeAviso,
  diasAteDataCivilAmazon,
  diasParaReautorizarAmazon,
  motivoContaAmazonSchema,
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
  /** The backstop poll read the conta cleanly after a counted failure (step 4). */
  importacaoRetomada: 'importacao-retomada',
  /**
   * An import of the order (per-pedido rows) or of one of the conta's orders
   * (per-conta rows) saw the condition END (step 5).
   */
  condicaoEncerrada: 'condicao-encerrada',
} as const;
export type MotivoAvisoAmazon = (typeof MOTIVO_AVISO_AMAZON)[keyof typeof MOTIVO_AVISO_AMAZON];

/** The seven tipos of this channel. */
export const TIPOS_AVISO_AMAZON: ReadonlySet<string> = new Set([
  TIPO_AVISO.amazonReconexaoPendente,
  TIPO_AVISO.amazonReautorizacaoExpirando,
  TIPO_AVISO.amazonSegredoLwaExpirando,
  TIPO_AVISO.amazonSegredoLwaRecusado,
  TIPO_AVISO.amazonImportacaoParada,
  TIPO_AVISO.amazonPedidoPrecisaAtencao,
  TIPO_AVISO.amazonContaPrecisaAtencao,
]);

/**
 * The four PER-CONTA tipos the sweep's orphan pass may close. ⚠️ The pass keeps
 * a row only when its id is one of the keys it computes for every LISTED conta
 * (`conta/expiracaoSweep.ts`), so a tipo listed here must have its key computed
 * there too: `amazonImportacaoParada` (step 4, PR 4-b) without
 * {@link chaveImportacaoParada} in that set would close EVERY live conta's open
 * import aviso, every day — and `amazonContaPrecisaAtencao` (step 5) needs BOTH
 * of its keys there ({@link chavesContaPrecisaAtencao}).
 *
 * ⚠️ `amazonPedidoPrecisaAtencao` is deliberately NOT here: its key names an
 * ORDER, which the pass cannot compute for a listed conta, so listing it would
 * close every live pedido's open row on every run. Its rows of a deleted conta
 * have no resolver (a documented residue).
 */
export const TIPOS_AVISO_AMAZON_POR_CONTA: ReadonlySet<string> = new Set([
  TIPO_AVISO.amazonReconexaoPendente,
  TIPO_AVISO.amazonReautorizacaoExpirando,
  TIPO_AVISO.amazonImportacaoParada,
  TIPO_AVISO.amazonContaPrecisaAtencao,
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
/*                 amazonImportacaoParada (clocked, step 4)                    */
/* -------------------------------------------------------------------------- */

/** The import-stopped aviso of one conta (the backstop poll's). */
export function chaveImportacaoParada(integracaoId: string): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.amazonImportacaoParada, conta: integracaoId });
}

/** A Firestore commit stamp, as the poll hands it over: converted to µs HERE only. */
export interface CommitDoDocumento {
  readonly seconds: number;
  readonly nanoseconds: number;
}

export interface ImportacaoParadaAmazon {
  readonly integracaoId: string;
  /** The conta's `nome` (its id for a malformed legacy row). */
  readonly lojaNome: string;
  readonly motivo: MotivoImportacaoParadaAmazon;
  /** The commit time of the run's FIRST write to its poll document (header). */
  readonly commit: CommitDoDocumento;
}

/**
 * Raise "the backstop poll stopped importing this conta". In-app only;
 * `params` are exactly `loja` and the motivo CODE (the wording reads it), so a
 * wording fix is retroactive. The poll calls it only once the write that
 * stored the failure count LANDED, at the motivo's threshold.
 */
export function levantarImportacaoParadaAmazon(
  db: Firestore,
  e: ImportacaoParadaAmazon,
  deps: AvisoDepsAmazon,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.amazonImportacaoParada,
      conta: e.integracaoId,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: { loja: e.lojaNome, motivo: e.motivo },
      urlInterna: urlDaConta(e.integracaoId),
      relogioEvento: relogioDoDocumentoUs(e.commit),
    },
    depsDeEscrita(deps),
  );
}

/**
 * Close the import-stopped aviso — ALWAYS clocked, by the commit time of the
 * clean run's lease, as `importacao-retomada`. When the row is absent it seeds a
 * RESOLVED one carrying that clock, so a late raise from an older run is still
 * dropped.
 *
 * ⚠️ The poll calls it only when the stored `falhasSeguidas` was above 0: a
 * clocked resolve re-stamps a resolved row's watermark (or seeds one), so a call
 * on every healthy run would cost one aviso write per conta per tick.
 *
 * `true` only on a real open → resolved transition.
 */
export function resolverImportacaoParadaAmazon(
  db: Firestore,
  integracaoId: string,
  deps: { readonly nowMs: number },
  relogio: { readonly commit: CommitDoDocumento; readonly lojaNome: string },
): Promise<boolean> {
  return resolverAviso(
    db,
    chaveImportacaoParada(integracaoId),
    MOTIVO_AVISO_AMAZON.importacaoRetomada,
    { agoraUs: agoraUsDe(deps) },
    sementeImportacaoParada(integracaoId, relogioDoDocumentoUs(relogio.commit), relogio.lojaNome),
  );
}

/**
 * The complete seed of a RESOLVED import-stopped row, for a clocked resolve that
 * finds none: the raise's metadata minus what this observation does not know
 * (the motivo always; the name when the conta is gone).
 */
function sementeImportacaoParada(
  integracaoId: string,
  relogioUs: number,
  lojaNome: string | null,
): ResolverAvisoOpts {
  return {
    tipo: TIPO_AVISO.amazonImportacaoParada,
    conta: integracaoId,
    severidade: SEVERIDADE_AVISO.critico,
    canal: CANAL_AVISO.amazon,
    ...(lojaNome === null ? {} : { params: { loja: lojaNome } }),
    urlInterna: urlDaConta(integracaoId),
    relogioEvento: relogioUs,
  };
}

/* -------------------------------------------------------------------------- */
/*           amazonPedidoPrecisaAtencao / amazonContaPrecisaAtencao            */
/*                  (step 5 — the keys; producers come with the import)         */
/* -------------------------------------------------------------------------- */

/**
 * The key of ONE per-conta row: `(tipo, conta, no entidade, janela = motivo)`.
 * One row per (conta, motivo), so each motivo is raised and resolved on its own.
 */
export function chaveContaPrecisaAtencao(integracaoId: string, motivo: MotivoContaAmazon): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.amazonContaPrecisaAtencao,
    conta: integracaoId,
    janela: motivo,
  });
}

/**
 * EVERY per-conta key of one conta — one per {@link motivoContaAmazonSchema}
 * member, read off the enum so a new motivo is never left out. The sweep's
 * orphan pass keeps exactly these for every listed conta: a key missing here
 * would close a LIVE conta's open row on every run.
 */
export function chavesContaPrecisaAtencao(integracaoId: string): readonly string[] {
  return motivoContaAmazonSchema.options.map((motivo) =>
    chaveContaPrecisaAtencao(integracaoId, motivo),
  );
}

/**
 * The complete seed of a RESOLVED per-conta row, for a clocked resolve that
 * finds none: the raise's metadata, which here carries no name at all.
 */
function sementeContaPrecisaAtencao(
  integracaoId: string,
  motivo: MotivoContaAmazon,
  relogioUs: number,
): ResolverAvisoOpts {
  return {
    tipo: TIPO_AVISO.amazonContaPrecisaAtencao,
    conta: integracaoId,
    janela: motivo,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.amazon,
    params: { motivo },
    motivo,
    urlInterna: urlDaConta(integracaoId),
    relogioEvento: relogioUs,
  };
}

/**
 * The key of ONE per-pedido row: `(tipo, conta, entidade = orderId, janela =
 * motivo)` — one row per (order, motivo), each raised and resolved on its own.
 */
export function chavePedidoPrecisaAtencao(
  integracaoId: string,
  orderId: string,
  motivo: MotivoPedidoAmazon,
): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
    conta: integracaoId,
    entidade: orderId,
    janela: motivo,
  });
}

/** Each per-pedido motivo's severity (the tipo's docblock in `@delfrance/schemas`). */
export const SEVERIDADE_MOTIVO_PEDIDO_AMAZON: Readonly<
  Record<MotivoPedidoAmazon, SeveridadeAviso>
> = {
  [MOTIVO_PEDIDO_AMAZON.divergenciaItens]: SEVERIDADE_AVISO.critico,
  [MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida]: SEVERIDADE_AVISO.critico,
  [MOTIVO_PEDIDO_AMAZON.aceitarCancelamento]: SEVERIDADE_AVISO.critico,
  [MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp]: SEVERIDADE_AVISO.critico,
  [MOTIVO_PEDIDO_AMAZON.statusDesconhecido]: SEVERIDADE_AVISO.atencao,
  [MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado]: SEVERIDADE_AVISO.atencao,
  [MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido]: SEVERIDADE_AVISO.atencao,
  [MOTIVO_PEDIDO_AMAZON.coletaCancelada]: SEVERIDADE_AVISO.atencao,
};

/** One order, as its per-pedido rows name it. */
export interface PedidoDoAvisoAmazon {
  readonly integracaoId: string;
  /** Amazon's order id: the key's `entidade` and the ONE value the wording prints. */
  readonly orderId: string;
  /** The deterministic pedido id: the route. */
  readonly pedidoId: string;
}

/** A per-pedido row's metadata — its raise, and the seed of a clocked resolve. */
function planoPedidoPrecisaAtencao(
  p: PedidoDoAvisoAmazon,
  motivo: MotivoPedidoAmazon,
  relogioUs: number,
): ResolverAvisoOpts {
  return {
    tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
    conta: p.integracaoId,
    entidade: p.orderId,
    janela: motivo,
    severidade: SEVERIDADE_MOTIVO_PEDIDO_AMAZON[motivo],
    canal: CANAL_AVISO.amazon,
    params: { pedido: p.orderId, motivo },
    motivo,
    urlInterna: { rota: ROTAS_AVISO.pedido.build(p.pedidoId), campo: null },
    relogioEvento: relogioUs,
  };
}

/** What one sync did, counted (the import's log line). */
export interface SincroniaAvisosAmazon {
  /** Raises that wrote (`criado`, `repetido` or `reaberto`; a stale one is `ignorado`). */
  readonly levantados: number;
  /** Open rows this sync closed (a real open → resolved transition). */
  readonly resolvidos: number;
}

/**
 * Raise every `levantar` motivo and resolve every `resolver` motivo, each
 * CLOCKED by `relogio` — a FIRESTORE commit or read time (plan §3 decision 40),
 * converted HERE by {@link relogioDoDocumentoUs}: never an order's own clock,
 * which the import re-derives on when equal (an equal clock is dropped by both
 * `escreverAviso` and `resolverAviso`).
 *
 * The raises run first; then ONE `getAll` over the keys to resolve: a resolve
 * runs only on a row that EXISTS (an open one is closed; a resolved one has its
 * watermark advanced when the clock is newer — the shared resolver's rule). A
 * key with NO row is left alone: a
 * clocked resolve would seed a resolved row for every motivo of every order
 * (eight documents per pedido, rewritten on every import). The residue,
 * documented: an older import of the same order whose FIRST raise of a motivo
 * lands after a newer import's read found no row opens a stale row, closed by
 * the order's next import.
 */
async function sincronizarAvisos(
  db: Firestore,
  deps: AvisoDepsAmazon,
  planos: {
    readonly levantar: readonly (readonly [string, PlanoAviso])[];
    readonly resolver: readonly (readonly [string, ResolverAvisoOpts])[];
  },
): Promise<SincroniaAvisosAmazon> {
  let levantados = 0;
  for (const [, plano] of planos.levantar) {
    const { resultado } = await escreverAviso(db, plano, depsDeEscrita(deps));
    if (resultado !== 'ignorado') levantados += 1;
  }
  if (planos.resolver.length === 0) return { levantados, resolvidos: 0 };
  const snaps = await db.getAll(
    ...planos.resolver.map(([chave]) => avisoCollection.docRef(db, {}, chave)),
  );
  let resolvidos = 0;
  for (const [i, [chave, semente]] of planos.resolver.entries()) {
    if (snaps[i]?.exists !== true) continue;
    const motivo = MOTIVO_AVISO_AMAZON.condicaoEncerrada;
    const fechou = await resolverAviso(db, chave, motivo, { agoraUs: agoraUsDe(deps) }, semente);
    if (fechou) resolvidos += 1;
  }
  return { levantados, resolvidos };
}

/**
 * The order import's per-pedido rows (`amazonPedidoPrecisaAtencao`): raise the
 * motivos the WINNING attempt derived, resolve the ones whose resolver it saw
 * (the importer decides both lists), clocked by that attempt's batch commit
 * `writeTime` — or, when it wrote nothing, its snapshot's `readTime`. In-app
 * only (no escalation), `params` exactly `pedido` + `motivo`, the pedido route.
 */
export function sincronizarAvisosDoPedidoAmazon(
  db: Firestore,
  deps: AvisoDepsAmazon,
  e: PedidoDoAvisoAmazon & {
    readonly levantar: readonly MotivoPedidoAmazon[];
    readonly resolver: readonly MotivoPedidoAmazon[];
    readonly relogio: CommitDoDocumento;
  },
): Promise<SincroniaAvisosAmazon> {
  const relogioUs = relogioDoDocumentoUs(e.relogio);
  const plano = (motivo: MotivoPedidoAmazon) =>
    [
      chavePedidoPrecisaAtencao(e.integracaoId, e.orderId, motivo),
      planoPedidoPrecisaAtencao(e, motivo, relogioUs),
    ] as const;
  return sincronizarAvisos(db, deps, {
    levantar: e.levantar.map(plano),
    resolver: e.resolver.map(plano),
  });
}

/**
 * The order import's per-conta rows (`amazonContaPrecisaAtencao`): raise and
 * resolve as the import's conta read and verdicts say, clocked by that conta
 * read's `readTime` — the server timeline the orphan pass's conta enumeration
 * shares, never an order's clock (one row gathers many orders' observations).
 */
export function sincronizarAvisosDaContaAmazon(
  db: Firestore,
  deps: AvisoDepsAmazon,
  e: {
    readonly integracaoId: string;
    readonly levantar: readonly MotivoContaAmazon[];
    readonly resolver: readonly MotivoContaAmazon[];
    readonly relogio: CommitDoDocumento;
  },
): Promise<SincroniaAvisosAmazon> {
  const relogioUs = relogioDoDocumentoUs(e.relogio);
  const plano = (motivo: MotivoContaAmazon) =>
    [
      chaveContaPrecisaAtencao(e.integracaoId, motivo),
      sementeContaPrecisaAtencao(e.integracaoId, motivo, relogioUs),
    ] as const;
  return sincronizarAvisos(db, deps, {
    levantar: e.levantar.map(plano),
    resolver: e.resolver.map(plano),
  });
}

/* -------------------------------------------------------------------------- */
/*                          The sweep's orphan pass                            */
/* -------------------------------------------------------------------------- */

/** The per-conta tipos whose every resolve is CLOCKED (header). */
type TipoComRelogioAmazon =
  | typeof TIPO_AVISO.amazonReconexaoPendente
  | typeof TIPO_AVISO.amazonImportacaoParada;

/** A CLOCKED per-conta chave, parsed back into what computed it. */
type AlvoComRelogio =
  | { readonly tipo: TipoComRelogioAmazon; readonly conta: string }
  | {
      readonly tipo: typeof TIPO_AVISO.amazonContaPrecisaAtencao;
      readonly conta: string;
      readonly motivo: MotivoContaAmazon;
    };

/**
 * The conta a CLOCKED per-conta chave was computed for, and its tipo (and, for
 * `amazonContaPrecisaAtencao`, its motivo), or `null` when `chave` is not one
 * {@link chaveReconexao}, {@link chaveImportacaoParada} or
 * {@link chaveContaPrecisaAtencao} could have produced. Checked by recomputing
 * the key, never by trusting the split: a fold in `chaveDeAviso` would otherwise
 * hand back a conta whose key is a DIFFERENT document.
 */
function contaDaChaveComRelogio(chave: string): AlvoComRelogio | null {
  const candidatos = [
    [TIPO_AVISO.amazonReconexaoPendente, chaveReconexao],
    [TIPO_AVISO.amazonImportacaoParada, chaveImportacaoParada],
  ] as const;
  for (const [tipo, chaveDe] of candidatos) {
    const prefixo = `${tipo}:`;
    if (!chave.startsWith(prefixo)) continue;
    const conta = chave.slice(prefixo.length);
    return conta !== '' && chaveDe(conta) === chave ? { tipo, conta } : null;
  }
  // `<tipo>:<conta>::<motivo>` — no `entidade`, so its segment is empty.
  const prefixoConta = `${TIPO_AVISO.amazonContaPrecisaAtencao}:`;
  if (chave.startsWith(prefixoConta)) {
    const resto = chave.slice(prefixoConta.length);
    const corte = resto.indexOf('::');
    if (corte <= 0) return null;
    const conta = resto.slice(0, corte);
    const motivo = motivoContaAmazonSchema.safeParse(resto.slice(corte + 2));
    if (!motivo.success || chaveContaPrecisaAtencao(conta, motivo.data) !== chave) return null;
    return { tipo: TIPO_AVISO.amazonContaPrecisaAtencao, conta, motivo: motivo.data };
  }
  return null;
}

/**
 * Close an open per-conta row BY ITS DOCUMENT ID as `conta-removida` — for a
 * conta that no longer exists as an Amazon conta.
 *
 *  - A **reconexão** row and an **import-stopped** row (step 4) are resolved
 *    CLOCKED by `relogioListaUs`, the read time of the conta enumeration that
 *    did not contain the conta (header): a conta created after that read — and
 *    then parked, or failing to import — raised at a later commit-time clock,
 *    and its row stays open for the next sweep, which lists the conta. A raise
 *    from a run whose lease predates the deletion carries an older clock and is
 *    closed. Each seed carries no name: the conta is gone.
 *  - A **conta-precisa-atenção** row (step 5) is resolved CLOCKED by the same
 *    `relogioListaUs`: its raise is clocked by the import's conta read, on the
 *    same server timeline, so a conta created after the enumeration keeps the
 *    row its first import raised. Its seed carries the motivo the key names.
 *  - A **reauthorization** row stays clockless, like every resolve of that tipo.
 *  - A clocked-tipo id no producer here could have computed has no write to
 *    race, so it is resolved clockless too.
 */
export function resolverAvisoDeContaRemovida(
  db: Firestore,
  chave: string,
  relogioListaUs: number,
  deps: { readonly nowMs: number },
): Promise<boolean> {
  const agora = { agoraUs: agoraUsDe(deps) };
  const alvo = contaDaChaveComRelogio(chave);
  if (alvo === null) return resolverAviso(db, chave, MOTIVO_AVISO_AMAZON.contaRemovida, agora);
  const semente =
    alvo.tipo === TIPO_AVISO.amazonContaPrecisaAtencao
      ? sementeContaPrecisaAtencao(alvo.conta, alvo.motivo, relogioListaUs)
      : alvo.tipo === TIPO_AVISO.amazonReconexaoPendente
        ? sementeReconexao(alvo.conta, relogioListaUs, null)
        : sementeImportacaoParada(alvo.conta, relogioListaUs, null);
  return resolverAviso(db, chave, MOTIVO_AVISO_AMAZON.contaRemovida, agora, semente);
}
