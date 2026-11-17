/**
 * The discovery planner: the tick's window and the recovery's window with its
 * keep rule (the 5-minute range, the 20-s commit margin, the pending start),
 * forcing, the units, and the path from estoque rows to the conta's SKUs with
 * their observations.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON } from '@delfrance/schemas';

import {
  ADIANTAMENTO_MAXIMO_MS,
  ESPACO_ENTRE_SNAPSHOTS_MS,
  type JanelaEstoqueAmazon,
  JANELA_MAXIMA_MS,
  LINHAS_POR_PAGINA_JANELA,
  type LinhaJanelaEstoqueAmazon,
  MARGEM_COMMIT_MS,
  SOBREPOSICAO_CATCH_UP_MS,
  SOBREPOSICAO_MS,
  TETO_PAGINAS_JANELA,
  forcarSku,
  janelaDaRecuperacao,
  janelaDoTick,
  manterLinha,
  observacoesDaJanela,
  partesDoCommit,
  produtosDaJanela,
  skusDaConta,
  sondasDoProduto,
} from './descobertaEstoque';
import { partesDoCaminhoEstoqueAmazon } from './familiaEstoque';

const SEG = 1_000;
const MIN = 60 * SEG;
/** ms — a snapshot S (2027-01-15T08:00:00Z). */
const S = 1_800_000_000_000;
const CONTA = 'conta-1';

/** An estoque row of `produto`, stamped `carimboMs`, committed at `commitMs`. */
function linha(
  produto: string,
  carimboMs: number,
  commitMs: number = carimboMs,
  doc = 'dep-1',
): LinhaJanelaEstoqueAmazon {
  return {
    caminho: `produtos/${produto}/estoques/${doc}`,
    ultimaModificacao: carimboMs,
    updateTime: Timestamp.fromMillis(commitMs),
  };
}

/** The recovery window of S with no pending start, read at S + 10 min. */
function catchUp(): JanelaEstoqueAmazon {
  const j = janelaDaRecuperacao({ snapshotEmMs: S, pendenteDesdeMs: null, agoraMs: S + 10 * MIN });
  if (j === null) throw new Error('fixture: janela esperada');
  return j;
}

describe('the constants', () => {
  it('pins every bound by value', () => {
    expect(SOBREPOSICAO_MS).toBe(20_000);
    expect(JANELA_MAXIMA_MS).toBe(86_400_000);
    expect(SOBREPOSICAO_CATCH_UP_MS).toBe(300_000);
    expect(MARGEM_COMMIT_MS).toBe(20_000);
    expect(ESPACO_ENTRE_SNAPSHOTS_MS).toBe(40_000);
    expect(TETO_PAGINAS_JANELA).toBe(10);
    expect(LINHAS_POR_PAGINA_JANELA).toBe(300);
    expect(ADIANTAMENTO_MAXIMO_MS).toBe(86_400_000);
  });

  it('the commit margin IS the tick’s overlap, and snapshots are spaced by two margins', () => {
    expect(MARGEM_COMMIT_MS).toBe(SOBREPOSICAO_MS);
    expect(ESPACO_ENTRE_SNAPSHOTS_MS).toBe(2 * MARGEM_COMMIT_MS);
  });

  it('the window cap (10 pages × 300 rows) IS the delta-feed bound', () => {
    expect(TETO_PAGINAS_JANELA * LINHAS_POR_PAGINA_JANELA).toBe(MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON);
  });
});

