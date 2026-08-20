import { describe, expect, it } from 'vitest';
import { ESTADO_ENVIO, ORIGEM_CONVERSA } from '@delfrance/schemas';
import type {
  MlConversationStatus,
  MlPostSaleMessage,
} from '@delfrance/integrations-mercado-livre';

import {
  buildConversaFromPack,
  buildOrderMensagem,
  isFromSeller,
  orderMessageActionability,
  packOrOrderIdFromResources,
} from './orderMessageMapping';

const NOW_MS = 1_753_180_800_000;
const SELLER = 415458330;
/** ML's MLB messaging Agent — what `from.user_id` is since 02/02/2026. */
const AGENTE_MLB = 3037675074;

function status(over: Partial<MlConversationStatus> = {}): MlConversationStatus {
  return {
    path: '/packs/2000000089077943/seller/415458330',
    status: 'active',
    substatus: null,
    status_date: '2026-02-05T20:01:46.000Z',
    status_update_allowed: false,
    shipping_id: null,
    ...over,
  } as MlConversationStatus;
}

function message(over: Partial<MlPostSaleMessage> = {}): MlPostSaleMessage {
  return {
    id: 'fd1d2e37ad004ede9e0bf25d1215002d',
    site_id: 'MLB',
    from: { user_id: AGENTE_MLB },
    to: { user_id: SELLER },
    status: 'available',
    text: 'Bom dia, quando envia?',
    message_date: {
      received: '2026-02-05T20:01:46.000Z',
      available: null,
      notified: null,
      created: '2026-02-05T20:01:46.000Z',
      read: null,
    },
    message_attachments: [],
    message_resources: [
      { id: '2000000089077943', name: 'packs' },
      { id: '415458330', name: 'sellers' },
    ],
    ...over,
  } as MlPostSaleMessage;
}

describe('orderMessageActionability', () => {
  it('is repliable only while the conversation is active', () => {
    expect(orderMessageActionability(status(), 350)).toEqual({
      podeResponder: true,
      motivo: null,
      limiteCaracteres: 350,
    });
  });

  it('reads ML live per-thread seller cap rather than a constant', () => {
    // ML returns `seller_max_message_length` on every response precisely because
    // it is not a constant.
    expect(orderMessageActionability(status(), 500).limiteCaracteres).toBe(500);
    expect(orderMessageActionability(status(), null).limiteCaracteres).toBeNull();
  });

  it.each([
    ['blocked_by_time', 'Prazo de resposta encerrado (30 dias sem mensagens)'],
    ['blocked_by_buyer', 'O comprador bloqueou o recebimento de mensagens'],
    ['blocked_by_mediation', 'Mediação em andamento'],
    ['blocked_by_fulfillment', 'Venda Fulfillment — liberada só após a entrega'],
    ['blocked_by_cancelled_order', 'Venda cancelada'],
  ])('explains %s to the operator', (substatus, motivo) => {
    const a = orderMessageActionability(status({ status: 'blocked', substatus }), 350);
    expect(a).toMatchObject({ podeResponder: false, motivo });
  });

  it('degrades gracefully on a substatus ML has not documented here', () => {
    // The blocked_by_* list keeps growing; an unmapped one must not throw and
    // must not read as repliable.
    const a = orderMessageActionability(
      status({ status: 'blocked', substatus: 'blocked_by_algo_novo' }),
      350,
    );
    expect(a.podeResponder).toBe(false);
    expect(a.motivo).toContain('blocked_by_algo_novo');
  });

  it('treats an ABSENT conversation_status as NOT repliable', () => {
    // The by-id endpoint answers `conversation_status: null`, so a null here
    // means we never asked the pack. Assuming "yes" on missing evidence is the
    // #817 failure mode.
    const a = orderMessageActionability(null, 350);
    expect(a.podeResponder).toBe(false);
    expect(a.motivo).toBeTruthy();
  });
});

describe('packOrOrderIdFromResources', () => {
  it('prefers packs over orders', () => {
    // A cart of several orders shares ONE pack; keying on the order id would
    // split one buyer conversation into several threads.
    expect(
      packOrOrderIdFromResources([
        { id: '777', name: 'orders' },
        { id: '2000000089077943', name: 'packs' },
      ] as never),
    ).toEqual({ id: '2000000089077943', kind: 'pack' });
  });

  it('falls back to orders when the sale has no pack', () => {
    expect(packOrOrderIdFromResources([{ id: 777, name: 'orders' }] as never)).toEqual({
      id: '777',
      kind: 'order',
    });
  });

  it('is null when neither is present', () => {
    expect(packOrOrderIdFromResources([{ id: '1', name: 'sellers' }] as never)).toBeNull();
    expect(packOrOrderIdFromResources([])).toBeNull();
  });
});

