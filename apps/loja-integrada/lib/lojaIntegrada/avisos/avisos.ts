/**
 * The producers and resolvers of the three per-conta Loja Integrada avisos —
 * `lojaIntegradaTokenExpirando`, `lojaIntegradaReconexaoPendente` and (step 3)
 * `lojaIntegradaImportacaoParada`, raised and resolved by the order poller
 * (`pedidos/pollPedidos.ts`) — the channel's tipo list the sweep's orphan pass
 * reads (the order-import tipos of step 5 included; their producer is
 * `pedidos/avisosPedidoLi.ts`), and the µs boundary of this app.
 *
 * ## ⚠️ The ONE module in `apps/loja-integrada` that speaks MICROSECONDS
 *
 * Every other signature in this app is milliseconds: the credential's
 * `tokenExpiraEmMs` / `tokenAtualizadoEmMs`, the park's `desdeMs`, every
 * `nowMs`. The `avisos` collection is µs, so the conversion happens here and
 * only here, at exactly three sites:
 *
 *  - {@link agoraUsDe} — "now", ms → µs. Every writer AND every resolver below
 *    funnels through it;
 *  - {@link prazoUsDe} — the stored expiry, ms → µs, for the aviso's `prazo`;
 *  - {@link relogioDoDocumentoUs} — a Firestore commit `Timestamp` → µs, the
 *    app's only Timestamp conversion. The credential store imports it for the
 *    version it hands the panel and for a read's `readTime`, the conta
 *    enumeration for its `readTime`, and the park for its aviso clock.
 *
 * `avisos.test.ts` counts the first two as raw source text (two calls of the
 * ms → µs converter, both here) and the third as the only nanosecond read in
 * `lib/lojaIntegrada`, so the promise cannot quietly become four.
 *
 * ## Why a document commit time is the reconexão clock
 *
 * The park, every save, every renewal and every removal write the SAME
 * credential document, and commit times on one document strictly increase. So
 * `relogioEvento` = µs of the credential write that produced the observation:
 * `escreverAviso` drops a raise whose clock is `<=` the stored one, and a
 * clocked `resolverAviso` stamps its clock (seeding a resolved row when none
 * exists). A late raise from a park that lost to a newer save therefore cannot
 * reopen the row the save closed — with no wall clock, and no skew, involved.
 *
 * ⚠️ **The reconexão aviso is NEVER resolved clockless.** A clockless resolve
 * can close a row a park opened AFTER the observation it acts on, and nothing
 * reopens it: every later raise for that park carries the same commit time,
 * which is `<=` the stored one, so the conta stays halted with no open aviso.
 * An observation of ABSENCE has no document stamp, so it is clocked by the
 * snapshot's `readTime` instead — the credential read's when the conta holds no
 * token, the conta enumeration's when the conta is gone. Any park committed
 * after that read is stamped later, so the stale resolve is the one dropped.
 *
 * ⚠️ µs and not ms: reading the stamp in milliseconds would make two commits
 * inside the same millisecond look equal, and an equal clock is dropped.
 *
 * ## The expiry aviso is CLOCKLESS on purpose
 *
 * Its event is time passing, which no document write records. A document clock
 * there would freeze reopening after the next resolve (the Shopee precedent).
 * And it carries no `janela`: a new expiry date must refresh the SAME row, never
 * mint a second one that no resolver would ever compute.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { dataCivilNoFuso, millisToMicros } from '@delfrance/core/datetime';
import {
  type ResolverAvisoOpts,
  type ResultadoAviso,
  escreverAviso,
  resolverAviso,
} from '@delfrance/data/admin/avisos';
import { isTransientGrpcError } from '@delfrance/data/admin/grpcErrors';
import {
  CANAL_AVISO,
  FUSO_FISCAL,
  LIMIAR_AVISO_TOKEN_LI_DIAS,
  type MotivoImportacaoParadaLi,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  diasParaExpirarLi,
  type TipoAviso,
} from '@delfrance/schemas';

/** The motivos every machine resolution of these three tipos is stamped with. */
export const MOTIVO_AVISO_LI = {
  /** A save or a renewal validated the token just now. */
  tokenValidado: 'token-validado',
  /** The sweep found the stored expiry further out than the threshold. */
  validadeEmDia: 'validade-em-dia',
  /** The sweep found the credential not parked. */
  semReconexaoPendente: 'sem-reconexao-pendente',
  /** The token was removed, or the conta holds none. */
  credencialRemovida: 'credencial-removida',
  /** The conta no longer exists as a Loja Integrada conta. */
  contaRemovida: 'conta-removida',
  /** The order poller read the conta cleanly after a counted failure. */
  importacaoRetomada: 'importacao-retomada',
} as const;
export type MotivoAvisoLi = (typeof MOTIVO_AVISO_LI)[keyof typeof MOTIVO_AVISO_LI];