describe('★ the tick’s window', () => {
  it('is (cursorMs − 20 s, agoraMs], keeps every row, and is not truncated', () => {
    const j = janelaDoTick({ cursorMs: S, agoraMs: S + 5 * MIN });
    expect(j).toEqual({
      desdeMs: S - 20 * SEG,
      ateMs: S + 5 * MIN,
      manterDesdeMs: S - 20 * SEG,
      commitAposMs: null,
      truncada: false,
    });
    if (j === null) throw new Error('janela esperada');
    // Every row in range is kept, however old its commit; the bounds are (desde, ate].
    expect(manterLinha(linha('P', S - 19 * SEG, S - 10 * MIN), j)).toBe(true);
    expect(manterLinha(linha('P', S + 5 * MIN), j)).toBe(true);
    expect(manterLinha(linha('P', S - 20 * SEG), j)).toBe(false);
    expect(manterLinha(linha('P', S + 5 * MIN + 1), j)).toBe(false);
    expect(forcarSku([linha('P', S + MIN)], j)).toBe(false);
  });

  it('a cursor older than 24 h is clamped to agora − 24 h, and truncada', () => {
    const agoraMs = S + 30 * 60 * MIN;
    const j = janelaDoTick({ cursorMs: S, agoraMs });
    expect(j).toMatchObject({
      desdeMs: agoraMs - JANELA_MAXIMA_MS,
      ateMs: agoraMs,
      truncada: true,
    });
  });

  it('NEAR-MISS: a cursor exactly 24 h − 20 s old is not clamped', () => {
    const agoraMs = S - 20 * SEG + JANELA_MAXIMA_MS;
    expect(janelaDoTick({ cursorMs: S, agoraMs })).toMatchObject({
      desdeMs: S - 20 * SEG,
      truncada: false,
    });
  });

  it('a cursor ahead of this clock by more than the overlap ⇒ no window (the cursor never moves back)', () => {
    expect(janelaDoTick({ cursorMs: S + 21 * SEG, agoraMs: S })).toBeNull();
    expect(janelaDoTick({ cursorMs: S + 20 * SEG, agoraMs: S })).toBeNull();
    expect(janelaDoTick({ cursorMs: S + 19 * SEG, agoraMs: S })).toMatchObject({
      desdeMs: S - SEG,
      ateMs: S,
    });
  });

  it('refuses an instant that is not ms', () => {
    expect(() => janelaDoTick({ cursorMs: -1, agoraMs: S })).toThrow(/cursorMs/);
    expect(() => janelaDoTick({ cursorMs: S, agoraMs: 1.5 })).toThrow(/agoraMs/);
  });

  it('★ a cursor far AHEAD (a µs value) is thrown, never a silent "no window" that freezes the tick', () => {
    expect(() => janelaDoTick({ cursorMs: S * 1_000, agoraMs: S })).toThrow(RangeError);
    expect(() => janelaDoTick({ cursorMs: S * 1_000, agoraMs: S })).toThrow(/cursorMs/);
    expect(() => janelaDoTick({ cursorMs: S + 25 * 60 * MIN, agoraMs: S })).toThrow(/cursorMs/);
    expect(() => janelaDoTick({ cursorMs: S + ADIANTAMENTO_MAXIMO_MS + 1, agoraMs: S })).toThrow(
      RangeError,
    );
  });

  it('NEAR-MISS: a skewed clock (21 s ahead) or exactly the bound ahead ⇒ no window, no throw', () => {
    expect(janelaDoTick({ cursorMs: S + 21 * SEG, agoraMs: S })).toBeNull();
    expect(janelaDoTick({ cursorMs: S + ADIANTAMENTO_MAXIMO_MS, agoraMs: S })).toBeNull();
  });
});

