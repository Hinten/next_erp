import { describe, expect, it } from 'vitest';
import { histPgtoMeta, histPgtoSchema } from './pagamento';

describe('histPgtoSchema', () => {
  it('defaults every field to null', () => {
    const out = histPgtoSchema.parse({});
    expect(out.status_anterior).toBeNull();
    expect(out.status_atual).toBeNull();
    expect(out.timestamp).toBeNull();
    expect(out.usuarioHistoricoPagamentoOuterRef).toBeNull();
    expect(out.eventId).toBeNull();
  });

  it('accepts a known status_pagamento transition', () => {
    const out = histPgtoSchema.parse({ status_anterior: 0, status_atual: 4 });
    expect(out.status_anterior).toBe(0);
    expect(out.status_atual).toBe(4);
  });

  it('rejects an unknown status code', () => {
    expect(histPgtoSchema.safeParse({ status_atual: 999 }).success).toBe(false);
  });

  it('preserves legacy base-model keys via passthrough', () => {
    const out = histPgtoSchema.parse({ docId: 'abc', createTime: '2026-01-01T00:00:00Z' });
    expect(out.docId).toBe('abc');
  });

  it('lives at pedidos/{pedidoId}/pagamentos/{pagamentoId}/histpgto, reusing PAGAMENTO perms', () => {
    expect(histPgtoMeta.collectionPath).toBe(
      'pedidos/{pedidoId}/pagamentos/{pagamentoId}/histpgto',
    );
    expect(histPgtoMeta.permissions.read).toBe(1n << 24n);
    expect(histPgtoMeta.permissions.write).toBe(1n << 25n);
    expect(histPgtoMeta.permissions.delete).toBe(1n << 26n);
  });

  it('is server-owned with a newest-first defaultQuery', () => {
    expect(histPgtoMeta.serverOwned).toBe(true);
    expect(histPgtoMeta.defaultQuery).toEqual({
      orderBy: [{ field: 'timestamp', direction: 'desc' }],
      limit: 50,
    });
  });
});