export interface AvisoDepsLi {
  /**
   * `(by) => FieldValue.increment(by)` — injected because
   * `packages/data/src/admin/**` may only `import type` from firebase-admin.
   */
  readonly increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. Converted to µs at the seam, never before. */
  readonly nowMs: number;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** The dedup identity — and the document id — of the expiry aviso. */
export function chaveExpiracao(integracaoId: string): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaTokenExpirando, conta: integracaoId });
}

/** The dedup identity of the "token refused, conta parked" aviso. */
export function chaveReconexao(integracaoId: string): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente, conta: integracaoId });
}

/**
 * The dedup identity of the "order import stopped" aviso (step 3). Its producer
 * is the order poller (PR 3-e); the expiry sweep's orphan pass needs the key
 * already, so a LISTED conta's open row is never mistaken for an orphan.
 */
export function chaveImportacaoParada(integracaoId: string): string {
  return chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaImportacaoParada, conta: integracaoId });
}

/** "Now", ms → µs. Every writer and resolver here goes through it. */
export function agoraUsDe(deps: { nowMs: number }): number {
  return millisToMicros(deps.nowMs);
}

/** A stored expiry (ms) → the aviso's `prazo` (µs). Copied, never computed. */
export function prazoUsDe(ms: number): number {
  return millisToMicros(ms);
}

/**
 * A Firestore commit stamp → whole microseconds since the epoch.
 *
 * Commit times carry µs precision (the nanosecond part is a multiple of 1000),
 * so this identifies ONE write exactly. The result is a safe integer for any
 * date before the year 2255.
 */
export function relogioDoDocumentoUs(ts: { seconds: number; nanoseconds: number }): number {
  return ts.seconds * 1_000_000 + Math.floor(ts.nanoseconds / 1000);
}

function depsDeEscrita(deps: AvisoDepsLi): {
  increment: (by: number) => unknown;
  agoraUs: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
} {
  return { increment: deps.increment, agoraUs: agoraUsDe(deps), logger: deps.logger };
}

function urlInterna(integracaoId: string): { rota: string; campo: null } {
  return { rota: ROTAS_AVISO.canalLojaIntegrada.build(integracaoId), campo: null };
}

export interface ExpiracaoLi {
  readonly integracaoId: string;
  /** The conta's `nome` — the operator-facing store name. */
  readonly lojaNome: string;
  /** ms — the stored `tokenExpiraEmMs`. */
  readonly tokenExpiraEmMs: number;
}

/**
 * Raise (or refresh) "the token nears its expiry". A repeat replaces `dias`,
 * `expiraEm` and `prazo` without moving `criadoEm`, so the row never nags.
 */
export function avisarExpiracaoToken(
  db: Firestore,
  evento: ExpiracaoLi,
  deps: AvisoDepsLi,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.lojaIntegradaTokenExpirando,
      conta: evento.integracaoId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      // Structured params, never a sentence: the wording lives in
      // `apps/web/lib/avisos/mensagens.ts` and reads exactly these three.
      params: {
        loja: evento.lojaNome,
        dias: diasParaExpirarLi(evento.tokenExpiraEmMs, deps.nowMs),
        expiraEm: dataCivilNoFuso(evento.tokenExpiraEmMs, FUSO_FISCAL),
      },
      urlInterna: urlInterna(evento.integracaoId),
      prazo: prazoUsDe(evento.tokenExpiraEmMs),
      // No `relogioEvento`: clockless (module header).
    },
    depsDeEscrita(deps),
  );
}

/** Close the expiry aviso, clockless. `true` only on a real open → resolved transition. */
export function resolverExpiracaoToken(
  db: Firestore,
  integracaoId: string,
  motivo: MotivoAvisoLi,
  deps: { nowMs: number },
): Promise<boolean> {
  return resolverAviso(db, chaveExpiracao(integracaoId), motivo, { agoraUs: agoraUsDe(deps) });
}