describe('★ the recovery window: a snapshot S and no pending start', () => {
  it('reaches back 5 minutes and keeps only what COMMITTED after S − 20 s', () => {
    expect(catchUp()).toEqual({
      desdeMs: S - 5 * MIN,
      ateMs: S + 10 * MIN,
      manterDesdeMs: null,
      commitAposMs: S - 20 * SEG,
    });
  });

  it('a row stamped S − 301 s is OUT of the range, whatever its commit', () => {
    expect(manterLinha(linha('P', S - 301 * SEG, S + 2 * SEG), catchUp())).toBe(false);
    expect(manterLinha(linha('P', S - 299 * SEG, S + 2 * SEG), catchUp())).toBe(true);
  });

  it('the range is exclusive below: stamped EXACTLY S − 5 min is out even when committed late, 1 ms later is in', () => {
    const naBorda = linha('P', S - 5 * MIN, S + 2 * SEG);
    expect(manterLinha(naBorda, catchUp())).toBe(false);
    expect(forcarSku([naBorda], catchUp())).toBe(false);
    expect(manterLinha(linha('P', S - 5 * MIN + 1, S + 2 * SEG), catchUp())).toBe(true);
  });

  it('★ the commit-lag case: stamped S − 60 s, COMMITTED at S + 2 s ⇒ kept and forced', () => {
    const l = linha('P', S - 60 * SEG, S + 2 * SEG);
    expect(manterLinha(l, catchUp())).toBe(true);
    expect(forcarSku([l], catchUp())).toBe(true);
  });

  it('★ NEAR-MISS: stamped S − 60 s and committed then ⇒ NOT kept (a stamp-only rule re-sent every member of the feed)', () => {
    const l = linha('P', S - 60 * SEG, S - 60 * SEG);
    expect(manterLinha(l, catchUp())).toBe(false);
    expect(forcarSku([l], catchUp())).toBe(false);
  });

  it('the margin’s boundary: committed at S − 19 s kept, at S − 21 s not', () => {
    expect(manterLinha(linha('P', S - 60 * SEG, S - 19 * SEG), catchUp())).toBe(true);
    expect(manterLinha(linha('P', S - 60 * SEG, S - 21 * SEG), catchUp())).toBe(false);
  });

  it('a row stamped S + 1 ms is kept and forced', () => {
    const l = linha('P', S + 1, S + 1);
    expect(manterLinha(l, catchUp())).toBe(true);
    expect(forcarSku([l], catchUp())).toBe(true);
  });
});

describe('★ the recovery window with a pending start p', () => {
  const p = S - 20 * MIN;
  const janela = (): JanelaEstoqueAmazon => {
    const j = janelaDaRecuperacao({ snapshotEmMs: S, pendenteDesdeMs: p, agoraMs: S + 10 * MIN });
    if (j === null) throw new Error('janela esperada');
    return j;
  };

  it('p < S − 5 min: the range starts at p, every row stamped after p is kept', () => {
    expect(janela()).toEqual({
      desdeMs: p,
      ateMs: S + 10 * MIN,
      manterDesdeMs: p,
      commitAposMs: S - 20 * SEG,
    });
    expect(manterLinha(linha('P', p + 1, p + 1), janela())).toBe(true);
    expect(manterLinha(linha('P', S - 60 * SEG, S - 60 * SEG), janela())).toBe(true);
    expect(manterLinha(linha('P', p, p), janela())).toBe(false);
  });

  it('…and only those committed after S − 20 s are forced', () => {
    expect(forcarSku([linha('P', p + 1, p + 1)], janela())).toBe(false);
    expect(forcarSku([linha('P', S - 60 * SEG, S - 60 * SEG)], janela())).toBe(false);
    expect(forcarSku([linha('P', S - 60 * SEG, S + 2 * SEG)], janela())).toBe(true);
    expect(forcarSku([linha('P', p + 1, p + 1), linha('Q', S + SEG)], janela())).toBe(true);
  });

  it('NEAR-MISS: p is NEVER overwritten by the snapshot’s bound (a later p still keeps its own rows)', () => {
    const tarde = S - 2 * MIN;
    const j = janelaDaRecuperacao({ snapshotEmMs: S, pendenteDesdeMs: tarde, agoraMs: S + MIN });
    expect(j).toMatchObject({ desdeMs: S - 5 * MIN, manterDesdeMs: tarde });
    if (j === null) throw new Error('janela esperada');
    // Stamped after p, committed long before the snapshot: kept by p, not forced.
    expect(manterLinha(linha('P', tarde + 1, S - 3 * MIN), j)).toBe(true);
    expect(forcarSku([linha('P', tarde + 1, S - 3 * MIN)], j)).toBe(false);
    // Stamped between S − 5 min and p, committed before S − 20 s: neither rule keeps it.
    expect(manterLinha(linha('P', S - 4 * MIN, S - 4 * MIN), j)).toBe(false);
  });

  it('the pending start is exclusive: stamped EXACTLY at a later p is not kept by it, 1 ms after p is', () => {
    const tarde = S - 2 * MIN;
    const j = janelaDaRecuperacao({ snapshotEmMs: S, pendenteDesdeMs: tarde, agoraMs: S + MIN });
    if (j === null) throw new Error('janela esperada');
    // Committed before S − 20 s, so only the stamp rule could keep either row.
    expect(manterLinha(linha('P', tarde, S - 3 * MIN), j)).toBe(false);
    expect(manterLinha(linha('P', tarde + 1, S - 3 * MIN), j)).toBe(true);
  });

  it('a vez recovery (snapshotEmMs null): the range is (p, agora], nothing forced', () => {
    const j = janelaDaRecuperacao({ snapshotEmMs: null, pendenteDesdeMs: p, agoraMs: S });
    expect(j).toEqual({ desdeMs: p, ateMs: S, manterDesdeMs: p, commitAposMs: null });
    if (j === null) throw new Error('janela esperada');
    expect(manterLinha(linha('P', p + 1, S), j)).toBe(true);
    expect(forcarSku([linha('P', p + 1, S)], j)).toBe(false);
  });

  it('both null ⇒ no window; an empty range ⇒ no window', () => {
    expect(
      janelaDaRecuperacao({ snapshotEmMs: null, pendenteDesdeMs: null, agoraMs: S }),
    ).toBeNull();
    expect(janelaDaRecuperacao({ snapshotEmMs: null, pendenteDesdeMs: S, agoraMs: S })).toBeNull();
  });

  it('refuses an instant that is not ms, naming the field', () => {
    expect(() =>
      janelaDaRecuperacao({ snapshotEmMs: -1, pendenteDesdeMs: null, agoraMs: S }),
    ).toThrow(/snapshotEmMs/);
    expect(() =>
      janelaDaRecuperacao({ snapshotEmMs: null, pendenteDesdeMs: 2.5, agoraMs: S }),
    ).toThrow(/pendenteDesdeMs/);
  });

  it('★ a pending start far AHEAD (a µs value) is thrown; NEAR-MISS: exactly the bound ahead is an empty range', () => {
    expect(() =>
      janelaDaRecuperacao({ snapshotEmMs: null, pendenteDesdeMs: S * 1_000, agoraMs: S }),
    ).toThrow(/pendenteDesdeMs/);
    expect(() =>
      janelaDaRecuperacao({
        snapshotEmMs: S,
        pendenteDesdeMs: S + ADIANTAMENTO_MAXIMO_MS + 1,
        agoraMs: S,
      }),
    ).toThrow(/pendenteDesdeMs/);
    expect(
      janelaDaRecuperacao({
        snapshotEmMs: null,
        pendenteDesdeMs: S + ADIANTAMENTO_MAXIMO_MS,
        agoraMs: S,
      }),
    ).toBeNull();
  });
});

