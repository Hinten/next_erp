/**
 * `estoqueShopeeSync/{integracaoId}` — the per-conta stock-sync state document:
 * ONE tolerant reader and FIVE writers, and nothing else may touch it.
 *
 * Three tiers share this one document (the quarter-hourly incremental, the
 * nightly diário, the monthly reconciliação) together with the send task and
 * the manual push route. Concentrating every access here is what keeps the
 * field semantics — which patch advances what — readable as a list instead of
 * scattered across five call sites that each remember a different half.
 *
 * ## ⚠️ MILLISECONDS, everywhere, and the unit is in every field name
 *
 * This channel has exactly one microsecond module and this is deliberately not
 * a second one. Every instant this document is compared against — the sweep's
 * `nowMs`, the task payload's stamps, the link docs' stamps — is ms, and root
 * `CLAUDE.md` rule 7's own words are that a cross-unit comparison is a guard
 * that never fires.
 *
 * ## ⚠️ ONE gate field (C-c)
 *
 * `pausadoAte` is the SINGLE pause instant. The daily-quota outage and the
 * burst throttle share it and are told apart by `pausaMotivo`
 * (`'burst'` · `'cota-diaria'` · `'loja-em-ferias'` · `'loja-bloqueada'`). A
 * second gate field was rejected on purpose: two gates are two readers that can
 * disagree, and all three consumers — the sweep's per-conta skip, the send
 * task's pause rung, the route's 409 pre-check — would each have to consult
 * both and take a maximum. One instant plus a reason is strictly more
 * informative and strictly harder to get wrong.
 *
 * It is always an EXPIRY, never a latch: a conta Shopee refuses outright is
 * paused for a day, because a latch would need a human clearer this app does
 * not have.
 *
 * ## ⚠️ `lastReconciliacaoAtMs` is REPORT-ONLY
 *
 * The reconciliação force-sends; nothing reads that stamp to decide what to
 * send. It exists so an operator can tell "a full pass ran" from "a full pass
 * was due and was silently skipped".
 *
 * ## Why the read is RAW and not a soft parse
 *
 * The document is read once per conta per tick and narrowed field by field with
 * `typeof`, exactly as the order backfill's cursor is
 * (`notificacoes/orderBackfill.ts`). The handle's soft read returns the raw
 * object on a mismatch anyway, so it would buy no narrowing — while logging a
 * warning on every tick for a state this module deliberately TOLERATES: a
 * malformed `continuacao` reads as `null` and the tick derives its own window,
 * which is the designed behaviour, not an incident. A hard parse is the one
 * thing that is forbidden outright: it would throw the whole tick over a
 * document the sweep knows how to ignore.
 *
 * ## Every write is a `merge`
 *
 * Create-on-first-use is the point for a per-conta state doc — a conta's first
 * tick has no document, and the exists-only sibling would resolve `false` and
 * write nothing for ever. Patches are FLAT at the top level; `continuacao` is
 * written WHOLE as one key, never as dotted field paths.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { estoqueShopeeSyncCollection } from '@delfrance/data/admin/collections';
import { type ModoVarreduraEstoque, modoVarreduraEstoqueSchema } from '@delfrance/schemas';

import type { MotivoDePausa } from './constantesEstoque';
import type { MotivoEstoqueShopee } from './errosEstoque';

/**
 * A stored continuation, once it has been read and found WHOLE.
 *
 * Mirrors the schema's `continuacao` exactly. All five keys are required: there
 * is no previous release of this document, so no continuation can legitimately
 * be missing one, and there is therefore no inheritance rule to write. A stored
 * object missing a key, carrying an unknown `modo` or an empty `afterAnchorId`
 * reads as `null` and the tick runs its own freshly derived window — the safe
 * direction, and the reason nothing here tries to repair one.
 */
export interface ContinuacaoLida {
  /** Keyset cursor: THE query resumes after this produto anchor id. */
  readonly afterAnchorId: string;
  /**
   * MS. The frozen discovery window start.
   *
   * ⚠️ A reconciliação freezes **−1** here — the force-all sentinel, a
   * legitimate stored value. Nothing may read a non-positive `changedSinceMs`
   * as malformed.
   */
  readonly changedSinceMs: number;
  /** The frozen tier, which decides the resumed tick's send policy. */
  readonly modo: ModoVarreduraEstoque;
  /**
   * MS. The frozen ledger window.
   *
   * ⚠️ ALWAYS `null` on `reconciliacao` — that tier force-sends and sums no
   * ledger. `null` is therefore a VALUE and the KEY is required; a stored
   * continuation missing the key is malformed, and the correct response is a
   * freshly derived window, never an inferred baseline.
   */
  readonly movimentosDesdeMs: number | null;
  /** MS. When the ORIGINAL (pre-truncation) sweep started. */
  readonly startedAtMs: number;
}