/**
 * The order-import tipos (step 5, producer `pedidos/avisosPedidoLi.ts`): MANY
 * rows per conta — one per pedido, or one per shipping-method key — so a row
 * belongs to a conta by its key PREFIX ({@link prefixoDaContaNoAvisoLi}), never
 * by one chave per conta. The paid-without-address tipo is raised by the
 * notification pipeline's exhaustion signal rather than by an import, but it
 * is keyed per pedido like the rest, so it is one of them.
 */
export const TIPOS_AVISO_PEDIDO_LI: ReadonlySet<TipoAviso> = new Set<TipoAviso>([
  TIPO_AVISO.lojaIntegradaSituacaoDesconhecida,
  TIPO_AVISO.lojaIntegradaPedidoContestado,
  TIPO_AVISO.lojaIntegradaPedidoHub,
  TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
  TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
]);

/**
 * Every tipo of this channel — what the sweep's orphan pass filters on.
 * `lojaIntegradaImportacaoParada` (step 3) is listed beside the two step-2 tipos
 * this module raises, and the order-import tipos (step 5) beside them, so a
 * gone conta's rows of every tipo are closed too.
 */
export const TIPOS_AVISO_LI: ReadonlySet<string> = new Set([
  TIPO_AVISO.lojaIntegradaTokenExpirando,
  TIPO_AVISO.lojaIntegradaReconexaoPendente,
  TIPO_AVISO.lojaIntegradaImportacaoParada,
  ...TIPOS_AVISO_PEDIDO_LI,
]);

/**
 * The conta part of an order-import row's key: `chaveDeAviso({ tipo, conta })`,
 * which every such row's id starts with, followed by `:` and its entity (a
 * pedido id or a key digest, neither carrying a `:`). RECOMPUTED for a listed
 * conta and compared whole, never split out of a row's id — the key fold could
 * map two conta ids onto one segment, and a split would hand back the wrong one.
 */
export function prefixoDaContaNoAvisoLi(tipo: TipoAviso, integracaoId: string): string {
  return chaveDeAviso({ tipo, conta: integracaoId });
}

/**
 * The part of an order-import row's id before its entity (everything before the
 * LAST `:`), to look up among the listed contas' {@link prefixoDaContaNoAvisoLi}
 * — or `null` for a row of any other tipo, or an id with no entity.
 */
export function prefixoDoAvisoDePedidoLi(tipo: string, chave: string): string | null {
  if (!(TIPOS_AVISO_PEDIDO_LI as ReadonlySet<string>).has(tipo)) return null;
  const fim = chave.lastIndexOf(':');
  return fim > 0 ? chave.slice(0, fim) : null;
}

/** The CLOCKED tipos of the orphan pass: their rows are raised at a document's commit time. */
type TipoComRelogioLi =
  | typeof TIPO_AVISO.lojaIntegradaReconexaoPendente
  | typeof TIPO_AVISO.lojaIntegradaImportacaoParada;

/**
 * The conta a clocked chave (reconexão or import-stopped) was computed for, and
 * its tipo — or `null` when `chave` is not one {@link chaveReconexao} or
 * {@link chaveImportacaoParada} could have produced. Checked by recomputing the
 * key, never by trusting the split: a fold in `chaveDeAviso` would otherwise
 * hand back a conta whose key is a DIFFERENT document.
 */
function contaDaChaveComRelogio(
  chave: string,
): { readonly tipo: TipoComRelogioLi; readonly conta: string } | null {
  const candidatos = [
    [TIPO_AVISO.lojaIntegradaReconexaoPendente, chaveReconexao],
    [TIPO_AVISO.lojaIntegradaImportacaoParada, chaveImportacaoParada],
  ] as const;
  for (const [tipo, chaveDe] of candidatos) {
    const prefixo = `${tipo}:`;
    if (!chave.startsWith(prefixo)) continue;
    const conta = chave.slice(prefixo.length);
    return conta !== '' && chaveDe(conta) === chave ? { tipo, conta } : null;
  }
  return null;
}

