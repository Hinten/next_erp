import { describe, expect, it } from 'vitest';
import { transformCopiedMedidas } from './medidaFields';

describe('transformCopiedMedidas', () => {
  it('clears marketplace bindings and owned photos while preserving ordinary fields and legacy data', () => {
    const fotos = [{ arquivoOuterRef: 'arquivos/foto-1', legacyCaption: 'Medidas' }];
    const mercadoLivre = { conta: { tabelas: [{ id: 'ML-1' }] } };
    const shopee = { loja: [{ size_chart_id: 42 }] };
    const source = Object.freeze({
      nome: 'Camisetas',
      codigo: 'CAM',
      descricao: 'Medidas em centímetros',
      fotos,
      fotosArquivosIds: ['foto-1'],
      legacyField: { retained: true },
      tabelasDeMedidasMercadoLivre: mercadoLivre,
      tabelasMedidasShopee: shopee,
    });

    const copied = transformCopiedMedidas(source);

    expect(copied).toEqual({
      ...source,
      tabelasDeMedidasMercadoLivre: null,
      tabelasMedidasShopee: null,
      fotos: null,
      fotosArquivosIds: null,
    });
    expect(copied).not.toBe(source);
    expect(source.fotos).toBe(fotos);
    expect(source.fotosArquivosIds).toEqual(['foto-1']);
    expect(source.tabelasDeMedidasMercadoLivre).toBe(mercadoLivre);
    expect(source.tabelasMedidasShopee).toBe(shopee);
  });

  it.each([
    {},
    { tabelasDeMedidasMercadoLivre: null, tabelasMedidasShopee: null },
    { tabelasDeMedidasMercadoLivre: {}, tabelasMedidasShopee: {} },
    { fotos: [], fotosArquivosIds: [] },
  ])('writes explicit nulls for absent or empty bindings and media: %j', (bindings) => {
    const source = { nome: 'Tabela', fotos: null, ...bindings };
    const before = structuredClone(source);

    expect(transformCopiedMedidas(source)).toEqual({
      ...source,
      tabelasDeMedidasMercadoLivre: null,
      tabelasMedidasShopee: null,
      fotos: null,
      fotosArquivosIds: null,
    });
    expect(source).toEqual(before);
  });
});
