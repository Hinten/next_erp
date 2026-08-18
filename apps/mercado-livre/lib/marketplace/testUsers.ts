/**
 * Mint the pair of Mercado Livre **test users** an end-to-end run needs — one
 * seller, one buyer — from a throwaway "bootstrap" conta, then revoke that
 * conta's credential.
 *
 * ML has no sandbox. It hands out throwaway production accounts through
 * `POST /users/test_user` instead, and the response is the ONLY time the
 * credential is ever shown:
 *
 *  - «Você pode criar até 10 usuários de teste com sua conta de Mercado Livre.
 *    (…**não temos um recurso que mostre os usuários de teste criados e suas
 *    credenciais**.)»
 *  - «Se você perder a senha da conta de teste, não é possível recuperar, sendo
 *    assim é necessário criar uma nova conta.»
 *
 * — `realizacao-de-testes` (pt_br, rev. 2025-12-30). {@link anuncioTeste} quotes
 * the listing half of the same page.
 *
 * ## The ordering is the whole design
 *
 * Read those two quotes together: a mint whose result is not persisted has
 * **permanently** consumed one of ten slots and produced nothing. So this module
 * commits to three rules, in this order:
 *
 *  1. **Persist each user the moment it exists**, before minting the next. A
 *     failure on the buyer must not cost the seller.
 *  2. **Reuse whatever is already stored.** Doc ids are the role, so a re-run
 *     after a partial failure mints only what is missing instead of burning a
 *     second slot. (Root `CLAUDE.md` rule 7, tier 0: a deterministic id has no
 *     race to lose.)
 *  3. **Revoke the bootstrap credential only once BOTH are stored.** Wiping
 *     earlier leaves no token to retry with and no way to recover the user —
 *     the one unrecoverable state this whole flow exists to avoid.
 *
 * ⚠️ Rule 3 is why the wipe is not `Promise.all`'d with anything, and why it
 * takes the store rather than being folded into the loop.
 *
 * ## What the caller must not do with the result
 *
 * `password` is a live credential ML will never reissue. It is returned so the
 * route can hand it to the operator once and persist it; it must never reach a
 * log line. The API client's `criarUsuarioTeste` is built around the same
 * constraint — see the note on `parseTestUser` in the integrations package.
 */
import type { MercadoLivreApi, MlTestUser } from '@delfrance/integrations-mercado-livre';
import {
  USUARIO_TESTE_ROLE,
  type UsuarioTesteMercadoLivre,
  type UsuarioTesteRole,
} from '@delfrance/schemas';

import { isContaDeTeste } from './anuncioTeste';
import type { TokenDuravelStore } from './tokenStore';

/** The site every account in this repo operates on. */
export const SITE_ID_PADRAO = 'MLB';

/**
 * Seller first, buyer second — the order a test run needs them in, and the order
 * the UI reports. Not cosmetic: if only one mint succeeds, the seller is the
 * half that unblocks publishing.
 */
export const ROLES_A_CRIAR: readonly UsuarioTesteRole[] = [
  USUARIO_TESTE_ROLE.vendedor,
  USUARIO_TESTE_ROLE.comprador,
];

/**
 * A conta-level refusal the ROUTE turns into a 4xx. Mirrors
 * `ManualPushGuardError` in `estoqueManual.ts`.
 */
export class TestUserGuardError extends Error {
  constructor(
    readonly code: 'ML_CONTA_JA_E_TESTE',
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TestUserGuardError';
  }
}

/** Persistence for the minted records. One document per role. */
export interface TestUserStore {
  /** The stored record for a role, or null. */
  get(role: UsuarioTesteRole): Promise<UsuarioTesteMercadoLivre | null>;
  /** Write a record at the role's fixed doc id. */
  put(record: UsuarioTesteMercadoLivre): Promise<void>;
  /** Every stored record, for the read-back route. */
  list(): Promise<UsuarioTesteMercadoLivre[]>;
}

export interface CriarUsuariosTesteDeps {
  readonly api: Pick<MercadoLivreApi, 'criarUsuarioTeste' | 'getMe'>;
  readonly store: TestUserStore;
  /** Only `deleteAll` is used — the bootstrap conta's credential. */
  readonly tokens: Pick<TokenDuravelStore, 'deleteAll'>;
  readonly siteId?: string;
  readonly now?: () => number;
}

