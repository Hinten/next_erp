import { describe, expect, it } from 'vitest';
import { WEBHOOK_FIELD_MESSAGES, incomingMessageSchema, webhookEnvelopeSchema } from './types';

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

  it('parses a non-`messages` field without rejecting the envelope', () => {
    const envelope = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'phone_number_quality_update',
              value: baseValue(),
            },
          ],
        },
      ],
    };
    const parsed = webhookEnvelopeSchema.parse(envelope);
    expect(parsed.entry[0]?.changes[0]?.field).toBe('phone_number_quality_update');
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
