import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type ShopeeMultipartBody, shopeeCall } from '../src/call';
import {
  SHOPEE_SIGN_WINDOW_SECONDS,
  type ShopeeQueryValue,
  merchantBaseString,
  publicBaseString,
  shopBaseString,
  shopeeTimestamp,
  signBaseString,
  signedQuery,
} from '../src/sign';

/**
 * ⚠️ Invented. Not a Shopee credential, and nothing in this file may be replaced
 * with a real partner key.
 */
const TEST_PARTNER_KEY = 'chave-de-teste-nao-e-credencial';

/**
 * Shopee's own PUBLISHED documentation sample (`guide 16`). The partner id,
 * timestamp, access token and shop id below are the values printed in that
 * public example — they authorise nothing and there is no key in it.
 */
const DOC_PARTNER_ID = 2001887;
const DOC_TIMESTAMP = 1655714431;
const DOC_ACCESS_TOKEN = '59777174636562737266615546704c6d';
const DOC_SHOP_ID = 14701711;

const SHOP_INFO_PATH = '/api/v2/shop/get_shop_info';
const SHOPS_BY_PARTNER_PATH = '/api/v2/public/get_shops_by_partner';

describe('the base strings', () => {
  it('matches the published PUBLIC vector', () => {
    expect(
      publicBaseString({
        partnerId: DOC_PARTNER_ID,
        path: SHOPS_BY_PARTNER_PATH,
        timestamp: DOC_TIMESTAMP,
      }),
    ).toBe('2001887/api/v2/public/get_shops_by_partner1655714431');
  });

  it('matches the published SHOP vector', () => {
    expect(
      shopBaseString({
        partnerId: DOC_PARTNER_ID,
        path: SHOP_INFO_PATH,
        timestamp: DOC_TIMESTAMP,
        accessToken: DOC_ACCESS_TOKEN,
        shopId: DOC_SHOP_ID,
      }),
    ).toBe('2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711');
  });

  it('uses NO separator between the parts', () => {
    // NEAR-MISS: the two spellings a reader would guess. Both produce a
    // well-formed signature that Shopee answers with `error_sign`.
    const parts = [String(DOC_PARTNER_ID), SHOP_INFO_PATH, String(DOC_TIMESTAMP)];
    const real = publicBaseString({
      partnerId: DOC_PARTNER_ID,
      path: SHOP_INFO_PATH,
      timestamp: DOC_TIMESTAMP,
    });
    expect(real).not.toBe(parts.join('|'));
    expect(real).not.toBe(parts.join('&'));
    expect(real).toBe(parts.join(''));
  });

  it('keeps the shop and merchant base strings distinct', () => {
    // NEAR-MISS: same partner, path, timestamp, token and numeric id — only the
    // id CLASS differs, and the two strings are byte-identical if the caller
    // picks the wrong builder. They must still be told apart by which id the
    // caller meant, which is what the union in `SignedCall` enforces.
    const common = { partnerId: DOC_PARTNER_ID, path: SHOP_INFO_PATH, timestamp: DOC_TIMESTAMP };
    expect(shopBaseString({ ...common, accessToken: 'tok', shopId: 1 })).toBe(
      merchantBaseString({ ...common, accessToken: 'tok', merchantId: 1 }),
    );
    expect(shopBaseString({ ...common, accessToken: 'tok', shopId: 1 })).not.toBe(
      merchantBaseString({ ...common, accessToken: 'tok', merchantId: 2 }),
    );
  });
});