/** The state document as one tick reads it. Every clock is MILLISECONDS. */
export interface EstadoEstoqueLido {
  readonly cursorMs: number | null;
  readonly lastSweepAtMs: number | null;
  readonly lastDailyAtMs: number | null;
  /** Report only — never a baseline. */
  readonly lastReconciliacaoAtMs: number | null;
  readonly lastError: string | null;
  readonly lastErrorAtMs: number | null;
  /** THE gate. See the module header. */
  readonly pausadoAte: number | null;
  readonly pausaMotivo: string | null;
  /** Shopee's code VERBATIM, or null when the pause is ours. */
  readonly pausaCodigo: string | null;
  readonly pauseCount: number;
  readonly ultimoMotivoConta: string | null;
  readonly ultimoMotivoContaEmMs: number | null;
  readonly continuacao: ContinuacaoLida | null;
  /**
   * Whether the document existed at all.
   *
   * ⚠️ Distinct from "every field is null", which a document written by a
   * partial patch can also be. A conta's first tick is the former, and the
   * sweep reports the two differently.
   */
  readonly existe: boolean;
}

function campoNumerico(dados: Record<string, unknown> | undefined, chave: string): number | null {
  const v = dados?.[chave];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function campoTexto(dados: Record<string, unknown> | undefined, chave: string): string | null {
  const v = dados?.[chave];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Own-properties-only plain record, the shape a stored `continuacao` must be. */
function comoRegistro(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * A stored continuation, or `null` when it is not WHOLE.
 *
 * ⚠️ `movimentosDesdeMs` is checked for the KEY's presence, not for a value:
 * `null` is legitimate there (the reconciliação) while an absent key is
 * malformed, and the two are different facts. Collapsing them would let a
 * truncated incremental resume with no ledger window and silently force-send
 * its whole tail.
 *
 * `modo` is validated through the schema rather than against string literals,
 * so the vocabulary has one declaration and `prefer-schema-enum` has nothing to
 * flag.
 */
function continuacaoLida(bruto: unknown): ContinuacaoLida | null {
  const dados = comoRegistro(bruto);
  if (dados === null) return null;
  const afterAnchorId = campoTexto(dados, 'afterAnchorId');
  const changedSinceMs = campoNumerico(dados, 'changedSinceMs');
  const startedAtMs = campoNumerico(dados, 'startedAtMs');
  const modo = modoVarreduraEstoqueSchema.safeParse(dados.modo);
  if (afterAnchorId === null || changedSinceMs === null || startedAtMs === null) return null;
  if (!modo.success) return null;
  if (!Object.prototype.hasOwnProperty.call(dados, 'movimentosDesdeMs')) return null;
  const movimentosDesdeMs = campoNumerico(dados, 'movimentosDesdeMs');
  if (movimentosDesdeMs === null && dados.movimentosDesdeMs !== null) return null;
  return { afterAnchorId, changedSinceMs, modo: modo.data, movimentosDesdeMs, startedAtMs };
}

const ESTADO_VAZIO = {
  cursorMs: null,
  lastSweepAtMs: null,
  lastDailyAtMs: null,
  lastReconciliacaoAtMs: null,
  lastError: null,
  lastErrorAtMs: null,
  pausadoAte: null,
  pausaMotivo: null,
  pausaCodigo: null,
  pauseCount: 0,
  ultimoMotivoConta: null,
  ultimoMotivoContaEmMs: null,
  continuacao: null,
} as const;

/**
 * Read the conta's state document — ONE `get`, tolerant of every legacy and
 * hand-edited shape.
 *
 * An absent document answers all-null with `pauseCount: 0` and
 * `existe: false`; that is a conta's first tick and it is not an error.
 */
export async function lerEstadoEstoque(
  db: Firestore,
  integracaoId: string,
): Promise<EstadoEstoqueLido> {
  const snap = await estoqueShopeeSyncCollection.docRef(db, {}, integracaoId).get();
  if (!snap.exists) return { ...ESTADO_VAZIO, existe: false };
  const dados = snap.data() as Record<string, unknown> | undefined;
  return {
    cursorMs: campoNumerico(dados, 'cursorMs'),
    lastSweepAtMs: campoNumerico(dados, 'lastSweepAtMs'),
    lastDailyAtMs: campoNumerico(dados, 'lastDailyAtMs'),
    lastReconciliacaoAtMs: campoNumerico(dados, 'lastReconciliacaoAtMs'),
    lastError: campoTexto(dados, 'lastError'),
    lastErrorAtMs: campoNumerico(dados, 'lastErrorAtMs'),
    pausadoAte: campoNumerico(dados, 'pausadoAte'),
    pausaMotivo: campoTexto(dados, 'pausaMotivo'),
    pausaCodigo: campoTexto(dados, 'pausaCodigo'),
    pauseCount: campoNumerico(dados, 'pauseCount') ?? 0,
    ultimoMotivoConta: campoTexto(dados, 'ultimoMotivoConta'),
    ultimoMotivoContaEmMs: campoNumerico(dados, 'ultimoMotivoContaEmMs'),
    continuacao: continuacaoLida(dados?.continuacao),
    existe: true,
  };
}

/**
 * Whether the gate is CLOSED right now.
 *
 * ⚠️ Strictly `>`: a pause whose instant has arrived is over. The equality case
 * is the one a retry lands on — the send task re-enqueues itself for exactly
 * `pausadoAte`, so reading `===` as still-paused would make it re-enqueue a
 * second time and spend one of its attempts on nothing.
 */
export function estaPausada(estado: EstadoEstoqueLido, nowMs: number): boolean {
  return estado.pausadoAte !== null && estado.pausadoAte > nowMs;
}

/** What {@link armarPausa} needs. Every instant is MILLISECONDS. */
export interface PausaParaArmar {
  /** MS. When the gate re-opens. */
  readonly ate: number;
  readonly motivo: MotivoDePausa;
  /** Shopee's code VERBATIM, prefix and all, or `null` when the pause is ours. */
  readonly codigo: string | null;
  /**
   * The `pauseCount` the CALLER read, in the same tick, from the same document.
   *
   * ⚠️ The counter is ADVISORY and is written without any read-modify-write
   * protection, on purpose. Two senders pausing the same conta in the same
   * instant will produce one increment rather than two, and that is an
   * acceptable loss for an observability counter: buying exactness would cost
   * an extra round trip on the throttled path — the one path that is already
   * being told to slow down. Nothing branches on the value.
   */
  readonly pauseCountAtual: number;
}

/**
 * Arm the ONE gate: `{pausadoAte, pausaMotivo, pausaCodigo, pauseCount + 1}`.
 *
 * Writes nothing else — in particular it never touches the cursor or the
 * continuation, because a pause is not progress and the resumed tick must find
 * the window exactly where it left it.
 */
export async function armarPausa(
  db: Firestore,
  integracaoId: string,
  pausa: PausaParaArmar,
): Promise<void> {
  await estoqueShopeeSyncCollection.merge(db, {}, integracaoId, {
    pausadoAte: pausa.ate,
    pausaMotivo: pausa.motivo,
    pausaCodigo: pausa.codigo,
    pauseCount: pausa.pauseCountAtual + 1,
  });
}

/**
 * Record a CONTAINED per-conta failure: `{lastError, lastErrorAtMs,
 * lastSweepAtMs}`.
 *
 * ⚠️ Never the cursor and never the continuation. The next tick retries the
 * same window, and re-covering is harmless because the re-run recomputes every
 * quantity at ITS OWN sweep time — while advancing either one would turn a
 * failure into a silent skip of everything the failed tick had not reached.
 */
export async function registrarErroDaConta(
  db: Firestore,
  integracaoId: string,
  erro: string,
  nowMs: number,
): Promise<void> {
  await estoqueShopeeSyncCollection.merge(db, {}, integracaoId, {
    lastError: erro,
    lastErrorAtMs: nowMs,
    lastSweepAtMs: nowMs,
  });
}

/**
 * Record why NOTHING went out for this conta on this tick:
 * `{ultimoMotivoConta, ultimoMotivoContaEmMs, lastSweepAtMs}`.
 *
 * This is the field an operator reads when they ask why a conta is quiet. A
 * conta gated by `loja-fbs` or `loja-em-ferias` writes no error and enqueues
 * nothing, so without it "healthy and idle" and "structurally cannot send" are
 * the same picture — a green tick over a total stock outage.
 */
export async function registrarMotivoDaConta(
  db: Firestore,
  integracaoId: string,
  motivo: MotivoEstoqueShopee,
  nowMs: number,
): Promise<void> {
  await estoqueShopeeSyncCollection.merge(db, {}, integracaoId, {
    ultimoMotivoConta: motivo,
    ultimoMotivoContaEmMs: nowMs,
    lastSweepAtMs: nowMs,
  });
}

/** Which sweep outcome a {@link CarimboDeVarredura} carries. */
export type TipoDeCarimbo =
  | 'incremental-drenada'
  | 'diario-drenado'
  | 'reconciliacao-drenada'
  | 'truncada';

/** Named members of {@link TipoDeCarimbo} — never a bare literal at a call site. */
export const CARIMBO_VARREDURA = {
  incrementalDrenada: 'incremental-drenada',
  diarioDrenado: 'diario-drenado',
  reconciliacaoDrenada: 'reconciliacao-drenada',
  truncada: 'truncada',
} as const satisfies Record<string, TipoDeCarimbo>;

/**
 * The end of one tick, as a discriminated union — the four sweep patches, and
 * the discriminant is what stops one tier writing another's field.
 */
export type CarimboDeVarredura =
  | {
      readonly tipo: typeof CARIMBO_VARREDURA.incrementalDrenada;
      /** MS. The sweep's OWN start — what `cursorMs` advances to. */
      readonly startedAtMs: number;
      readonly nowMs: number;
    }
  | {
      readonly tipo:
        | typeof CARIMBO_VARREDURA.diarioDrenado
        | typeof CARIMBO_VARREDURA.reconciliacaoDrenada;
      readonly nowMs: number;
    }
  | {
      readonly tipo: typeof CARIMBO_VARREDURA.truncada;
      readonly continuacao: ContinuacaoLida;
      readonly nowMs: number;
    };

/**
 * Close one tick with exactly the patch its outcome earns.
 *
 * | outcome | patch |
 * |---|---|
 * | incremental drained | `cursorMs = startedAtMs`, `continuacao: null`, `lastSweepAtMs`, `lastError: null`, `ultimoMotivoConta: null` |
 * | diário / reconciliação drained | `lastDailyAtMs` \| `lastReconciliacaoAtMs`, `continuacao: null`, `lastSweepAtMs`, `lastError: null` — **never `cursorMs`** |
 * | truncated | `continuacao`, `lastSweepAtMs` — advances **nothing** |
 *
 * ⚠️ **The cursor advances to the sweep's OWN start, never to `nowMs`.** The
 * window was covered exactly up to the instant the sweep began; claiming
 * anything past it would skip whatever landed while it ran.
 *
 * ⚠️ **Only the incremental tier defines the incremental floor.** The diário
 * and the reconciliação cover their own windows and must not move `cursorMs` —
 * a nightly pass that advanced it would make the next quarter-hourly tick skip
 * everything the day's incremental ticks had not yet reached.
 *
 * ⚠️ **A truncated tick advances NOTHING.** It stores where it stopped so the
 * next tick of any tier RESUMES that frozen sweep — same window, same policy —
 * instead of restarting page 1 of a re-derived window, which is how a conta
 * with a standing backlog would otherwise never reach its tail. Writing the
 * cursor here would drop that tail permanently.
 */
export async function carimbarVarredura(
  db: Firestore,
  integracaoId: string,
  carimbo: CarimboDeVarredura,
): Promise<void> {
  const patch: Record<string, unknown> = { lastSweepAtMs: carimbo.nowMs };
  if (carimbo.tipo === CARIMBO_VARREDURA.truncada) {
    // The whole object as ONE top-level key — never dotted field paths.
    patch.continuacao = { ...carimbo.continuacao };
    await estoqueShopeeSyncCollection.merge(db, {}, integracaoId, patch);
    return;
  }
  patch.continuacao = null;
  patch.lastError = null;
  if (carimbo.tipo === CARIMBO_VARREDURA.incrementalDrenada) {
    patch.cursorMs = carimbo.startedAtMs;
    patch.ultimoMotivoConta = null;
  } else if (carimbo.tipo === CARIMBO_VARREDURA.diarioDrenado) {
    patch.lastDailyAtMs = carimbo.nowMs;
  } else {
    patch.lastReconciliacaoAtMs = carimbo.nowMs;
  }
  await estoqueShopeeSyncCollection.merge(db, {}, integracaoId, patch);
}
