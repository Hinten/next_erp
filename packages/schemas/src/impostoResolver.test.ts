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

  // NVE (wire: List<String>?) and indEscala (wire: bool?) are DELIBERATELY
  // kept as lenient strings, not retyped to match the wire — see the class
  // doc comment. The shared ImpostoConfigEditor renders both as plain text
  // inputs producing `string | null`, and `categoriaImpostoCarriesInfo`
  // (apps/web/lib/categorias/clientPort.ts) keys emptiness off
  // `typeof v === 'string'`; retyping either broke the categoria save path
  // (caught in review on #467's own PR).
  it('reads a legacy doc verbatim: UPPERCASE CFOP alongside string NVE/indEscala', () => {
    const out = impostoCategoriaSchema.parse({
      impostoCategoriaOperacaoOuterRef: null,
      CFOP: '5405',
      origem: '0',
      NCM: '61091000',
      NVE: 'some legacy value',
      indEscala: 'S',
      configuracaoICMS: { crt: '1', csosn: '102' },
    });
    expect(out.CFOP).toBe('5405');
    expect(out.NVE).toBe('some legacy value');
    expect(out.indEscala).toBe('S');
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

  it('defaults estados, NVE, indEscala and timeStamp to null', () => {
    const out = regraImpostoSchema.parse({});
    expect(out.estados).toBeNull();
    expect(out.NVE).toBeNull();
    expect(out.indEscala).toBeNull();
    expect(out.timeStamp).toBeNull();
  });

  it('reads a full legacy _$RegraImpostoToJson doc verbatim', () => {
    // Shape lifted from the legacy wire (issue #468): estados/timeStamp are
    // fields the old (nullable().optional()) schema silently dropped, and
    // NVE/indEscala carried the wrong scalar types.
    const out = regraImpostoSchema.parse({
      produtos: ['prod-a'],
      categorias: ['cat-1'],
      ncms: ['61091000'],
      CFOP: '5405',
      estados: ['SP', 'MG'],
      timeStamp: 1_700_000_000_000,
      NVE: ['12345678'],
      indEscala: true,
      configuracaoICMS: { crt: '1', csosn: '102' },
    });
    expect(out.estados).toEqual(['SP', 'MG']);
    expect(out.timeStamp).toBe(1_700_000_000_000);
    expect(out.NVE).toEqual(['12345678']);
    expect(out.indEscala).toBe(true);
  });

  it('rejects a genuinely unknown key on a strict (write-path) parse', () => {
    // Mirrors the strict re-check `parseForWrite`/`parseMergePatch`
    // (`@delfrance/data`) run internally on a dropped supplied key.
    expect(() => regraImpostoSchema.strict().parse({ typo: 1 })).toThrow(/unrecognized_keys|typo/);
  });

  it('tolerates the OLD scalar-string shape this app itself wrote for NVE/indEscala', () => {
    // Before this schema fixed their type, NVE/indEscala were z.string() and
    // MacrosTab's editor wrote plain strings through it — an already-stored
    // operacao/{id}/regras doc can carry that shape, and a bare type swap
    // would fail the WHOLE-DOCUMENT parse (dropping the rule from the NF-e
    // resolver's cascade, not just these two fields).
    const out = regraImpostoSchema.parse({ NVE: 'AB1234', indEscala: 'S' });
    expect(out.NVE).toEqual(['AB1234']);
    expect(out.indEscala).toBe(true);
  });

  it('parses a blank legacy NVE/indEscala string as null, not an empty array/false', () => {
    const out = regraImpostoSchema.parse({ NVE: '   ', indEscala: '' });
    expect(out.NVE).toBeNull();
    expect(out.indEscala).toBeNull();
  });

  it('parses the legacy indEscala negative words as false, case-insensitively', () => {
    for (const word of ['n', 'não', 'nao', 'NÃO', 'false', '0']) {
      expect(regraImpostoSchema.parse({ indEscala: word }).indEscala).toBe(false);
    }
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
