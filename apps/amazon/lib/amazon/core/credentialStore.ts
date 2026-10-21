/**
 * The Amazon LWA credential store — `integracao/{integracaoId}/credenciais/current`,
 * the GENERIC marketplace credential path, typed by `credenciaisAmazonSchema`.
 *
 * Paths come through `credenciaisIntegracaoCollection.docRef` with
 * `CREDENCIAL_AMAZON_DOC_ID`; nothing here spells a collection path.
 *
 * ## The writes (root `CLAUDE.md` rule 7)
 *
 * | operation | tier | mechanism |
 * | --- | --- | --- |
 * | {@link salvarConsentimento} | 0 | a FULL `set()` — a consent is a deliberate reconnect, so last-write-wins is correct; a concurrent park or refresh is defused by IDENTITY (the park re-derives the ref, the refresh tags `acessoRef`) |
 * | {@link persistirAcesso} | 0 | a field `update` of exactly `{access_token, expirationDate, acessoRef}`; never a `set`, never `refresh_token` / `autorizadoEmMs` / `reconexaoPendente`; an update never resurrects a deleted doc |
 * | {@link removerCredencial} | 0 | unconditional, idempotent `delete` — the callback's undo only |
 * | the park (`estacionamento.ts`) | 1 | `update` under `lastUpdateTime`, re-decided |
 *
 * ## Strict reads
 *
 * Every read parses with `credenciaisAmazonSchema.safeParse`, NEVER the handle's
 * `parseRead`: that soft read logs and returns the RAW document on a mismatch,
 * which would hand a half-formed credential to the park's guard. A corrupt
 * document throws {@link CredencialAmazonInvalidaError} carrying field PATHS.
 *
 * ## Never cached
 *
 * A cached credential would replay a refused token and decide a write on a
 * stale read — both cases `@delfrance/data/admin/cache` forbids.
 *
 * ⚠️ Token hygiene: no function here logs, and no error it raises carries a
 * token, a fingerprint or a ref.
 */
import type { DocumentReference, Firestore, Timestamp } from 'firebase-admin/firestore';
import { camposInvalidos } from '@delfrance/core/wire';
import { credenciaisIntegracaoCollection } from '@delfrance/data/admin/collections';
import { isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  CREDENCIAL_AMAZON_DOC_ID,
  type CredenciaisAmazon,
  credenciaisAmazonSchema,
} from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { CredencialAmazonAusenteError, CredencialAmazonInvalidaError } from './erros';

/** The one credential document of a conta. */
export function docCredencial(db: Firestore, integracaoId: string): DocumentReference {
  return credenciaisIntegracaoCollection.docRef(db, { integracaoId }, CREDENCIAL_AMAZON_DOC_ID);
}

/** A strictly-parsed credential, with the commit stamp it was read at. */
export interface CredencialLida {
  readonly credencial: CredenciaisAmazon;
  /** The document's `updateTime` — the precondition of a write decided on this read. */
  readonly updateTime: Timestamp;
  /** The same stamp in µs: the reconexão aviso's clock. */
  readonly versaoUs: number;
}

/** A credential read, together with WHEN it was read. */
export interface LeituraDeCredencial {
  /** The credential, or `null` when none was stored at {@link readTimeUs}. */
  readonly lida: CredencialLida | null;
  /**
   * µs of the snapshot's `readTime`. The read saw every write stamped `<=` it,
   * and any write it did not see is stamped `>` it — so it orders an ABSENCE
   * against a later commit, which no document stamp can (there is no
   * document). The sweep resolves the reconexão aviso with it when no
   * credential exists.
   */
  readonly readTimeUs: number;
}

/** What a write that landed reports. */
export interface EscritaCredencial {
  readonly writeTime: Timestamp;
  /** The same stamp in µs: the reconexão aviso's clock for a consent. */
  readonly versaoUs: number;
}

function escrita(writeTime: Timestamp): EscritaCredencial {
  return { writeTime, versaoUs: relogioDoDocumentoUs(writeTime) };
}

/**
 * {@link lerCredencial}, plus the read time.
 *
 * @throws {CredencialAmazonInvalidaError} when the document does not parse
 *   (paths only). Firestore failures propagate as themselves.
 */