describe('★ units: ms everywhere, ONE conversion', () => {
  it('★ a snapshot in µs is compared WITHOUT conversion: it is THROWN, and even forced into a window it excludes everything (the cross-unit trap, made visible)', () => {
    const emUs = S * 1_000;
    expect(() =>
      janelaDaRecuperacao({ snapshotEmMs: emUs, pendenteDesdeMs: null, agoraMs: S }),
    ).toThrow(/snapshotEmMs/);
    expect(() =>
      janelaDaRecuperacao({ snapshotEmMs: emUs, pendenteDesdeMs: S - MIN, agoraMs: S }),
    ).toThrow(/snapshotEmMs/);
    // NEAR-MISS: the same snapshot in ms is a window, and a snapshot exactly the bound ahead an empty one.
    expect(
      janelaDaRecuperacao({ snapshotEmMs: S, pendenteDesdeMs: null, agoraMs: S + MIN }),
    ).not.toBeNull();
    expect(
      janelaDaRecuperacao({
        snapshotEmMs: S + ADIANTAMENTO_MAXIMO_MS,
        pendenteDesdeMs: null,
        agoraMs: S,
      }),
    ).toBeNull();
    // Even forced into a window, a µs commit margin keeps no ms row.
    const j: JanelaEstoqueAmazon = {
      desdeMs: 0,
      ateMs: S + MIN,
      manterDesdeMs: null,
      commitAposMs: emUs - MARGEM_COMMIT_MS,
    };
    expect(manterLinha(linha('P', S, S + 30 * SEG), j)).toBe(false);
  });

  it('the commit test reads a Timestamp at the millisecond: one ms past the margin kept, a sub-ms past not', () => {
    const margem = catchUp().commitAposMs ?? 0;
    const seg = Math.floor(margem / 1_000);
    const nanosDoMs = (margem % 1_000) * 1_000_000;
    const subMs: LinhaJanelaEstoqueAmazon = {
      caminho: 'produtos/P/estoques/dep-1',
      ultimaModificacao: S - 60 * SEG,
      updateTime: new Timestamp(seg, nanosDoMs + 999_999),
    };
    const umMs: LinhaJanelaEstoqueAmazon = {
      ...subMs,
      updateTime: new Timestamp(seg, nanosDoMs + 1_000_000),
    };
    expect(manterLinha(subMs, catchUp())).toBe(false);
    expect(manterLinha(umMs, catchUp())).toBe(true);
  });

  it('toMillis appears in exactly one function of the module', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./descobertaEstoque.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(fonte.match(/\.toMillis\(/g) ?? []).toHaveLength(1);
    expect(fonte).toMatch(/function commitAposMargem\([^)]*\)[^{]*\{\s*return[^;]*\.toMillis\(\)/);
  });

  it('under estoque/, ONE function reads a Timestamp’s sub-second part, whole, and never as µs', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const leitores = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) =>
        /\bnanoseconds\b/.test(
          readFileSync(join(dir, f), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, ''),
        ),
      );
    expect(leitores).toEqual(['descobertaEstoque.ts']);
    const fonte = readFileSync(join(dir, 'descobertaEstoque.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(fonte.match(/\bnanoseconds\b/g) ?? []).toHaveLength(2);
    expect(fonte).toMatch(
      /function partesDoCommit\([^)]*\)[^{]*\{\s*const \{ seconds, nanoseconds \} = t;\s*return \[seconds, nanoseconds\];\s*\}/,
    );
    expect(partesDoCommit(new Timestamp(7, 8))).toEqual([7, 8]);
  });
});

