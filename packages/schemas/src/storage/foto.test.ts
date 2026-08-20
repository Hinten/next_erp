import { describe, expect, it } from 'vitest';
import {
  buildFotoRefs,
  buildOriginalFotoRef,
  deriveFotosArquivosIds,
  fotoSchema,
  type Foto,
} from './foto';

describe('buildFotoRefs', () => {
  it('builds the optimistic arquivos/<id> ref strings (Flutter Foto wire shape)', () => {
    expect(buildFotoRefs('p1', 'h')).toEqual({
      arquivoOuterRef: 'arquivos/p1_h',
      arquivo200pxOuterRef: 'arquivos/p1_h_200',
      arquivo400pxOuterRef: 'arquivos/p1_h_400',
      arquivoJpegOuterRef: 'arquivos/p1_h_jpeg',
    });
  });
});

describe('buildOriginalFotoRef', () => {
  it('builds an original-only ref with null derivatives (a no-resize owner)', () => {
    expect(buildOriginalFotoRef('tm1_h')).toEqual({
      arquivoOuterRef: 'arquivos/tm1_h',
      arquivo200pxOuterRef: null,
      arquivo400pxOuterRef: null,
      arquivoJpegOuterRef: null,
    });
  });

  it('parses as a valid Foto and derives only the original id', () => {
    const foto = fotoSchema.parse(buildOriginalFotoRef('tm1_h'));
    expect(foto.arquivoOuterRef).toBe('arquivos/tm1_h');
    expect(deriveFotosArquivosIds([foto])).toEqual(['tm1_h']);
  });
});

describe('fotoSchema', () => {
  it('parses a minimal photo (only the original ref) and defaults the rest to null', () => {
    const out = fotoSchema.parse({ arquivoOuterRef: 'arquivos/p1_h' });
    expect(out.arquivo200pxOuterRef).toBeNull();
    expect(out.arquivo400pxOuterRef).toBeNull();
    expect(out.arquivoJpegOuterRef).toBeNull();
    expect(out.grupoDeVariacoesOuterRef).toBeNull();
    expect(out.variantePath).toBeNull();
  });

  it('accepts the full buildFotoRefs output as a valid Foto', () => {
    expect(fotoSchema.safeParse(buildFotoRefs('p1', 'h')).success).toBe(true);
  });

  it('requires a non-empty arquivoOuterRef', () => {
    expect(fotoSchema.safeParse({}).success).toBe(false);
    expect(fotoSchema.safeParse({ arquivoOuterRef: '' }).success).toBe(false);
  });

  it('passes through extra fields the migrated corpus may carry', () => {
    const out = fotoSchema.parse({
      arquivoOuterRef: 'arquivos/p1_h',
      variantePath: 'grupos/g1/variacoes/v1',
      legado: 123,
    }) as Record<string, unknown>;
    expect(out.variantePath).toBe('grupos/g1/variacoes/v1');
    expect(out.legado).toBe(123);
  });
});

describe('deriveFotosArquivosIds', () => {
  it('collects the bare original + 200px + 400px ids (Flutter wire shape), deduped', () => {
    const ids = deriveFotosArquivosIds([
      fotoSchema.parse(buildFotoRefs('p1', 'h1')),
      fotoSchema.parse(buildFotoRefs('p1', 'h2')),
    ]);
    // jpeg is intentionally excluded; the `arquivos/` prefix is stripped.
    expect(ids).toEqual(['p1_h1', 'p1_h1_200', 'p1_h1_400', 'p1_h2', 'p1_h2_200', 'p1_h2_400']);
  });

  it('skips missing derivative refs (resize not finished) and an empty list', () => {
    expect(
      deriveFotosArquivosIds([fotoSchema.parse({ arquivoOuterRef: 'arquivos/p1_h' })]),
    ).toEqual(['p1_h']);
    expect(deriveFotosArquivosIds([])).toEqual([]);
    expect(deriveFotosArquivosIds(null)).toEqual([]);
  });

  it('rejects a derivative ref that strips to an empty id (strict idRefSchema)', () => {
    expect(
      fotoSchema.safeParse({ arquivoOuterRef: 'arquivos/p1_h', arquivo200pxOuterRef: 'arquivos/' })
        .success,
    ).toBe(false);
  });

  it('skips a malformed derivative ref at runtime (defensive, non-schema data)', () => {
    const foto = {
      arquivoOuterRef: 'arquivos/p1_h',
      arquivo200pxOuterRef: 'arquivos/',
    } as unknown as Foto;
    expect(deriveFotosArquivosIds([foto])).toEqual(['p1_h']);
  });
});
