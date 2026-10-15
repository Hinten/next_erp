/**
 * Registers a Loja Integrada shipping method in its conta's freight `mapa` (master plan step 20,
 * #1826): the first order that uses a method appends one unmapped row, so the operator can map it
 * on the conta screen. Step 5's importer is the caller; until then only tests call it.
 *
 * ## The rules come from `@delfrance/schemas`, never from here
 *
 * The key, the presence read and the row are the shared pure module's (`mapaFreteLojaIntegrada.ts`,
 * #1369), the same copy the conta screen and the window pass call. Registration is on the FULL
 * `'<id>---<code>'` key: one id can carry several services, and each needs its own row.
 *
 * ## A tier-1 precondition write (root `CLAUDE.md` rule 7)
 *
 * One document, one decision: read the doc, decide, then
 * `update({ mapa: arrayUnion(row) }, { lastUpdateTime })`.
 *
 *  - **Why the read.** Each row carries the order number in `observacao`, so an unconditional
 *    union would append one row per order. The presence read bounds the array to one row per key.
 *  - **Why the precondition.** Two registrations of one key that overlap (an at-least-once
 *    duplicate of the same task) would both read "absent" and both append. The stamp makes the
 *    second fail `FAILED_PRECONDITION` (9).
 *  - **On a lost precondition** (9, or `NOT_FOUND` (5), handled the same so the outcome does not
 *    hinge on which code the server picks for a removal): RE-READ and RE-DECIDE from the doc
 *    check. The row that lost is never re-applied; a doc removed meanwhile answers
 *    `sem-int-frete`, and an `update` can never resurrect it.
 *  - At most {@link MAX_TENTATIVAS_MAPA_FRETE_LI} attempts, then {@link LiMapaFreteEmConflitoError}:
 *    the step-3 classifier returns `null` for it, so the task rethrows and retries.
 *  - The other writers of this doc cannot lose the append. The conta trigger patches scalar fields
 *    and the conta screen rewrites `mapa` under its own guard; a commit by either only makes this
 *    precondition fail, and the retry re-decides against what landed.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document atomic-write call — not even in a
 * comment (`estrutura.test.ts`, and `firestore-transaction-inventory.test.js` would demand a class
 * for a site that does not exist).
 *
 * ## What it never does
 *
 *  - It writes `mapa` ONLY: never `ultimaModificacao`, never another field.
 *  - It never parses, normalises or rewrites the stored rows. `arrayUnion` leaves them
 *    byte-identical and turns a `null` or absent `mapa` into `[row]`; a whole-array rewrite would
 *    re-serialise every legacy row.
 *  - It never throws a `ZodError` on stored data: the step-3 classifier PARKS on one. The doc is
 *    read raw through the admin handle (no converter) and never strictly parsed.
 *  - It never writes with a merge-`set`, which would resurrect a doc removed between the read and
 *    the write.
 *  - It never caches the read: it is the input of a write.
 *  - It logs ids only: never a method's name, a row, or a doc's fields.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { intFreteCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  chaveFormaEnvioLi,
  entradaDoMapaPorChaveLi,
  montarEntradaDoMapaLi,
} from '@delfrance/schemas';

import { syncIntFreteLi } from './intFrete';

/** Read-decide-write attempts before giving up. */
export const MAX_TENTATIVAS_MAPA_FRETE_LI = 3;

/** Persistent contention on one `int_frete` doc: the task rethrows and retries (module header). */
export class LiMapaFreteEmConflitoError extends Error {
  readonly integracaoId: string;
  readonly intFreteId: string;
  readonly tentativas: number;

  constructor(integracaoId: string, intFreteId: string, tentativas: number) {
    super(
      `Não foi possível registrar a forma de envio no mapa do int_frete ${intFreteId} ` +
        `(conta da Loja Integrada ${integracaoId}): ${String(tentativas)} escritas seguidas ` +
        'perderam a precondição.',
    );
    this.name = 'LiMapaFreteEmConflitoError';
    this.integracaoId = integracaoId;
    this.intFreteId = intFreteId;
    this.tentativas = tentativas;
  }
}

export interface RegistroFormaEnvioLi {
  /** The conta whose order used the method. */
  readonly integracaoId: string;
  /** The conta's freight doc, as step 5's lookup chose it. */
  readonly intFreteId: string;
  /** The order's `forma_envio`, as the wire carried it. */
  readonly formaEnvio: unknown;
  /** The order's number: the appended row's `observacao`. */
  readonly numero: number | string;
}

