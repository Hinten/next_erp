import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as barrel from './index';
import {
  CONTA_ID_AMAZON_REGEX,
  NOTIFICATION_ID_AMAZON_REGEX,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
  contaIdAmazonSchema,
  notificacaoAmazonSchema,
  notificationIdAmazonSchema,
  pedidoAmazonSchema,
  sellerIdAmazonSchema,
  tarefaAmazonSchema,
} from './notificacaoAmazon';
import { ALL_DOMAINS } from './registry';

/** The models' sandbox placeholder seller id. Placeholders only (public repo). */
const SPID = 'AXXXXXXXXXXXXX';
const PEDIDO = '000-0000000-0000001';

const PUSH = {
  tipo: TIPO_TAREFA_AMAZON.pedido,
  origem: ORIGEM_NOTIFICACAO_AMAZON.push,
  sellerId: SPID,
  amazonOrderId: PEDIDO,
  notificationId: '00000000-0000-0000-0000-000000000001',
  publishTimeMs: 1_800_000_000_000,
};

const POLL = {
  tipo: TIPO_TAREFA_AMAZON.pedido,
  origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
  sellerId: SPID,
  amazonOrderId: PEDIDO,
  contaId: 'conta-amz_1',
  lastUpdatedUs: 1_800_000_000_000_000,
};

describe('tarefaAmazonSchema — the ids-only task payload', () => {
  it('★ parses BOTH variants, each to exactly its own six fields', () => {
    expect(tarefaAmazonSchema.parse(PUSH)).toEqual(PUSH);
    expect(tarefaAmazonSchema.parse(POLL)).toEqual(POLL);
  });

  it('★ STRIPS unknown keys — a buyer field, and the OTHER variant’s fields (§3 decision 29)', () => {
    const push = tarefaAmazonSchema.parse({
      ...PUSH,
      contaId: 'conta-amz_1',
      lastUpdatedUs: 1,
      BuyerInfo: { BuyerEmail: 'fulano@example.com' },
    });
    expect(push).toEqual(PUSH);
    const poll = tarefaAmazonSchema.parse({ ...POLL, notificationId: 'x', publishTimeMs: 1 });
    expect(poll).toEqual(POLL);
  });

  it('a variant missing its own field is refused (the union never falls back to the other)', () => {
    const { notificationId: _n, ...semId } = PUSH;
    expect(tarefaAmazonSchema.safeParse(semId).success).toBe(false);
    const { contaId: _c, ...semConta } = POLL;
    expect(tarefaAmazonSchema.safeParse(semConta).success).toBe(false);
    // A push body under the poll discriminator.
    expect(tarefaAmazonSchema.safeParse({ ...PUSH, origem: 'poll' }).success).toBe(false);
  });

  it('a missing or unknown tipo, or an unknown origem, is refused', () => {
    const { tipo: _t, ...semTipo } = PUSH;
    expect(tarefaAmazonSchema.safeParse(semTipo).success).toBe(false);
    expect(tarefaAmazonSchema.safeParse({ ...PUSH, tipo: 'feed' }).success).toBe(false);
    expect(tarefaAmazonSchema.safeParse({ ...PUSH, origem: 'webhook' }).success).toBe(false);
  });
});

