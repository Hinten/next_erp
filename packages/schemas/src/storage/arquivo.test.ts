import { nowMicros } from '@delfrance/core/datetime';
import { describe, expect, it } from 'vitest';
import { arquivoMeta, arquivoSchema, filetypeFromMime, normalizeContentType } from './arquivo';

describe('normalizeContentType', () => {
  it('strips params, trims and lowercases', () => {
    expect(normalizeContentType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeContentType('Image/PNG')).toBe('image/png');
    expect(normalizeContentType('image/jpeg ; charset=binary')).toBe('image/jpeg');
  });
});

describe('filetypeFromMime', () => {
  it('buckets common MIME types like the Flutter FILETYPE.fromMime', () => {
    expect(filetypeFromMime('image/png')).toBe('image');
    expect(filetypeFromMime('image/webp')).toBe('image');
    expect(filetypeFromMime('video/mp4')).toBe('video');
    expect(filetypeFromMime('audio/mpeg')).toBe('audio');
    expect(filetypeFromMime('text/plain')).toBe('txt');
    expect(filetypeFromMime('text/html')).toBe('html');
    expect(filetypeFromMime('application/pdf')).toBe('document');
    expect(filetypeFromMime('application/zip')).toBe('application');
    expect(filetypeFromMime('font/woff2')).toBe('fallback');
  });

  it('tolerates full Content-Type headers (params + casing)', () => {
    expect(filetypeFromMime('text/plain; charset=utf-8')).toBe('txt');
    expect(filetypeFromMime('application/pdf; qs=0.9')).toBe('document');
    expect(filetypeFromMime('Image/PNG; charset=binary')).toBe('image');
  });
});

describe('arquivoSchema', () => {
  it('parses a minimal doc and applies defaults', () => {
    const out = arquivoSchema.parse({ filetype: 'image', filename: 'abc.jpeg' });
    expect(out.filepath).toBeNull();
    expect(out.originalFilename).toBeNull();
    expect(out.contentType).toBeNull();
    expect(out.url).toBeNull();
    expect(out.externalIds).toEqual([]);
    // resizeState defaults null — only product-image originals set 'pending'.
    expect(out.resizeState).toBeNull();
    // uploadState defaults null — create-first uploads set 'pending'.
    expect(out.uploadState).toBeNull();
  });

  it('accepts the uploadState marker', () => {
    expect(
      arquivoSchema.parse({ filetype: 'image', filename: 'a.png', uploadState: 'pending' })
        .uploadState,
    ).toBe('pending');
    expect(
      arquivoSchema.parse({ filetype: 'image', filename: 'a.png', uploadState: 'finalized' })
        .uploadState,
    ).toBe('finalized');
    expect(
      arquivoSchema.safeParse({ filetype: 'image', filename: 'a.png', uploadState: 'nope' })
        .success,
    ).toBe(false);
  });

  it('accepts the resizeState marker', () => {
    expect(
      arquivoSchema.parse({ filetype: 'image', filename: 'a.png', resizeState: 'pending' })
        .resizeState,
    ).toBe('pending');
    expect(
      arquivoSchema.parse({ filetype: 'image', filename: 'a.png', resizeState: 'done' })
        .resizeState,
    ).toBe('done');
    expect(
      arquivoSchema.safeParse({ filetype: 'image', filename: 'a.png', resizeState: 'nope' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown filetype and an empty filename', () => {
    expect(arquivoSchema.safeParse({ filetype: 'nope', filename: 'a' }).success).toBe(false);
    expect(arquivoSchema.safeParse({ filetype: 'image', filename: '' }).success).toBe(false);
  });

  // `createTime` is one of the keys the migrated corpus carries and this repo
  // does not model. The writer that stamped it is gone (there is no dual run —
  // root `CLAUDE.md` rule 8); the DATA arrives anyway, so `.passthrough()` has
  // to keep it or a round-trip through the schema would drop it on the next save.
  it('passes through fields the migrated corpus carries that we do not model', () => {
    const out = arquivoSchema.parse({
      filetype: 'image',
      filename: 'abc.jpeg',
      createTime: '2026-06-08T00:00:00.000Z',
    }) as Record<string, unknown>;
    expect(out.createTime).toBe('2026-06-08T00:00:00.000Z');
  });

  it('accepts externalIds and criadoEm (microseconds, tolerant of legacy ISO)', () => {
    const out = arquivoSchema.parse({
      filetype: 'image',
      filename: 'abc.jpeg',
      criadoEm: 1_700_000_000_000_000, // µs since epoch
      externalIds: [{ externalId: 'X1', integracaoPath: 'integracoes/abc' }],
    });
    expect(out.criadoEm).toBe(1_700_000_000_000_000);
    expect(out.externalIds[0]?.externalId).toBe('X1');

    // Legacy ISO-string criadoEm is coerced to microseconds on read.
    const legacy = arquivoSchema.parse({
      filetype: 'image',
      filename: 'abc.jpeg',
      criadoEm: '2026-06-08T00:00:00.000Z',
    });
    expect(legacy.criadoEm).toBe(Date.parse('2026-06-08T00:00:00.000Z') * 1000);
  });

  it('defaults criadoEm to nowMicros() when omitted (required, not nullable)', () => {
    const before = nowMicros();
    const out = arquivoSchema.parse({ filetype: 'image', filename: 'abc.jpeg' });
    expect(typeof out.criadoEm).toBe('number');
    expect(out.criadoEm).toBeGreaterThanOrEqual(before);
  });
});

describe('arquivoMeta', () => {
  it('targets the arquivos collection with the new byte-80 perms', () => {
    expect(arquivoMeta.collectionPath).toBe('arquivos');
    expect(arquivoMeta.permissions.read).toBe(1n << 80n);
    expect(arquivoMeta.permissions.write).toBe(1n << 81n);
    expect(arquivoMeta.permissions.delete).toBe(1n << 82n);
  });
});
