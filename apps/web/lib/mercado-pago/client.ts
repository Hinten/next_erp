'use client';

/**
 * `useMercadoPagoClient()` — a memoized typed client bound to the current
 * Firebase auth state, talking to the mercado-pago payments backend's own
 * App Hosting deployment. Mirrors `useMercadoLivreClient`
 * (lib/mercado-livre/client.ts): returns `null` while logged out so
 * components can disable their buttons, and passes `() => user.getIdToken()`
 * so token refreshes propagate.
 *
 * The client is defined here (not in `@delfrance/integrations-mercado-pago`)
 * on purpose: that package's OAuth core handles the app clientSecret and must
 * never be bundled into the browser. The browser never sees a Mercado Pago
 * access/refresh token — the panel only ever reads the connected collector's
 * identity via `conta()`, and the pedido's "Link Pgto" tab (#367) only ever
 * receives the checkout URLs and ids that `criarLinks()` returns.
 */
import { useMemo } from 'react';
import { FirebaseError } from 'firebase/app';
import { z } from 'zod';

import { envelopeDeErro, lerRespostaJson, resumirCampos, wireInt } from '@delfrance/core/wire';
import {
  ROTA_LINK_PAGAMENTO,
  cancelarLinkPagamentoRespostaSchema,
  criarLinksPagamentoRespostaSchema,
  sincronizarLinksPagamentoRespostaSchema,
  type CancelarLinkPagamentoBody,
  type CancelarLinkPagamentoResposta,
  type CriarLinksPagamentoBody,
  type CriarLinksPagamentoResposta,
  type SincronizarLinksPagamentoBody,
  type SincronizarLinksPagamentoResposta,
} from '@delfrance/schemas';

import { useAuth } from '@/lib/auth/useAuth';

const DEFAULT_MERCADO_PAGO_URL = 'http://localhost:3007';

/** Non-2xx response from the mercado-pago backend. */
export class MercadoPagoClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Optional machine code from the backend (e.g. MP_REAUTH_REQUIRED). */
    readonly code: string | null,
    /**
     * Why a `LINK_NAO_ELEGIVEL` (409) refusal happened, in the vocabulary of
     * `MOTIVO_RECUSA_LINK` (#367). `null` on every other error — including a 409
     * from an older backend that sends no `reason`.
     *
     * ⚠️ A plain `string`, not the enum: this is a browser-side read of a
     * deployed backend that may be NEWER than this tab, so an unknown value must
     * survive as text instead of costing the whole error. The consumer
     * (`descreverFalhaLink`) narrows it.
     */
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = 'MercadoPagoClientHttpError';
  }
}

/**
 * The backend answered 2xx and the body was not the shape this app claims — the
 * wrong fields, no body at all, or not JSON.
 *
 * ⚠️ Nothing here describes what WE send: it is a browser-side `Error` that
 * never leaves the tab, and `status` records the 2xx the backend sent US.
 *
 * ⚠️ A SUBCLASS of `MercadoPagoClientHttpError`, matching the ML client for the
 * same reason — the panel narrows to that class and rethrows anything else, so a
 * sibling would land as an unhandled rejection instead of a message.
 */
export class MercadoPagoClientRespostaInvalidaError extends MercadoPagoClientHttpError {
  constructor(
    message: string,
    status: number,
    /** Field PATHS that failed, never values. */
    readonly campos: string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA');
    this.name = 'MercadoPagoClientRespostaInvalidaError';
  }
}

/** Network-level failure reaching the mercado-pago backend. */
export class MercadoPagoClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MercadoPagoClientNetworkError';
  }
}

/**
 * ⚠️ Schemas rather than interfaces, and the types are inferred from them —
 * one definition, so the runtime check and the type cannot disagree. They sit
 * in this file rather than a `wire.ts` (as the ML client has) only because
 * there are two of them; the rule is the same. The payment-link routes' request
 * and response schemas (#367) are NOT here: they are one contract shared with
 * `apps/mercado-pago`, declared once in `@delfrance/schemas`.
 *
 * Unknown keys pass (Zod strips by default, nothing is `.strict()`): apps/web
 * calls the DEPLOYED backend, so a newer one must not break an older tab.
 */