describe('isFromSeller — the MLB Agent trap', () => {
  it('identifies OUR message by the seller id', () => {
    expect(isFromSeller(message({ from: { user_id: SELLER } } as never), SELLER)).toBe(true);
  });

  it('does NOT treat the ML Agent as us', () => {
    // Since 02/02/2026 a buyer message arrives with the Agent as `from`. Matching
    // "not the buyer" would classify every inbound message as our own.
    expect(isFromSeller(message(), SELLER)).toBe(false);
  });

  it('compares as strings — ML prints these ids both ways', () => {
    expect(isFromSeller(message({ from: { user_id: String(SELLER) } } as never), SELLER)).toBe(
      true,
    );
  });
});

describe('buildOrderMensagem', () => {
  it('stamps a buyer message RECEBIDO and ours ENVIADO', () => {
    // Legacy stamped BOTH `enviado` (models.dart:3374-3404). Under the new
    // identity model there is no `user_id` to fall back on, so that would render
    // the entire thread as our own outgoing messages.
    const doComprador = buildOrderMensagem(message(), {
      clienteOuterRef: 'documents/clientes/c1',
      sellerUserId: SELLER,
      nowMs: NOW_MS,
    });
    expect(doComprador.estadoEnvio).toBe(ESTADO_ENVIO.recebido);
    expect(doComprador.clienteMensagemOuterRef).toBe('documents/clientes/c1');

    const nosso = buildOrderMensagem(message({ from: { user_id: SELLER } } as never), {
      clienteOuterRef: 'documents/clientes/c1',
      sellerUserId: SELLER,
      nowMs: NOW_MS,
    });
    expect(nosso.estadoEnvio).toBe(ESTADO_ENVIO.enviado);
    // Ours is operator-authored, so it carries no contact author.
    expect(nosso.clienteMensagemOuterRef).toBeNull();
  });

  it('keys mid on the ML message id and converts dates to millis', () => {
    const m = buildOrderMensagem(message(), {
      clienteOuterRef: null,
      sellerUserId: SELLER,
      nowMs: NOW_MS,
    });
    expect(m.mid).toBe('fd1d2e37ad004ede9e0bf25d1215002d');
    expect(m.timestamp).toBe(Date.parse('2026-02-05T20:01:46.000Z'));
  });

  it('makes attachments VISIBLE rather than silently dropping them', () => {
    // Download is not implemented yet. An operator reading "segue a foto" with
    // no foto and no indication one exists is worse than not having it.
    const m = buildOrderMensagem(
      message({
        text: 'Segue o comprovante',
        message_attachments: [{ filename: 'a.pdf', original_filename: 'comprovante.pdf' }],
      } as never),
      { clienteOuterRef: null, sellerUserId: SELLER, nowMs: NOW_MS },
    );
    expect(m.conteudo).toContain('Segue o comprovante');
    expect(m.conteudo).toContain('1 anexo');
    expect(m.conteudo).toContain('comprovante.pdf');
  });
});

describe('buildConversaFromPack', () => {
  const ctx = {
    clienteOuterRef: 'documents/clientes/cli1',
    integracaoOuterRef: 'documents/integracao/conta1',
    pedidoOuterRef: 'documents/pedidos/ped1',
    corEtiqueta: 7,
    nowMs: NOW_MS,
    acao: { podeResponder: true, motivo: null, limiteCaracteres: 350 },
    packOrOrderId: '2000000089077943',
    pedidoNumero: '1234',
    ultimaMensagemMs: 1_700_000_000_000,
  };

  it('is an mlped conversa keyed on the pack, linked to pedido and cliente', () => {
    const c = buildConversaFromPack(ctx);
    expect(c.origem).toBe(ORIGEM_CONVERSA.mercadoLivrePedido);
    expect(c.id).toBe('2000000089077943');
    expect(c.pedidoOuterRef).toBe('documents/pedidos/ped1');
    expect(c.clienteOuterRef).toBe('documents/clientes/cli1');
    expect(c).not.toHaveProperty('usarioOuterRef');
  });

  it('NEVER writes estadoConversa', () => {
    expect(buildConversaFromPack(ctx)).not.toHaveProperty('estadoConversa');
  });

  it('carries the block reason and marks it atendido when not repliable', () => {
    const c = buildConversaFromPack({
      ...ctx,
      acao: { podeResponder: false, motivo: 'Venda cancelada', limiteCaracteres: null },
    });
    expect(c.respostaBloqueada).toBe('Venda cancelada');
    expect(c.atendido).toBe(true);
  });

  it('tracks the thread’s own newest timestamp, not our write clock', () => {
    expect(buildConversaFromPack(ctx).ultimaModificacaoIntegracao).toBe(1_700_000_000_000);
    expect(
      buildConversaFromPack({ ...ctx, ultimaMensagemMs: null }).ultimaModificacaoIntegracao,
    ).toBe(NOW_MS);
  });
});
