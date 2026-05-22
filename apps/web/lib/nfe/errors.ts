/**
 * Map NF-e HTTP-client outcomes (success + typed errors) to Mantine
 * notification shapes — title, message, color — in PT-BR. The UI
 * layer pipes the result of `notificationForNFeResult` or
 * `notificationForNFeError` straight into `notifications.show(...)`.
 *
 * Kept separate from the React component so the mapping can be unit
 * tested without a DOM.
 */
import {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  type NFeEmitResult,
} from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE } from '@delfrance/schemas';

export interface NotificationShape {
  readonly title: string;
  readonly message: string;
  readonly color: 'green' | 'blue' | 'yellow' | 'red' | 'gray';
}

/**
 * Map a successful `emitir` result to a notification. The orchestrator
 * returns `estado='rejeitada'` with HTTP 422, which the HTTP client
 * raises as `NFeRejectedError` — so this function only sees the
 * happy-ish paths (`aprovada` / `enviando` / `aguardandoResposta`).
 * Includes a defensive default for any unexpected estado.
 */
export function notificationForNFeResult(
  result: NFeEmitResult,
): NotificationShape {
  if (result.estado === ESTADO_NFE.aprovada) {
    const protocol = result.nRec ?? result.chave.slice(-15);
    return {
      title: 'NF-e autorizada',
      message: `Protocolo ${protocol} — cStat=${result.cStat} ${result.xMotivo}`,
      color: 'green',
    };
  }
  if (
    result.estado === ESTADO_NFE.enviando ||
    result.estado === ESTADO_NFE.aguardandoResposta
  ) {
    return {
      title: 'NF-e em processamento',
      message: `Lote enviado a SEFAZ; aguardando protocolo (cStat=${result.cStat} ${result.xMotivo}).`,
      color: 'blue',
    };
  }
  if (result.estado === ESTADO_NFE.rejeitada) {
    return {
      title: 'NF-e rejeitada',
      message: `cStat=${result.cStat}: ${result.xMotivo}`,
      color: 'red',
    };
  }
  return {
    title: 'NF-e enviada',
    message: `Estado: ${result.estado} (cStat=${result.cStat} ${result.xMotivo}).`,
    color: 'gray',
  };
}

/**
 * Map a thrown error from `client.emitir(...)` to a notification.
 * Narrows via `instanceof` on the typed error classes exported from
 * `@delfrance/integrations-nfe`. Returns a generic fallback for
 * anything that doesn't match.
 */
export function notificationForNFeError(err: unknown): NotificationShape {
  if (err instanceof NFeRejectedError) {
    return {
      title: 'SEFAZ rejeitou a NF-e',
      message: `cStat=${err.cStat}: ${err.xMotivo}`,
      color: 'red',
    };
  }
  if (err instanceof NFeBlockedError) {
    return {
      title: 'Pedido bloqueado',
      message: 'A emissão de NF-e está bloqueada para este pedido (campo bloquearEmissaoNFe).',
      color: 'yellow',
    };
  }
  if (err instanceof NFePedidoNotFoundError) {
    return {
      title: 'Pedido não encontrado',
      message: `O pedido ${err.pedidoId} não foi encontrado pelo servidor de NF-e.`,
      color: 'red',
    };
  }
  if (err instanceof NFeAuthError) {
    return {
      title: 'Sessão inválida',
      message: 'Faça login novamente para emitir NF-e.',
      color: 'red',
    };
  }
  if (err instanceof NFeRuntimeNotReadyError) {
    return {
      title: 'Servidor NF-e indisponível',
      message:
        'O serviço de emissão não está pronto (certificado, chain TLS ou runtime). ' +
        'Tente novamente em alguns instantes.',
      color: 'red',
    };
  }
  if (err instanceof NFeBadRequestError) {
    return {
      title: 'Requisição inválida',
      message: err.message,
      color: 'red',
    };
  }
  if (err instanceof NFeNetworkError) {
    return {
      title: 'Erro de rede',
      message: 'Não foi possível alcançar o servidor de NF-e. Verifique a conexão e tente novamente.',
      color: 'red',
    };
  }
  if (err instanceof NFeServerError) {
    return {
      title: 'Erro no servidor de NF-e',
      message: err.message,
      color: 'red',
    };
  }
  return {
    title: 'Erro inesperado',
    message: err instanceof Error ? err.message : 'Falha desconhecida ao emitir NF-e.',
    color: 'red',
  };
}
