/**
 * The UNCACHED conta reads: the single conta a route gates a write on, the ONE
 * enumeration of Loja Integrada contas, and the wrong-store guard built on it.
 *
 * ⚠️ Every read here decides a write, so none of them may come from
 * `contaCache.ts`.
 *
 * ⚠️ **The enumeration's clauses are load-bearing.** `where('tipo', '==', 3)
 * .orderBy('nome')` is exactly the declared `integracao (tipo ASC, nome ASC)`
 * composite — the slice the list screen shows. On Firestore Enterprise an
 * unindexed query does not throw, it silently full-scans and bills the data
 * scanned (root rule 1), so a third clause needs its own index in the same
 * commit. And it is deliberately NOT filtered on `ativo`: an inactive conta's
 * token keeps its three-month clock, and a browser can reactivate the conta
 * without passing through any route.
 *
 * ⚠️ **A tipo-3 conta with NO `nome` field is outside the enumeration.** A
 * classic `orderBy` also filters for the field's existence, so such a document
 * never comes back — not to the expiry sweep (no warning; pass (b) would close
 * its open rows as `conta-removida`), not to the wrong-store guard. Accepted:
 * `integracaoSchema.nome` is required (`min(1)`), so every conta this ERP writes
 * has one, and the SAME `(tipo, nome)` query is the list screen's
 * `defaultQuery` — a nome-less conta is already invisible there, so the list
 * never leads an operator to its panel to save a token. A legacy row lacking
 * it would need a backfill at the cutover (root rule 8), not a second query
 * here. `contas.test.ts` pins the exclusion.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { fingerprintDoToken } from './credencial';
import { lerCredencial } from './credentialStore';
import { LiCredencialInvalidaError } from './erros';

/**
 * Is this value unusable as a conta (document) id? Empty, or carrying a `/`
 * (it would address another path) or a `.` (Firestore reserves `.` and `..`).
 *
 * A route checks it FIRST, before any read: `.doc(id)` validates the path
 * itself and throws outside every narrow `catch`, so a malformed id would be a
 * 500 — or, with a separator, a read of a document the caller never named. A
 * real conta id is an auto-id, so refusing every `.` costs nothing.
 *
 * ⚠️ Copied, not imported: `apps/*` have no dependency edge to each other
 * (`apps/shopee`'s `naoDocId` is the same rule). Nothing here asserts what any
 * other copy does.
 */
export function naoEhIdDeConta(id: unknown): boolean {
  return typeof id !== 'string' || id === '' || id.includes('/') || id.includes('.');
}

/**
 * The conta document, read uncached, when it exists AND is a Loja Integrada
 * conta; `null` otherwise (the routes answer both with one 404). `ativo` is not
 * checked: a parked or inactive conta must stay fixable.
 */
export async function lerContaLojaIntegrada(
  db: Firestore,
  integracaoId: string,
): Promise<Integracao | null> {
  const snap = await integracaoCollection.docRef(db, {}, integracaoId).get();
  if (!snap.exists) return null;
  const conta = integracaoCollection.parseRead(
    snap.data(),
    integracaoCollection.docPath({}, integracaoId),
  );
  return conta.tipo === INTEGRACAO_TIPO.lojaIntegrada ? conta : null;
}

/** One Loja Integrada conta, reduced to what a sweep or a guard needs. */
export interface ContaLojaIntegradaResumo {
  readonly integracaoId: string;
  /**
   * The operator-facing store name; `''` only when a malformed legacy row holds
   * a non-string `nome` (a `null`, say). A row LACKING the field is not listed.
   */
  readonly nome: string;
  /** `false` only when the document says so explicitly (the schema default is `true`). */
  readonly ativo: boolean;
}

/** The enumeration, and WHEN it was read. */
export interface ContasLojaIntegrada {
  readonly contas: readonly ContaLojaIntegradaResumo[];
  /**
   * µs of the query's `readTime`: a conta created — or a credential parked —
   * after it is stamped later. Pass (b) of the expiry sweep resolves an orphan
   * reconexão aviso with it, so a park on a conta this list could not see
   * cannot be closed by it.
   */
  readonly leituraUs: number;
}

/**
 * EVERY Loja Integrada conta, active or not, ordered by `nome` — except one
 * lacking the field (module header).
 *
 * Fields are read RAW off each row: two are needed, and a soft parse of every
 * conta would warn-spam each tick on a legacy partial document.
 */
export async function listarContasLojaIntegrada(db: Firestore): Promise<ContasLojaIntegrada> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.lojaIntegrada)
    .orderBy('nome')
    .get();
  const contas = snap.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      integracaoId: doc.id,
      nome: typeof data.nome === 'string' ? data.nome : '',
      ativo: data.ativo !== false,
    };
  });
  return { contas, leituraUs: relogioDoDocumentoUs(snap.readTime) };
}

export interface GuardaDeLojaDeps {
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * The wrong-store guard: the id of ANOTHER Loja Integrada conta — active or
 * inactive — whose stored token is the candidate, or `null`.
 *
 * Compared through fingerprints DERIVED from each stored `personalToken`, never
 * through the stored `tokenFingerprint` field (a hand edit cannot defeat it).
 * The conta being saved is skipped, so re-saving its own token passes.
 *
 * Another conta with no credential is skipped. One whose credential is corrupt
 * is skipped TOO, and its id logged: this save must never be blocked by another
 * conta's corruption. Any Firestore failure propagates.
 *
 * ⚠️ It cannot catch two DIFFERENT tokens swapped between two contas — no Loja
 * Integrada endpoint names the store a token belongs to. Two operators saving
 * the same token on two contas at the same instant both pass; that residual is
 * accepted (step-2 plan §8).
 */
export async function contaComOMesmoToken(
  db: Firestore,
  integracaoId: string,
  tokenCandidato: string,
  deps: GuardaDeLojaDeps = {},
): Promise<string | null> {
  const alvo = fingerprintDoToken(tokenCandidato);
  const { contas } = await listarContasLojaIntegrada(db);
  for (const conta of contas) {
    if (conta.integracaoId === integracaoId) continue;
    try {
      const lida = await lerCredencial(db, conta.integracaoId);
      if (lida !== null && fingerprintDoToken(lida.credencial.personalToken) === alvo) {
        return conta.integracaoId;
      }
    } catch (err) {
      if (!(err instanceof LiCredencialInvalidaError)) throw err;
      deps.logger?.warn('[loja-integrada/contas] credencial ilegível ignorada na guarda de loja', {
        integracaoId: conta.integracaoId,
        campos: err.campos,
      });
    }
  }
  return null;
}
