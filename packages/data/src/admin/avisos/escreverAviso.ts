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
 * problem that went away and came back is genuinely new and has to clear the
 * read watermark.
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

  const base = {
    tipo: plano.tipo,
    severidade: plano.severidade,
    canal: plano.canal ?? null,
    params: plano.params ?? {},
    motivo: plano.motivo ?? null,
    destinatarioUid: plano.destinatarioUid ?? null,
    urlInterna: plano.urlInterna ?? null,
    urlExterna: plano.urlExterna ?? null,
    prazo: plano.prazo ?? null,
    relogioEvento: plano.relogioEvento ?? null,
  };

  const novo = avisoCollection.parse({
    ...base,
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
      ...base,
      atualizadoEm: deps.agoraUs,
      ocorrencias: deps.increment(1),
      resolvidoEm: null,
      resolucaoMotivo: null,
      // A repeat keeps its original `criadoEm` so it does not re-alert; a reopen
      // takes a new one so it clears the operator's read watermark.
      ...(reaberto ? { criadoEm: deps.agoraUs } : {}),
    };

    try {
      // Raw `update`, deliberately not the handle's `merge()`: the converter
      // full-parses a patch, and `ocorrencias` here is a FieldValue sentinel,
      // not a number. The shape is otherwise pinned by `base` above.
      await ref.update(patch, { lastUpdateTime: snap.updateTime });
      if (reaberto) {
        // Validated rather than cast: this is what the row now holds, and a
        // reopened `critico` must escalate exactly like a fresh one.
        const atual = avisoCollection.parse({
          ...base,
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
 * `mergeIfExists`, not `merge`: an admin `merge` is an UPSERT and would happily
 * resurrect a document the retention sweep already deleted, as a ghost carrying
 * only the patch keys.
 */
export async function resolverAviso(
  db: Firestore,
  chave: string,
  motivo: string,
  deps: Pick<EscreverAvisoDeps, 'agoraUs'>,
): Promise<boolean> {
  return avisoCollection.mergeIfExists(db, {}, chave, {
    resolvidoEm: deps.agoraUs,
    resolucaoMotivo: motivo,
    atualizadoEm: deps.agoraUs,
  });
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
