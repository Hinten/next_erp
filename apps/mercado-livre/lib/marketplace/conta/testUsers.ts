/**
 * Mint Mercado Livre **test users** from a throwaway "bootstrap" conta, then
 * revoke that conta's credential.
 *
 * Two shapes, one code path:
 *
 *  - **the pair bootstrap** (`modo: 'reaproveitar'`, the default) — one seller
 *    and one buyer, keyed on the ROLE, reusing anything already stored;
 *  - **an additional mint** (`modo: 'novo'`) — ONE fresh account of a named
 *    role, keyed on `${role}-${mlUserId}`, reusing nothing. #1087 needs it: a
 *    buyer that Mercado Pago has stopped accepting purchases from has to be
 *    replaced without re-minting the seller that still works.
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
 * ⚠️ **`modo: 'novo'` suspends rule 2 and nothing else.** Reuse is exactly what
 * that caller is asking us not to do, so it is skipped — but the write still
 * lands the instant ML answers (rule 1), and the revocation still runs last
 * (rule 3). What replaces rule 2 is the doc id: `${role}-${mlUserId}` is derived
 * from ML's own response, so it cannot collide with a stored record, and it is
 * written with `create` rather than `set` so a collision would FAIL rather than
 * silently overwrite an unrecoverable password.
 *
 * ## Two things this module cannot protect you from
 *
 * ⚠️ **The cap is real and uncheckable.** Ten per real account, and ML publishes
 * no endpoint that lists them, so {@link USUARIO_TESTE_LIMITE_POR_CONTA} is
 * enforced against what WE stored — a floor, never the true total. The guard
 * refuses at ten; it cannot tell you when you are at nine having spent eleven.
 *
 * ⚠️ **A successful mint leaves the conta unable to mint again.** `deleteAll`
 * removes every `tokenDuravel` doc, and the route resolves the channel context
 * before reaching this function — so the next `POST` dies at
 * `getOrRefreshAccessToken` with `ML_REAUTH_REQUIRED` before any guard here
 * runs. That is intended (the bootstrap account is a real seller account), but
 * it makes "reconnect the real account first" a PRECONDITION of every
 * additional mint, not an error to be surprised by. `revogarCredencial: false`
 * is the deliberate opt-out, and it is the caller's to make explicit.
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
  USUARIO_TESTE_LIMITE_POR_CONTA,
  USUARIO_TESTE_ROLE,
  type UsuarioTesteMercadoLivre,
  type UsuarioTesteRole,
} from '@delfrance/schemas';

import { isContaDeTeste } from './anuncioTeste';
import type { TokenDuravelStore } from '../core/tokenStore';

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
    readonly code:
      | 'ML_CONTA_JA_E_TESTE'
      | 'ML_LIMITE_USUARIOS_TESTE'
      | 'ML_USUARIO_TESTE_DUPLICADO',
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TestUserGuardError';
  }
}

/**
 * Persistence for the minted records.
 *
 * ⚠️ There is deliberately NO read-one-by-role member. Reuse is decided from
 * {@link list} through `reutilizavel`, because a lookup keyed on the bare role
 * doc id cannot see an account an additional mint wrote at
 * `${role}-${mlUserId}` — which is precisely how a pair bootstrap came to
 * re-mint a buyer that already existed. One read, one source of truth.
 *
 * ⚠️ Two writers with different guarantees, deliberately. {@link put} is the
 * pair bootstrap's idempotent full write at the ROLE's fixed doc id — reached
 * only after `reutilizavel` found nothing, so re-running it re-writes identical
 * content. {@link create} is the additional mint's, at an explicit id, and it
 * REFUSES a doc that already exists. Do not collapse them: `put` overwriting is
 * what makes a partial re-run safe, and `create` refusing is what stops an
 * additional mint from destroying an unrecoverable password.
 */
export interface TestUserStore {
  /** Write a record at the role's fixed doc id, overwriting. */
  put(record: UsuarioTesteMercadoLivre): Promise<void>;
  /**
   * Write at an EXPLICIT doc id, refusing if the document already exists.
   * Throws {@link TestUserGuardError} `ML_USUARIO_TESTE_DUPLICADO` on collision.
   */
  create(docId: string, record: UsuarioTesteMercadoLivre): Promise<void>;
  /** Every stored record, for the read-back route. */
  list(): Promise<UsuarioTesteMercadoLivre[]>;
}

