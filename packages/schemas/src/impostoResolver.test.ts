import { describe, expect, it } from 'vitest';

import { impostoProdutoSchema, impostoProdutoMeta } from './impostoProduto';
import { impostoCategoriaSchema, impostoCategoriaMeta } from './impostoCategoria';
import { regraImpostoSchema, regraImpostoMeta } from './regraImposto';

describe('impostoProdutoSchema', () => {
  it('accepts an empty doc (every field defaults)', () => {
    const out = impostoProdutoSchema.parse({});
    expect(out.id).toBeNull();
    // Flutter's typo wire key, preserved verbatim for legacy parity.
    expect(out.impostoOpercaoOuterRef).toBeNull();
    expect(out.timestamp).toBeNull();
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
  it('targets the categorias imposto subcollection (legacy Flutter wire name)', () => {
    expect(impostoCategoriaMeta.collectionPath).toBe('categorias/{categoriaId}/imposto');
  });

  it('accepts an empty doc with a typed imposto blob', () => {
    const out = impostoCategoriaSchema.parse({ configuracaoICMS: { crt: '1', csosn: '500' } });
    expect(out.configuracaoICMS).toEqual({ crt: '1', csosn: '500' });
  });

  it('keeps the legacy UPPERCASE CFOP as a read fallback alongside cfop (#467)', () => {
    const out = impostoCategoriaSchema.parse({ CFOP: '5405' });
    expect(out.CFOP).toBe('5405');
    expect(out.cfop ?? null).toBeNull();
  });

  it('models NVE as a string array, not a scalar (#467 wire audit)', () => {
    const out = impostoCategoriaSchema.parse({ NVE: ['12345678'] });
    expect(out.NVE).toEqual(['12345678']);
  });

  it('models indEscala as a boolean, not a string (#467 wire audit)', () => {
    const out = impostoCategoriaSchema.parse({ indEscala: false });
    expect(out.indEscala).toBe(false);
  });

  it('reads a legacy doc verbatim: UPPERCASE CFOP + array NVE + boolean indEscala', () => {
    const out = impostoCategoriaSchema.parse({
      impostoCategoriaOperacaoOuterRef: null,
      CFOP: '5405',
      origem: '0',
      NCM: '61091000',
      NVE: ['12345678'],
      indEscala: false,
      configuracaoICMS: { crt: '1', csosn: '102' },
    });
    expect(out.CFOP).toBe('5405');
    expect(out.NVE).toEqual(['12345678']);
    expect(out.indEscala).toBe(false);
  });

  // No `.passthrough()`: an unmodeled key is stripped on a lenient parse (the
  // read path, `parseSoftRead` in `@delfrance/data`) — this is what keeps a
  // legacy corpus doc carrying a since-retired field readable (root
  // `CLAUDE.md` rule 8) — but throws on the write path, which re-parses
  // strictly whenever the lenient parse dropped a caller-supplied key
  // (`parseForWrite`/`parseMergePatch`, `packages/data/src/zodParse.ts`).
  it('silently strips a genuinely unknown top-level key on a lenient (read) parse', () => {
    const parsed = impostoCategoriaSchema.parse({ origem: '0', someRetiredLegacyField: 'x' });
    expect(parsed).not.toHaveProperty('someRetiredLegacyField');
  });

  it('rejects a genuinely unknown top-level key on a strict (write) parse', () => {
    // Mirrors the `.strict()` re-parse `parseForWrite`/`parseMergePatch` run
    // internally once they notice the lenient parse above dropped a key.
    expect(() =>
      impostoCategoriaSchema.strict().parse({ origem: '0', someUnknownField: 'x' }),
    ).toThrow(/nrecognized/);
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

  it('accepts free-form NCM entries (legacy docs; matching normalizes digits-only)', () => {
    // A legacy `regras` doc with a formatted NCM must not fail the WHOLE doc
    // parse — the resolver compares digits-only, the form enforces 8 digits.
    const out = regraImpostoSchema.parse({ ncms: ['6109.10.00', '61091000'] });
    expect(out.ncms).toEqual(['6109.10.00', '61091000']);
  });

  it('keeps the legacy UPPERCASE CFOP as a read fallback alongside cfop', () => {
    const out = regraImpostoSchema.parse({ CFOP: '5405' });
    expect(out.CFOP).toBe('5405');
    expect(out.cfop ?? null).toBeNull();
  });

  it('targets the operacao regras subcollection (legacy Flutter wire name)', () => {
    expect(regraImpostoMeta.collectionPath).toBe('operacao/{operacaoId}/regras');
  });

  it('uses fresh permission bits, not aliased to existing ones', () => {
    // Byte 12 — relocated off 81-83, which collided with PERM.arquivo (80-82).
    expect(regraImpostoMeta.permissions.read).toBe(1n << 99n);
    expect(regraImpostoMeta.permissions.write).toBe(1n << 100n);
    expect(regraImpostoMeta.permissions.delete).toBe(1n << 101n);
  });
});
