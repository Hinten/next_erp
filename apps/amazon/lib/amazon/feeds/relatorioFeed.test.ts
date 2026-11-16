/**
 * The processing report's reduction (step 12a, PR 12-b): attribution by `sku`
 * only, the link shape, the per-SKU and per-report bounds, the loggable codes.
 * Every report goes through the package's own reader first.
 */
import {
  type RelatorioProcessamentoListings,
  lerRelatorioProcessamentoListings,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it } from 'vitest';

import {
  MAX_CODIGOS_RELATORIO_FEED,
  MAX_PROBLEMAS_POR_SKU,
  MAX_SKUS_COM_PROBLEMA_GRAVADOS,
  type ProblemaSku,
  SEVERIDADE_ISSUE_FEED,
  reduzirRelatorioFeed,
  skusParaGravar,
} from './relatorioFeed';

const RESUMO = {
  errors: 3,
  warnings: 2,
  messagesProcessed: 40,
  messagesAccepted: 37,
  messagesInvalid: 1,
};

function relatorio(issues: readonly Record<string, unknown>[]): RelatorioProcessamentoListings {
  return lerRelatorioProcessamentoListings(
    JSON.stringify({
      header: { sellerId: 'AXXXXXXXXXXXXX', version: '2.0', feedId: '3485934' },
      issues,
      summary: RESUMO,
    }),
  );
}

const ERRO = SEVERIDADE_ISSUE_FEED.erro;
const AVISO = SEVERIDADE_ISSUE_FEED.aviso;

function problema(sku: string, severidade: string): ProblemaSku {
  return {
    code: '90220',
    message: `problema de ${sku}`,
    severity: severidade,
    attributeNames: null,
    categories: null,
  };
}

describe('reduzirRelatorioFeed', () => {
  it('the summary becomes the record’s resultado', () => {
    expect(reduzirRelatorioFeed(relatorio([])).resumo).toEqual({
      erros: 3,
      avisos: 2,
      processadas: 40,
      aceitas: 37,
      invalidas: 1,
    });
  });

  it('★ an issue with a sku goes to that SKU, in the link shape', () => {
    const r = reduzirRelatorioFeed(
      relatorio([
        {
          messageId: 1,
          sku: 'SKU-A',
          code: '90220',
          severity: ERRO,
          message: 'falta atributo',
          attributeName: 'x',
        },
      ]),
    );
    expect([...r.porSku.entries()]).toEqual([
      [
        'SKU-A',
        [
          {
            code: '90220',
            message: 'falta atributo',
            severity: ERRO,
            attributeNames: ['x'],
            categories: null,
          },
        ],
      ],
    ]);
    expect(r.semSku).toEqual({ erros: 0, avisos: 0 });
  });

  it('★ an issue with a messageId only, or an absent, null or empty sku, is feed-level (never by position)', () => {
    const r = reduzirRelatorioFeed(
      relatorio([
        { messageId: 1, code: '4000', severity: ERRO, message: 'sem sku' },
        { messageId: 2, sku: '', code: '4001', severity: AVISO, message: 'sku vazio' },
        { messageId: 3, sku: null, code: '4002', severity: ERRO, message: 'sku nulo' },
      ]),
    );
    expect(r.porSku.size).toBe(0);
    expect(r.semSku).toEqual({ erros: 2, avisos: 1 });
  });

  it('NEAR-MISS: attribution is EXACT — a case or space variant is ANOTHER SKU, never folded into the first', () => {
    const r = reduzirRelatorioFeed(
      relatorio([
        { sku: 'sku-a', severity: ERRO, message: 'x' },
        { sku: 'SKU-A ', severity: ERRO, message: 'y' },
        { sku: 'SKU-A', severity: ERRO, message: 'z' },
        { sku: 'SKU-A', severity: AVISO, message: 'w' },
      ]),
    );
    expect([...r.porSku.keys()]).toEqual(['sku-a', 'SKU-A ', 'SKU-A']);
    expect(r.porSku.get('SKU-A')?.map((p) => p.message)).toEqual(['z', 'w']);
    expect(r.porSku.get('sku-a')?.map((p) => p.message)).toEqual(['x']);
    expect(r.semSku).toEqual({ erros: 0, avisos: 0 });
  });

  it('a feed-level issue of another severity is not counted as an error or a warning', () => {
    const r = reduzirRelatorioFeed(
      relatorio([
        { severity: 'INFO', message: 'informativo' },
        { severity: 'error', message: 'minúsculo' },
      ]),
    );
    expect(r.semSku).toEqual({ erros: 0, avisos: 0 });
  });

  it('per SKU: ERROR first, then WARNING, then the rest, each in report order, at most 10', () => {
    const issues = [
      { sku: 'A', severity: 'INFO', message: 'i1' },
      { sku: 'A', severity: AVISO, message: 'w1' },
      { sku: 'A', severity: ERRO, message: 'e1' },
      { sku: 'A', severity: AVISO, message: 'w2' },
      { sku: 'A', severity: ERRO, message: 'e2' },
      ...Array.from({ length: 8 }, (_, i) => ({ sku: 'A', severity: ERRO, message: `e${i + 3}` })),
    ];
    const lista = reduzirRelatorioFeed(relatorio(issues)).porSku.get('A') ?? [];
    expect(MAX_PROBLEMAS_POR_SKU).toBe(10);
    expect(lista.map((p) => p.message)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
      'e7',
      'e8',
      'e9',
      'e10',
    ]);
    const poucas = reduzirRelatorioFeed(relatorio(issues.slice(0, 4))).porSku.get('A');
    expect(poucas?.map((p) => p.message)).toEqual(['e1', 'w1', 'w2', 'i1']);
  });

  it('attributeName is the one-element list; absent or empty ⇒ null; categories always null', () => {
    const r = reduzirRelatorioFeed(
      relatorio([
        { sku: 'A', severity: ERRO, message: 'a', attributeName: 'x' },
        { sku: 'A', severity: ERRO, message: 'b' },
        { sku: 'A', severity: ERRO, message: 'c', attributeName: '' },
      ]),
    );
    expect(r.porSku.get('A')?.map((p) => [p.attributeNames, p.categories])).toEqual([
      [['x'], null],
      [null, null],
      [null, null],
    ]);
  });

  it('never copies a key outside the link shape (the report issue is passthrough)', () => {
    const r = reduzirRelatorioFeed(
      relatorio([{ sku: 'A', severity: ERRO, message: 'a', messageId: 7, extra: 'x' }]),
    );
    expect(Object.keys(r.porSku.get('A')?.[0] ?? {}).sort()).toEqual([
      'attributeNames',
      'categories',
      'code',
      'message',
      'severity',
    ]);
  });

  it('codigos: the distinct loggable codes, sorted, bounded — never free text', () => {
    const r = reduzirRelatorioFeed(
      relatorio([
        { sku: 'A', code: '90220', severity: ERRO, message: 'a' },
        { code: '18027', severity: AVISO, message: 'b' },
        { sku: 'A', code: '90220', severity: ERRO, message: 'c' },
        { code: 'texto livre com espaços', severity: ERRO, message: 'd' },
      ]),
    );
    expect(r.codigos).toEqual(['18027', '90220']);
    const muitos = reduzirRelatorioFeed(
      relatorio(
        Array.from({ length: 30 }, (_, i) => ({
          code: `C${String(i).padStart(2, '0')}`,
          severity: ERRO,
          message: 'm',
        })),
      ),
    );
    expect(muitos.codigos).toHaveLength(MAX_CODIGOS_RELATORIO_FEED);
    expect(muitos.codigos[0]).toBe('C00');
  });
});