/**
 * How a run treats a role that is already stored.
 *
 *  - `reaproveitar` — reuse it and mint nothing (rule 2). The pair bootstrap.
 *  - `novo` — mint a fresh account regardless, under `${role}-${mlUserId}`.
 */
export type CriarUsuariosTesteModo = 'reaproveitar' | 'novo';

export interface CriarUsuariosTesteDeps {
  readonly api: Pick<MercadoLivreApi, 'criarUsuarioTeste' | 'getMe'>;
  readonly store: TestUserStore;
  /** Only `deleteAll` is used — the bootstrap conta's credential. */
  readonly tokens: Pick<TokenDuravelStore, 'deleteAll'>;
  readonly siteId?: string;
  readonly now?: () => number;
  /**
   * Roles to mint on this run, in order. Default {@link ROLES_A_CRIAR} — the
   * pair. An additional mint passes exactly one.
   */
  readonly roles?: readonly UsuarioTesteRole[];
  /** See {@link CriarUsuariosTesteModo}. Default `reaproveitar`. */
  readonly modo?: CriarUsuariosTesteModo;
  /**
   * Revoke the bootstrap conta's credential once every record is durable.
   *
   * ⚠️ Defaults to **true**, and every caller that wants it off must say so.
   * An absent value disabling a security step is #1059's shape; here it would
   * silently leave a real seller account wired to the ERP.
   */
  readonly revogarCredencial?: boolean;
}

export interface CriarUsuariosTesteResult {
  /** The records this run produced — reused ones included, seller first. */
  readonly usuarios: readonly UsuarioTesteMercadoLivre[];
  /** Roles minted on THIS run — the ones that consumed a slot. */
  readonly criados: readonly UsuarioTesteRole[];
  /** Roles that were already stored and were reused instead of re-minted. */
  readonly reaproveitados: readonly UsuarioTesteRole[];
  /** Credential docs deleted from the bootstrap conta. */
  readonly credenciaisRemovidas: number;
  /**
   * Whether the credential was revoked at all.
   *
   * ⚠️ Reported separately because `credenciaisRemovidas === 0` is ambiguous:
   * it is also what a revocation against an already-empty subcollection returns.
   * The UI has to tell "we left this conta connected" from "there was nothing
   * left to delete", and only this flag does.
   */
  readonly credencialRevogada: boolean;
  /** Who minted them — the conta that is now disconnected. */
  readonly conta: { readonly id: number; readonly nickname: string | null };
}

/**
 * Doc id for an ADDITIONAL mint — never the bare role, which the pair bootstrap
 * owns and whose stored password an overwrite would destroy.
 *
 * Derived from ML's own response, so it is unique by construction (ML user ids
 * are), needs no read to compute, and has no race to lose.
 */
export function docIdAdicional(role: UsuarioTesteRole, mlUserId: number): string {
  return `${role}-${String(mlUserId)}`;
}

/**
 * The stored record a `reaproveitar` run should reuse for `role` — newest first.
 *
 * ⚠️ Matches on the record's **`role` FIELD**, not on the doc id. Looking it up
 * by the bare role doc id (what this did first) cannot see an account an
 * additional mint wrote at `${role}-${mlUserId}`, so a pair bootstrap run after
 * a "Novo comprador" read null, minted a redundant buyer, and spent one of the
 * ten permanent slots on an account the operator already had. That path is
 * reachable from the panel: with one buyer and no seller the pair button is
 * (correctly) enabled, and on a fresh integração the additional mint can be the
 * FIRST click.
 *
 * Newest-first because that is the account the operator is working with — it is
 * the one the panel badges "Mais recente".
 */