export type ResultadoRegistroFormaEnvioLi =
  /**
   * The method has no key: an id that is not a canonical positive integer, or a code that is not
   * a string. Nothing was read.
   */
  | 'chave-invalida'
  /** No doc at `intFreteId`, or one that is not this conta's Loja Integrada freight doc. */
  | 'sem-int-frete'
  /** The stored `mapa` is neither `null`, absent nor an array: a union would overwrite it. */
  | 'mapa-invalido'
  /** A row under this key is already stored (mapped or not). Nothing was written. */
  | 'ja-presente'
  /** This call appended the row. */
  | 'registrada';

export interface RegistroDoMapaLi {
  readonly resultado: ResultadoRegistroFormaEnvioLi;
  /**
   * The stored `mapa` array exactly as the DECIDING attempt read it (elements untouched, never
   * parsed), or `null` when that attempt read no array: no read at all (`chave-invalida`), no
   * usable doc (`sem-int-frete`), a non-array (`mapa-invalido`), or a field absent or `null`.
   *
   * It never includes the row this call appended. That row is unmapped, so a router reading this
   * snapshot routes the order exactly as it would with the row present: step 5 routes from it
   * without a second read.
   */
  readonly mapa: readonly unknown[] | null;
}

export interface MapaFreteDeps {
  /** `(...e) => FieldValue.arrayUnion(...e)` in production; the fake's sentinel in tests. */
  readonly arrayUnion: (...elementos: unknown[]) => unknown;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

const ROTULO_LOG = '[loja-integrada/mapa-frete]';

/**
 * Append the method's row to the conta's freight `mapa` when no row carries its key (module
 * header).
 *
 * @throws {LiMapaFreteEmConflitoError} after {@link MAX_TENTATIVAS_MAPA_FRETE_LI} lost
 *   preconditions.
 */
export async function registrarFormaEnvioNoMapaLi(
  db: Firestore,
  registro: RegistroFormaEnvioLi,
  deps: MapaFreteDeps,
): Promise<RegistroDoMapaLi> {
  const { integracaoId, intFreteId, formaEnvio, numero } = registro;
  const ids = { integracaoId, intFreteId, numero };

  const chave = chaveFormaEnvioLi(formaEnvio);
  const linha = montarEntradaDoMapaLi({ forma: formaEnvio, numero });
  if (chave === null || linha === null) {
    deps.logger?.warn(`${ROTULO_LOG} forma de envio sem chave; nada registrado`, ids);
    return { resultado: 'chave-invalida', mapa: null };
  }

  const ref = intFreteCollection.docRef(db, {}, intFreteId);
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_MAPA_FRETE_LI; tentativa += 1) {
    // Every decision below is derived from THIS attempt's read.
    const snap = await ref.get();
    const raw = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
    const versao = snap.updateTime;
    // `ehDocDaConta` is the core's own check: tipo `lojaIntegrada` AND the canonical back-ref.
    if (
      raw === undefined ||
      versao === undefined ||
      !syncIntFreteLi.ehDocDaConta(raw, integracaoId)
    ) {
      deps.logger?.warn(`${ROTULO_LOG} int_frete ausente ou de outra conta; nada registrado`, ids);
      return { resultado: 'sem-int-frete', mapa: null };
    }

    const armazenado = raw.mapa;
    if (armazenado !== null && armazenado !== undefined && !Array.isArray(armazenado)) {
      deps.logger?.warn(`${ROTULO_LOG} mapa armazenado não é uma lista; nada registrado`, ids);
      return { resultado: 'mapa-invalido', mapa: null };
    }
    const mapa: readonly unknown[] | null = Array.isArray(armazenado) ? armazenado : null;

    if (entradaDoMapaPorChaveLi(mapa, chave) !== null) return { resultado: 'ja-presente', mapa };

    try {
      await ref.update({ mapa: deps.arrayUnion(linha) }, { lastUpdateTime: versao });
      return { resultado: 'registrada', mapa };
    } catch (err) {
      // Lost the race, or the doc was removed (9, or 5 — header): loop, re-read, re-decide.
      // Never re-apply this write.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  throw new LiMapaFreteEmConflitoError(integracaoId, intFreteId, MAX_TENTATIVAS_MAPA_FRETE_LI);
}
