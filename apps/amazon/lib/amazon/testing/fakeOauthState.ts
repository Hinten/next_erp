/**
 * An in-memory `OauthStateStore`, **for tests only** (the `fakeDb.ts` rule:
 * nothing outside a `*.test.ts` imports it).
 *
 * The real store (`@delfrance/data/admin/oauth-state`) redeems inside a
 * Firestore multi-document atomic write, which `fakeDb.ts` deliberately does not
 * model (this app runs none). The seam's own tests own those semantics; this
 * double reproduces the CONTRACT the callback relies on, branch for branch:
 *
 *  - `put` overwrites the conta's one record (a newer attempt supersedes);
 *  - `consume` throws `OauthStateError` for an absent record, a nonce that is
 *    not the current one (superseded), an already-consumed one (replay) or an
 *    expired one (`MAX_AGE_MS`), and otherwise stamps it consumed.
 *
 * Every call is recorded, so a suite can assert "nothing was consumed".
 */
import {
  type ConsumedOauthState,
  MAX_AGE_MS,
  OauthStateError,
  type OauthStateStore,
  type PutOauthStateInput,
} from '@delfrance/data/admin/oauth-state';

interface Registro {
  nonce: string;
  codeVerifier: string | null;
  criadoEm: number;
  consumidoEm: number | null;
}

export interface FakeOauthState extends OauthStateStore {
  /** Every `put`, in order: `[id, nonce]`. */
  readonly puts: [string, string][];
  /** Every `consume` ATTEMPT, in order (refused ones included): `[id, nonce]`. */
  readonly consumos: [string, string][];
  /** The stored record of a conta, or `undefined`. */
  registro(id: string): Readonly<Registro> | undefined;
}

export function criarFakeOauthState(): FakeOauthState {
  const registros = new Map<string, Registro>();
  const puts: [string, string][] = [];
  const consumos: [string, string][] = [];
  return {
    puts,
    consumos,
    registro: (id) => registros.get(id),
    put(_db, id, input: PutOauthStateInput, now = Date.now()): Promise<void> {
      puts.push([id, input.nonce]);
      registros.set(id, {
        nonce: input.nonce,
        codeVerifier: input.codeVerifier,
        criadoEm: now,
        consumidoEm: null,
      });
      return Promise.resolve();
    },
    consume(_db, id, nonce, now = Date.now()): Promise<ConsumedOauthState> {
      consumos.push([id, nonce]);
      const r = registros.get(id);
      if (r === undefined) {
        return Promise.reject(new OauthStateError('nenhuma tentativa de conexão pendente'));
      }
      if (r.nonce !== nonce) {
        return Promise.reject(new OauthStateError('state não corresponde à tentativa atual'));
      }
      if (r.consumidoEm !== null) {
        return Promise.reject(new OauthStateError('state já utilizado'));
      }
      if (now - r.criadoEm > MAX_AGE_MS) {
        return Promise.reject(new OauthStateError('tentativa de conexão expirada'));
      }
      r.consumidoEm = now;
      return Promise.resolve({ codeVerifier: r.codeVerifier });
    },
  };
}