describe('signBaseString', () => {
  it('reproduces RFC 4231 HMAC-SHA256 test case 2', () => {
    // A known-answer test for the primitive itself, so a wrong digest algorithm
    // or encoding cannot hide behind our own fixtures.
    expect(signBaseString('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('is lowercase hex, 64 characters', () => {
    const sign = signBaseString('qualquer coisa', TEST_PARTNER_KEY);
    expect(sign).toMatch(/^[0-9a-f]{64}$/);
    expect(sign).toBe(sign.toLowerCase());
  });
});

describe('shopeeTimestamp', () => {
  it('is Unix seconds, floored', () => {
    expect(shopeeTimestamp(1_655_714_431_000)).toBe(DOC_TIMESTAMP);
    expect(shopeeTimestamp(1_655_714_431_999)).toBe(DOC_TIMESTAMP);
    expect(shopeeTimestamp(1_655_714_432_000)).toBe(DOC_TIMESTAMP + 1);
  });

  it('documents the accepted window', () => {
    expect(SHOPEE_SIGN_WINDOW_SECONDS).toBe(300);
  });
});

describe('signedQuery', () => {
  const base = {
    partnerId: DOC_PARTNER_ID,
    partnerKey: TEST_PARTNER_KEY,
    nowMs: 1_655_714_431_000,
  };

  it('puts exactly the three common params on a PUBLIC call', () => {
    const qs = signedQuery({ ...base, path: SHOPS_BY_PARTNER_PATH, call: { class: 'public' } });
    expect([...qs.keys()].sort()).toEqual(['partner_id', 'sign', 'timestamp']);
    expect(qs.get('partner_id')).toBe('2001887');
    expect(qs.get('timestamp')).toBe('1655714431');
    expect(qs.get('access_token')).toBeNull();
    expect(qs.get('shop_id')).toBeNull();
  });

  it('adds access_token and shop_id on a SHOP call', () => {
    const qs = signedQuery({
      ...base,
      path: SHOP_INFO_PATH,
      call: { class: 'shop', accessToken: DOC_ACCESS_TOKEN, shopId: DOC_SHOP_ID },
    });
    expect([...qs.keys()].sort()).toEqual([
      'access_token',
      'partner_id',
      'shop_id',
      'sign',
      'timestamp',
    ]);
    expect(qs.get('access_token')).toBe(DOC_ACCESS_TOKEN);
    expect(qs.get('shop_id')).toBe('14701711');
    expect(qs.get('sign')).toBe(
      signBaseString(
        shopBaseString({
          partnerId: DOC_PARTNER_ID,
          path: SHOP_INFO_PATH,
          timestamp: DOC_TIMESTAMP,
          accessToken: DOC_ACCESS_TOKEN,
          shopId: DOC_SHOP_ID,
        }),
        TEST_PARTNER_KEY,
      ),
    );
  });

  it('adds merchant_id, not shop_id, on a MERCHANT call', () => {
    const qs = signedQuery({
      ...base,
      path: SHOP_INFO_PATH,
      call: { class: 'merchant', accessToken: DOC_ACCESS_TOKEN, merchantId: 987 },
    });
    expect(qs.get('merchant_id')).toBe('987');
    expect(qs.get('shop_id')).toBeNull();
  });

  it('carries extras and drops undefined ones, without changing the sign', () => {
    // ⚠️ The signature covers neither the other query params nor a body. Two
    // calls that differ only in their extras have the SAME sign, and a future
    // reader must not "fix" that.
    const plain = signedQuery({
      ...base,
      path: SHOPS_BY_PARTNER_PATH,
      call: { class: 'public' },
    });
    const withExtras = signedQuery({
      ...base,
      path: SHOPS_BY_PARTNER_PATH,
      call: { class: 'public' },
      extra: { page_size: 100, page_no: 1, ausente: undefined },
    });
    expect(withExtras.get('page_size')).toBe('100');
    expect(withExtras.get('page_no')).toBe('1');
    expect(withExtras.has('ausente')).toBe(false);
    expect(withExtras.get('sign')).toBe(plain.get('sign'));
  });

  it('changes the sign when the clock moves by one second', () => {
    const a = signedQuery({ ...base, path: SHOP_INFO_PATH, call: { class: 'public' } });
    const b = signedQuery({
      ...base,
      nowMs: base.nowMs + 1000,
      path: SHOP_INFO_PATH,
      call: { class: 'public' },
    });
    expect(a.get('sign')).not.toBe(b.get('sign'));
  });

  it('changes the sign when the access token changes', () => {
    const call = (accessToken: string) =>
      signedQuery({
        ...base,
        path: SHOP_INFO_PATH,
        call: { class: 'shop', accessToken, shopId: DOC_SHOP_ID },
      }).get('sign');
    expect(call('token-a')).not.toBe(call('token-b'));
  });

  /* ------------------------------------------------------------------------ */
  /*            A chave repetida do `item_status` (passo 9)                    */
  /* ------------------------------------------------------------------------ */

  describe('um valor em ARRAY vira chave REPETIDA', () => {
    const chamar = (extra: Readonly<Record<string, ShopeeQueryValue>>) =>
      signedQuery({
        ...base,
        path: '/api/v2/product/get_item_list',
        call: { class: 'shop', accessToken: DOC_ACCESS_TOKEN, shopId: DOC_SHOP_ID },
        extra,
      });

    it('S1 — repete a chave uma vez por elemento, na ORDEM dada', () => {
      // ⚠️ A única frase explícita sobre repetição em todo o corpus da Shopee
      // está na página do `get_item_list`: "please upload the url like this:
      // item_status=NORMAL&item_status=BANNED".
      const qs = chamar({ item_status: ['NORMAL', 'UNLIST'] });
      expect(qs.getAll('item_status')).toEqual(['NORMAL', 'UNLIST']);
      // E na string crua, que é o que a Shopee lê.
      expect(qs.toString()).toContain('item_status=NORMAL&item_status=UNLIST');
    });

    it('S2 — um array NÃO muda a assinatura (mesmo sign que o escalar)', () => {
      // ⚠️ FOLD, par IGUAL: a base string não lê `extra`. Uma chamada com
      // `['NORMAL']` e outra com `'NORMAL'` assinam idêntico.
      expect(chamar({ item_status: ['NORMAL'] }).get('sign')).toBe(
        chamar({ item_status: 'NORMAL' }).get('sign'),
      );
    });

    it('S3 — ⛔ NEAR-MISS: dois arrays DIFERENTES têm o MESMO sign — a query não é assinada', () => {
      // O que muda é só a query. Quem "consertar" isso assinando os parâmetros
      // quebra todas as chamadas de uma vez, e o erro chega como `error_sign`,
      // que se lê como problema de credencial.
      const um = chamar({ item_status: ['NORMAL'] });
      const dois = chamar({ item_status: ['NORMAL', 'UNLIST'] });
      expect(dois.get('sign')).toBe(um.get('sign'));
      expect(dois.toString()).not.toBe(um.toString());
    });

    it('S4 — um array VAZIO não emite chave nenhuma', () => {
      // ⚠️ Igual a `undefined`: este módulo é um construtor de query e não tem
      // vocabulário de recusa. Quem recusa uma lista obrigatória vazia é o
      // guarda de `api.ts`, que sabe que o parâmetro é obrigatório.
      const qs = chamar({ item_status: [] });
      expect(qs.has('item_status')).toBe(false);
      expect(qs.getAll('item_status')).toEqual([]);
    });

    it('S5 — um escalar continua SUBSTITUINDO: nunca aparece duas vezes', () => {
      const qs = chamar({ page_size: 100 });
      expect(qs.getAll('page_size')).toEqual(['100']);
    });

    it('S6 — números dentro de um array são serializados como escalares', () => {
      const qs = chamar({ ids: [1, 2] });
      expect(qs.getAll('ids')).toEqual(['1', '2']);
      expect(qs.toString()).toContain('ids=1&ids=2');
    });

    it('S7 — `undefined` continua sendo descartado, com ou sem array por perto', () => {
      const qs = chamar({ item_status: ['NORMAL'], ausente: undefined });
      expect(qs.has('ausente')).toBe(false);
      expect(qs.getAll('item_status')).toEqual(['NORMAL']);
    });

    it('55 — um array não altera a base string de NENHUMA das três classes', () => {
      // ⚠️ A prova direta do invariante, classe por classe: `baseStringFor` lê
      // partner_id, path, timestamp (+ token e id) e NUNCA `extra`.
      const classes = [
        { class: 'public' } as const,
        { class: 'shop', accessToken: DOC_ACCESS_TOKEN, shopId: DOC_SHOP_ID } as const,
        { class: 'merchant', accessToken: DOC_ACCESS_TOKEN, merchantId: 987 } as const,
      ];
      for (const call of classes) {
        const semArray = signedQuery({ ...base, path: SHOP_INFO_PATH, call });
        const comArray = signedQuery({
          ...base,
          path: SHOP_INFO_PATH,
          call,
          extra: { item_status: ['NORMAL', 'UNLIST', 'BANNED'] },
        });
        expect(comArray.get('sign')).toBe(semArray.get('sign'));
        expect(comArray.getAll('item_status')).toHaveLength(3);
      }
    });
  });

  /* ------------------------------------------------------------------------ */
  /*        O corpo NÃO é assinado — nem o JSON, nem o multipart (passo 11)     */
  /* ------------------------------------------------------------------------ */

  describe('o corpo multipart não entra na base string', () => {
    // ⚠️ `sign.ts` não muda no passo 11, e ESTA é a afirmação que o prova. A base
    // string (`baseStringFor`) lê partner_id, path e timestamp (+ token e id) e
    // nunca o corpo — mas `signedQuery` sequer RECEBE um corpo, de modo que a
    // única forma de observar o invariante é pelo transporte, mandando dois
    // corpos diferentes e comparando os dois `sign`.
    const UPLOAD_PATH = '/api/v2/media_space/upload_image';
    const OUTRO_PATH = '/api/v2/media_space/upload_video';

    const corpo = (bytes: readonly number[], filename: string): ShopeeMultipartBody => ({
      file: {
        field: 'image',
        filename,
        contentType: 'image/png',
        bytes: new Uint8Array(bytes),
      },
    });

    async function assinarUpload(
      multipart: ShopeeMultipartBody,
      path = UPLOAD_PATH,
    ): Promise<string> {
      const fetchMock = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: '',
              message: null,
              warning: null,
              request_id: 'req-sign',
              response: {},
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
      await shopeeCall(
        {
          partnerId: DOC_PARTNER_ID,
          partnerKey: TEST_PARTNER_KEY,
          apiHost: 'https://partner.test-stable.shopeemobile.com',
          fetch: fetchMock,
          now: () => 1_655_714_431_000,
        },
        {
          method: 'POST',
          path,
          call: { class: 'public' },
          schema: z.object({}).passthrough(),
          surface: 'business',
          multipart,
        },
      );
      const assinatura = new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('sign');
      expect(assinatura).not.toBeNull();
      return assinatura!;
    }

    it('T3 — PAIR: dois BYTES diferentes produzem o MESMO sign', async () => {
      // A assinatura cobre partner_id + path + timestamp e mais nada. Quem
      // "consertar" isso passando o corpo para a base string quebra TODAS as
      // chamadas de uma vez, e a Shopee responde `error_sign` — que se lê como
      // problema de credencial, não como um refactor de ontem.
      const a = await assinarUpload(corpo([1, 2, 3], 'a.png'));
      const b = await assinarUpload(corpo([9, 9, 9, 9, 9], 'b.png'));
      expect(a).toBe(b);
    });

    it('T4 — ⛔ NEAR-MISS: um PATH diferente produz um sign DIFERENTE', async () => {
      // Sem este par, o T3 passaria até com uma assinatura calculada sobre
      // NADA. O path é o que precisa continuar dentro da base string.
      const a = await assinarUpload(corpo([1, 2, 3], 'a.png'), UPLOAD_PATH);
      const b = await assinarUpload(corpo([1, 2, 3], 'a.png'), OUTRO_PATH);
      expect(a).not.toBe(b);
      expect(a).toBe(
        signBaseString(
          publicBaseString({
            partnerId: DOC_PARTNER_ID,
            path: UPLOAD_PATH,
            timestamp: DOC_TIMESTAMP,
          }),
          TEST_PARTNER_KEY,
        ),
      );
    });
  });

  it('never puts the partner key in the query', () => {
    const qs = signedQuery({
      ...base,
      path: SHOP_INFO_PATH,
      call: { class: 'shop', accessToken: DOC_ACCESS_TOKEN, shopId: DOC_SHOP_ID },
      extra: { page_size: 50 },
    });
    for (const value of qs.values()) expect(value).not.toContain(TEST_PARTNER_KEY);
    expect(qs.toString()).not.toContain(TEST_PARTNER_KEY);
  });
});
