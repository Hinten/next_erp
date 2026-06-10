import { describe, expect, it } from 'vitest';
import { buildFotoRefs, fotoSchema } from './foto';

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

  it('passes through extra fields the Flutter app may write', () => {
    const out = fotoSchema.parse({
      arquivoOuterRef: 'arquivos/p1_h',
      variantePath: 'grupos/g1/variacoes/v1',
      legado: 123,
    }) as Record<string, unknown>;
    expect(out.variantePath).toBe('grupos/g1/variacoes/v1');
    expect(out.legado).toBe(123);
  });
});