describe('★ from rows to produtos', () => {
  it('two estoque docs of one produto ⇒ one produto, its NEWEST commit kept (compared as Timestamps)', () => {
    const j = catchUp();
    const { produtos, foraDeProduto } = produtosDaJanela(
      [
        linha('P', S - MIN, S + 2 * SEG, 'dep-1'),
        linha('P', S - MIN, S + 3 * SEG, 'auto-x'),
        linha('Q', S + SEG),
      ],
      j,
    );
    expect(foraDeProduto).toBe(0);
    expect(produtos.map((p) => p.produtoId)).toEqual(['P', 'Q']);
    expect(produtos[0]?.updateTime.toMillis()).toBe(S + 3 * SEG);
    expect(produtos[0]?.linhas).toHaveLength(2);
  });

  it('two commits inside ONE millisecond are still told apart (nanoseconds, never toMillis)', () => {
    const base: LinhaJanelaEstoqueAmazon = linha('P', S + SEG);
    const antes = { ...base, updateTime: new Timestamp(Math.floor((S + SEG) / 1_000), 100) };
    const depois = { ...base, updateTime: new Timestamp(Math.floor((S + SEG) / 1_000), 200) };
    for (const ordem of [
      [depois, antes],
      [antes, depois],
    ]) {
      const [p] = produtosDaJanela(ordem, catchUp()).produtos;
      expect(p?.updateTime.nanoseconds).toBe(200);
    }
    // A later SECOND beats a larger sub-second part.
    const segundoDepois = {
      ...base,
      updateTime: new Timestamp(Math.floor((S + SEG) / 1_000) + 1, 0),
    };
    for (const ordem of [
      [segundoDepois, depois],
      [depois, segundoDepois],
    ]) {
      const [p] = produtosDaJanela(ordem, catchUp()).produtos;
      expect(p?.updateTime.seconds).toBe(Math.floor((S + SEG) / 1_000) + 1);
    }
  });

  it('a row the keep rule drops never makes a produto', () => {
    const { produtos } = produtosDaJanela([linha('P', S - MIN, S - MIN)], catchUp());
    expect(produtos).toEqual([]);
  });

  it('a kept row outside a produto’s estoques is counted, never mapped', () => {
    const fora: LinhaJanelaEstoqueAmazon = {
      caminho: 'depositos/d1/estoques/x',
      ultimaModificacao: S + SEG,
      updateTime: Timestamp.fromMillis(S + SEG),
    };
    const fundo: LinhaJanelaEstoqueAmazon = { ...fora, caminho: 'produtos/P/estoques/x/sub/y' };
    const relativo: LinhaJanelaEstoqueAmazon = { ...fora, caminho: 'produtos/Q/estoques/..' };
    // Nested under another parent: a collection-group row is a produto's only at the root.
    const aninhado: LinhaJanelaEstoqueAmazon = {
      ...fora,
      caminho: 'empresas/e1/produtos/R/estoques/x',
    };
    const prefixado: LinhaJanelaEstoqueAmazon = {
      ...fora,
      caminho: 'documents/produtos/R/estoques/x',
    };
    const { produtos, foraDeProduto } = produtosDaJanela(
      [fora, fundo, relativo, aninhado, prefixado, linha('P', S + SEG)],
      catchUp(),
    );
    expect(produtos.map((p) => p.produtoId)).toEqual(['P']);
    expect(foraDeProduto).toBe(5);
  });

  it('★ the window and the family read share ONE estoque-path grammar: a path one maps, the other maps (EQUAL pairs and NEAR-MISSES)', () => {
    for (const [caminho, produtoId] of [
      ['produtos/P/estoques/dep-1', 'P'],
      ['produtos/P-2/estoques/Xq81AutoId', 'P-2'],
      ['documents/produtos/P/estoques/dep-1', null],
      ['empresas/e1/produtos/P/estoques/x', null],
      ['produtos/P/estoques/x/sub/y', null],
      ['produtos/P/estoques/..', null],
      ['produtos//estoques/x', null],
      ['/produtos/P/estoques/x', null],
      ['produtos/P/estoques/x/', null],
      ['produtos/P/Estoques/x', null],
      ['depositos/d1/estoques/x', null],
    ] as const) {
      const lido = produtosDaJanela(
        [{ caminho, ultimaModificacao: S + SEG, updateTime: Timestamp.fromMillis(S + SEG) }],
        catchUp(),
      );
      expect(
        lido.produtos.map((p) => p.produtoId),
        caminho,
      ).toEqual(produtoId === null ? [] : [produtoId]);
      expect(partesDoCaminhoEstoqueAmazon(caminho)?.produtoId ?? null, caminho).toBe(produtoId);
    }
  });

  it('the produtos come out sorted by id, whatever the row order', () => {
    const { produtos } = produtosDaJanela(
      [linha('Q', S + SEG), linha('B', S + SEG), linha('P', S + SEG)],
      catchUp(),
    );
    expect(produtos.map((p) => p.produtoId)).toEqual(['B', 'P', 'Q']);
  });
});