/**
 * Close an open row of any tipo of this channel BY ITS DOCUMENT ID as
 * `conta-removida` — the sweep's orphan pass, for a conta that no longer exists
 * as a Loja Integrada conta. The id IS the chave the producers computed
 * (`chaveDeAviso` is the document id).
 *
 *  - A **reconexão** row and an **import-stopped** row are resolved CLOCKED by
 *    `relogioListaUs`, the read time of the conta enumeration that did not
 *    contain the conta (module header): a conta created after that read — and
 *    then parked, or failing to import — raised at a later commit-time clock,
 *    and its row stays open. Each seed carries no store name: the conta is gone.
 *  - An **expiry** row stays clockless, like every resolve of that tipo: the
 *    next sweep re-raises it if the conta turns out to exist.
 *  - A clocked-tipo id no producer here could have computed has no write to
 *    race, so it is resolved clockless too.
 *  - An order-import row (step 5) is resolved clockless: its clock is the
 *    order's Loja Integrada stamp, a domain `relogioListaUs` can never be
 *    compared with. The sweep therefore hands this only rows last written NO
 *    LATER than the enumeration's read: a row written after it may belong to a
 *    conta created after the list was read (`conta/expiracaoSweep.ts`).
 */
export function resolverAvisoDeContaRemovida(
  db: Firestore,
  chave: string,
  relogioListaUs: number,
  deps: { nowMs: number },
): Promise<boolean> {
  const agora = { agoraUs: agoraUsDe(deps) };
  const alvo = contaDaChaveComRelogio(chave);
  if (alvo === null) return resolverAviso(db, chave, MOTIVO_AVISO_LI.contaRemovida, agora);
  const semente =
    alvo.tipo === TIPO_AVISO.lojaIntegradaReconexaoPendente
      ? sementeReconexao(alvo.conta, relogioListaUs, null)
      : sementeImportacaoParada(alvo.conta, relogioListaUs, null);
  return resolverAviso(db, chave, MOTIVO_AVISO_LI.contaRemovida, agora, semente);
}

/** What {@link sincronizarAvisoDeExpiracao} did. */
export type SincroniaExpiracao =
  | { readonly acao: 'avisado'; readonly dias: number; readonly resultado: ResultadoAviso }
  | { readonly acao: 'resolvido'; readonly dias: number; readonly fechou: boolean };

/**
 * The ONE threshold decision: raise at or below `LIMIAR_AVISO_TOKEN_LI_DIAS`
 * whole days left, resolve above it. The save, the renewal and the daily sweep
 * all come through here, so the three can never disagree about one date.
 *
 * `motivoSeResolver` names WHY a far-away date closes the row: a validated
 * write says `token-validado`, the sweep `validade-em-dia`.
 */
export async function sincronizarAvisoDeExpiracao(
  db: Firestore,
  evento: ExpiracaoLi,
  motivoSeResolver: MotivoAvisoLi,
  deps: AvisoDepsLi,
): Promise<SincroniaExpiracao> {
  const dias = diasParaExpirarLi(evento.tokenExpiraEmMs, deps.nowMs);
  if (dias <= LIMIAR_AVISO_TOKEN_LI_DIAS) {
    const { resultado } = await avisarExpiracaoToken(db, evento, deps);
    return { acao: 'avisado', dias, resultado };
  }
  const fechou = await resolverExpiracaoToken(db, evento.integracaoId, motivoSeResolver, deps);
  return { acao: 'resolvido', dias, fechou };
}

export interface ReconexaoLi {
  readonly integracaoId: string;
  readonly lojaNome: string;
  /** What Loja Integrada answered when it refused the stored token. */
  readonly status: 401 | 403;
  /** µs — the commit time of the credential write that parked the conta. */
  readonly relogioUs: number;
}

/**
 * Raise "Loja Integrada refused the token; the conta is parked".
 *
 * `critico`, and NO `escalar` is passed: the aviso is in-app only (step-2 Q3).
 */
export function avisarReconexaoPendente(
  db: Firestore,
  evento: ReconexaoLi,
  deps: AvisoDepsLi,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
      conta: evento.integracaoId,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: evento.lojaNome, status: evento.status },
      urlInterna: urlInterna(evento.integracaoId),
      relogioEvento: evento.relogioUs,
    },
    depsDeEscrita(deps),
  );
}

/**
 * The complete seed of a RESOLVED reconexão row, for a clocked resolve that
 * finds none — the same metadata a raise writes, minus the HTTP status this
 * observation does not know (and minus the store name when the conta is gone).
 */
function sementeReconexao(
  integracaoId: string,
  relogioUs: number,
  lojaNome: string | null,
): ResolverAvisoOpts {
  return {
    tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
    conta: integracaoId,
    severidade: SEVERIDADE_AVISO.critico,
    canal: CANAL_AVISO.lojaIntegrada,
    ...(lojaNome === null ? {} : { params: { loja: lojaNome } }),
    urlInterna: urlInterna(integracaoId),
    relogioEvento: relogioUs,
  };
}

