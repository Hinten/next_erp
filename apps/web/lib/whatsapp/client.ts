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
import { z } from 'zod';

import { envelopeDeErro, lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

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

/**
 * The backend answered 2xx and the body was not the shape this app claims — the
 * wrong fields, no body at all, or not JSON.
 *
 * ⚠️ Nothing here describes what WE send: it is a browser-side `Error` that
 * never leaves the tab, and `status` records the 2xx the backend sent US.
 *
 * ⚠️ A SUBCLASS of `WhatsappClientHttpError`, matching the ML client: the conta
 * panel narrows to that class and rethrows anything else, so a sibling would
 * land as an unhandled rejection instead of a message.
 */
export class WhatsappClientRespostaInvalidaError extends WhatsappClientHttpError {
  constructor(
    message: string,
    status: number,
    /** Field PATHS that failed, never values. */
    readonly campos: string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA');
    this.name = 'WhatsappClientRespostaInvalidaError';
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
export const contaSchema = z.object({
  connected: z.boolean(),
  hasToken: z.boolean(),
  /** Why a stored credential is not live — currently only the número gap. */
  reason: z.literal('numero_nao_configurado').optional(),
  phone: z
    .object({
      display_phone_number: z.string().nullable(),
      verified_name: z.string().nullable(),
    })
    .nullable(),
});
export type WhatsappConta = z.infer<typeof contaSchema>;

/** One check row of the account-health response (`GET /api/whatsapp/health`). */
export const healthCheckSchema = z.object({
  id: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'skip']),
  label: z.string(),
  detail: z.string().nullable(),
  hint: z.string().nullable(),
});
export type WhatsappHealthCheck = z.infer<typeof healthCheckSchema>;

/**
 * The account-health aggregation as returned by `GET /api/whatsapp/health`
 * (`apps/whatsapp/lib/whatsapp/health.ts`). `canReceive` is tri-state: `null`
 * when it can't be determined (e.g. no WABA id to check the subscription).
 */
export const healthSchema = z.object({
  generatedAt: z.number(),
  canSend: z.boolean(),
  canReceive: z.boolean().nullable(),
  checks: z.array(healthCheckSchema).default([]),
});
export type WhatsappHealth = z.infer<typeof healthSchema>;

/**
 * ⚠️ Six of the nine methods `await call(...)` and THROW THE BODY AWAY — the
 * "did it work?" signal is the absence of a throw. That made them the quietest
 * call sites in the repo: an empty body, an HTML body and a real `{ ok }` were
 * all indistinguishable from success. Validating them costs nothing, because
 * nothing downstream reads the value.
 */
export const okSchema = z.object({ ok: z.boolean() });

export const templateMessageSchema = z.object({
  ok: z.boolean(),
  messageId: z.string().optional(),
});

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
  /**
   * Send the standard "reabertura de conversa" template message for a WhatsApp
   * conversa (PERM.chat.write). The backend sends the approved template via the
   * Cloud API, then writes the outbound `mensagem` doc (send-then-write). The
   * thread picks up the new message via its live snapshot; the resolved `wamid`
   * is returned for reference.
   */
  templateMessage(conversaId: string): Promise<{ ok: boolean; messageId?: string }>;
}

/**
 * Log a body the operator will never see, capped so a whole HTML document
 * cannot flood the console.
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(
    `[whatsapp] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, 500),
  );
}

export function createWhatsappClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): WhatsappClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
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

    const text = await res.text();

    if (!res.ok) {
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          // ⚠️ The body used to become `{ error: text }`, so a proxy's whole HTML
          // document ended up verbatim in `err.message`. The ML client fixed this
          // in 3a4b7278; this one never got the same treatment.
          if (err instanceof SyntaxError) {
            logarCorpoNaoJson(path, res.status, text);
          } else throw err;
        }
      }
      const errBody = envelopeDeErro(parsed);
      throw new WhatsappClientHttpError(
        errBody?.error ?? `Falha na comunicação com o WhatsApp (HTTP ${String(res.status)}).`,
        res.status,
        errBody?.code ?? null,
      );
    }

    const leitura = lerRespostaJson(text, schema);
    if (leitura.ok) return leitura.data;

    if (leitura.motivo !== 'formato') {
      // ⚠️ EMPTY and NON-JSON share this branch: neither is version skew — in
      // both the request failed to reach a route that answers JSON, so neither
      // may tell the operator to deploy anything.
      logarCorpoNaoJson(
        path,
        res.status,
        leitura.motivo === 'nao-json' ? leitura.texto : '(corpo vazio)',
      );
      throw new WhatsappClientRespostaInvalidaError(
        `A integração com o WhatsApp respondeu HTTP ${String(res.status)} sem um corpo JSON — ` +
          'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o ' +
          'suporte.',
        res.status,
        [],
      );
    }

    throw new WhatsappClientRespostaInvalidaError(
      'O backend do WhatsApp respondeu num formato que este aplicativo não reconhece. ' +
        `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
        'backend e esta tela estão em versões diferentes — faça o deploy de `apps/whatsapp` e ' +
        'recarregue a página.',
      res.status,
      leitura.campos,
    );
  }

  return {
    conta: (integracaoId) =>
      call(
        'GET',
        `/api/whatsapp/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
        contaSchema,
      ),
    setToken: async (integracaoId, token) => {
      await call('POST', '/api/whatsapp/token', okSchema, { integracaoId, token });
    },
    revokeToken: async (integracaoId) => {
      await call(
        'DELETE',
        `/api/whatsapp/token?integracaoId=${encodeURIComponent(integracaoId)}`,
        okSchema,
      );
    },
    requestCode: async (integracaoId, metodo) => {
      await call('POST', '/api/whatsapp/verificacao/solicitar', okSchema, {
        integracaoId,
        metodo,
      });
    },
    verifyCode: async (integracaoId, codigo) => {
      await call('POST', '/api/whatsapp/verificacao/confirmar', okSchema, {
        integracaoId,
        codigo,
      });
    },
    registerNumber: async (integracaoId, pin) => {
      await call('POST', '/api/whatsapp/registro', okSchema, { integracaoId, pin });
    },
    deregisterNumber: async (integracaoId) => {
      await call(
        'DELETE',
        `/api/whatsapp/registro?integracaoId=${encodeURIComponent(integracaoId)}`,
        okSchema,
      );
    },
    health: (integracaoId) =>
      call(
        'GET',
        `/api/whatsapp/health?integracaoId=${encodeURIComponent(integracaoId)}`,
        healthSchema,
      ),
    templateMessage: (conversaId) =>
      call('POST', '/api/whatsapp/template-message', templateMessageSchema, {
        conversaId,
      }),
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
