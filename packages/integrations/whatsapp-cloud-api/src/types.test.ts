import { describe, expect, it } from 'vitest';
import {
  WA_STATUS_DESCONHECIDO,
  WA_STATUS_KNOWN,
  WEBHOOK_FIELD_MESSAGES,
  incomingMessageSchema,
  narrowWaStatus,
  valuePayloadSchema,
  webhookEnvelopeSchema,
} from './types';

function baseValue(overrides: Record<string, unknown> = {}) {
  return {
    messaging_product: 'whatsapp',
    metadata: {
      display_phone_number: '5511999990000',
      phone_number_id: '111',
    },
    ...overrides,
  };
}

describe('webhookEnvelopeSchema', () => {
  it('parses a `messages` field change', () => {
    const envelope = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: WEBHOOK_FIELD_MESSAGES,
              value: baseValue({
                messages: [
                  {
                    from: '5511999990000',
                    id: 'wamid.1',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'oi' },
                  },
                ],
              }),
            },
          ],
        },
      ],
    };
    const parsed = webhookEnvelopeSchema.parse(envelope);
    expect(parsed.entry[0]?.changes[0]?.field).toBe('messages');
  });

  /**
   * ⚠️ This test used to build its value with `baseValue()`, which supplies
   * `messaging_product` and `metadata` — so it asserted tolerance against a
   * payload shape Meta DOES NOT SEND, and passed while the tolerance it claimed
   * to pin did not exist. Legacy models this event's value as
   * `{event, message_template_id, message_template_name,
   * message_template_language, reason, …}` (`.old/…/api_v23/templates.dart`) —
   * no `messaging_product`, no `metadata` anywhere. Against the REAL shape the
   * old envelope rejected the whole delivery, which is why
   * `DropOutcome.'campo-nao-suportado'` was dead code in production.
   *
   * The fixtures below are therefore metadata-LESS on purpose. Adding either key
   * back would restore the false pass.
   */
  it.each([
    [
      'message_template_status_update',
      {
        event: 'APPROVED',
        message_template_id: 1234567890,
        message_template_name: 'reabertura_conversa',
        message_template_language: 'pt_BR',
        reason: 'NONE',
      },
    ],
    [
      'phone_number_quality_update',
      { display_phone_number: '5511999990000', event: 'FLAGGED', current_limit: 'TIER_10K' },
    ],
    ['account_update', { phone_number: '5511999990000', event: 'VERIFIED_ACCOUNT' }],
  ])(
    'parses the REAL (metadata-less) `%s` value without rejecting the envelope',
    (field, value) => {
      const parsed = webhookEnvelopeSchema.parse({
        object: 'whatsapp_business_account',
        entry: [{ id: 'waba-1', changes: [{ field, value }] }],
      });
      expect(parsed.entry[0]?.changes[0]?.field).toBe(field);
      // The value survives untouched for the dispatcher to drop WITH A LOG.
      expect(parsed.entry[0]?.changes[0]?.value).toEqual(value);
    },
  );

  /**
   * THE PROPERTY, and the one the old test could not state: an account-level
   * change riding in the same POST as a real customer message must not take that
   * message down with it. Meta batches changes per WABA, so this is not a
   * hypothetical pairing.
   */
  it('a metadata-less account change does NOT discard a `messages` change beside it', () => {
    const parsed = webhookEnvelopeSchema.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            { field: 'account_update', value: { event: 'PARTNER_ADDED' } },
            {
              field: WEBHOOK_FIELD_MESSAGES,
              value: baseValue({
                messages: [
                  {
                    from: '5511999990000',
                    id: 'wamid.SURVIVOR',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'oi' },
                  },
                ],
              }),
            },
          ],
        },
      ],
    });
    expect(parsed.entry[0]?.changes).toHaveLength(2);
    const messages = parsed.entry[0]?.changes[1];
    expect(messages?.field).toBe(WEBHOOK_FIELD_MESSAGES);
    // The customer message is still reachable — the whole point.
    expect(valuePayloadSchema.parse(messages?.value).messages?.[0]?.id).toBe('wamid.SURVIVOR');
  });

  it('still returns null-equivalent for a body that is not a WhatsApp envelope', () => {
    // The skeleton kept exactly enough structure to tell a WhatsApp webhook from
    // an arbitrary signed POST — widening `value` must not widen THIS.
    expect(webhookEnvelopeSchema.safeParse({ hello: 'world' }).success).toBe(false);
    expect(webhookEnvelopeSchema.safeParse({ object: 'page', entry: [] }).success).toBe(false);
    expect(
      webhookEnvelopeSchema.safeParse({ object: 'whatsapp_business_account', entry: {} }).success,
    ).toBe(false);
  });
});