export interface CriarUsuariosTesteResult {
  /** Both records, seller first. */
  readonly usuarios: readonly UsuarioTesteMercadoLivre[];
  /** Roles minted on THIS run — the ones that consumed a slot. */
  readonly criados: readonly UsuarioTesteRole[];
  /** Roles that were already stored and were reused instead of re-minted. */
  readonly reaproveitados: readonly UsuarioTesteRole[];
  /** Credential docs deleted from the bootstrap conta. */
  readonly credenciaisRemovidas: number;
  /** Who minted them — the conta that is now disconnected. */
  readonly conta: { readonly id: number; readonly nickname: string | null };
}

/**
 * Mint (or reuse) the seller/buyer pair, then revoke the bootstrap credential.
 *
 * Throws {@link TestUserGuardError} when the conta is itself a test user: ML's
 * test users cannot mint test users, and reaching this point with one connected
 * means the operator selected the wrong conta — the failure mode worth catching,
 * since the next step wipes that conta's credential.
 */
export async function criarUsuariosTeste(
  deps: CriarUsuariosTesteDeps,
): Promise<CriarUsuariosTesteResult> {
  const siteId = deps.siteId ?? SITE_ID_PADRAO;
  const now = deps.now ?? Date.now;

  const me = await deps.api.getMe();
  if (isContaDeTeste(me.nickname)) {
    // ⚠️ Refuse BEFORE minting anything. `isContaDeTeste` is a nickname
    // heuristic and only warns on the publish path, but here the very next step
    // deletes this conta's credential, so a wrong conta is not recoverable by
    // clicking again.
    throw new TestUserGuardError(
      'ML_CONTA_JA_E_TESTE',
      409,
      `A conta conectada (${me.nickname ?? String(me.id)}) já é um usuário de teste do ` +
        'Mercado Livre. Conecte a conta real que registrou a aplicação para criar os ' +
        'usuários de teste.',
      { nickname: me.nickname ?? null },
    );
  }

  const usuarios: UsuarioTesteMercadoLivre[] = [];
  const criados: UsuarioTesteRole[] = [];
  const reaproveitados: UsuarioTesteRole[] = [];

  for (const role of ROLES_A_CRIAR) {
    const existente = await deps.store.get(role);
    if (existente) {
      // Rule 2: never re-mint what we already hold. A retry after a partial
      // failure must cost zero slots.
      usuarios.push(existente);
      reaproveitados.push(role);
      continue;
    }

    const minted = await deps.api.criarUsuarioTeste(siteId);
    const record = toRecord(minted, role, siteId, now(), me.id);
    // Rule 1: persist BEFORE the next mint. Anything between the ML response and
    // this write is a window in which a slot is spent and the credential lost.
    await deps.store.put(record);
    usuarios.push(record);
    criados.push(role);
  }

  // Rule 3: both are durable — only now is it safe to lose the token that
  // created them.
  const credenciaisRemovidas = await deps.tokens.deleteAll();

  return {
    usuarios,
    criados,
    reaproveitados,
    credenciaisRemovidas,
    conta: { id: me.id, nickname: me.nickname ?? null },
  };
}

/**
 * ML's mint response → the stored record.
 *
 * `site_id` falls back to the requested site: ML echoes it inconsistently, and a
 * null there would leave the operator unable to tell which marketplace the
 * account belongs to — for a credential that cannot be looked up again.
 */
export function toRecord(
  minted: MlTestUser,
  role: UsuarioTesteRole,
  siteId: string,
  createdAt: number,
  createdByUserId: number,
): UsuarioTesteMercadoLivre {
  return {
    role,
    id: minted.id,
    nickname: minted.nickname,
    password: minted.password,
    site_id: minted.site_id ?? siteId,
    site_status: minted.site_status ?? null,
    email: minted.email ?? null,
    createdAt,
    createdByUserId,
  };
}

/**
 * ML's e-mail verification code for a test user: «o código de validação de
 * e-mail para usuários de teste será igual aos últimos dígitos do ID do
 * usuário, o tamanho do código pode ser de 4 ou 6 dígitos dependendo do caso».
 *
 * Surfaced next to each account because there is no inbox to check — without it
 * the operator hits a verification wall with no way past it. Both lengths are
 * returned since ML does not say which it will ask for.
 */
export function codigosVerificacaoEmail(id: number): { quatro: string; seis: string } {
  const digits = String(Math.abs(Math.trunc(id)));
  return {
    quatro: digits.slice(-4),
    seis: digits.slice(-6),
  };
}
