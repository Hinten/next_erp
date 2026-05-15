import { describe, expect, it } from 'vitest';
import {
  TIPO_VARIACAO,
  TIPO_VARIACAO_LABELS,
  externalVariacaoLinkSchema,
  grupoDeVariacoesMeta,
  grupoDeVariacoesSchema,
  tipoVariacaoSchema,
  varianteSchema,
} from './grupoDeVariacoes';

describe('grupoDeVariacoesSchema', () => {
  it('accepts a minimal valid group and applies defaults', () => {
    const out = grupoDeVariacoesSchema.parse({ nome: 'Tamanho' });
    expect(out).toMatchObject({
      nome: 'Tamanho',
      ordem: 1,
      permiteFotos: false,
      variacoesIds: [],
    });
  });

  it('rejects empty nome', () => {
    expect(grupoDeVariacoesSchema.safeParse({ nome: '' }).success).toBe(false);
  });

  it('round-trips an embedded variantes list', () => {
    const out = grupoDeVariacoesSchema.parse({
      nome: 'Cor',
      tipo: TIPO_VARIACAO.cor,
      variacoesIds: ['v1', 'v2'],
      variacoes: [
        { id: 'v1', nome: 'Azul' },
        { id: 'v2', nome: 'Verde', codigo: 'VRD' },
      ],
    });
    expect(out.variacoes).toHaveLength(2);
    expect(out.variacoes?.[1]?.codigo).toBe('VRD');
    expect(out.tipo).toBe(2);
  });

  it('rejects a tipo value outside {0,1,2}', () => {
    expect(
      grupoDeVariacoesSchema.safeParse({ nome: 'X', tipo: 9 }).success,
    ).toBe(false);
  });
});

describe('varianteSchema', () => {
  it('requires id and nome', () => {
    expect(varianteSchema.safeParse({ nome: 'Azul' }).success).toBe(false);
    expect(varianteSchema.safeParse({ id: 'v1' }).success).toBe(false);
    expect(varianteSchema.parse({ id: 'v1', nome: 'Azul' }).id).toBe('v1');
  });
});

describe('externalVariacaoLinkSchema', () => {
  it('accepts a valid link with INTEGRACAO_PEDIDO tipo', () => {
    const out = externalVariacaoLinkSchema.parse({
      tipo: 5, // shopee
      integracaoId: 'i1',
      externalId: 'shopee-sku-42',
    });
    expect(out.tipo).toBe(5);
  });

  it('rejects an unknown tipo', () => {
    expect(
      externalVariacaoLinkSchema.safeParse({
        tipo: 99,
        integracaoId: 'i1',
        externalId: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('tipoVariacaoSchema + labels', () => {
  it('has labels for every variant', () => {
    for (const key of Object.values(TIPO_VARIACAO)) {
      expect(TIPO_VARIACAO_LABELS[key]).toBeDefined();
      expect(tipoVariacaoSchema.safeParse(key).success).toBe(true);
    }
  });
});

describe('grupoDeVariacoesMeta', () => {
  it('targets the grupoDeVariacoes collection', () => {
    expect(grupoDeVariacoesMeta.collectionPath).toBe('grupoDeVariacoes');
  });

  it('reuses the produto BigInt permission bits', () => {
    expect(grupoDeVariacoesMeta.permissions.read).toBe(1n << 8n);
    expect(grupoDeVariacoesMeta.permissions.write).toBe(1n << 9n);
    expect(grupoDeVariacoesMeta.permissions.delete).toBe(1n << 10n);
  });
});