describe('incomingMessageSchema', () => {
  it('parses a reaction message', () => {
    const parsed = incomingMessageSchema.parse({
      from: '5511999990000',
      id: 'wamid.2',
      timestamp: '1700000001',
      type: 'reaction',
      reaction: { message_id: 'wamid.1', emoji: '\u{1F44D}' },
    });
    expect(parsed.reaction).toEqual({ message_id: 'wamid.1', emoji: '\u{1F44D}' });
  });

  it('parses a text message carrying a referral', () => {
    const parsed = incomingMessageSchema.parse({
      from: '5511999990000',
      id: 'wamid.3',
      timestamp: '1700000002',
      type: 'text',
      text: { body: 'quero saber mais' },
      referral: {
        source_url: 'https://fb.me/ad',
        source_type: 'ad',
        source_id: '12345',
        headline: 'Promo',
        body: 'Confira',
        media_type: 'image',
        image_url: 'https://example.com/img.png',
        video_url: null,
        thumbnail_url: null,
        ctwa_clid: 'abc123',
      },
    });
    expect(parsed.referral?.source_type).toBe('ad');
    expect(parsed.referral?.video_url).toBeNull();
  });

  it('tolerates a null referral (nullish, not just optional)', () => {
    const parsed = incomingMessageSchema.parse({
      from: '5511999990000',
      id: 'wamid.4',
      timestamp: '1700000003',
      type: 'text',
      text: { body: 'oi' },
      referral: null,
    });
    expect(parsed.referral).toBeNull();
  });

  it('parses an interactive button reply as a tolerant passthrough object', () => {
    const parsed = incomingMessageSchema.parse({
      from: '5511999990000',
      id: 'wamid.5',
      timestamp: '1700000004',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'opt-1', title: 'Sim' },
      },
    });
    expect(parsed.interactive).toEqual({
      type: 'button_reply',
      button_reply: { id: 'opt-1', title: 'Sim' },
    });
  });

  it('parses a legacy template button tap', () => {
    const parsed = incomingMessageSchema.parse({
      from: '5511999990000',
      id: 'wamid.6',
      timestamp: '1700000005',
      type: 'button',
      button: { text: 'Confirmar', payload: 'CONFIRM' },
    });
    expect(parsed.button).toEqual({ text: 'Confirmar', payload: 'CONFIRM' });
  });

  it('parses message-level errors', () => {
    const parsed = incomingMessageSchema.parse({
      from: '5511999990000',
      id: 'wamid.7',
      timestamp: '1700000006',
      type: 'unknown',
      errors: [
        {
          code: 131051,
          title: 'Unsupported message type',
          message: 'Unsupported message type',
        },
      ],
    });
    expect(parsed.errors?.[0]?.code).toBe(131051);
  });

  it('still accepts an ordinary text message (existing behavior)', () => {
    const parsed = incomingMessageSchema.parse({
      from: '5511999990000',
      id: 'wamid.8',
      timestamp: '1700000007',
      type: 'text',
      text: { body: 'olá' },
    });
    expect(parsed.text?.body).toBe('olá');
    expect(parsed.reaction).toBeUndefined();
  });
});

/**
 * The status enum was the single most expensive field in this package: a Zod
 * array fails as a WHOLE when any element fails, and this schema is embedded
 * transitively in the RECEIVER's envelope parse, whose failure path returns null
 * and acks 200. So one unrecognised status discarded every entry, every change,
 * and any customer message riding in the same POST — with no task, no failure
 * document and no log line anywhere.
 */