describe('★ the probes', () => {
  it('a child’s probe set holds its parent (a family-of-one wrapper’s link)', () => {
    expect(sondasDoProduto('M', { paiId: 'W' })).toEqual(['M', 'W']);
  });

  it('a root, a gone produto, and an unusable paiId probe only themselves', () => {
    expect(sondasDoProduto('R', { paiId: null })).toEqual(['R']);
    expect(sondasDoProduto('R', {})).toEqual(['R']);
    expect(sondasDoProduto('R', null)).toEqual(['R']);
    expect(sondasDoProduto('R', { paiId: '' })).toEqual(['R']);
    expect(sondasDoProduto('R', { paiId: 'a/b' })).toEqual(['R']);
    expect(sondasDoProduto('R', { paiId: 'R' })).toEqual(['R']);
  });

  it('refuses a produto id that is not a document id', () => {
    expect(() => sondasDoProduto('', null)).toThrow(RangeError);
    expect(() => sondasDoProduto('a/b', null)).toThrow(RangeError);
  });
});

describe('★ the conta’s SKUs (both conta ref forms, compared exactly)', () => {
  const doc = (ref: unknown, sku: unknown = 'SKU-1') => ({ contaAmazonOuterRef: ref, sku });

  it('EQUAL pair: the canonical and the bare form of the conta both match', () => {
    expect(skusDaConta([doc(`documents/integracao/${CONTA}`)], CONTA)).toEqual(['SKU-1']);
    expect(skusDaConta([doc(`integracao/${CONTA}`)], CONTA)).toEqual(['SKU-1']);
    expect(
      skusDaConta([doc(`documents/integracao/${CONTA}`), doc(`integracao/${CONTA}`)], CONTA),
    ).toEqual(['SKU-1']);
  });

  it('NEAR-MISS: another conta, a longer id, another case, a padded or a re-rooted ref ⇒ not the conta’s', () => {
    for (const ref of [
      'documents/integracao/conta-2',
      'documents/integracao/conta-10',
      'documents/integracao/CONTA-1',
      `documents/integracao/${CONTA} `,
      `/documents/integracao/${CONTA}`,
      `documents/documents/integracao/${CONTA}`,
      `documents/integracao/${CONTA}/x`,
      `integracoes/${CONTA}`,
      CONTA,
      null,
      42,
    ]) {
      expect(skusDaConta([doc(ref)], CONTA), String(ref)).toEqual([]);
    }
  });

  it('the SKU is EXACT: a padded SKU is another SKU; an empty or non-string one is none', () => {
    const ref = `documents/integracao/${CONTA}`;
    expect(skusDaConta([doc(ref, 'SKU-1'), doc(ref, 'SKU-1 '), doc(ref, 'sku-1')], CONTA)).toEqual([
      'SKU-1',
      'SKU-1 ',
      'sku-1',
    ]);
    expect(skusDaConta([doc(ref, ''), doc(ref, 7), doc(ref, null)], CONTA)).toEqual([]);
  });

  it('NEAR-MISS: a SKU of spaces is still a SKU (only the empty string is none), and the list is code-unit sorted whatever the listing order', () => {
    const ref = `integracao/${CONTA}`;
    expect(
      skusDaConta(
        [doc(ref, 'sku-1'), doc(ref, 'SKU-1 '), doc(ref, 'SKU-1'), doc(ref, '  ')],
        CONTA,
      ),
    ).toEqual(['  ', 'SKU-1', 'SKU-1 ', 'sku-1']);
  });

  it('refuses a conta id outside its grammar', () => {
    expect(() => skusDaConta([], 'conta/1')).toThrow(RangeError);
  });
});

