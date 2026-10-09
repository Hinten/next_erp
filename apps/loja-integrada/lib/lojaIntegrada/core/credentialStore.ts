/**
 * The Loja Integrada Personal Token store —
 * `integracao/{integracaoId}/credenciaisLojaIntegrada/current`.
 *
 * Four operations, each a single-document write with its own concurrency rule
 * (root `CLAUDE.md` rule 7):
 *
 * | operation | tier | on a lost race |
 * | --- | --- | --- |
 * | {@link salvarCredencial} | `create` when the caller saw no document, else `update` under `lastUpdateTime` | {@link LiCredencialAlteradaError} (409) |
 * | {@link atualizarValidade} | `update` under `lastUpdateTime` | 409 — altered, or absent when deleted |
 * | {@link removerCredencial} | unconditional `delete` (tier 0, idempotent) | — |
 * | the park (`estacionamento.ts`) | `update` under `lastUpdateTime`, re-decided | re-read, ≤ 3 attempts |
 *
 * The save and the renewal are INTERACTIVE edits: they carry the version the
 * operator's page read, and losing is reported (tier 3), never re-applied —
 * under last-write-wins two operators saving different tokens would both see
 * "saved".
 *
 * ## Strict reads
 *
 * {@link lerCredencial} parses with `credenciaisLojaIntegradaSchema.safeParse`,
 * NEVER the handle's `parseRead`: that soft read logs and returns the RAW
 * document on a mismatch, which here would hand a half-formed credential to the
 * park's guard. A corrupt document throws {@link LiCredencialInvalidaError}
 * carrying field PATHS only.
 *
 * ## Never cached
 *
 * Every function here reads or writes Firestore directly. A cached credential
 * would replay a refused token and decide a write on a stale read — both of the
 * cases `@delfrance/data/admin/cache` forbids.
 *
 * ⚠️ Token hygiene: no function here logs, and no error it raises carries the
 * token, its fingerprint or its ref.
 */
import type { DocumentReference, Firestore, Timestamp } from 'firebase-admin/firestore';
import { camposInvalidos } from '@delfrance/core/wire';
import { credenciaisLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  CREDENCIAL_LOJA_INTEGRADA_DOC_ID,
  type CredenciaisLojaIntegrada,
  credenciaisLojaIntegradaSchema,
} from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { fingerprintDoToken } from './credencial';
import {
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
} from './erros';

/** The one credential document of a conta. */
export function docCredencial(db: Firestore, integracaoId: string): DocumentReference {
  return credenciaisLojaIntegradaCollection.docRef(
    db,
    { integracaoId },
    CREDENCIAL_LOJA_INTEGRADA_DOC_ID,
  );
}

/** A strictly-parsed credential, with the commit stamp it was read at. */
export interface CredencialLida {
  readonly credencial: CredenciaisLojaIntegrada;
  /**
   * The document's `updateTime` — the precondition a write decided on this
   * read must carry. Compared by the server, never by `===`.
   */
  readonly updateTime: Timestamp;
  /** The same stamp in µs: the version the panel sees as `versaoCredencialUs`. */
  readonly versaoUs: number;
}

/** What a write that landed reports. */
export interface EscritaCredencial {
  /** The commit stamp — the document's new `updateTime` (absent after a delete). */
  readonly writeTime: Timestamp;
  /** The same stamp in µs: the new version, and the reconexão aviso's clock. */
  readonly versaoUs: number;
}

function escrita(writeTime: Timestamp): EscritaCredencial {
  return { writeTime, versaoUs: relogioDoDocumentoUs(writeTime) };
}

/** A credential read, together with WHEN it was read. */
export interface LeituraDeCredencial {
  /** The credential, or `null` when none was stored at {@link leituraUs}. */
  readonly lida: CredencialLida | null;
  /**
   * µs of the snapshot's `readTime`. The read saw every write stamped `<=` it,
   * and any write it did not see is stamped `>` it — so it orders an ABSENCE
   * against a later commit, which no document stamp can (there is no document).
   * The sweep resolves the reconexão aviso with it when no credential exists.
   */
  readonly leituraUs: number;
}

/**
 * {@link lerCredencial}, plus the read time — for a caller that must order "no
 * credential" against a park committed after it.
 *
 * @throws {LiCredencialInvalidaError} when the document does not parse (paths
 *   only). Firestore failures propagate as themselves.
 */
export async function lerCredencialComLeitura(
  db: Firestore,
  integracaoId: string,
): Promise<LeituraDeCredencial> {
  const snap = await docCredencial(db, integracaoId).get();
  const leituraUs = relogioDoDocumentoUs(snap.readTime);
  if (!snap.exists) return { lida: null, leituraUs };
  const parsed = credenciaisLojaIntegradaSchema.safeParse(snap.data());
  if (!parsed.success) {
    throw new LiCredencialInvalidaError(integracaoId, camposInvalidos(parsed.error.issues));
  }
  const updateTime = snap.updateTime;
  if (updateTime === undefined) {
    // An existing document always has one; refusing beats deciding a guarded
    // write on no stamp at all.
    throw new Error(`lerCredencial(${integracaoId}): documento existente sem updateTime`);
  }
  return {
    lida: { credencial: parsed.data, updateTime, versaoUs: relogioDoDocumentoUs(updateTime) },
    leituraUs,
  };
}

/**
 * The conta's credential, strictly parsed, or `null` when none is stored.
 *
 * @throws {LiCredencialInvalidaError} when the document does not parse (paths
 *   only). Firestore failures propagate as themselves.
 */
export async function lerCredencial(
  db: Firestore,
  integracaoId: string,
): Promise<CredencialLida | null> {
  return (await lerCredencialComLeitura(db, integracaoId)).lida;
}