export function reutilizavel(
  registrados: readonly UsuarioTesteMercadoLivre[],
  role: UsuarioTesteRole,
): UsuarioTesteMercadoLivre | null {
  const candidatos = registrados.filter((u) => u.role === role);
  if (candidatos.length === 0) return null;
  return candidatos.reduce((a, b) => ((b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a));
}

/**
 * Mint (or reuse) test users, then revoke the bootstrap credential.
 *
 * Throws {@link TestUserGuardError} in two cases, BOTH before anything is
 * minted:
 *
 *  - the conta is itself a test user (`ML_CONTA_JA_E_TESTE`). ML's test users
 *    cannot mint test users, and reaching this point with one connected means
 *    the operator selected the wrong conta — the failure mode worth catching,
 *    since the next step wipes that conta's credential.
 *  - ten records are already stored (`ML_LIMITE_USUARIOS_TESTE`). See the ⚠️ in
 *    the module header for why that number is a floor rather than the truth.
 */
export async function criarUsuariosTeste(
  deps: CriarUsuariosTesteDeps,
): Promise<CriarUsuariosTesteResult> {
  const siteId = deps.siteId ?? SITE_ID_PADRAO;
  const now = deps.now ?? Date.now;
  const roles = deps.roles ?? ROLES_A_CRIAR;
  const modo = deps.modo ?? 'reaproveitar';
  // ⚠️ `?? true`, not `=== true`: an absent flag must REVOKE. See the field's doc.
  const revogar = deps.revogarCredencial ?? true;

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

  // ⚠️ Also before any mint. `registrados` is what WE stored, which is a FLOOR
  // on the slots this real account has spent — ML lists nothing, so an eleventh
  // mint is refused here or nowhere. Refusing a request ML would reject anyway
  // costs nothing; not refusing one it would ACCEPT is the cost of the floor
  // being a floor, and the message says so rather than pretending otherwise.
  const registrados = await deps.store.list();

  const usuarios: UsuarioTesteMercadoLivre[] = [];
  const criados: UsuarioTesteRole[] = [];
  const reaproveitados: UsuarioTesteRole[] = [];

  for (const role of roles) {
    if (modo === 'reaproveitar') {
      const existente = reutilizavel(registrados, role);
      if (existente) {
        // Rule 2: never re-mint what we already hold. A retry after a partial
        // failure must cost zero slots.
        usuarios.push(existente);
        reaproveitados.push(role);
        continue;
      }
    }

    // ⚠️ Checked HERE, not once before the loop. The pre-loop version could not
    // know how many mints the run would do: at nine stored records a pair
    // bootstrap passed it and then minted twice, ending at eleven. Counting
    // `criados` makes the bound hold per mint instead of per call.
    //
    // A consequence worth having: a run that reuses everything mints nothing,
    // so it is no longer refused at the cap. Refusing a zero-cost re-run was
    // never the point — spending an eleventh slot is.
    if (registrados.length + criados.length >= USUARIO_TESTE_LIMITE_POR_CONTA) {
      const total = registrados.length + criados.length;
      throw new TestUserGuardError(
        'ML_LIMITE_USUARIOS_TESTE',
        409,
        `Esta integração já tem ${String(total)} usuários de teste registrados, ` +
          `e o Mercado Livre permite ${String(USUARIO_TESTE_LIMITE_POR_CONTA)} por conta real — ` +
          'um limite permanente, sem nenhum endpoint que liste o que já foi criado. ' +
          'Uma vaga só volta a existir depois de 60 dias sem atividade na conta de teste.',
        { registrados: total, limite: USUARIO_TESTE_LIMITE_POR_CONTA },
      );
    }

    const minted = await deps.api.criarUsuarioTeste(siteId);
    const record = toRecord(minted, role, siteId, now(), me.id);
    // Rule 1: persist BEFORE anything else — the next mint, the revocation, the
    // response. Anything between the ML response and this write is a window in
    // which a slot is spent and the credential lost.
    if (modo === 'novo') {
      // `create` at a response-derived id: it cannot collide with the pair
      // bootstrap's role doc, and if it somehow did it FAILS instead of
      // overwriting a password nothing can reissue.
      await deps.store.create(docIdAdicional(role, minted.id), record);
    } else {
      await deps.store.put(record);
    }
    usuarios.push(record);
    criados.push(role);
  }

  // Rule 3: every record is durable — only now is it safe to lose the token
  // that created them. ⚠️ Still the LAST statement when it runs, and skipped
  // whole when the caller opted out; there is no ordering in which a credential
  // dies before the account it minted is on disk.
  const credenciaisRemovidas = revogar ? await deps.tokens.deleteAll() : 0;

  return {
    usuarios,
    criados,
    reaproveitados,
    credenciaisRemovidas,
    credencialRevogada: revogar,
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