describe('★ observations: per SKU, the newest commit among the rows that mapped to it', () => {
  it('a wrapper W and its member M mapping to one SKU ⇒ ONE observation, the newer of their commits', () => {
    const j = catchUp();
    const { produtos } = produtosDaJanela(
      [linha('M', S - MIN, S + 2 * SEG), linha('W', S - MIN, S + 5 * SEG)],
      j,
    );
    const obs = observacoesDaJanela({
      produtos,
      sondasPorProduto: new Map([
        ['M', sondasDoProduto('M', { paiId: 'W' })],
        ['W', sondasDoProduto('W', { paiId: null })],
      ]),
      skusPorSonda: new Map([
        ['M', []],
        ['W', skusDaConta([{ contaAmazonOuterRef: `integracao/${CONTA}`, sku: 'SKU-W' }], CONTA)],
      ]),
      janela: j,
    });
    expect(obs).toHaveLength(1);
    expect(obs[0]?.sku).toBe('SKU-W');
    expect(obs[0]?.updateTime.toMillis()).toBe(S + 5 * SEG);
    expect(obs[0]?.forcar).toBe(true);
  });

  it('a link on a family-of-one wrapper is found from its MEMBER’s estoque move alone', () => {
    const j = catchUp();
    const { produtos } = produtosDaJanela([linha('M', S - MIN, S + 2 * SEG)], j);
    const obs = observacoesDaJanela({
      produtos,
      sondasPorProduto: new Map([['M', sondasDoProduto('M', { paiId: 'W' })]]),
      skusPorSonda: new Map([
        ['M', []],
        ['W', ['SKU-W']],
      ]),
      janela: j,
    });
    expect(obs.map((o) => o.sku)).toEqual(['SKU-W']);
    expect(obs[0]?.updateTime.toMillis()).toBe(S + 2 * SEG);
  });

  it('forcing is per SKU: a SKU only reached through rows kept by the pending start is not forced', () => {
    const p = S - 20 * MIN;
    const j = janelaDaRecuperacao({ snapshotEmMs: S, pendenteDesdeMs: p, agoraMs: S + MIN });
    if (j === null) throw new Error('janela esperada');
    const { produtos } = produtosDaJanela([linha('A', p + 1, p + 1), linha('B', S + SEG)], j);
    const obs = observacoesDaJanela({
      produtos,
      sondasPorProduto: new Map([
        ['A', ['A']],
        ['B', ['B']],
      ]),
      skusPorSonda: new Map([
        ['A', ['SKU-A']],
        ['B', ['SKU-B']],
      ]),
      janela: j,
    });
    expect(obs.map((o) => [o.sku, o.forcar])).toEqual([
      ['SKU-A', false],
      ['SKU-B', true],
    ]);
  });

  it('★ one SKU reached by two produtos is forced when EITHER produto’s rows pass the commit test, whichever sorts first', () => {
    const p = S - 20 * MIN;
    const j = janelaDaRecuperacao({ snapshotEmMs: S, pendenteDesdeMs: p, agoraMs: S + MIN });
    if (j === null) throw new Error('janela esperada');
    // One produto's row is kept by the pending start only (stamped and committed at p + 1);
    // the other's committed after the snapshot's margin (S + 1 s). Both roles, both sort orders.
    for (const [soPendente, comCommit] of [
      ['A', 'B'],
      ['B', 'A'],
    ] as const) {
      const { produtos } = produtosDaJanela(
        [linha(soPendente, p + 1, p + 1), linha(comCommit, S - MIN, S + SEG)],
        j,
      );
      expect(produtos.map((x) => x.produtoId)).toEqual(['A', 'B']);
      const obs = observacoesDaJanela({
        produtos,
        sondasPorProduto: new Map([
          ['A', ['A']],
          ['B', ['B']],
        ]),
        skusPorSonda: new Map([
          ['A', ['SKU-X']],
          ['B', ['SKU-X']],
        ]),
        janela: j,
      });
      expect(
        obs.map((o) => [o.sku, o.forcar]),
        `${soPendente} só pelo início pendente`,
      ).toEqual([['SKU-X', true]]);
      expect(obs[0]?.updateTime.toMillis()).toBe(S + SEG);
    }
  });

  it('the observations come out sorted by SKU, whatever the probe order', () => {
    const j = catchUp();
    const { produtos } = produtosDaJanela([linha('A', S + SEG)], j);
    const obs = observacoesDaJanela({
      produtos,
      sondasPorProduto: new Map([['A', ['A']]]),
      skusPorSonda: new Map([['A', ['SKU-B', 'SKU-A']]]),
      janela: j,
    });
    expect(obs.map((o) => o.sku)).toEqual(['SKU-A', 'SKU-B']);
  });

  it('SKUs stay EXACT across probes: one SKU twice is one observation, a padded one is another', () => {
    const j = catchUp();
    const { produtos } = produtosDaJanela([linha('A', S + SEG), linha('B', S + 2 * SEG)], j);
    const obs = observacoesDaJanela({
      produtos,
      sondasPorProduto: new Map([
        ['A', ['A']],
        ['B', ['B']],
      ]),
      skusPorSonda: new Map([
        ['A', ['SKU-1']],
        ['B', ['SKU-1', 'SKU-1 ']],
      ]),
      janela: j,
    });
    expect(obs.map((o) => o.sku)).toEqual(['SKU-1', 'SKU-1 ']);
    expect(obs[0]?.updateTime.toMillis()).toBe(S + 2 * SEG);
  });

  it('an incomplete mapping is a wiring bug: a produto without probes, or a probe never listed', () => {
    const j = catchUp();
    const { produtos } = produtosDaJanela([linha('A', S + SEG)], j);
    expect(() =>
      observacoesDaJanela({
        produtos,
        sondasPorProduto: new Map(),
        skusPorSonda: new Map(),
        janela: j,
      }),
    ).toThrow(TypeError);
    expect(() =>
      observacoesDaJanela({
        produtos,
        sondasPorProduto: new Map([['A', ['A', 'PAI']]]),
        skusPorSonda: new Map([['A', ['SKU-A']]]),
        janela: j,
      }),
    ).toThrow(TypeError);
  });
});
