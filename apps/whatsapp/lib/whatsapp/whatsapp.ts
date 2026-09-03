/**
 * Resolve an `integracao` WhatsApp account into a ready-to-use server context:
 * the parsed account doc, the single-token permanent-token store (over the
 * admin-only `integracao/{id}/credenciaisWhatsapp` subcollection), and the
 * helpers the routes drive — `hasToken()` / `resolveToken()`, `buildClient()`
 * (a `WhatsAppClient` for the outbound sender, #529), and a live Graph
 * phone-number lookup. Mirrors apps/mercado-pago/lib/payments/mercadoPago.ts,
 * adapted to the WhatsApp (integracao) domain and dropping the OAuth flow —
 * the WhatsApp Cloud API token is a long-lived Meta Graph token, so there is
 * no consent URL / code exchange / refresh here.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';
import {
  DEFAULT_GRAPH_API_VERSION,
  GRAPH_BASE,
  WhatsAppClient,
} from '@delfrance/integrations-whatsapp-cloud-api';

import { readWhatsappConta } from './contaCache';
import { type CredentialStore, createCredentialStore } from './credentialStore';

/** The account doc is missing, not a WhatsApp tipo, or has no phone number id. */
export class WhatsappContaNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsappContaNotConfiguredError';
  }
}

/**
 * Server is misconfigured. Kept for parity with the marketplace backends (where
 * it flags missing app-wide OAuth credentials); WhatsApp has no app-wide OAuth
 * config, but the inbound webhook (#527) will throw this when its
 * `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` are absent. Maps to HTTP 500.
 */
export class WhatsappConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsappConfigError';
  }
}

/** No permanent token stored for this account — it must be (re)connected. */
export class WhatsappTokenMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsappTokenMissingError';
  }
}

/** The stored permanent token was rejected by Graph (401 / error code 190). */
export class WhatsappTokenInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsappTokenInvalidError';
  }
}

/** A non-auth Graph failure (unexpected HTTP status). Carries the upstream code. */
export class WhatsappGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WhatsappGraphError';
  }
}

/** The connected number's identity as returned by the Graph phone-number node. */
export interface WhatsappPhoneInfo {
  readonly display_phone_number: string | null;
  readonly verified_name: string | null;
}

/** Graph error code for an invalid/expired OAuth access token. */
const GRAPH_INVALID_TOKEN_CODE = 190;

/**
 * Live phone-number lookup against the Meta Graph API — the `conta` route's
 * "is this token still good?" probe. `fetch` is injectable for tests. A 401 (or
 * a Graph `error.code` of 190) means the token is dead → `WhatsappTokenInvalidError`
 * (the route renders the disconnected state); any other non-OK status is an
 * upstream `WhatsappGraphError`.
 */
export async function fetchWhatsappPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  opts: { fetch?: typeof fetch; graphApiVersion?: string } = {},
): Promise<WhatsappPhoneInfo> {
  const fetcher = opts.fetch ?? fetch;
  const version = opts.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const res = await fetcher(
    `${GRAPH_BASE}/${version}/${phoneNumberId}?fields=display_phone_number,verified_name`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const raw = await res.text();
    let code: number | undefined;
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: number } };
      code = parsed.error?.code;
    } catch (err) {
      // Non-JSON error body — leave `code` undefined and fall through.
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (res.status === 401 || code === GRAPH_INVALID_TOKEN_CODE) {
      throw new WhatsappTokenInvalidError(
        `Token WhatsApp inválido ou expirado (HTTP ${res.status}${
          code != null ? `, code ${code}` : ''
        }).`,
      );
    }
    throw new WhatsappGraphError(
      `Consulta ao número WhatsApp falhou (HTTP ${res.status}): ${raw}`,
      res.status,
    );
  }
  const json = (await res.json()) as {
    display_phone_number?: string;
    verified_name?: string;
  };
  return {
    display_phone_number: json.display_phone_number ?? null,
    verified_name: json.verified_name ?? null,
  };
}

export interface WhatsappContext {
  readonly integracaoId: string;
  /** The parsed `integracao` account doc (extra fields ride through). */
  readonly conta: Integracao;
  readonly store: CredentialStore;
  /**
   * The Graph phone number id to send from — `conta.phoneNumberId` ONLY. Throws
   * `WhatsappContaNotConfiguredError` when it is null (the número was never
   * filled in). Does NOT fall back to `wa_id`: per the `integracaoSchema`
   * contract, legacy `wa_id` carries the webhook `metadata.phone_number_id`
   * (inbound account RESOLUTION only) — it is never the id legacy hands to
   * Graph API calls, and legacy `getPhoneNumberId()` never falls back either.
   */
  phoneNumberId(): string;
  /** Whether a permanent token is stored for this account. */
  hasToken(): Promise<boolean>;
  /**
   * The stored permanent token. Throws `WhatsappTokenMissingError` when the
   * account was never connected.
   */
  resolveToken(): Promise<string>;
  /** A `WhatsAppClient` bound to this account's number + token (#529 sender). */
  buildClient(): Promise<WhatsAppClient>;
}

export async function loadWhatsappContext(
  db: Firestore,
  integracaoId: string,
): Promise<WhatsappContext> {
  // The cached reader replaces the READ, not the contract — both throws below
  // are unchanged, and a `null` stands in for `!snap.exists`. See
  // `contaCache.ts` for why the cache is a separate module.
  const conta = await readWhatsappConta(db, integracaoId);
  if (conta == null) {
    throw new WhatsappContaNotConfiguredError(`Integração ${integracaoId} não encontrada.`);
  }
  if (conta.tipo !== INTEGRACAO_TIPO.whatsapp) {
    throw new WhatsappContaNotConfiguredError(`Integração ${integracaoId} não é do tipo WhatsApp.`);
  }

  const store = createCredentialStore(db, integracaoId);

  // The sending number is `conta.phoneNumberId` ONLY — never a `wa_id` fallback.
  // Legacy `getPhoneNumberId()` throws when `phoneNumberId` is null and does NOT
  // fall back to `wa_id` (`.old/packages/canais_de_venda/whatsapp_cloud_api/lib/
  // src/api_v23/api.dart:86-102`). `wa_id` exists for inbound webhook account
  // RESOLUTION (it carries `metadata.phone_number_id` per the integracaoSchema
  // contract) — it is not the id legacy passes to Graph calls, so a fallback
  // here would encode the wrong semantics.
  const phoneNumberId = (): string => {
    const id = conta.phoneNumberId;
    if (!id) {
      throw new WhatsappContaNotConfiguredError(
        `Integração ${integracaoId} sem phoneNumberId — número não configurado.`,
      );
    }
    return id;
  };

  const resolveToken = async (): Promise<string> => {
    const cred = await store.load();
    if (!cred) {
      throw new WhatsappTokenMissingError(
        'Conta WhatsApp não conectada. Cadastre o token permanente primeiro.',
      );
    }
    return cred.permanent_token;
  };

  return {
    integracaoId,
    conta,
    store,
    phoneNumberId,
    resolveToken,
    async hasToken(): Promise<boolean> {
      return (await store.load()) !== null;
    },
    async buildClient(): Promise<WhatsAppClient> {
      const accessToken = await resolveToken();
      return new WhatsAppClient({ phoneNumberId: phoneNumberId(), accessToken });
    },
  };
}
