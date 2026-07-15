import { describe, expect, it } from 'vitest';
import {
  brandShopeeMeta,
  brandShopeeSchema,
  credenciaisIntegracaoMeta,
  credenciaisIntegracaoSchema,
  integracaoMeta,
  integracaoSchema,
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
  it('integracaoMeta targets integracao and cascades credenciais', () => {
    expect(integracaoMeta.collectionPath).toBe('integracao');
    expect(integracaoMeta.cascade).toEqual([
      { path: 'integracao/{integracaoId}/credenciais', onDelete: 'cascade' },
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