describe('statuses[] tolerance', () => {
  function withStatuses(statuses: unknown[]) {
    return valuePayloadSchema.parse(baseValue({ statuses }));
  }

  function status(over: Record<string, unknown> = {}) {
    return {
      id: 'wamid.1',
      recipient_id: '5511888880000',
      status: 'delivered',
      timestamp: '1700000000',
      ...over,
    };
  }

  it('keeps a status value Meta added after this schema was written', () => {
    const parsed = withStatuses([status({ id: 'wamid.NEW', status: 'warning' })]);
    // The RAW token survives — narrowing happens at the point of use, so the log
    // can name what actually arrived instead of a sentinel.
    expect(parsed.statuses?.[0]?.status).toBe('warning');
  });

  it('THE PROPERTY: an unknown status does not discard its siblings', () => {
    const parsed = withStatuses([
      status({ id: 'wamid.A', status: 'sent' }),
      status({ id: 'wamid.B', status: 'warning' }),
      status({ id: 'wamid.C', status: 'read' }),
    ]);
    expect(parsed.statuses?.map((s) => s?.id)).toEqual(['wamid.A', 'wamid.B', 'wamid.C']);
  });

  it('an unknown status does not discard the `messages[]` riding beside it', () => {
    const parsed = valuePayloadSchema.parse(
      baseValue({
        messages: [
          {
            from: '5511999990000',
            id: 'wamid.SURVIVOR',
            timestamp: '1700000000',
            type: 'text',
            text: { body: 'oi' },
          },
        ],
        statuses: [status({ status: 'warning' })],
      }),
    );
    expect(parsed.messages?.[0]?.id).toBe('wamid.SURVIVOR');
  });

  it('a MALFORMED element becomes null and keeps its siblings — nulls are KEPT, not filtered', () => {
    const parsed = withStatuses([
      status({ id: 'wamid.A' }),
      { id: 'wamid.B' }, // no recipient_id / status / timestamp → fails the element
      status({ id: 'wamid.C' }),
    ]);
    // ⚠️ Length is preserved and the hole is a null, so `processStatuses` can
    // COUNT it. A `.filter()` here would fix the loss and hide it in one line.
    expect(parsed.statuses).toHaveLength(3);
    expect(parsed.statuses?.[1]).toBeNull();
    expect(parsed.statuses?.[0]?.id).toBe('wamid.A');
    expect(parsed.statuses?.[2]?.id).toBe('wamid.C');
  });
});

describe('messages[] tolerance', () => {
  function message(over: Record<string, unknown> = {}) {
    return {
      from: '5511999990000',
      id: 'wamid.1',
      timestamp: '1700000000',
      type: 'text',
      text: { body: 'oi' },
      ...over,
    };
  }

  it('parses a message `type` this schema does not list', () => {
    // Nothing reads `type` — the mensagem kind comes from which media key is
    // present — so a closed enum here only ever cost deliveries.
    const parsed = incomingMessageSchema.parse(message({ type: 'poll' }));
    expect(parsed.type).toBe('poll');
  });

  it('THE PROPERTY: a malformed message keeps its siblings AND the statuses beside it', () => {
    const parsed = valuePayloadSchema.parse(
      baseValue({
        messages: [message({ id: 'wamid.A' }), { id: 'wamid.B' }, message({ id: 'wamid.C' })],
        statuses: [
          {
            id: 'wamid.OUT',
            recipient_id: '5511888880000',
            status: 'delivered',
            timestamp: '1700000000',
          },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages?.[1]).toBeNull();
    expect(parsed.messages?.[0]?.id).toBe('wamid.A');
    expect(parsed.messages?.[2]?.id).toBe('wamid.C');
    expect(parsed.statuses?.[0]?.id).toBe('wamid.OUT');
  });
});

/**
 * ⚠️ `narrowWaStatus` is an equivalence FOLD: its output drives the two switches
 * in `processStatus.ts`, so what it treats as the same decides which
 * `estadoEnvio` gets written. Per the repo rule, a test that the fold APPLIES
 * cannot show where it STOPS — so both halves are pinned here.
 *
 * Folded together: every value outside the documented five → `desconhecido`.
 * Kept distinct: the five themselves, AND every near-miss of them. A case- or
 * whitespace-tolerant fold would map `'Sent'` onto `'sent'` and write `enviando`
 * for a token nobody has verified means that — strictly worse than the honest
 * `desconhecido`, and invisible.
 */
describe('narrowWaStatus — what it folds, and where it stops', () => {
  it.each(WA_STATUS_KNOWN)('keeps the known value `%s` distinct', (known) => {
    expect(narrowWaStatus(known)).toBe(known);
  });

  it.each(['warning', 'accepted', 'enqueued', '', 'SENT_'])(
    'folds the unmodelled value `%s` onto the sentinel',
    (unknownStatus) => {
      expect(narrowWaStatus(unknownStatus)).toBe(WA_STATUS_DESCONHECIDO);
    },
  );

  it.each(['Sent', 'SENT', 'sent ', ' sent', 'delivered\n', 'Read'])(
    'the NEAR-MISS `%s` stays distinct from the known value it resembles',
    (nearMiss) => {
      // The fold must not reach this far. Mapping these onto the known token
      // would write a confident, wrong `estadoEnvio` instead of `desconhecido`.
      expect(narrowWaStatus(nearMiss)).toBe(WA_STATUS_DESCONHECIDO);
      expect(narrowWaStatus(nearMiss)).not.toBe(nearMiss.trim().toLowerCase());
    },
  );

  it('the sentinel is not itself a known status — it can only come from the fold', () => {
    expect(WA_STATUS_KNOWN).not.toContain(WA_STATUS_DESCONHECIDO);
  });
});
