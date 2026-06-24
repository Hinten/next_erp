import { describe, expect, it } from 'vitest';

import { buildCsvReport } from './buildCsvReport';
import { FIXTURE_ENTRADA, FIXTURE_SAIDA } from './procnfeFixture';
import { ExportIncompleteError, type ExportSource, type NfeNote } from './types';

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

describe('buildCsvReport', () => {
  it('builds a BOM CSV with header, rows, blank cols for no-xml notes, and the totals trailer', async () => {
    const notes: NfeNote[] = [
      {
        id: 'a',
        path: 'pedidos/p1/nfev4/a',
        chave: 'a',
        numeracao: 7,
        serie: 1,
        estado: 'a',
        dataEmissao: new Date('2026-05-26T18:25:00.000Z').getTime(),
        xmlNfeProc: FIXTURE_SAIDA,
      },
      {
        id: 'b',
        path: 'pedidos/p2/nfev4/b',
        chave: 'b',
        numeracao: 8,
        serie: 1,
        estado: 'a',
        dataEmissao: new Date('2026-05-27T12:00:00.000Z').getTime(),
        xmlNfeProc: FIXTURE_ENTRADA,
      },
      {
        id: 'c',
        path: 'pedidos/p3/nfev4/c',
        chave: 'c',
        numeracao: 9,
        serie: 1,
        estado: 'n',
        dataEmissao: new Date('2026-05-27T12:00:00.000Z').getTime(),
        xmlNfeProc: null,
      },
    ];

    const res = await buildCsvReport(source({ preCount: 3, exact: true, pages: [notes] }));
    expect(res.processed).toBe(3);
    expect(res.filename).toBe('nfe-relatorio-20260501-20260531.csv');

    // The blob's bytes start with the UTF-8 BOM (EF BB BF) — what Excel needs.
    // `blob.text()` strips a leading BOM on decode, so assert on the raw bytes.
    const bytes = new Uint8Array(await res.blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const text = await res.blob.text();
    expect(text).toContain('Série;Número;Status');
    expect(text).toMatch(/;103,00/); // saída total
    expect(text).toMatch(/;50,00/); // entrada total
    expect(text).toContain('Total Saídas;');
    expect(text).toContain('Total de notas: 3'); // completeness marker
    // Faturamento = saídas(103,00) - entradas(50,00) = 53,00
    expect(text).toMatch(/Faturamento Total[^\n]*;53,00/);
  });

  it('sorts the report rows by (série, número), even across pages and out-of-order input', async () => {
    const note = (serie: number, numeracao: number): NfeNote => ({
      id: `${serie}-${numeracao}`,
      path: `pedidos/p${serie}-${numeracao}/nfev4/s1`,
      chave: `${serie}-${numeracao}`,
      numeracao,
      serie,
      estado: 'a',
      dataEmissao: null,
      xmlNfeProc: null,
    });
    // Out of order, and split across pages: 1/8 + 2/5, then 1/7.
    const res = await buildCsvReport(
      source({
        preCount: 3,
        exact: false,
        pages: [[note(1, 8), note(2, 5)], [note(1, 7)]],
      }),
    );
    const dataLines = (await res.blob.text()).split('\r\n').slice(1, 4);
    expect(dataLines.map((l) => l.split(';').slice(0, 2).join('/'))).toEqual(['1/7', '1/8', '2/5']);
  });

  it('throws ExportIncompleteError when an exact source scans fewer than preCount', async () => {
    await expect(
      buildCsvReport(
        source({
          preCount: 9,
          exact: true,
          pages: [
            [
              {
                id: 'a',
                path: 'pedidos/p1/nfev4/a',
                chave: 'a',
                numeracao: 1,
                serie: 1,
                estado: 'a',
                dataEmissao: null,
                xmlNfeProc: null,
              },
            ],
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  });
});