describe('skusParaGravar', () => {
  it('★ 201 SKUs with problems ⇒ 200 kept, the ERROR ones first, then SKU order', () => {
    const porSku = new Map<string, readonly ProblemaSku[]>();
    // 150 SKUs with a WARNING only, 51 with an ERROR — the ERROR ones sort LAST by SKU.
    for (let i = 0; i < 150; i += 1) {
      const sku = `A${String(i).padStart(3, '0')}`;
      porSku.set(sku, [problema(sku, AVISO)]);
    }
    for (let i = 0; i < 51; i += 1) {
      const sku = `Z${String(i).padStart(3, '0')}`;
      porSku.set(sku, [problema(sku, ERRO), problema(sku, AVISO)]);
    }
    const { problemas, omitidos } = skusParaGravar(porSku);
    expect(MAX_SKUS_COM_PROBLEMA_GRAVADOS).toBe(200);
    expect(problemas.size).toBe(200);
    expect(omitidos).toBe(1);
    const chaves = [...problemas.keys()];
    // NEAR-MISS: by SKU order alone, the 51 ERROR SKUs (Z…) would be the ones cut.
    expect(chaves.slice(0, 51)).toEqual(
      Array.from({ length: 51 }, (_, i) => `Z${String(i).padStart(3, '0')}`),
    );
    expect(chaves.slice(51)).toEqual(
      Array.from({ length: 149 }, (_, i) => `A${String(i).padStart(3, '0')}`),
    );
    expect(problemas.has('A149')).toBe(false);
    expect(problemas.get('Z000')).toBe(porSku.get('Z000'));
  });

  it('WARNING before anything else; SKU order is code-unit order, never a locale’s', () => {
    const porSku = new Map<string, readonly ProblemaSku[]>([
      ['b', [problema('b', 'INFO')]],
      ['a', [problema('a', 'INFO')]],
      ['c', [problema('c', AVISO)]],
      ['B', [problema('B', 'INFO')]],
    ]);
    expect([...skusParaGravar(porSku).problemas.keys()]).toEqual(['c', 'B', 'a', 'b']);
  });

  it('a report under the bound keeps everything, omitting nothing', () => {
    const porSku = new Map<string, readonly ProblemaSku[]>([['A', [problema('A', ERRO)]]]);
    expect(skusParaGravar(porSku).omitidos).toBe(0);
    expect(skusParaGravar(new Map()).problemas.size).toBe(0);
  });
});