export async function lerCredencialComLeitura(
  db: Firestore,
  integracaoId: string,
): Promise<LeituraDeCredencial> {
  const snap = await docCredencial(db, integracaoId).get();
  const readTimeUs = relogioDoDocumentoUs(snap.readTime);
  if (!snap.exists) return { lida: null, readTimeUs };
  const parsed = credenciaisAmazonSchema.safeParse(snap.data());
  if (!parsed.success) {
    throw new CredencialAmazonInvalidaError(integracaoId, camposInvalidos(parsed.error.issues));
  }
  const updateTime = snap.updateTime;
  if (updateTime === undefined) {
    // An existing document always has one; refusing beats deciding a guarded
    // write on no stamp at all.
    throw new Error(`lerCredencial(${integracaoId}): documento existente sem updateTime`);
  }
  return {
    lida: { credencial: parsed.data, updateTime, versaoUs: relogioDoDocumentoUs(updateTime) },
    readTimeUs,
  };
}

/**
 * The conta's credential, strictly parsed, or `null` when none is stored.
 *
 * @throws {CredencialAmazonInvalidaError} when the document does not parse.
 */
export async function lerCredencial(
  db: Firestore,
  integracaoId: string,
): Promise<CredencialLida | null> {
  return (await lerCredencialComLeitura(db, integracaoId)).lida;
}

/** What a consent stores. `reconexaoPendente` is always cleared: a new grant is unparked. */
export interface Consentimento {
  readonly access_token: string;
  readonly refresh_token: string;
  /** ms — the access token's expiry (`obtidoEmMs + expiraEmS * 1000`). */
  readonly expirationDate: number;
  /** ms — the start of OUR code exchange: the 365-day clock, and part of the ref. */
  readonly autorizadoEmMs: number;
  /** The ref of THIS grant — the first access token was minted from it. */
  readonly acessoRef: string;
}

/**
 * Store a consent: a FULL `set()` of the whole document (tier 0, module header).
 *
 * The document is parsed with the STRICT schema first, so no write can produce a
 * document the strict reader would reject — an extra key, a µs stamp in an ms
 * field, an over-long ref all throw here, before anything is sent.
 */
export async function salvarConsentimento(
  db: Firestore,
  integracaoId: string,
  c: Consentimento,
): Promise<EscritaCredencial> {
  const doc = credenciaisAmazonSchema.parse({
    access_token: c.access_token,
    refresh_token: c.refresh_token,
    expirationDate: c.expirationDate,
    autorizadoEmMs: c.autorizadoEmMs,
    acessoRef: c.acessoRef,
    reconexaoPendente: null,
  });
  const wr = await docCredencial(db, integracaoId).set(doc);
  return escrita(wr.writeTime);
}

/** The three fields an access-token refresh writes, and nothing else. */
const patchDeAcessoSchema = credenciaisAmazonSchema
  .pick({ access_token: true, expirationDate: true, acessoRef: true })
  .strict();

/** What a refresh persists. */
export interface Acesso {
  readonly access_token: string;
  /** ms */
  readonly expirationDate: number;
  /** The ref of the grant the token was minted from. */
  readonly acessoRef: string;
}

/**
 * Persist a refreshed access token: a field `update` of exactly three keys
 * (tier 0, module header). A token minted from a grant a consent has since
 * replaced lands tagged with the OLD ref, and the getter ignores it
 * (`acessoRef ≠ ref`); concurrent refreshes are harmless (the refresh token
 * does not rotate).
 *
 * @throws {CredencialAmazonAusenteError} when the document was removed: an
 *   `update` answers `NOT_FOUND` and never recreates it.
 */
export async function persistirAcesso(
  db: Firestore,
  integracaoId: string,
  a: Acesso,
): Promise<EscritaCredencial> {
  const patch = patchDeAcessoSchema.parse({
    access_token: a.access_token,
    expirationDate: a.expirationDate,
    acessoRef: a.acessoRef,
  });
  try {
    const wr = await docCredencial(db, integracaoId).update(patch);
    return escrita(wr.writeTime);
  } catch (err) {
    if (isNotFound(err)) throw new CredencialAmazonAusenteError(integracaoId);
    throw err;
  }
}

/**
 * Remove the conta's credential. Unconditional and idempotent (tier 0). Its only
 * caller is the callback's undo, when the conta was deleted while the consent
 * landed.
 */
export async function removerCredencial(
  db: Firestore,
  integracaoId: string,
): Promise<EscritaCredencial> {
  const wr = await docCredencial(db, integracaoId).delete();
  return escrita(wr.writeTime);
}