describe('the grammars', () => {
  it('NotificationId: 128 characters pass, 129 do not', () => {
    expect(notificationIdAmazonSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(notificationIdAmazonSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(notificationIdAmazonSchema.safeParse('').success).toBe(false);
  });

  it('NotificationId: a `/`, a space, a control character or a non-ASCII letter is refused', () => {
    for (const ruim of ['a/b', '/', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'ação', 1]) {
      expect(notificationIdAmazonSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(false);
    }
  });

  it('NotificationId: `.`, `..`, `__x__` and `poll:x` are ACCEPTED — the `push:` prefix makes them safe', () => {
    for (const ok of ['.', '..', '__x__', 'poll:x', '!', '~', 'a.b-c_d:e']) {
      expect(notificationIdAmazonSchema.safeParse(ok).success, ok).toBe(true);
    }
    // The pattern spans visible ASCII minus exactly the slash.
    expect(NOTIFICATION_ID_AMAZON_REGEX.test('\x2e\x30')).toBe(true);
    expect(NOTIFICATION_ID_AMAZON_REGEX.test('\x2f')).toBe(false);
    expect(NOTIFICATION_ID_AMAZON_REGEX.test('\x20')).toBe(false);
    expect(NOTIFICATION_ID_AMAZON_REGEX.test('\x7f')).toBe(false);
  });

  it('AmazonOrderId: 3-7-7, nothing else (3-7-8, letters, other digits refused)', () => {
    expect(pedidoAmazonSchema.safeParse('123-4567890-1234567').success).toBe(true);
    for (const ruim of [
      '123-4567890-12345678',
      '123-4567890-123456',
      '1234-567890-1234567',
      '123-456789-01234567',
      'ABC-4567890-1234567',
      '123 4567890 1234567',
      ' 123-4567890-1234567',
      '١٢٣-4567890-1234567',
    ]) {
      expect(pedidoAmazonSchema.safeParse(ruim).success, ruim).toBe(false);
    }
  });

  it('sellerId: the shared sellingPartnerIdValido rule (exact, never trimmed)', () => {
    expect(sellerIdAmazonSchema.safeParse(SPID).success).toBe(true);
    expect(sellerIdAmazonSchema.safeParse('A:B').success).toBe(true);
    for (const ruim of ['', ` ${SPID}`, `${SPID} `, 'A'.repeat(65), 'Ação']) {
      expect(sellerIdAmazonSchema.safeParse(ruim).success, ruim).toBe(false);
    }
  });

  it('contaId: the conta-id grammar', () => {
    expect(contaIdAmazonSchema.safeParse('conta-amz_1').success).toBe(true);
    for (const ruim of ['', 'a/b', '.', '..', 'a:b', 'a'.repeat(129)]) {
      expect(contaIdAmazonSchema.safeParse(ruim).success, ruim).toBe(false);
    }
    expect(CONTA_ID_AMAZON_REGEX.source).toBe('^[A-Za-z0-9_-]{1,128}$');
  });

  it('lastUpdatedUs / publishTimeMs: a non-negative SAFE integer — 2^53 - 1 passes, 2^53 does not', () => {
    for (const campo of ['lastUpdatedUs', 'publishTimeMs'] as const) {
      const base = campo === 'lastUpdatedUs' ? POLL : PUSH;
      expect(
        tarefaAmazonSchema.safeParse({ ...base, [campo]: Number.MAX_SAFE_INTEGER }).success,
      ).toBe(true);
      for (const ruim of [2 ** 53, -1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          tarefaAmazonSchema.safeParse({ ...base, [campo]: ruim }).success,
          `${campo}=${String(ruim)}`,
        ).toBe(false);
      }
    }
  });
});

describe('notificacaoAmazonSchema — the failure document', () => {
  it('applies the defaults: the other variant’s fields and the resilience block', () => {
    expect(notificacaoAmazonSchema.parse(PUSH)).toEqual({
      ...PUSH,
      contaId: null,
      lastUpdatedUs: null,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
    });
    expect(notificacaoAmazonSchema.parse(POLL)).toMatchObject({
      notificationId: null,
      publishTimeMs: null,
    });
  });

  it('STRIPS unknown keys too', () => {
    const doc = notificacaoAmazonSchema.parse({ ...PUSH, Payload: { x: 1 } }) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(doc, 'Payload')).toBe(false);
  });

  it('is a plain ZodObject — the shared store’s partial merges need `.partial()`', () => {
    expect(notificacaoAmazonSchema).toBeInstanceOf(z.ZodObject);
    // `.partial()` works (a refined object would throw here). Zod still fills the
    // defaults of absent keys; `parseMergePatch` keeps only the supplied ones.
    expect(notificacaoAmazonSchema.partial().parse({ status: 'deferred' })).toMatchObject({
      status: 'deferred',
    });
    expect(notificacaoAmazonSchema.partial().safeParse({ status: 'outro' }).success).toBe(false);
  });

  it('is admin-only: bare, barrel-exported, and NOT registered in ALL_DOMAINS', () => {
    expect(barrel.notificacaoAmazonSchema).toBe(notificacaoAmazonSchema);
    expect(barrel.tarefaAmazonSchema).toBe(tarefaAmazonSchema);
    for (const d of ALL_DOMAINS) {
      expect(d.schema).not.toBe(notificacaoAmazonSchema);
      expect(d.meta.collectionPath).not.toBe('notificacoesAmazon');
    }
  });
});