/**
 * The complete seed of a RESOLVED import-stopped row, for a clocked resolve that
 * finds none — the raise's metadata minus the params this observation does not
 * know: the motivo always (a clean run has none), the store name when the conta
 * is gone.
 */
function sementeImportacaoParada(
  integracaoId: string,
  relogioUs: number,
  lojaNome: string | null,
): ResolverAvisoOpts {
  return {
    tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
    conta: integracaoId,
    severidade: SEVERIDADE_AVISO.critico,
    canal: CANAL_AVISO.lojaIntegrada,
    ...(lojaNome === null ? {} : { params: { loja: lojaNome } }),
    urlInterna: urlInterna(integracaoId),
    relogioEvento: relogioUs,
  };
}

/** One counted failure of the order poller that reached its aviso threshold. */
export interface ImportacaoParadaLi {
  readonly integracaoId: string;
  /** The conta's `nome` — the operator-facing store name. */
  readonly lojaNome: string;
  /** The poll document's `ultimoErro`: a CODE the web wording renders. */
  readonly motivo: MotivoImportacaoParadaLi;
  /**
   * µs — the commit time of the poll run's FIRST write to its poll document
   * (the lease, or the refusal record).
   */
  readonly relogioUs: number;
}

/**
 * Raise (or refresh) "the order import of this conta stopped" — the order
 * poller's aviso (`pedidos/pollPedidos.ts` decides WHEN: at its threshold).
 *
 * CLOCKED by the poll document's commit time ({@link ImportacaoParadaLi}):
 * every write to that document is preconditioned, so the clocks of two runs are
 * strictly ordered, and a late raise from a run whose lease was taken over —
 * older than the resolve of the run that took it — is dropped by
 * `escreverAviso`. A repeat refreshes `motivo` without moving `criadoEm`.
 *
 * `critico`, and NO `escalar` is passed: in-app only, like the reconexão aviso.
 */
export function avisarImportacaoParada(
  db: Firestore,
  evento: ImportacaoParadaLi,
  deps: AvisoDepsLi,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      conta: evento.integracaoId,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      // Structured params, never a sentence: `apps/web/lib/avisos/mensagens.ts`
      // renders the motivo CODE, so a wording fix is retroactive.
      params: { loja: evento.lojaNome, motivo: evento.motivo },
      urlInterna: urlInterna(evento.integracaoId),
      relogioEvento: evento.relogioUs,
    },
    depsDeEscrita(deps),
  );
}

/**
 * Close the import-stopped aviso — ALWAYS clocked, by the commit time of the
 * clean poll run's lease (`relogioUs`), as `importacao-retomada`. When the row
 * is absent it seeds a RESOLVED one carrying that clock, so a late raise from an
 * older run is still dropped.
 *
 * ⚠️ The poller calls it only when the stored `falhasSeguidas` was above 0: a
 * clocked resolve re-stamps a resolved row's watermark (or seeds one), so a
 * call on every healthy run would cost one aviso write per conta per tick.
 *
 * `true` only on a real open → resolved transition.
 */
export function resolverImportacaoParada(
  db: Firestore,
  integracaoId: string,
  deps: { nowMs: number },
  relogio: { readonly relogioUs: number; readonly lojaNome: string },
): Promise<boolean> {
  return resolverAviso(
    db,
    chaveImportacaoParada(integracaoId),
    MOTIVO_AVISO_LI.importacaoRetomada,
    { agoraUs: agoraUsDe(deps) },
    sementeImportacaoParada(integracaoId, relogio.relogioUs, relogio.lojaNome),
  );
}

/**
 * Close the reconexão aviso — ALWAYS clocked (module header). `relogioUs` is
 * when the observation was true:
 *
 *  - a credential write's commit time — a save, a renewal, a removal, or the
 *    sweep seeing an unparked document at that version;
 *  - the credential read's `readTime` when the sweep found NO credential.
 *
 * The resolve stamps that clock, and when the row is absent it seeds a
 * RESOLVED row carrying it, so a late raise from an older park is dropped by
 * `escreverAviso`'s own guard — while a park committed AFTER the observation
 * keeps its row open: the resolve is the stale one.
 *
 * `true` only on a real open → resolved transition.
 */
