import {
  CODIGO_ERRO_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  motivoRecusaLinkSchema,
} from '@delfrance/schemas';

import {
  MercadoPagoClientHttpError,
  MercadoPagoClientNetworkError,
  MercadoPagoClientRespostaInvalidaError,
  MercadoPagoClientSessaoError,
} from '@/lib/mercado-pago/client';

/**
 * A failed payment-link call (`criarLinks` / `cancelarLink` / `sincronizarLinks`)
 * as operator copy (#367).
 *
 * The shape is exactly what `showErrorNotification` takes, so the caller passes the
 * result straight through — `link` renders under the message and is how the
 * reauth arm sends the operator to the account page.
 */
export interface FalhaLinkDescrita {
  title: string;
  message: string;
  link?: { href: string; label: string };
}

export interface ContextoFalhaLink {
  /** The account the call ran against — the reconnect link needs it. */
  metodoId: string | null;
  /**
   * `PERM.metodoPagamento.write`. Reconnecting on `/pagamentos/mercado-pago/<id>`
   * needs it, and the tab's own gate (`pedido.write | pagamento.write`) does NOT
   * imply it, so a sales operator would otherwise be sent to a page whose
   * "Conectar" button is disabled.
   */
  podeReconectar: boolean;
}

/** `respond.ts` of `apps/mercado-pago`: the stored grant is dead, OAuth must be redone. */
const CODIGO_REAUTH = 'MP_REAUTH_REQUIRED';

/**
 * Turn a failed link call into a notification, or `null` when the failure is not
 * one of this client's — which makes the CALLER rethrow (root `CLAUDE.md` rule 6:
 * a `TypeError` from a bug must surface, not become a toast).
 *
 * ⚠️ Total over every error CLASS this client throws, so a known failure is never
 * rethrown as an unhandled rejection: every `MercadoPagoClientHttpError` ends in
 * the catch-all arm carrying the backend's own message (a 401 expired token, a
 * 500, a 400 body-validation refusal all land there).
 *
 * ⚠️ The order matters twice:
 *  - `MercadoPagoClientRespostaInvalidaError` and `MercadoPagoClientSessaoError`
 *    are SUBCLASSES of the HTTP error, so they are tested first or they would be
 *    described as an HTTP failure.
 *  - `code` is read BEFORE `status` for the 404s: `MP_CONTA_NAO_CONFIGURADA` is a
 *    real answer about the account, while a 404 with NO code is Next's own HTML
 *    404 — a web build that shipped before the backend route did — and telling
 *    the operator the ACCOUNT is misconfigured would send them to fix the wrong
 *    thing.
 */
export function descreverFalhaLink(err: unknown, ctx: ContextoFalhaLink): FalhaLinkDescrita | null {
  if (err instanceof MercadoPagoClientRespostaInvalidaError) {
    return { title: 'Resposta inesperada do Mercado Pago', message: err.message };
  }
  if (err instanceof MercadoPagoClientSessaoError) {
    return {
      title: 'Sessão expirada',
      message: 'Sua sessão expirou. Entre novamente e tente de novo.',
    };
  }
  if (err instanceof MercadoPagoClientHttpError) return descreverFalhaHttp(err, ctx);
  if (err instanceof MercadoPagoClientNetworkError) {
    return {
      title: 'Sem conexão',
      message: 'Sem conexão com o backend do Mercado Pago. Tente de novo.',
    };
  }
  return null;
}

function descreverFalhaHttp(
  err: MercadoPagoClientHttpError,
  ctx: ContextoFalhaLink,
): FalhaLinkDescrita {
  if (err.code === CODIGO_REAUTH) {
    const titulo = 'Conta Mercado Pago desconectada';
    if (ctx.podeReconectar && ctx.metodoId) {
      return {
        title: titulo,
        message: 'Reconecte a conta para continuar.',
        link: {
          href: `/pagamentos/mercado-pago/${encodeURIComponent(ctx.metodoId)}`,
          label: 'Reconectar conta',
        },
      };
    }
    return {
      title: titulo,
      message: 'Peça a quem administra os meios de pagamento para reconectar a conta.',
    };
  }

  if (err.code === CODIGO_ERRO_LINK.naoElegivel) {
    // The label table is keyed by the enum, so an unknown `reason` (a backend
    // newer than this tab) must not index it: it falls through to the backend's
    // own message, which is already the same sentence.
    const motivo = motivoRecusaLinkSchema.safeParse(err.reason);
    if (motivo.success) {
      return { title: 'Operação não permitida', message: MOTIVO_RECUSA_LINK_LABELS[motivo.data] };
    }
  }

  if (err.code === CODIGO_ERRO_LINK.contaNaoConfigurada) {
    return {
      title: 'Conta Mercado Pago inválida',
      message: 'A conta escolhida não está configurada como Mercado Pago.',
    };
  }

  if (err.status === 404 && err.code === null) {
    return {
      title: 'Backend do Mercado Pago desatualizado',
      message: 'O backend do Mercado Pago está desatualizado (rota não encontrada).',
    };
  }

  if (err.status === 403) {
    return {
      title: 'Sem permissão',
      message: 'Sem permissão para gerenciar links de pagamento.',
    };
  }

  if (err.status === 429) {
    return {
      title: 'Aguarde um instante',
      message: 'Aguarde um minuto antes de sincronizar novamente.',
    };
  }

  if (err.status === 502 || err.status === 503) {
    return {
      title: 'Falha no Mercado Pago',
      message: `O Mercado Pago não respondeu como esperado: ${err.message}`,
    };
  }

  return { title: 'Falha ao falar com o Mercado Pago', message: err.message };
}
