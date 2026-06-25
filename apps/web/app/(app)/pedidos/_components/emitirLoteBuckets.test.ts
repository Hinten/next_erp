import { describe, expect, it } from 'vitest';
import type { NFeEmitError, NFeEmitResult } from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE, type EstadoNFe } from '@delfrance/schemas';

import { classifyEmitResult } from './emitirLoteBuckets';

function result(over: Partial<NFeEmitResult> & { estado: EstadoNFe }): NFeEmitResult {
  return {
    nfeId: 'n1',
    pedidoId: 'p1',
    chave: '3526'.padEnd(44, '0'),
    nRec: null,
    cStat: '100',
    xMotivo: 'ok',
    reused: false,
    ...over,
  };
}

function emitError(over: Partial<NFeEmitError> = {}): NFeEmitError {
  return { pedidoId: 'p1', errorCode: 'prepare-fail', errorMessage: 'boom', ...over };
}

describe('classifyEmitResult', () => {
  it('buckets cStat 103 (aguardandoResposta) as "processando", not "falhas" (#259)', () => {
    expect(
      classifyEmitResult(
        result({
          estado: ESTADO_NFE.aguardandoResposta,
          cStat: '103',
          xMotivo: 'Lote recebido com sucesso',
        }),
      ),
    ).toBe('processando');
  });

  it('buckets "enviando" as "processando"', () => {
    expect(classifyEmitResult(result({ estado: ESTADO_NFE.enviando }))).toBe('processando');
  });

  it('buckets a fresh autorizada as "sucesso"', () => {
    expect(classifyEmitResult(result({ estado: ESTADO_NFE.aprovada, reused: false }))).toBe(
      'sucesso',
    );
  });

  it('buckets a reused (dedup short-circuit) autorizada as "naoEmitidas"', () => {
    expect(classifyEmitResult(result({ estado: ESTADO_NFE.aprovada, reused: true }))).toBe(
      'naoEmitidas',
    );
  });

  it('buckets a reused non-aprovada (e.g. cancelada) as "naoEmitidas", not "falhas"', () => {
    // The server short-circuited on an existing bloqueada doc (cStat 101 →
    // estado cancelada). The click was a dedup no-op, never a fresh failure.
    expect(
      classifyEmitResult(
        result({ estado: ESTADO_NFE.cancelada, reused: true, cStat: '101', xMotivo: 'cancelada' }),
      ),
    ).toBe('naoEmitidas');
  });

  it('keeps a reused in-flight note (cStat 103 is a STATUS_BLOQUEADOR) as "processando"', () => {
    // Pending wins over the reused dedup: an already-sent lote is still
    // processing, so it must not collapse into "naoEmitidas".
    expect(
      classifyEmitResult(
        result({ estado: ESTADO_NFE.aguardandoResposta, reused: true, cStat: '103' }),
      ),
    ).toBe('processando');
  });

  it('buckets a rejeitada as "falhas"', () => {
    expect(
      classifyEmitResult(result({ estado: ESTADO_NFE.rejeitada, cStat: '539', xMotivo: 'dup' })),
    ).toBe('falhas');
  });

  it('buckets an errored note as "falhas"', () => {
    expect(classifyEmitResult(result({ estado: ESTADO_NFE.error, cStat: '656' }))).toBe('falhas');
  });

  it('buckets a per-pedido EmitError as "naoEmitidas"', () => {
    expect(classifyEmitResult(emitError())).toBe('naoEmitidas');
  });
});