export interface SalvarCredencialEntrada {
  /** The VALIDATED token, exactly as the route trimmed it. */
  readonly personalToken: string;
  /** ms — 23:59:59 São Paulo on the date the operator entered. */
  readonly tokenExpiraEmMs: number;
  /** ms — now; becomes `tokenAtualizadoEmMs`, and so part of the new ref. */
  readonly agoraMs: number;
  /**
   * The `updateTime` of the credential the caller read and decided on.
   * ABSENT ⇒ the caller saw no document: `create`. PRESENT ⇒ `update` under
   * that stamp. Never a µs number — the server compares the stamp itself.
   */
  readonly versaoEsperada?: Timestamp;
}

/**
 * Store a validated token.
 *
 * - **Create** (no `versaoEsperada`): the full document, `webhookPedido` and
 *   `reconexaoPendente` both `null`. `ALREADY_EXISTS` means another writer got
 *   there first: 409.
 * - **Update**: ONE patch of exactly the four token fields plus
 *   `reconexaoPendente: null`, under `lastUpdateTime`. `FAILED_PRECONDITION`
 *   — someone wrote OR removed it after our read: the SDK sends only the stamp,
 *   so a removal fails it too — is 409; so is `NOT_FOUND`, in case the server
 *   ever answers a removal that way. ⚠️ The patch never mentions
 *   `webhookPedido` — a later step's registration survives a token save — and
 *   every value is a leaf or `null`, so `update` replaces nothing a set-merge
 *   would have kept.
 *
 * @throws {LiCredencialAlteradaError} on a lost race.
 */
export async function salvarCredencial(
  db: Firestore,
  integracaoId: string,
  entrada: SalvarCredencialEntrada,
): Promise<EscritaCredencial> {
  const ref = docCredencial(db, integracaoId);
  const campos = {
    personalToken: entrada.personalToken,
    tokenFingerprint: fingerprintDoToken(entrada.personalToken),
    tokenExpiraEmMs: entrada.tokenExpiraEmMs,
    tokenAtualizadoEmMs: entrada.agoraMs,
    reconexaoPendente: null,
  };

  if (entrada.versaoEsperada === undefined) {
    const doc = credenciaisLojaIntegradaCollection.parse({ ...campos, webhookPedido: null });
    try {
      const wr = await ref.create(doc);
      return escrita(wr.writeTime);
    } catch (err) {
      if (isAlreadyExists(err)) throw new LiCredencialAlteradaError(integracaoId);
      throw err;
    }
  }

  const patch = credenciaisLojaIntegradaCollection.parseMerge(campos);
  try {
    const wr = await ref.update(patch, { lastUpdateTime: entrada.versaoEsperada });
    return escrita(wr.writeTime);
  } catch (err) {
    if (isFailedPrecondition(err) || isNotFound(err)) {
      throw new LiCredencialAlteradaError(integracaoId);
    }
    throw err;
  }
}

export interface AtualizarValidadeEntrada {
  /** ms — the new expiry the operator copied from the painel. */
  readonly tokenExpiraEmMs: number;
  /** ms — now; the stored token was re-validated just now. */
  readonly agoraMs: number;
  /** The `updateTime` of the credential the caller read and re-validated. */
  readonly versaoEsperada: Timestamp;
}

/**
 * Store a new expiry for the token ALREADY stored (renewing in the painel keeps
 * the same token). Exactly three fields: the expiry, `tokenAtualizadoEmMs` and
 * `reconexaoPendente: null` — so it only ever clears a park on a token that was
 * validated just now, and the new `tokenAtualizadoEmMs` gives it a new ref.
 *
 * @throws {LiCredencialAlteradaError} when the document changed after the read.
 * @throws {LiCredencialAusenteError} when it was removed after the read — told
 *   apart by a re-read, because the server reports both as `FAILED_PRECONDITION`.
 */
export async function atualizarValidade(
  db: Firestore,
  integracaoId: string,
  entrada: AtualizarValidadeEntrada,
): Promise<EscritaCredencial> {
  const patch = credenciaisLojaIntegradaCollection.parseMerge({
    tokenExpiraEmMs: entrada.tokenExpiraEmMs,
    tokenAtualizadoEmMs: entrada.agoraMs,
    reconexaoPendente: null,
  });
  const ref = docCredencial(db, integracaoId);
  try {
    const wr = await ref.update(patch, { lastUpdateTime: entrada.versaoEsperada });
    return escrita(wr.writeTime);
  } catch (err) {
    if (isFailedPrecondition(err)) {
      // The SDK sends ONLY the update-time precondition (it replaces its own
      // `exists` check), so a removal after our read fails it too — 9, never 5.
      // A fresh read tells "removed" from "altered". It picks the error code and
      // nothing else: no write is decided on it.
      const atual = await ref.get();
      if (!atual.exists) throw new LiCredencialAusenteError(integracaoId);
      throw new LiCredencialAlteradaError(integracaoId);
    }
    // What an update WITHOUT the stamp answers on a missing document; mapped
    // too, so the code does not hinge on which of the two the server picks.
    if (isNotFound(err)) throw new LiCredencialAusenteError(integracaoId);
    throw err;
  }
}

/**
 * Remove the conta's token. Unconditional and idempotent (tier 0): the intent
 * is "no token on this conta", whoever saved the current one. Deleting an
 * absent document succeeds, and still reports a commit stamp — the clock the
 * removal's aviso resolve carries.
 */
export async function removerCredencial(
  db: Firestore,
  integracaoId: string,
): Promise<EscritaCredencial> {
  const wr = await docCredencial(db, integracaoId).delete();
  return escrita(wr.writeTime);
}
