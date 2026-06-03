/**
 * Unit tests for the NF-e notification mappers. Pure functions, no
 * DOM — testing the PT-BR mapping + color choice for every typed
 * error class + every estado.
 */
import { describe, expect, it } from 'vitest';

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

import {
  notificationForNFeError,
  notificationForNFeResult,
} from './errors';

function emitResult(over: Partial<NFeEmitResult> = {}): NFeEmitResult {
  return {
    nfeId: 'nfev4-001',
    pedidoId: 'PED-001',
    estado: ESTADO_NFE.aprovada,
    chave: '35260514200166000187550010000000071000000018',
    nRec: '12345',
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    ...over,
  };
}

describe('notificationForNFeResult', () => {
  it('maps estado=aprovada → green with protocol', () => {
    const n = notificationForNFeResult(emitResult());
    expect(n.color).toBe('green');
    expect(n.title).toBe('NF-e autorizada');
    expect(n.message).toContain('12345');
    expect(n.message).toContain('100');
  });

  it('falls back to last-15 of chave when nRec is null on aprovada', () => {
    const n = notificationForNFeResult(emitResult({ nRec: null }));
    expect(n.message).toContain('071000000018');
  });

  it('maps estado=enviando → blue', () => {
    const n = notificationForNFeResult(
      emitResult({ estado: ESTADO_NFE.enviando, cStat: '103', xMotivo: 'Lote recebido' }),
    );
    expect(n.color).toBe('blue');
    expect(n.title).toBe('NF-e em processamento');
  });

  it('maps estado=aguardandoResposta → blue', () => {
    const n = notificationForNFeResult(
      emitResult({ estado: ESTADO_NFE.aguardandoResposta, cStat: '105' }),
    );
    expect(n.color).toBe('blue');
  });

  it('maps estado=rejeitada → red (defensive — 422 normally throws NFeRejectedError)', () => {
    const n = notificationForNFeResult(
      emitResult({ estado: ESTADO_NFE.rejeitada, cStat: '226', xMotivo: 'UF inválida' }),
    );
    expect(n.color).toBe('red');
    expect(n.message).toContain('226');
    expect(n.message).toContain('UF inválida');
  });

  it('maps unknown estado → gray fallback', () => {
    const n = notificationForNFeResult(emitResult({ estado: '9' as never }));
    expect(n.color).toBe('gray');
    expect(n.title).toBe('NF-e enviada');
  });

  it('reused=true → yellow "já emitida" toast (dedup skip), overrides estado branch', () => {
    const n = notificationForNFeResult(emitResult({ reused: true }));
    expect(n.color).toBe('yellow');
    expect(n.title).toBe('NFe já emitida');
    expect(n.message).toContain('pulada');
    expect(n.message).toContain('100');
  });
});

describe('notificationForNFeError', () => {
  it('NFeRejectedError → red with cStat + xMotivo', () => {
    const err = new NFeRejectedError('226', 'UF inválida', { foo: 'bar' });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('SEFAZ rejeitou a NF-e');
    expect(n.message).toContain('226');
    expect(n.message).toContain('UF inválida');
  });

  it('NFeBlockedError → yellow', () => {
    const err = new NFeBlockedError('PED-001', { error: 'bloqueada' });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('yellow');
    expect(n.title).toBe('Pedido bloqueado');
  });

  it('NFePedidoNotFoundError → red carrying the pedidoId', () => {
    const err = new NFePedidoNotFoundError('PED-MISSING', { error: 'nope' });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.message).toContain('PED-MISSING');
  });

  it('NFeAuthError 401 → Sessão inválida, surfaces server message', () => {
    const err = new NFeAuthError('Token inválido ou expirado.', 401, {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Sessão inválida');
    expect(n.message).toBe('Token inválido ou expirado.');
  });

  it('NFeAuthError 403 → Sem permissão, surfaces server message', () => {
    const err = new NFeAuthError('Sem permissão para esta operação.', 403, {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Sem permissão');
    expect(n.message).toBe('Sem permissão para esta operação.');
  });

  it('NFeRuntimeNotReadyError → surfaces body.code as the message', () => {
    const err = new NFeRuntimeNotReadyError('NF-e runtime not ready', {
      error: 'NF-e runtime not ready',
      code: "Failed to read certificate file at '/some/path/cert.pfx'",
    });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Servidor NF-e indisponível');
    expect(n.message).toBe("Failed to read certificate file at '/some/path/cert.pfx'");
  });

  it('NFeRuntimeNotReadyError → falls back to generic message when body has no code', () => {
    const err = new NFeRuntimeNotReadyError('NF-e runtime not ready', {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Servidor NF-e indisponível');
    expect(n.message).toContain('certificado, chain TLS ou runtime');
  });

  it('NFeBadRequestError → red with the underlying message', () => {
    const err = new NFeBadRequestError('pedidoId deve ser uma string', {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Requisição inválida');
    expect(n.message).toBe('pedidoId deve ser uma string');
  });

  it('NFeNetworkError → red', () => {
    const err = new NFeNetworkError('Failed to fetch');
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro de rede');
  });

  it('NFeServerError → red with the underlying message', () => {
    const err = new NFeServerError('transport failed', 500, {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro no servidor de NF-e');
    expect(n.message).toBe('transport failed');
  });

  it('generic Error → red fallback', () => {
    const n = notificationForNFeError(new Error('algo deu errado'));
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro inesperado');
    expect(n.message).toBe('algo deu errado');
  });

  it('non-Error thrown value → red with generic message', () => {
    const n = notificationForNFeError('weird');
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro inesperado');
    expect(n.message).toContain('desconhecida');
  });
});
