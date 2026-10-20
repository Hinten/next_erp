import { describe, expect, it } from 'vitest';
import { notificacaoAmazonSchema, tarefaAmazonSchema } from '@delfrance/schemas';

import {
  camposDoDocumentoAmazon,
  dedupKeyAmazon,
  docIdNotificacaoAmazon,
} from '../notificacoes/notificacao';
import { SPID_A } from '../testing/fixtures';
import { lerLinhaPollAmazon } from './janelaPoll';
import { notificacaoDoPoll } from './notificacaoSintetica';

const CONTA = { integracaoId: 'conta-1', sellingPartnerId: SPID_A };

function linha(orderId = '171-2345678-9012345', carimbo = '2027-01-15T10:00:00.123456Z') {
  const lida = lerLinhaPollAmazon({ orderId, lastUpdatedTime: carimbo });
  if (lida === null) throw new Error('linha de teste inválida');
  return lida;
}

describe('notificacaoDoPoll', () => {
  it('builds exactly the poll variant, ids only', () => {
    const p = notificacaoDoPoll(CONTA, linha());
    expect(p).toEqual({
      tipo: 'pedido',
      origem: 'poll',
      sellerId: SPID_A,
      amazonOrderId: '171-2345678-9012345',
      contaId: 'conta-1',
      lastUpdatedUs: Date.UTC(2027, 0, 15, 10, 0, 0) * 1000 + 123_456,
    });
  });

  it('parses under step 3’s REAL task schema, unchanged', () => {
    const p = notificacaoDoPoll(CONTA, linha());
    expect(tarefaAmazonSchema.parse(p)).toEqual(p);
  });

  it('round-trips through the store’s toDocFields and the strict fromDoc read', () => {
    const p = notificacaoDoPoll(CONTA, linha());
    // What the shared core writes (`toDocFields` → the document schema)…
    const documento = notificacaoAmazonSchema.parse({
      ...camposDoDocumentoAmazon(p),
      status: 'failed',
      tentativas: 0,
      processedAt: 1,
    });
    // …and what the sweep reads back (`fromDoc` = the task schema over the raw row).
    expect(tarefaAmazonSchema.parse(documento)).toEqual(p);
  });

  it('names its failure document by conta, order and µs; dedups by seller + order', () => {
    const p = notificacaoDoPoll(CONTA, linha());
    expect(docIdNotificacaoAmazon(p)).toBe(
      `poll:conta-1:171-2345678-9012345:${String(p.lastUpdatedUs)}`,
    );
    expect(dedupKeyAmazon(p)).toBe(`${SPID_A}:171-2345678-9012345`);
    // A later change of the same order is another document (near-miss: 1 µs later).
    const depois = notificacaoDoPoll(CONTA, linha(undefined, '2027-01-15T10:00:00.123457Z'));
    expect(docIdNotificacaoAmazon(depois)).not.toBe(docIdNotificacaoAmazon(p));
    expect(dedupKeyAmazon(depois)).toBe(dedupKeyAmazon(p));
  });

  it('refuses a conta id or a seller id outside their grammars (TypeError, never a silent drop)', () => {
    expect(() => notificacaoDoPoll({ ...CONTA, integracaoId: 'a/b' }, linha())).toThrow(TypeError);
    expect(() => notificacaoDoPoll({ ...CONTA, sellingPartnerId: '' }, linha())).toThrow(TypeError);
  });
});
