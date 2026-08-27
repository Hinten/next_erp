import { describe, expect, it } from 'vitest';
import { ESTADO_ENVIO, ORIGEM_CONVERSA } from '@delfrance/schemas';
import type {
  MlConversationStatus,
  MlPackMessages,
  MlPostSaleMessage,
} from '@delfrance/integrations-mercado-livre';

import {
  buildConversaFromPack,
  buildOrderMensagem,
  isFromSeller,
  orderMessageActionability,
  packOrOrderIdFromResources,
  postSaleRecipientUserId,
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

describe('postSaleRecipientUserId', () => {
  const COMPRADOR = 1234567890;

  function pack(
    messages: readonly MlPostSaleMessage[],
    statusOver: Partial<MlConversationStatus> = {},
  ): MlPackMessages {
    return {
      paging: { limit: 100, offset: 0, total: messages.length },
      conversation_status: status(statusOver),
      messages: [...messages],
      seller_max_message_length: 350,
      buyer_max_message_length: 3500,
    } as MlPackMessages;
  }

  /** A message at a fixed offset from the fixture date, so ordering is explicit. */
  function em(minutos: number, over: Partial<MlPostSaleMessage> = {}): MlPostSaleMessage {
    const iso = new Date(Date.parse('2026-02-05T20:01:46.000Z') + minutos * 60_000).toISOString();
    return message({
      ...over,
      message_date: { received: iso, available: null, notified: null, created: iso, read: null },
    } as never);
  }

  it('replies to the real BUYER on a thread ML has not migrated', () => {
    // The live 400 this exists to prevent: ML's agent rollout is progressive, so
    // a legacy thread refuses the agent outright.
    const r = postSaleRecipientUserId(pack([em(0, { from: { user_id: COMPRADOR } })]), SELLER);
    expect(r).toEqual({ userId: COMPRADOR, fonte: 'mensagem', paginaTruncada: false });
    expect(r?.userId).not.toBe(AGENTE_MLB);
  });

  it('replies to the AGENT on a thread ML has migrated', () => {
    expect(postSaleRecipientUserId(pack([em(0)]), SELLER)).toEqual({
      userId: AGENTE_MLB,
      fonte: 'mensagem',
      paginaTruncada: false,
    });
  });

  it('takes the NEWEST counterparty, not the first or last in ML’s array', () => {
    // A thread migrated mid-life carries older buyer-id messages and newer
    // agent-id ones. The array is deliberately out of chronological order.
    const messages = [
      em(0, { from: { user_id: COMPRADOR } }),
      em(5, { from: { user_id: SELLER } }),
      em(10),
    ];
    expect(postSaleRecipientUserId(pack(messages), SELLER)?.userId).toBe(AGENTE_MLB);
    // Same answer from the reversed array: the rule is the timestamp, and nothing
    // in this repo proves ML's sort order.
    expect(postSaleRecipientUserId(pack([...messages].reverse()), SELLER)?.userId).toBe(AGENTE_MLB);
  });

  it('…and in the other direction — a newer BUYER message beats an older agent one', () => {
    // Kills "if any message is from a known agent id, prefer the agent", which
    // the previous case alone survives.
    const messages = [em(10, { from: { user_id: COMPRADOR } }), em(0)];
    expect(postSaleRecipientUserId(pack(messages), SELLER)?.userId).toBe(COMPRADOR);
    expect(postSaleRecipientUserId(pack([...messages].reverse()), SELLER)?.userId).toBe(COMPRADOR);
  });

  it('never addresses the SELLER itself, even when ours is the newest message', () => {
    // Dropping the isFromSeller filter POSTs `to === from`, which ML refuses with
    // "Sender and received must not be equals".
    const r = postSaleRecipientUserId(
      pack([em(10, { from: { user_id: SELLER } }), em(0, { from: { user_id: COMPRADOR } })]),
      SELLER,
    );
    expect(r?.userId).toBe(COMPRADOR);
  });

  it('falls back to `created` being absent by reading `received`', () => {
    const semCreated = message({
      from: { user_id: COMPRADOR },
      message_date: {
        received: '2026-02-05T21:01:46.000Z',
        available: null,
        notified: null,
        created: null,
        read: null,
      },
    } as never);
    expect(postSaleRecipientUserId(pack([em(0), semCreated]), SELLER)?.userId).toBe(COMPRADOR);
  });

  it('returns a NUMBER for a user_id that arrived as a string', () => {
    // ML prints these both ways; a NaN would reach the wire as the literal "NaN".
    const r = postSaleRecipientUserId(
      pack([em(0, { from: { user_id: String(COMPRADOR) } })]),
      SELLER,
    );
    expect(r?.userId).toBe(COMPRADOR);
  });

  it('skips a user_id that is not a positive integer and tries the next rung', () => {
    for (const ruim of ['', '   ', 'abc', '-1', '0', '1.5', null]) {
      expect(
        postSaleRecipientUserId(pack([em(0, { from: { user_id: ruim } } as never)]), SELLER),
        String(ruim),
      ).toBeNull();
    }
  });

  it('falls back to the site AGENT when the path names a /conversations/ segment', () => {
    const semContraparte = [em(0, { from: { user_id: SELLER } })];
    expect(
      postSaleRecipientUserId(
        pack(semContraparte, { path: '/packs/1/sellers/2/conversations/post_sale' }),
        SELLER,
      ),
    ).toEqual({ userId: AGENTE_MLB, fonte: 'agente-path', paginaTruncada: false });
  });

  it('reads the site off the thread for that fallback, defaulting to MLB', () => {
    const nosso = (site: string | null) =>
      pack([em(0, { from: { user_id: SELLER }, site_id: site } as never)], {
        path: '/packs/1/sellers/2/conversations/post_sale',
      });
    expect(postSaleRecipientUserId(nosso('MLA'), SELLER)?.userId).toBe(3037674934);
    expect(postSaleRecipientUserId(nosso(null), SELLER)?.userId).toBe(AGENTE_MLB);
  });

  it('⚠️ does NOT read the PLURAL `sellers` as the agent flow', () => {
    // The whole trap. ML's 400 quotes `/packs/…/sellers/…` for a LEGACY thread,
    // and this file's own `status()` fixture uses the singular — both spellings
    // appear off the agent flow, so only `/conversations/` discriminates. Matching
    // the plural would re-break exactly the threads this fixes.
    expect(
      postSaleRecipientUserId(
        pack([em(0, { from: { user_id: SELLER } })], { path: '/packs/1/sellers/2' }),
        SELLER,
      ),
    ).toBeNull();
  });

  it('refuses to guess when the thread names nobody — never a default agent', () => {
    expect(postSaleRecipientUserId(pack([], { path: null }), SELLER)).toBeNull();
    expect(
      postSaleRecipientUserId(pack([em(0, { from: null } as never)], { path: null }), SELLER),
    ).toBeNull();
  });

  /** A pack ML paged: `total` messages exist, only `messages` came back. */
  function packTruncado(
    messages: readonly MlPostSaleMessage[],
    total: number,
    statusOver: Partial<MlConversationStatus> = {},
  ): MlPackMessages {
    return {
      ...pack(messages, statusOver),
      paging: { limit: 100, offset: 0, total },
    } as MlPackMessages;
  }

  it('⚠️ on a TRUNCATED page the path outranks the messages', () => {
    // The silent half, one page deeper. The send path reads offset 0 only, and
    // ML's sort order is not proven anywhere — so a MIGRATED thread over 100
    // messages can hand back its OLDEST page, whose newest counterparty is the
    // stale pre-migration buyer id. Trusting it gets a 200 that reaches nobody.
    const r = postSaleRecipientUserId(
      packTruncado([em(0, { from: { user_id: COMPRADOR } })], 250, {
        path: '/packs/1/sellers/2/conversations/post_sale',
      }),
      SELLER,
    );
    expect(r).toEqual({ userId: AGENTE_MLB, fonte: 'agente-path', paginaTruncada: true });
  });

  it('…but a truncated LEGACY thread still resolves, it does not refuse', () => {
    // No `/conversations/` ⇒ not migrated, and one pack has exactly one buyer
    // whose id does not change over the thread's life. Migration is the only
    // thing that could change it, and that is what the path reports. Refusing
    // here would strand the operator on a 100+-message thread — the problem
    // order they most need to answer.
    const r = postSaleRecipientUserId(
      packTruncado([em(0, { from: { user_id: COMPRADOR } })], 250),
      SELLER,
    );
    expect(r).toEqual({ userId: COMPRADOR, fonte: 'mensagem', paginaTruncada: true });
  });

  it('a COMPLETE page keeps the observed id ahead of the path', () => {
    // The observed address is stronger than the per-site table, which would miss
    // an agent id ML newly minted. `total` equal to what came back is complete.
    const r = postSaleRecipientUserId(
      packTruncado([em(0, { from: { user_id: 99999 } })], 1, {
        path: '/packs/1/sellers/2/conversations/post_sale',
      }),
      SELLER,
    );
    expect(r).toEqual({ userId: 99999, fonte: 'mensagem', paginaTruncada: false });
  });

  it('treats an ABSENT paging.total as complete, like the importer does', () => {
    // `lerThreadCompleta` stops walking on the same condition.
    const semPaging = { ...pack([em(0, { from: { user_id: COMPRADOR } })]), paging: null };
    expect(postSaleRecipientUserId(semPaging as MlPackMessages, SELLER)).toEqual({
      userId: COMPRADOR,
      fonte: 'mensagem',
      paginaTruncada: false,
    });
  });

  it('returns null without a seller id rather than addressing ourselves', () => {
    // `isFromSeller` cannot exclude our own messages without one, so every message
    // would read as a counterparty.
    expect(postSaleRecipientUserId(pack([em(0, { from: { user_id: SELLER } })]), null)).toBeNull();
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
