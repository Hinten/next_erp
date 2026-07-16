'use client';

/**
 * `useWhatsappClient()` — a memoized typed client bound to the current
 * Firebase auth state, talking to the WhatsApp Cloud API channel host (its
 * own App Hosting backend, #527/#529). Mirrors `useMercadoPagoClient`
 * (lib/mercado-pago/client.ts): returns `null` while logged out so
 * components can disable their buttons, and passes `() => user.getIdToken()`
 * so token refreshes propagate.
 *
 * Unlike the OAuth channels (Mercado Livre, Mercado Pago, Melhor Envio), the
 * WhatsApp Cloud API has no OAuth flow — the operator pastes a long-lived
 * "permanent token" generated in Meta's app dashboard. `setToken`/`revokeToken`
 * POST/DELETE it to the backend, which stores it in the admin-only
 * `credenciaisWhatsapp` subcollection (`packages/schemas/src/integracao.ts`).
 * The browser sends the token once over HTTPS and never reads it back —
 * `conta()` only returns the connected number's public identity.
 *
 * The client is defined here (not in `@delfrance/integrations-whatsapp-cloud-api`)
 * on purpose, mirroring the other channel clients: the browser bundle must
 * never pull in server-only credential-handling code.
 */
import { useMemo } from 'react';

import { useAuth } from '@/lib/auth/useAuth';

const DEFAULT_WHATSAPP_URL = 'http://localhost:3008';

/** Non-2xx response from the whatsapp backend. */
export class WhatsappClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Optional machine code from the backend (e.g. WA_INVALID_TOKEN). */
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'WhatsappClientHttpError';
  }
}

/** Network-level failure reaching the whatsapp backend. */
export class WhatsappClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WhatsappClientNetworkError';
  }
}

/**
 * The account connection status as returned by `GET /api/whatsapp/conta`
 * (`apps/whatsapp`). `hasToken` is ALWAYS present and distinguishes "no
 * credential yet" (`false`) from "credential stored but not live" (`true` with
 * `connected: false` — a dead/expired token, or a token stored before the
 * número was filled in, signalled by `reason: 'numero_nao_configurado'`).
 * `phone` (the Graph phone-number node fields — `WhatsappPhoneInfo`,
 * `apps/whatsapp/lib/whatsapp/whatsapp.ts`) is present only when `connected`;
 * it stays snake_case to match the wire response exactly rather than relabeling.
 */
export interface WhatsappConta {
  connected: boolean;
  hasToken: boolean;
  /** Why a stored credential is not live — currently only the número gap. */
  reason?: 'numero_nao_configurado';
  phone: { display_phone_number: string | null; verified_name: string | null } | null;
}

/** One check row of the account-health response (`GET /api/whatsapp/health`). */
export interface WhatsappHealthCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  label: string;
  detail: string | null;
  hint: string | null;
}

/**
 * The account-health aggregation as returned by `GET /api/whatsapp/health`
 * (`apps/whatsapp/lib/whatsapp/health.ts`). `canReceive` is tri-state: `null`
 * when it can't be determined (e.g. no WABA id to check the subscription).
 */
export interface WhatsappHealth {
  generatedAt: number;
  canSend: boolean;
  canReceive: boolean | null;
  checks: WhatsappHealthCheck[];
}

export interface WhatsappClient {
  /** Connection status: the Cloud API phone-number identity or `connected: false`. */
  conta(integracaoId: string): Promise<WhatsappConta>;
  /**
   * Store (or replace) the account's permanent token (PERM.integracao.write).
   * The token is sent once in the request body over HTTPS; never returned by
   * `conta()` afterwards.
   */
  setToken(integracaoId: string, token: string): Promise<void>;
  /** Revoke the stored permanent token (PERM.integracao.write). */
  revokeToken(integracaoId: string): Promise<void>;
  /** Request a 6-digit verification code via SMS/VOICE (PERM.integracao.write). */
  requestCode(integracaoId: string, metodo: 'SMS' | 'VOICE'): Promise<void>;
  /** Confirm the 6-digit code; flags the account verified (PERM.integracao.write). */
  verifyCode(integracaoId: string, codigo: string): Promise<void>;
  /** Register the number with its 6-digit PIN (PERM.integracao.write). */
  registerNumber(integracaoId: string, pin: string): Promise<void>;
  /** Deregister the number, keeping the stored PIN (PERM.integracao.write). */
  deregisterNumber(integracaoId: string): Promise<void>;
  /** Account-health aggregation for the "Saúde da conta" card (PERM.integracao.read). */
  health(integracaoId: string): Promise<WhatsappHealth>;
}

export function createWhatsappClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): WhatsappClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new WhatsappClientNetworkError(
        err instanceof Error ? err.message : 'fetch falhou',
        err,
      );
    }

    let parsed: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) parsed = { error: text };
        else throw err;
      }
    }

    if (!res.ok) {
      const errBody = parsed as { error?: string; code?: string } | null;
      throw new WhatsappClientHttpError(
        errBody?.error ?? `HTTP ${res.status}`,
        res.status,
        errBody?.code ?? null,
      );
    }
    return parsed as T;
  }

  return {
    conta: (integracaoId) =>
      call<WhatsappConta>(
        'GET',
        `/api/whatsapp/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
    setToken: async (integracaoId, token) => {
      await call<{ ok: boolean }>('POST', '/api/whatsapp/token', { integracaoId, token });
    },
    revokeToken: async (integracaoId) => {
      await call<{ ok: boolean }>(
        'DELETE',
        `/api/whatsapp/token?integracaoId=${encodeURIComponent(integracaoId)}`,
      );
    },
    requestCode: async (integracaoId, metodo) => {
      await call<{ ok: boolean }>('POST', '/api/whatsapp/verificacao/solicitar', {
        integracaoId,
        metodo,
      });
    },
    verifyCode: async (integracaoId, codigo) => {
      await call<{ ok: boolean }>('POST', '/api/whatsapp/verificacao/confirmar', {
        integracaoId,
        codigo,
      });
    },
    registerNumber: async (integracaoId, pin) => {
      await call<{ ok: boolean }>('POST', '/api/whatsapp/registro', { integracaoId, pin });
    },
    deregisterNumber: async (integracaoId) => {
      await call<{ ok: boolean }>(
        'DELETE',
        `/api/whatsapp/registro?integracaoId=${encodeURIComponent(integracaoId)}`,
      );
    },
    health: (integracaoId) =>
      call<WhatsappHealth>(
        'GET',
        `/api/whatsapp/health?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
  };
}

export function useWhatsappClient(): WhatsappClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_WHATSAPP_URL ?? DEFAULT_WHATSAPP_URL;
    return createWhatsappClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