export const contaSchema = z.object({
  connected: z.boolean(),
  me: z
    .object({
      /** Mercado Pago's own collector id, forwarded verbatim — hence tolerant. */
      id: wireInt(),
      nickname: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
});
export type MercadoPagoConta = z.infer<typeof contaSchema>;

export const authorizeUrlSchema = z.object({ authorizeUrl: z.string() });

export interface MercadoPagoClient {
  /** Mint the MP consent URL for a metodo_pgto account (PERM.metodoPagamento.write). */
  oauthStart(metodoId: string): Promise<{ authorizeUrl: string }>;
  /** Connection status: `/users/me` identity or `connected: false`. */
  conta(metodoId: string): Promise<MercadoPagoConta>;
  /**
   * Create the payment link(s) of a pedido (#367). The link ids in the body are
   * minted by the caller, so re-sending the SAME body after a lost response
   * replays the batch instead of creating a second one (`reaproveitado`).
   */
  criarLinks(body: CriarLinksPagamentoBody): Promise<CriarLinksPagamentoResposta>;
  /** Withdraw one link of a pedido. */
  cancelarLink(body: CancelarLinkPagamentoBody): Promise<CancelarLinkPagamentoResposta>;
  /** Pull the pedido's payments from Mercado Pago and reconcile them. */
  sincronizarLinks(body: SincronizarLinksPagamentoBody): Promise<SincronizarLinksPagamentoResposta>;
}

/**
 * Log a body the operator will never see, capped so a whole HTML document
 * cannot flood the console.
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(
    `[mercado-pago] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, 500),
  );
}

/**
 * The `reason` of a refusal body (`LINK_NAO_ELEGIVEL`), which the shared
 * `envelopeDeErro` does not carry — it is specific to the link routes.
 *
 * ⚠️ Read through a schema rather than a cast: the body is untrusted, and a
 * `null` / non-string / array body must come out as "no reason", never as a
 * value the caller then indexes a label table with.
 */
const motivoDoErroSchema = z.object({ reason: z.string() });

function lerMotivoDoErro(parsed: unknown): string | null {
  const leitura = motivoDoErroSchema.safeParse(parsed);
  return leitura.success ? leitura.data.reason : null;
}

export function createMercadoPagoClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): MercadoPagoClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    let token: string;
    try {
      token = await config.getAuthToken();
    } catch (err) {
      // `user.getIdToken()` refreshes an expiring token over the NETWORK, so an
      // offline tab fails HERE (`auth/network-request-failed`) before any request
      // exists. It is the same situation as a failed fetch — nothing reached the
      // backend — and must read as one: the link tab keeps its minted ids only
      // across a network error, and a raw FirebaseError is none of this client's
      // classes, so the caller would rethrow it as an unhandled rejection.
      if (err instanceof FirebaseError) {
        throw new MercadoPagoClientNetworkError(err.message, err);
      }
      throw err;
    }
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          // ⚠️ Only WITH a body: a GET that announced a JSON payload it does not
          // carry is a malformed request some proxies reject.
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new MercadoPagoClientNetworkError(
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
          // document ended up verbatim in `err.message` and buried the real cause
          // behind a wall of markup. The ML client fixed this in 3a4b7278; this
          // one never got the same treatment.
          if (err instanceof SyntaxError) {
            logarCorpoNaoJson(path, res.status, text);
          } else throw err;
        }
      }
      const errBody = envelopeDeErro(parsed);
      throw new MercadoPagoClientHttpError(
        errBody?.error ?? `Falha na comunicação com o Mercado Pago (HTTP ${String(res.status)}).`,
        res.status,
        errBody?.code ?? null,
        lerMotivoDoErro(parsed),
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
      throw new MercadoPagoClientRespostaInvalidaError(
        `A integração com o Mercado Pago respondeu HTTP ${String(res.status)} sem um corpo ` +
          'JSON — o pedido não chegou à rota esperada. Atualize a página e, se continuar, ' +
          'avise o suporte.',
        res.status,
        [],
      );
    }

    throw new MercadoPagoClientRespostaInvalidaError(
      'O backend do Mercado Pago respondeu num formato que este aplicativo não reconhece. ' +
        `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
        'backend e esta tela estão em versões diferentes — faça o deploy de ' +
        '`apps/mercado-pago` e recarregue a página.',
      res.status,
      leitura.campos,
    );
  }

  return {
    oauthStart: (metodoId) =>
      call(
        'GET',
        `/api/payments/mercado-pago/oauth/start?metodoId=${encodeURIComponent(metodoId)}`,
        authorizeUrlSchema,
      ),
    conta: (metodoId) =>
      call(
        'GET',
        `/api/payments/mercado-pago/conta?metodoId=${encodeURIComponent(metodoId)}`,
        contaSchema,
      ),
    criarLinks: (body) =>
      call('POST', ROTA_LINK_PAGAMENTO.criar, criarLinksPagamentoRespostaSchema, body),
    cancelarLink: (body) =>
      call('POST', ROTA_LINK_PAGAMENTO.cancelar, cancelarLinkPagamentoRespostaSchema, body),
    sincronizarLinks: (body) =>
      call('POST', ROTA_LINK_PAGAMENTO.sincronizar, sincronizarLinksPagamentoRespostaSchema, body),
  };
}

export function useMercadoPagoClient(): MercadoPagoClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_MERCADO_PAGO_URL ?? DEFAULT_MERCADO_PAGO_URL;
    return createMercadoPagoClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