export function resolverReconexaoPendente(
  db: Firestore,
  integracaoId: string,
  motivo: MotivoAvisoLi,
  deps: { nowMs: number },
  relogio: { readonly relogioUs: number; readonly lojaNome: string },
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
/*            The avisos a ROUTE syncs after its credential write              */
/* -------------------------------------------------------------------------- */

/**
 * What the avisos step of a route did. `sincronizado: false` means a TRANSIENT
 * Firestore failure stopped it (logged); the credential write had already
 * landed, and the daily expiry sweep (`conta/expiracaoSweep.ts`, scheduled from
 * step 3) re-syncs both rows from the stored credential. Until then the next
 * save, renewal or removal does.
 */
export interface AvisosAposEscrita {
  /** `true` only when this write closed an open "token recusado" row. */
  readonly reconexaoResolvida: boolean;
  readonly sincronizado: boolean;
}

/**
 * The aviso step runs AFTER the credential write committed, so a transient
 * Firestore failure here must not turn a saved token into a 500: the operator
 * would read "nothing was saved", retry with a now-stale version and get a 409
 * for a save that worked. Only a TRANSIENT gRPC status is contained
 * (`isTransientGrpcError`: 4, 8, 10, 13, 14) — a deterministic one, the
 * aviso writer's own contention error and any bug still throw, loudly.
 */
async function semDerrubarAEscrita(
  integracaoId: string,
  deps: AvisoDepsLi,
  passo: () => Promise<boolean>,
): Promise<AvisosAposEscrita> {
  try {
    return { reconexaoResolvida: await passo(), sincronizado: true };
  } catch (err) {
    if (!isTransientGrpcError(err)) throw err;
    deps.logger?.warn(
      '[loja-integrada/avisos] falha transitória ao sincronizar os avisos após gravar a credencial',
      { integracaoId, code: (err as { code: number }).code },
    );
    return { reconexaoResolvida: false, sincronizado: false };
  }
}

/** A credential write that left a VALIDATED token behind: a save or a renewal. */
export interface EscritaValidadaLi {
  readonly integracaoId: string;
  readonly lojaNome: string;
  /** ms — the expiry just stored. */
  readonly tokenExpiraEmMs: number;
  /** µs — the write's commit time: the reconexão aviso's clock. */
  readonly versaoUs: number;
}

/**
 * After a save or a renewal: the token was validated just now, so
 *
 *  - the reconexão aviso is RESOLVED, clocked by the write's commit time — a
 *    late raise from an older park is then dropped by `escreverAviso`;
 *  - the expiry aviso goes through the ONE threshold decision
 *    ({@link sincronizarAvisoDeExpiracao}): raised with fresh params at or
 *    below 30 days, resolved above.
 */
export function sincronizarAvisosAposValidacao(
  db: Firestore,
  e: EscritaValidadaLi,
  deps: AvisoDepsLi,
): Promise<AvisosAposEscrita> {
  return semDerrubarAEscrita(e.integracaoId, deps, async () => {
    const fechou = await resolverReconexaoPendente(
      db,
      e.integracaoId,
      MOTIVO_AVISO_LI.tokenValidado,
      deps,
      { relogioUs: e.versaoUs, lojaNome: e.lojaNome },
    );
    await sincronizarAvisoDeExpiracao(
      db,
      { integracaoId: e.integracaoId, lojaNome: e.lojaNome, tokenExpiraEmMs: e.tokenExpiraEmMs },
      MOTIVO_AVISO_LI.tokenValidado,
      deps,
    );
    return fechou;
  });
}

/**
 * After a removal: no token, so nothing to warn about. The reconexão aviso is
 * resolved CLOCKED by the delete's commit time (a park that raced the removal
 * cannot reopen it), the expiry aviso clockless — both as `credencial-removida`.
 */
export function resolverAvisosAposRemocao(
  db: Firestore,
  e: { readonly integracaoId: string; readonly lojaNome: string; readonly versaoUs: number },
  deps: AvisoDepsLi,
): Promise<AvisosAposEscrita> {
  return semDerrubarAEscrita(e.integracaoId, deps, async () => {
    const fechou = await resolverReconexaoPendente(
      db,
      e.integracaoId,
      MOTIVO_AVISO_LI.credencialRemovida,
      deps,
      { relogioUs: e.versaoUs, lojaNome: e.lojaNome },
    );
    await resolverExpiracaoToken(db, e.integracaoId, MOTIVO_AVISO_LI.credencialRemovida, deps);
    return fechou;
  });
}
