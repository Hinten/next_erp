import { describe, expect, it } from 'vitest';

import { collectMediaRefs } from './mediaMarks';

// Pure unit suite — the ref-collection logic the trigger diffs. The mark/unmark
// I/O lives in onProdutoMediaChanged.storage.test.ts (emulator).
describe('collectMediaRefs', () => {
  it('collects fotos + videos + anexos arquivoOuterRefs', () => {
    const refs = collectMediaRefs({
      fotos: [{ arquivoOuterRef: 'arquivos/p_a' }, { arquivoOuterRef: 'arquivos/p_b' }],
      videos: [{ arquivoOuterRef: 'arquivos/p_v' }],
      // anexos are now product-scoped (produtos/<id>/anexos) → eagerly reaped too.
      anexos: [{ arquivoOuterRef: 'arquivos/anx1' }],
    });
    expect(refs).toEqual(
      new Set(['arquivos/p_a', 'arquivos/p_b', 'arquivos/p_v', 'arquivos/anx1']),
    );
  });

  it('tolerates undefined data, missing/null arrays and malformed elements', () => {
    expect(collectMediaRefs(undefined)).toEqual(new Set());
    expect(collectMediaRefs({})).toEqual(new Set());
    expect(collectMediaRefs({ fotos: null, videos: null })).toEqual(new Set());
    expect(
      collectMediaRefs({
        fotos: [
          null,
          {},
          { arquivoOuterRef: '' },
          { arquivoOuterRef: 42 },
          { arquivoOuterRef: 'arquivos/ok' },
        ],
      }),
    ).toEqual(new Set(['arquivos/ok']));
  });

  it('de-dups a ref repeated across elements', () => {
    expect(
      collectMediaRefs({
        fotos: [{ arquivoOuterRef: 'arquivos/x' }, { arquivoOuterRef: 'arquivos/x' }],
        videos: [{ arquivoOuterRef: 'arquivos/x' }],
      }),
    ).toEqual(new Set(['arquivos/x']));
  });
});
