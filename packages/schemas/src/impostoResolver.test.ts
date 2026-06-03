import { describe, expect, it } from 'vitest';

import { impostoProdutoSchema, impostoProdutoMeta } from './impostoProduto';
import { impostoCategoriaSchema, impostoCategoriaMeta } from './impostoCategoria';
import { regraImpostoSchema, regraImpostoMeta } from './regraImposto';

describe('impostoProdutoSchema', () => {
  it('accepts an empty doc (every field defaults)', () => {
    const out = impostoProdutoSchema.parse({});
    expect(out.id).toBeNull();
    expect(out.impostoOperacaoOuterRef).toBeNull();
    expect(out.dataCadastro).toBeNull();
  });

  it('preserves a passthrough imposto blob', () => {
    const out = impostoProdutoSchema.parse({
      origem: '0',
      NCM: '61091000',
      configuracaoICMS: { crt: '1', csosn: '102' },
    });
    expect(out.origem).toBe('0');
    expect(out.NCM).toBe('61091000');
    expect(out.configuracaoICMS).toEqual({ crt: '1', csosn: '102' });
  });

  it('targets the produtos imposto subcollection', () => {
    expect(impostoProdutoMeta.collectionPath).toBe('produtos/{produtoId}/imposto');
  });
});

describe('impostoCategoriaSchema', () => {
  it('targets the categorias impostocategoria subcollection', () => {
    expect(impostoCategoriaMeta.collectionPath).toBe('categorias/{categoriaId}/impostocategoria');
  });

  it('accepts an empty doc with passthrough fields', () => {
    const out = impostoCategoriaSchema.parse({ configuracaoICMS: { crt: '1', csosn: '500' } });
    expect(out.configuracaoICMS).toEqual({ crt: '1', csosn: '500' });
  });
});

describe('regraImpostoSchema', () => {
  it('defaults matching arrays to empty', () => {
    const out = regraImpostoSchema.parse({});
    expect(out.produtos).toEqual([]);
    expect(out.categorias).toEqual([]);
    expect(out.ncms).toEqual([]);
  });

  it('accepts matching arrays + a passthrough imposto blob', () => {
    const out = regraImpostoSchema.parse({
      nome: 'Vestuário simples',
      produtos: ['prod-a', 'prod-b'],
      categorias: ['cat-1'],
      ncms: ['61091000', '62091000'],
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '102' },
    });
    expect(out.produtos).toHaveLength(2);
    expect(out.ncms).toEqual(['61091000', '62091000']);
    expect(out.configuracaoICMS).toEqual({ crt: '1', csosn: '102' });
  });

  it('rejects NCM entries that are not 8 digits', () => {
    expect(regraImpostoSchema.safeParse({ ncms: ['abc'] }).success).toBe(false);
    expect(regraImpostoSchema.safeParse({ ncms: ['12345'] }).success).toBe(false);
  });

  it('targets the operacao regraimposto subcollection', () => {
    expect(regraImpostoMeta.collectionPath).toBe('operacao/{operacaoId}/regraimposto');
  });

  it('uses fresh permission bits, not aliased to existing ones', () => {
    expect(regraImpostoMeta.permissions.read).toBe(1n << 81n);
    expect(regraImpostoMeta.permissions.write).toBe(1n << 82n);
    expect(regraImpostoMeta.permissions.delete).toBe(1n << 83n);
  });
});
