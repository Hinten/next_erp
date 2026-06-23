import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildXmlZip } from './buildXmlZip';
import { ExportIncompleteError, type ExportSource, type NfeNote } from './types';

function note(over: Partial<NfeNote> & { id: string }): NfeNote {
  return {
    chave: over.id,
    path: `pedidos/p/nfev4/${over.id}`,
    numeracao: 1,
    serie: 1,
    estado: 'a',
    dataEmissao: '2026-05-26T18:25:00.000Z',
    xmlNfeProc: `<x>${over.id}</x>`,
    ...over,
  };
}

async function* pagesOf(pages: NfeNote[][]): AsyncGenerator<NfeNote[]> {
  yield* pages;
}

function source(opts: { preCount: number; exact: boolean; pages: NfeNote[][] }): ExportSource {
  return {
    preCount: opts.preCount,
    exact: opts.exact,
    stamp: '20260501-20260531',
    pages: pagesOf(opts.pages),
  };
}

async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe('buildXmlZip', () => {
  it('zips every note that has xml + a manifest and finalizes a valid archive', async () => {
    const res = await buildXmlZip(
      source({
        preCount: 3,
        exact: true,
        pages: [
          [note({ id: 'aaa' }), note({ id: 'bbb', xmlNfeProc: null })],
          [note({ id: 'ccc' })],
        ],
      }),
    );

    expect(res.processed).toBe(3);
    expect(res.included).toBe(2);
    expect(res.filename).toBe('nfe-xmls-20260501-20260531.zip');

    const files = await unzip(res.blob);
    expect(Object.keys(files).sort()).toEqual([
      '_MANIFEST.csv',
      'aaa-procNFe.xml',
      'ccc-procNFe.xml',
    ]);
    expect(strFromU8(files['aaa-procNFe.xml']!)).toBe('<x>aaa</x>');

    const manifest = strFromU8(files['_MANIFEST.csv']!);
    expect(manifest).toContain('aaa');
    expect(manifest).toContain('ccc');
    expect(manifest).not.toContain('bbb'); // no xml → not in the zip nor the manifest
    expect(manifest).toContain('Total: 2');
  });

  it('throws ExportIncompleteError when an exact source scans fewer than preCount', async () => {
    await expect(
      buildXmlZip(source({ preCount: 5, exact: true, pages: [[note({ id: 'aaa' })]] })),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  });

  it('skips the completeness assert when the source is not exact', async () => {
    const res = await buildXmlZip(
      source({ preCount: 99, exact: false, pages: [[note({ id: 'aaa' })]] }),
    );
    expect(res.included).toBe(1);
  });
});
