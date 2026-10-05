import type { Firestore } from 'firebase-admin/firestore';
import {
  type Aviso,
  type CanalAviso,
  type ChaveAvisoInput,
  type SeveridadeAviso,
  type TipoAviso,
  type UrlInternaAviso,
  SEVERIDADE_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';
import { avisoCollection } from '../collections/avisoCollection';
import { isAlreadyExists, isFailedPrecondition, isNotFound } from '../grpcErrors';

/**
 * The seam every producer writes an operator notification through.
 *
 * ⚠️ `packages/data/src/admin/**` may only `import type` from `firebase-admin`
 * (`adminBundleSafety.test.ts` asserts it over the whole subtree), and
 * `FieldValue.increment` is a RUNTIME import. So the sentinel is supplied by the
 * caller via {@link EscreverAvisoDeps.increment}. In exchange, esbuild inlines
 * every `@delfrance/*` package into all five deploy artifacts, so this module
 * reaches every functions codebase with no manifest edit —
 * `@delfrance/data/admin/cache` is the proof.
 */

/** What a producer knows about the event. `chave` is derived, never passed in. */
export interface PlanoAviso extends ChaveAvisoInput {
  tipo: TipoAviso;
  severidade: SeveridadeAviso;
  canal?: CanalAviso | null;
  params?: Record<string, string | number>;
  motivo?: string | null;
  destinatarioUid?: string | null;
  urlInterna?: UrlInternaAviso | null;
  urlExterna?: string | null;
  prazo?: number | null;
  /**
   * The provider's own event clock for this delivery, when it has one.
   * ⚠️ Compare only against another value from the SAME provider — units are not
   * interchangeable across this codebase (µs on pedido/produto, ms on the ML
   * links), and a cross-unit comparison is a guard that never fires.
   */
  relogioEvento?: number | null;
}

export interface EscreverAvisoDeps {
  /** `(by) => FieldValue.increment(by)` — supplied by the caller, see above. */
  increment: (by: number) => unknown;
  /** Now, in microseconds. Passed in so the writer stays testable and clock-free. */
  agoraUs: number;
  /**
   * Out-of-app escalation for `critico` only. Failure here must NEVER fail the
   * aviso write — a broken webhook cannot be allowed to lose the durable record,
   * which is the whole reason the record exists.
   */
  escalar?: (aviso: Aviso, chave: string) => Promise<void>;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export type ResultadoAviso =
  /** A new row. The operator has not seen this problem before. */
  | 'criado'
  /** An existing row bumped: same problem, another occurrence. */
  | 'repetido'
  /** A resolved row brought back: the problem returned, and it re-surfaces unread. */
  | 'reaberto'
  /** A stale provider delivery, older than what is stored. Dropped on purpose. */
  | 'ignorado';

/** Bounded, per `isFailedPrecondition`'s contract: a persistent loser must surface. */
const MAX_TENTATIVAS_PRECONDICAO = 3;

/**
 * The fields this producer actually stated, and only those.
 *
 * ⚠️ **An absent optional means "I do not know", never "set it to null".** One
 * aviso has several producers by design, and they know different things: the
 * weekly `sweepShopeeAuthorizationExpiry` knows the expiry window and carries no
 * delivery clock; Shopee's `push 12` describes the same expiry and does carry
 * one, plus a provider `motivo` and a deep link. Writing a fixed shape on every
 * update would let whoever writes second erase what the other stored.
 *
 * For {@link PlanoAviso.relogioEvento} that is not merely lossy, it is a
 * correctness hole: nulling the stored watermark makes the tier-2 guard's
 * `armazenado.relogioEvento != null` test false forever, so the NEXT stale
 * redelivery is applied instead of dropped — it bumps `ocorrencias`, re-applies
 * its outdated payload, and can reopen an aviso a resolver already closed, with
 * a fresh `criadoEm` that re-alerts the operator about a fixed problem. Root
 * `CLAUDE.md` rule 7 warns that a watermark never advanced is a guard that never
 * rejects; a watermark that is RESET is worse.
 *
 * To clear a field deliberately, pass `null` explicitly — that is preserved.
 */
function camposInformados(plano: PlanoAviso): Record<string, unknown> {
  const campos: Record<string, unknown> = {
    tipo: plano.tipo,
    severidade: plano.severidade,
  };
  if (plano.canal !== undefined) campos.canal = plano.canal;
  if (plano.params !== undefined) campos.params = plano.params;
  if (plano.motivo !== undefined) campos.motivo = plano.motivo;
  if (plano.destinatarioUid !== undefined) campos.destinatarioUid = plano.destinatarioUid;
  if (plano.urlInterna !== undefined) campos.urlInterna = plano.urlInterna;
  if (plano.urlExterna !== undefined) campos.urlExterna = plano.urlExterna;
  if (plano.prazo !== undefined) campos.prazo = plano.prazo;
  if (plano.relogioEvento !== undefined) campos.relogioEvento = plano.relogioEvento;
  return campos;
}

/**
 * Raise (or re-raise) an operator notification.
 *
 * ## Why this is not a plain `merge`
 *
 * The dedup identity is `(tipo, conta, entidade, janela)` and it IS the document
 * id, so the same logical event from two producers — the weekly Shopee expiry
 * sweep and Shopee's own `push 12` — lands on one row. That is rule 7 tier 0:
 * nothing to compare, nothing to lose. `ocorrencias` rides `FieldValue.increment`
 * for the same reason.
 *
 * What is NOT expressible as a transform is the create/repeat/reopen branch:
 * `criadoEm` must stay put on a repeat (a recurring warning about the same
 * pending problem should not nag the operator again — that is what dedup is FOR,
 * and `ocorrencias` already records it) but must move on a REOPEN, because a
 * problem that went away and came back is genuinely new and has to read as
 * unread to everyone — past the operator's watermark AND past any individual
 * read, since each of those names the `criadoEm` it covered
 * (`entradaDeLeitura` in `@delfrance/schemas`).
 *
 * So: `create` first (atomic, no read); on ALREADY_EXISTS, read and update under
 * a `lastUpdateTime` precondition — rule 7 tier 1, recomputing the patch from a
 * fresh read on each retry, never re-applying the patch that just lost.
 */
export async function escreverAviso(
  db: Firestore,
  plano: PlanoAviso,
  deps: EscreverAvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  const chave = chaveDeAviso(plano);
  const ref = avisoCollection.docRef(db, {}, chave);

  const informados = camposInformados(plano);

  const novo = avisoCollection.parse({
    // A CREATE fills every optional, because the document must be complete and
    // the Firebase SDK rejects `undefined`.
    canal: null,
    params: {},
    motivo: null,
    destinatarioUid: null,
    urlInterna: null,
    urlExterna: null,
    prazo: null,
    relogioEvento: null,
    ...informados,
    criadoEm: deps.agoraUs,
    atualizadoEm: deps.agoraUs,
    ocorrencias: 1,
    resolvidoEm: null,
    resolucaoMotivo: null,
  });

  try {
    await ref.create(novo);
    await escalarSeCritico(novo, chave, deps);
    return { chave, resultado: 'criado' };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_PRECONDICAO; tentativa += 1) {
    const snap = await ref.get();
    if (!snap.exists) {
      // Swept between our create and our read. One more create is correct, and
      // if it collides again the next loop reads the winner.
      try {
        await ref.create(novo);
        await escalarSeCritico(novo, chave, deps);
        return { chave, resultado: 'criado' };
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        continue;
      }
    }

    const armazenado = avisoCollection.parseRead(snap.data(), `avisos/${chave}`);

    // Event-clock watermark (rule 7 tier 2): drop a delivery that is not fresher
    // than what we already stored. Only meaningful when BOTH sides carry a clock
    // from the same provider.
    if (
      plano.relogioEvento != null &&
      armazenado.relogioEvento != null &&
      plano.relogioEvento <= armazenado.relogioEvento
    ) {
      return { chave, resultado: 'ignorado' };
    }

    const reaberto = armazenado.resolvidoEm != null;
    const patch: Record<string, unknown> = {
      // ONLY the fields this producer actually supplied — see `camposInformados`.
      ...informados,
      atualizadoEm: deps.agoraUs,
      ocorrencias: deps.increment(1),
      resolvidoEm: null,
      resolucaoMotivo: null,
      // A repeat keeps its original `criadoEm` so it does not re-alert; a reopen
      // takes a new one so it re-alerts — it clears the read watermark and stops
      // matching every individual read, which names the old `criadoEm`.
      ...(reaberto ? { criadoEm: deps.agoraUs } : {}),
    };

    try {
      // Raw `update`, deliberately not the handle's `merge()`: the converter
      // full-parses a patch, and `ocorrencias` here is a FieldValue sentinel,
      // not a number. `camposInformados` is what constrains the rest of the shape.
      //
      // ⚠️ `informados` is computed once, from `plano` — it carries nothing read
      // from the document, so a precondition retry may reuse it. Everything that
      // IS derived from the snapshot (`reaberto`, and the `criadoEm` it decides)
      // is recomputed inside the loop, which is what the retry contract requires.
      await ref.update(patch, { lastUpdateTime: snap.updateTime });
      if (reaberto) {
        // Validated rather than cast: this is what the row now holds — the stored
        // document with this producer's fields laid over it, which is exactly what
        // the patch just wrote. A reopened `critico` escalates like a fresh one.
        const atual = avisoCollection.parse({
          ...armazenado,
          ...informados,
          criadoEm: deps.agoraUs,
          atualizadoEm: deps.agoraUs,
          ocorrencias: armazenado.ocorrencias + 1,
          resolvidoEm: null,
          resolucaoMotivo: null,
        });
        await escalarSeCritico(atual, chave, deps);
      }
      return { chave, resultado: reaberto ? 'reaberto' : 'repetido' };
    } catch (err) {
      if (isNotFound(err)) continue;
      if (!isFailedPrecondition(err)) throw err;
      // Lost the race — loop, re-READ and re-DERIVE. Never re-apply this patch.
    }
  }

  throw new Error(
    `escreverAviso(${chave}): ${String(MAX_TENTATIVAS_PRECONDICAO)} precondition failures in a row — persistent write contention on one aviso, which is a real problem rather than something to spin on.`,
  );
}

/**
 * Mark an aviso resolved. Called by the resolver every `tipo` must name: a
 * re-authorization for an expiry warning, `item_status` returning to normal for
 * a violation, `live_push_status` back to `Normal` for push health.
 *
 * ⚠️ It reports a **state transition**, not the existence of a document. The
 * read is what buys that, and it is not optional: the callers are periodic
 * (a weekly sweep resolves every healthy shop unconditionally), so a plain
 * `update` would answer `true` every run forever and re-stamp `resolvidoEm`
 * every run — which both makes the caller's `resolvidos` counter report
 * closures that never happened AND pushes the stamp forward faster than
 * `sweepAvisosResolvidos`'s 90-day cutoff can ever reach it, so the row never
 * ages out. An already-resolved row is therefore a no-op answering `false`.
 *
 * Never a plain `merge`: an admin `merge` is an UPSERT and would happily
 * resurrect a document the retention sweep already deleted, as a ghost carrying
 * only the patch keys. The read + `lastUpdateTime` precondition (rule 7 tier 1)
 * keeps that property and adds the transition: a CLOCK-LESS writer that lost the
 * race sees `FAILED_PRECONDITION` and reports `false` rather than overwriting the
 * winner. (With a clock the loser re-reads instead — see the last bullet below.)
 *
 * ## The event clock (`opts.relogioEvento`, rule 7 tier 2)
 *
 * The precondition orders two writes; it cannot order two OBSERVATIONS. A
 * resolver that derived "resolved" from an older provider state than the one
 * that last raised the row — two deliveries of one return, the newer committing
 * first — would close a problem that is open again. So a resolver that has the
 * provider's clock passes it, in the same unit its raise passes to
 * {@link escreverAviso}:
 *
 *  - stored `relogioEvento` non-null and `>=` the given one ⇒ the resolve is
 *    stale: no write, `false`. EQUAL is stale too, exactly as `escreverAviso`
 *    drops an equal raise.
 *  - otherwise the resolve also STAMPS the given clock, so a late, older raise
 *    arriving after it is dropped by `escreverAviso`'s own guard instead of
 *    reopening the row. A watermark not advanced on the write that wins is a
 *    guard that never rejects anything.
 *  - An ALREADY-resolved row is still not re-resolved (`resolvidoEm` and the
 *    motivo stay put, the answer is `false`), but a NEWER clock still ADVANCES
 *    its `relogioEvento` — alone, under the same `lastUpdateTime`
 *    precondition. Otherwise resolved → open → closed with the last two effects
 *    run in inverted order would let the late, older raise reopen a closed row:
 *    its clock beats the stale stamp, but not the one the closing observation
 *    carried. An equal or older clock on a resolved row writes nothing.
 *  - With a clock, a LOST PRECONDITION is re-decided, never conceded. Without
 *    one, "someone else wrote the row" means someone else resolved it, so
 *    `false` is the truth. With one it is not: the effects run concurrently (a
 *    task queue dispatching more than one at a time — Shopee's return effects —
 *    plus its reprocess sweep), so the winner can be an OLDER raise — it read
 *    the row before this resolve's write landed, beat its stored clock, and kept
 *    the row open (or reopened a resolved one, with a fresh `criadoEm` that
 *    re-alerts the operator about a closed problem). Nothing re-drives a
 *    terminal state afterwards, so conceding would leave that older observation
 *    standing for good. So, in EITHER branch, a `FAILED_PRECONDITION` loops:
 *    re-read, re-decide every rule above against the winner's row, write again —
 *    bounded by `escreverAviso`'s own `MAX_TENTATIVAS_PRECONDICAO`. A winner at
 *    an equal or newer clock makes the retry stale (`false`, nothing written);
 *    an older one is overwritten and stamped. A writer that keeps winning past
 *    the bound gets `false`, never a spin. `NOT_FOUND` (swept between read and
 *    write) is `false` on any path.
 *
 * Omitted ⇒ exactly the behaviour above minus the clock rules: the periodic
 * resolvers carry no clock, a stored one is left untouched, and a lost
 * precondition is `false` on the first attempt.
 */
export async function resolverAviso(
  db: Firestore,
  chave: string,
  motivo: string,
  deps: Pick<EscreverAvisoDeps, 'agoraUs'>,
  opts?: { relogioEvento?: number },
): Promise<boolean> {
  const ref = avisoCollection.docRef(db, {}, chave);
  const relogioEvento = opts?.relogioEvento;

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_PRECONDICAO; tentativa += 1) {
    // Every decision below is derived from THIS attempt's read — rule 7: a retry
    // that re-applies what the losing attempt decided is the lost update again.
    const snap = await ref.get();
    if (!snap.exists) return false;

    const armazenado = avisoCollection.parseRead(snap.data(), `avisos/${chave}`);

    if (armazenado.resolvidoEm != null) {
      // Not a transition — but a newer observation of "closed" must still move
      // the watermark, or a late older raise reopens the row (see the docblock).
      if (
        relogioEvento === undefined ||
        (armazenado.relogioEvento != null && armazenado.relogioEvento >= relogioEvento)
      ) {
        return false;
      }
      try {
        await ref.update(avisoCollection.parseMerge({ relogioEvento }) as Record<string, unknown>, {
          lastUpdateTime: snap.updateTime,
        });
        return false;
      } catch (err) {
        if (isNotFound(err)) return false;
        if (!isFailedPrecondition(err)) throw err;
        // The winner may be an OLDER raise that just reopened the row: re-read
        // and re-decide (the docblock's last bullet). Only reachable with a clock.
        continue;
      }
    }

    if (
      relogioEvento !== undefined &&
      armazenado.relogioEvento != null &&
      armazenado.relogioEvento >= relogioEvento
    ) {
      return false;
    }

    const patch = avisoCollection.parseMerge({
      resolvidoEm: deps.agoraUs,
      resolucaoMotivo: motivo,
      atualizadoEm: deps.agoraUs,
      ...(relogioEvento === undefined ? {} : { relogioEvento }),
    });

    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return true;
    } catch (err) {
      // Swept between our read and our write: there is nothing left to close.
      if (isNotFound(err)) return false;
      if (!isFailedPrecondition(err)) throw err;
      // Clock-less: someone else resolved the row; their write stands and this
      // call closed nothing. With a clock the winner may be an OLDER raise that
      // kept the row open — loop, re-read, re-decide.
      if (relogioEvento === undefined) return false;
    }
  }

  // A writer that kept winning every attempt: report no transition rather than
  // spin. The row holds whatever the last winner wrote.
  return false;
}

/**
 * What an escalator throws when its transport failed — a non-2xx from the chat
 * webhook, a malformed URL, a refused connection.
 *
 * It exists so {@link escreverAviso} can swallow exactly that and nothing else.
 * Rule 6 bans a generic catch, and `err instanceof Error` does not count as a
 * narrowing — it is the parent of every exception, so catching on it would
 * silently eat a programming error in the escalator and report the aviso as
 * cleanly written.
 */
export class AvisoEscalacaoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AvisoEscalacaoError';
  }
}

async function escalarSeCritico(
  aviso: Aviso,
  chave: string,
  deps: EscreverAvisoDeps,
): Promise<void> {
  if (aviso.severidade !== SEVERIDADE_AVISO.critico || deps.escalar === undefined) return;
  try {
    await deps.escalar(aviso, chave);
  } catch (err) {
    // Fails soft for transport only: the durable row is the system of record and
    // must survive a broken webhook. `TypeError` is what `fetch` throws on a
    // network failure or a bad URL; everything else propagates.
    if (!(err instanceof AvisoEscalacaoError) && !(err instanceof TypeError)) throw err;
    deps.logger?.warn('[avisos] escalation failed; the aviso itself was written', {
      chave,
      erro: err.message,
    });
  }
}
