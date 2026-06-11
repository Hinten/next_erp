import { describe, expect, it } from 'vitest';
import { videoSchema } from './video';

describe('videoSchema', () => {
  it('parses a minimal video (only the ref) and defaults the rest', () => {
    const out = videoSchema.parse({ arquivoOuterRef: 'arquivos/p1_h' });
    expect(out.formato).toBeNull();
    expect(out.duracaoSegundos).toBeNull();
    expect(out.larguraPx).toBeNull();
    expect(out.usarMercadoLivre).toBe(false);
    expect(out.usarShopee).toBe(false);
    expect(out.nomeArquivo).toBeNull();
  });

  it('parses a full Flutter VideoProduto-shaped doc unchanged', () => {
    const wire = {
      arquivoOuterRef: 'arquivos/p1_h',
      formato: 'quadrado',
      duracaoSegundos: 42,
      larguraPx: 1080,
      alturaPx: 1080,
      usarMercadoLivre: true,
      usarShopee: true,
      dataCadastro: 1_700_000_000_000,
      nomeArquivo: 'clip.mp4',
    };
    expect(videoSchema.parse(wire)).toMatchObject(wire);
  });

  it('requires a non-empty arquivoOuterRef and a valid formato', () => {
    expect(videoSchema.safeParse({}).success).toBe(false);
    expect(videoSchema.safeParse({ arquivoOuterRef: '' }).success).toBe(false);
    expect(
      videoSchema.safeParse({ arquivoOuterRef: 'arquivos/x', formato: 'paisagem' }).success,
    ).toBe(false);
  });

  it('coerces null/absent marketplace-compat flags to false (Flutter `as bool? ?? false`)', () => {
    const out = videoSchema.parse({
      arquivoOuterRef: 'arquivos/x',
      usarMercadoLivre: null,
      usarShopee: null,
    });
    expect(out.usarMercadoLivre).toBe(false);
    expect(out.usarShopee).toBe(false);
  });
});
