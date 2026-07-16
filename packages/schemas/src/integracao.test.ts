import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  brandShopeeMeta,
  brandShopeeSchema,
  credenciaisIntegracaoMeta,
  credenciaisIntegracaoSchema,
  credenciaisWhatsappMeta,
  credenciaisWhatsappSchema,
  decodeHorarioMs,
  encodeHorarioMs,
  integracaoMeta,
  integracaoSchema,
  periodoWhatsappSchema,
} from './integracao';
import { ALL_DOMAINS } from './registry';

/* -------------------------------------------------------------------------- */
/*                          CredenciaisIntegracao                             */
/* -------------------------------------------------------------------------- */

describe('credenciaisIntegracaoSchema', () => {
  it('parses an OAuth credential doc', () => {
    const doc = {
      access_token: 'jwt.abc.def',
      refresh_token: 'r-123',
      expirationDate: 1718003600000,
    };
    expect(credenciaisIntegracaoSchema.parse(doc)).toMatchObject(doc);
  });

  it('preserves channel-specific OAuth extras via passthrough', () => {
    // Fields each channel returns on top of the uniform core — never modeled
    // explicitly, carried verbatim (Mercado Livre token_type/scope/user_id,
    // Amazon revoked, Magalu created_at, Shopee isRefreshing).
    const parsed = credenciaisIntegracaoSchema.parse({
      access_token: 'a',
      refresh_token: 'r',
      expirationDate: 1718003600000,
      token_type: 'Bearer',
      scope: 'read write',
      user_id: 123456,
      revoked: false,
      created_at: 1718000000000,
      isRefreshing: false,
    }) as Record<string, unknown>;
    expect(parsed.token_type).toBe('Bearer');
    expect(parsed.scope).toBe('read write');
    expect(parsed.user_id).toBe(123456);
    expect(parsed.revoked).toBe(false);
    expect(parsed.created_at).toBe(1718000000000);
    expect(parsed.isRefreshing).toBe(false);
  });

  it('requires access_token and refresh_token (non-empty)', () => {
    expect(
      credenciaisIntegracaoSchema.safeParse({ refresh_token: 'r', expirationDate: 1 }).success,
    ).toBe(false);
    expect(
      credenciaisIntegracaoSchema.safeParse({ access_token: 'a', expirationDate: 1 }).success,
    ).toBe(false);
    expect(
      credenciaisIntegracaoSchema.safeParse({
        access_token: '',
        refresh_token: 'r',
        expirationDate: 1,
      }).success,
    ).toBe(false);
  });

  it('requires a parseable expirationDate', () => {
    expect(
      credenciaisIntegracaoSchema.safeParse({ access_token: 'a', refresh_token: 'r' }).success,
    ).toBe(false);
    expect(
      credenciaisIntegracaoSchema.safeParse({
        access_token: 'a',
        refresh_token: 'r',
        expirationDate: 'not-a-date',
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                    integracaoSchema — per-channel account fields           */
/* -------------------------------------------------------------------------- */

describe('integracaoSchema per-channel fields', () => {
  const base = { nome: 'Conta teste' };

  it('parses Shopee shop_id and main_account_id', () => {
    const doc = { ...base, shop_id: 123456, main_account_id: 789 };
    const parsed = integracaoSchema.parse(doc);
    expect(parsed.shop_id).toBe(123456);
    expect(parsed.main_account_id).toBe(789);
  });

  it('defaults shop_id/main_account_id to null when absent', () => {
    const parsed = integracaoSchema.parse(base);
    expect(parsed.shop_id).toBeNull();
    expect(parsed.main_account_id).toBeNull();
  });

  it('parses Shopee tabelasAtacado wholesale tiers', () => {
    const doc = {
      ...base,
      tabelasAtacado: [
        {
          listaDePrecoAtacadoOuterRef: 'documents/listaDePrecos/lp1',
          min_count: 10,
          max_count: 49,
        },
        {
          listaDePrecoAtacadoOuterRef: 'documents/listaDePrecos/lp2',
          min_count: 50,
          max_count: 999,
        },
      ],
    };
    const parsed = integracaoSchema.parse(doc);
    expect(parsed.tabelasAtacado).toHaveLength(2);
    expect(parsed.tabelasAtacado?.[0]).toEqual({
      listaDePrecoAtacadoOuterRef: 'documents/listaDePrecos/lp1',
      min_count: 10,
      max_count: 49,
    });
  });

  it('rejects a tabelasAtacado entry with an invalid inner object', () => {
    expect(
      integracaoSchema.safeParse({
        ...base,
        tabelasAtacado: [
          { listaDePrecoAtacadoOuterRef: 'not-a-ref', min_count: 10, max_count: 49 },
        ],
      }).success,
    ).toBe(false);
    expect(
      integracaoSchema.safeParse({
        ...base,
        // min_count must be an int, not a string
        tabelasAtacado: [
          {
            listaDePrecoAtacadoOuterRef: 'documents/listaDePrecos/lp1',
            min_count: '10',
            max_count: 49,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('parses Amazon selling_partner_id and Magalu tenant_id', () => {
    const doc = { ...base, selling_partner_id: 'A1B2C3D4E5', tenant_id: 'tenant-xyz' };
    const parsed = integracaoSchema.parse(doc);
    expect(parsed.selling_partner_id).toBe('A1B2C3D4E5');
    expect(parsed.tenant_id).toBe('tenant-xyz');
  });

  it('parses Mercado Livre Mercado-Shops price table outer refs', () => {
    const doc = {
      ...base,
      tabelaMercadoShopsOuterRef: 'documents/listaDePrecos/ms1',
      tabelaMercadoShopsPromocionalOuterRef: 'documents/listaDePrecos/ms2',
    };
    const parsed = integracaoSchema.parse(doc);
    expect(parsed.tabelaMercadoShopsOuterRef).toBe('documents/listaDePrecos/ms1');
    expect(parsed.tabelaMercadoShopsPromocionalOuterRef).toBe('documents/listaDePrecos/ms2');
  });

  it('parses modalidadeFreteImportacao as a string enum, including null', () => {
    expect(
      integracaoSchema.parse({ ...base, modalidadeFreteImportacao: '0' }).modalidadeFreteImportacao,
    ).toBe('0');
    expect(
      integracaoSchema.parse({ ...base, modalidadeFreteImportacao: '4' }).modalidadeFreteImportacao,
    ).toBe('4');
    expect(
      integracaoSchema.parse({ ...base, modalidadeFreteImportacao: '9' }).modalidadeFreteImportacao,
    ).toBe('9');
    expect(
      integracaoSchema.parse({ ...base, modalidadeFreteImportacao: null })
        .modalidadeFreteImportacao,
    ).toBeNull();
    expect(integracaoSchema.parse(base).modalidadeFreteImportacao).toBeNull();
  });

  it('rejects a numeric modalidadeFreteImportacao (legacy serializes it as a string)', () => {
    expect(integracaoSchema.safeParse({ ...base, modalidadeFreteImportacao: 3 }).success).toBe(
      false,
    );
  });

  it('passes a legacy Loja Integrada doc with token_id through untouched (not modeled)', () => {
    const doc = {
      ...base,
      tipo: 3,
      token_id: 'li-static-api-key-abc123',
    };
    const parsed = integracaoSchema.parse(doc) as Record<string, unknown>;
    expect(parsed.token_id).toBe('li-static-api-key-abc123');
  });
});

/* -------------------------------------------------------------------------- */
/*                    integracaoSchema — WhatsApp flat fields                 */
/* -------------------------------------------------------------------------- */

describe('integracaoSchema WhatsApp fields', () => {
  const base = { nome: 'Conta teste' };

  it('parses a marketplace doc with no WhatsApp fields (all default to null)', () => {
    const parsed = integracaoSchema.parse(base);
    expect(parsed.wa_id).toBeNull();
    expect(parsed.phoneNumberId).toBeNull();
    expect(parsed.numero).toBeNull();
    expect(parsed.verificado).toBe(false);
    expect(parsed.mensagem_automatica).toBeNull();
    expect(parsed.mensagem_inatividade).toBeNull();
    expect(parsed.horario_funcionamento).toBeNull();
  });

  it('parses a WhatsApp account doc with wa_id carrying the phone_number_id', () => {
    const doc = {
      ...base,
      tipo: 6,
      wa_id: '109876543210',
      phoneNumberId: '109876543210',
      numero: '5511999998888',
      verificado: true,
      mensagem_automatica: 'Obrigado por entrar em contato!',
      mensagem_inatividade: 'Estamos fora do horário de atendimento.',
    };
    const parsed = integracaoSchema.parse(doc);
    expect(parsed.wa_id).toBe('109876543210');
    expect(parsed.phoneNumberId).toBe('109876543210');
    expect(parsed.numero).toBe('5511999998888');
    expect(parsed.verificado).toBe(true);
    expect(parsed.mensagem_automatica).toBe('Obrigado por entrar em contato!');
    expect(parsed.mensagem_inatividade).toBe('Estamos fora do horário de atendimento.');
  });

  it('rejects a mensagem_automatica/mensagem_inatividade over 255 chars', () => {
    expect(
      integracaoSchema.safeParse({ ...base, mensagem_automatica: 'a'.repeat(256) }).success,
    ).toBe(false);
    expect(
      integracaoSchema.safeParse({ ...base, mensagem_inatividade: 'a'.repeat(256) }).success,
    ).toBe(false);
  });

  it('parses horario_funcionamento with a legacy-shaped Periodo_Whatsapp fixture', () => {
    // Mirrors `_fromJsonListPeriodo` — an array of Periodo_Whatsapp, each a
    // sparse map of weekday -> Horario_Whatsapp (abertura/fechamento ms epoch).
    const doc = {
      ...base,
      horario_funcionamento: [
        {
          segunda: { abertura: 1718000000000, fechamento: 1718028000000 },
          terca: { abertura: 1718000000000, fechamento: 1718028000000 },
          quarta: null,
        },
      ],
    };
    const parsed = integracaoSchema.parse(doc);
    expect(parsed.horario_funcionamento).toHaveLength(1);
    const periodo = parsed.horario_funcionamento?.[0];
    expect(periodo?.segunda).toEqual({ abertura: 1718000000000, fechamento: 1718028000000 });
    expect(periodo?.terca).toEqual({ abertura: 1718000000000, fechamento: 1718028000000 });
    expect(periodo?.quarta).toBeNull();
    expect(periodo?.domingo).toBeUndefined();
  });

  it('periodoWhatsappSchema exposes all 7 weekday keys, each nullish', () => {
    expect(periodoWhatsappSchema.parse({})).toEqual({});
    const full = periodoWhatsappSchema.parse({
      domingo: { abertura: 1, fechamento: 2 },
      segunda: null,
      terca: null,
      quarta: null,
      quinta: null,
      sexta: null,
      sabado: { abertura: 3, fechamento: 4 },
    });
    expect(full.domingo).toEqual({ abertura: 1, fechamento: 2 });
    expect(full.sabado).toEqual({ abertura: 3, fechamento: 4 });
    expect(full.segunda).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*          Horario_Whatsapp abertura/fechamento wire codec (golden)          */
/* -------------------------------------------------------------------------- */

describe('encodeHorarioMs / decodeHorarioMs', () => {
  // Round-trip is timezone-INDEPENDENT: encode then decode always yields the
  // same wall clock, whatever the runner's local zone (local → local, the
  // legacy UI contract). See the codec doc comment in `integracao.ts`.
  it('round-trips every wall-clock time back to itself (decode(encode(h,m)) === {h,m})', () => {
    for (const [hour, minute] of [
      [0, 0],
      [8, 0],
      [9, 5],
      [12, 30],
      [18, 30],
      [23, 59],
    ] as const) {
      expect(decodeHorarioMs(encodeHorarioMs(hour, minute))).toEqual({ hour, minute });
    }
  });

  describe('against a hand-computed legacy value (pinned to UTC)', () => {
    // Under a UTC clock the legacy anchor `DateTime(0,1,1,h,m)` collapses to
    // year0-Jan1 with no timezone offset, so we can hand-derive the exact ms and
    // assert byte-compatibility with Dart's `.millisecondsSinceEpoch`.
    //
    //   proleptic-Gregorian days from 0000-01-01 to 1970-01-01
    //     = 1970*365 + leapDays(0..1969)
    //     = 719050 + (493 − 20 + 5) = 719050 + 478 = 719528 days
    //   year0-Jan1 00:00:00 UTC = −719528 * 86_400_000 = −62_167_219_200_000 ms
    const YEAR0_JAN1_UTC_MS = -62_167_219_200_000;
    const HOUR_MS = 60 * 60 * 1000;

    let originalTz: string | undefined;
    beforeAll(() => {
      originalTz = process.env.TZ;
      process.env.TZ = 'UTC';
    });
    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('encodes 08:00 to the exact legacy ms Dart would write (year0 + 8h)', () => {
      expect(encodeHorarioMs(8, 0)).toBe(YEAR0_JAN1_UTC_MS + 8 * HOUR_MS);
      expect(encodeHorarioMs(8, 0)).toBe(-62_167_190_400_000);
    });

    it('encodes midnight to the bare year-0 anchor', () => {
      expect(encodeHorarioMs(0, 0)).toBe(YEAR0_JAN1_UTC_MS);
    });

    it('decodes a legacy-written value back to the wall clock it stored', () => {
      // −62_167_190_400_000 is exactly what legacy Dart writes for 08:00 under
      // UTC — decoding it must recover { hour: 8, minute: 0 }.
      expect(decodeHorarioMs(-62_167_190_400_000)).toEqual({ hour: 8, minute: 0 });
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                    CredenciaisWhatsapp (subcollection)                     */
/* -------------------------------------------------------------------------- */

describe('credenciaisWhatsappSchema', () => {
  it('parses a permanent-token doc', () => {
    const doc = {
      permanent_token: 'EAAG...permanent',
      phoneNumberId: '109876543210',
      wa_id: '109876543210',
      createdAt: 1718003600000,
    };
    expect(credenciaisWhatsappSchema.parse(doc)).toMatchObject(doc);
  });

  it('requires a non-empty permanent_token', () => {
    expect(credenciaisWhatsappSchema.safeParse({ phoneNumberId: null, wa_id: null }).success).toBe(
      false,
    );
    expect(
      credenciaisWhatsappSchema.safeParse({
        permanent_token: '',
        phoneNumberId: null,
        wa_id: null,
      }).success,
    ).toBe(false);
  });

  it('defaults phoneNumberId/wa_id/createdAt to null when absent', () => {
    const parsed = credenciaisWhatsappSchema.parse({ permanent_token: 'tok' });
    expect(parsed.phoneNumberId).toBeNull();
    expect(parsed.wa_id).toBeNull();
    expect(parsed.createdAt).toBeNull();
  });

  it('targets the credenciaisWhatsapp subcollection path', () => {
    expect(credenciaisWhatsappMeta.collectionPath).toBe(
      'integracao/{integracaoId}/credenciaisWhatsapp',
    );
  });

  it('is admin-only / default-deny: zero perms (mirrors credenciaisIntegracao)', () => {
    expect(credenciaisWhatsappMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });

  it('is NOT registered in ALL_DOMAINS (server-only secret store)', () => {
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(paths).not.toContain('integracao/{integracaoId}/credenciaisWhatsapp');
  });
});

/* -------------------------------------------------------------------------- */
/*                          BrandShopee (subcollection)                       */
/* -------------------------------------------------------------------------- */

describe('brandShopee', () => {
  it('passes a Shopee brand cache doc through untouched (loose passthrough)', () => {
    const doc = {
      brand_id: 12345,
      original_brand_name: 'Acme',
      display_brand_name: 'Acme Brasil',
    };
    expect(brandShopeeSchema.parse(doc)).toEqual(doc);
  });

  it('targets the brandshopee subcollection path', () => {
    expect(brandShopeeMeta.collectionPath).toBe('integracao/{integracaoId}/brandshopee');
  });

  it('reuses the parent integracao permission bits exactly', () => {
    expect(brandShopeeMeta.permissions).toEqual(integracaoMeta.permissions);
  });

  it('is registered in ALL_DOMAINS', () => {
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(paths).toContain('integracao/{integracaoId}/brandshopee');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Metas                                     */
/* -------------------------------------------------------------------------- */

describe('integracao metas', () => {
  it('integracaoMeta targets integracao and cascades credenciais + credenciaisWhatsapp', () => {
    expect(integracaoMeta.collectionPath).toBe('integracao');
    expect(integracaoMeta.cascade).toEqual([
      { path: 'integracao/{integracaoId}/credenciais', onDelete: 'cascade' },
      { path: 'integracao/{integracaoId}/credenciaisWhatsapp', onDelete: 'cascade' },
    ]);
  });

  it('credenciaisIntegracaoMeta targets the subcollection', () => {
    expect(credenciaisIntegracaoMeta.collectionPath).toBe('integracao/{integracaoId}/credenciais');
  });

  it('keeps the integracao parent on its own byte (56–58)', () => {
    expect(integracaoMeta.permissions).toEqual({
      read: 1n << 56n,
      write: 1n << 57n,
      delete: 1n << 58n,
    });
  });

  it('is admin-only / default-deny: zero perms (mirrors certificadoSecreto)', () => {
    // The credential doc holds live refresh tokens. No client domain grants
    // these bits; the domain is left out of ALL_DOMAINS so rules-gen emits no
    // block and Firestore default-denies every client. Only the Admin SDK reaches it.
    expect(credenciaisIntegracaoMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });

  it('is NOT registered in ALL_DOMAINS (server-only secret store)', () => {
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(paths).not.toContain('integracao/{integracaoId}/credenciais');
  });
});
