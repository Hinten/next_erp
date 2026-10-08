/**
 * The plan-text readers + the #1200 verdicts (`explainPlan.mjs`), offline.
 *
 * These are the ONE copy both the manual gate (`scripts/check-stock-indexes.mjs`)
 * and the staging suite (`estoque/auditoriaNaoEnumerados.staging.test.ts`) judge
 * a live Enterprise plan with, so a regression here would turn either into a
 * guard that passes anything — or fails a healthy plan and gets switched off.
 * Every verdict is pinned BOTH ways: the plan that must pass, and the near-miss
 * that must not (a test that only shows a check fires cannot show where it
 * stops).
 *
 * The fixtures follow the dialect the header of `explainPlan.mjs` documents
 * (calibrated on real staging plans): `•` node bullets, an `index:` identifier
 * carrying `@[id = …]`, `ranges:` with `|----` value lines, per-node
 * `Execution:` stats. ⚠️ They are hand-written to that dialect, not captured —
 * the staging suite PRINTS every real plan it judges, and a captured one belongs
 * here the first time its format disagrees with these.
 */
import { describe, expect, it } from 'vitest';

import {
  INDICE_DA_VARREDURA_RE,
  LIMITE_INFERIOR_DE_CHAVE_RE,
  NUMERIC_BOUND_RE,
  RECUSA_EXPLAIN_ENTERPRISE_RE,
  UNBOUNDED_RE,
  classicoServeFaixa,
  classicoServeVarredura,
  contadorDeLeitura,
  contadoresDeExecucao,
  julgarPlanoDaFaixaDeAvisos,
  julgarPlanoDaVarredura,
  limiteFechado,
  nomesDeNos,
  parseAccessNodes,
  predicateInResidualFilters,
  scansSemIdentificador,
  somaDeLeituras,
  temSortResidual,
  uniqueNodes,
} from './explainPlan.mjs';

const CG = '**/produtoMercadoLivre (contaOuterRef ASC, __key__ ASC)@[id = CICAgJiUpoMK]';

/** Lines joined as a plan — kept readable as arrays below. */
const plano = (...linhas: string[]): string => linhas.join('\n');

/** The healthy walk: one bounded range scan on the CG entry, page-sized reads. */
const VARREDURA_SAUDAVEL = plano(
  '• Limit',
  '|  limit: 2',
  '|  Execution:',
  '|   records returned: 2',
  '|',
  '└── • SequentialScan',
  `     |  index: ${CG}`,
  '     |  ranges:',
  '     |   |----["documents/integracao/e2e-x", "integracao/e2e-x"]',
  '     |   |----(EntityRef[produtos/a/produtoMercadoLivre/l2]..+∞)',
  '     |',
  '     |  Execution:',
  '     |   records returned: 2',
  '     |   index entries scanned: 3',
  '     |   latency: 1.25 ms',
);

/** The walk with NO usable index: a raw scan, the predicate thrown away after reading. */
const VARREDURA_SCAN_CHEIO = plano(
  '• Limit',
  '└── • Filter',
  '     |  expression: equal_any($contaOuterRef, ["documents/integracao/e2e-x", "integracao/e2e-x"])',
  '     |  Execution:',
  '     |   records returned: 2',
  '     └── • TableScan',
  '          |  kind: **/produtoMercadoLivre',
  '          |  Execution:',
  '          |   records scanned: 48,211',
);

describe('parseAccessNodes', () => {
  it('reads each access node: identifier, bounds, push-down, kind, partition, 1-based line, stats', () => {
    const nodes = parseAccessNodes(
      plano(
        '• Union',
        '├── • SequentialScan',
        `|    |  index: ${CG}`,
        '|    |  ranges:',
        '|    |   |----["integracao/x"]',
        '|    |   |----(-∞..+∞)',
        '|    |',
        '|    |  filter: (equal_any($contaOuterRef, ["integracao/x"]))',
        '|    |  Execution:',
        '|    |   records returned: 1',
        '└── • TableScan',
        '     |  kind: /produtos/p1/variacaoMercadoLivre',
        '     |  partition: /produtos/p1',
      ),
    );

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      type: 'SequentialScan',
      line: 2,
      identifier: CG,
      kind: null,
      filter: '(equal_any($contaOuterRef, ["integracao/x"]))',
      boundLines: ['|----["integracao/x"]', '|----(-∞..+∞)'],
      // The unbounded line is a bound line but NOT a bound.
      boundedLines: ['|----["integracao/x"]'],
      execution: ['Execution:', 'records returned: 1'],
    });
    expect(nodes[1]).toMatchObject({
      type: 'TableScan',
      line: 11,
      identifier: null,
      kind: '/produtos/p1/variacaoMercadoLivre',
      partition: '/produtos/p1',
      boundLines: [],
    });
  });

  it('sees a node type it has never been told about, as long as it is a `…Scan`', () => {
    expect(parseAccessNodes('• HypotheticalRangeScan\n|  kind: /x').map((n) => n.type)).toEqual([
      'HypotheticalRangeScan',
    ]);
    // …and only those: a Filter or a Limit is not an access node.
    expect(parseAccessNodes('• Filter\n• Limit')).toEqual([]);
  });
});

describe('the bound regexes', () => {
  it('UNBOUNDED_RE: the fully open range only, in both spellings — never a half-bounded one', () => {
    expect(UNBOUNDED_RE.test('|----(-∞..+∞)')).toBe(true);
    expect(UNBOUNDED_RE.test('|----(-inf..+inf)')).toBe(true);
    expect(UNBOUNDED_RE.test('|----[1,234L..+∞)')).toBe(false);
    expect(UNBOUNDED_RE.test('|----["integracao/x"]')).toBe(false);
  });

  it('NUMERIC_BOUND_RE: a numeric range — not a digit-laden id, not a parenthesised keyset number', () => {
    expect(NUMERIC_BOUND_RE.test('|----[1,782,652,331,060,000L..+∞)')).toBe(true);
    expect(NUMERIC_BOUND_RE.test('|----[1234L]')).toBe(true);
    expect(NUMERIC_BOUND_RE.test('|----(-1..500L]')).toBe(true);
    expect(NUMERIC_BOUND_RE.test('|----["depositos/checkstock-1785244325954-dep"]')).toBe(false);
    expect(NUMERIC_BOUND_RE.test('|----(EntityRef[produtos/p]..oid(000123))')).toBe(false);
  });

  it('limiteFechado: a point set or a finite range — never a line open on either side', () => {
    expect(limiteFechado('|----["documents/integracao/x", "integracao/x"]')).toBe(true);
    expect(limiteFechado('|----[EntityRef[avisos/t:x:]..EntityRef[avisos/t:x;])')).toBe(true);
    expect(limiteFechado('|----[null]')).toBe(true);
    // An id that merely CONTAINS `inf` is a value, not an infinite end.
    expect(limiteFechado('|----["integracao/inf-1"]')).toBe(true);
    expect(limiteFechado('|----(EntityRef[produtos/a/produtoMercadoLivre/l2]..+∞)')).toBe(false);
    expect(limiteFechado('|----(-∞..["integracao/x"]]')).toBe(false);
    expect(limiteFechado('|----[1,234L..+∞)')).toBe(false);
    expect(limiteFechado('|----(-∞..+∞)')).toBe(false);
    expect(limiteFechado('|----(-inf..+inf)')).toBe(false);
  });

  it('LIMITE_INFERIOR_DE_CHAVE_RE: a key LOWER bound (a seeked cursor) — not an upper one, not a value', () => {
    expect(LIMITE_INFERIOR_DE_CHAVE_RE.test('|----(EntityRef[produtos/a]..+∞)')).toBe(true);
    expect(
      LIMITE_INFERIOR_DE_CHAVE_RE.test('|----[EntityRef[avisos/a]..EntityRef[avisos/b])'),
    ).toBe(true);
    expect(LIMITE_INFERIOR_DE_CHAVE_RE.test('|----(-∞..EntityRef[produtos/a])')).toBe(false);
    expect(LIMITE_INFERIOR_DE_CHAVE_RE.test('|----["integracao/x"]')).toBe(false);
  });
});

describe('predicateInResidualFilters', () => {
  it('a `• Filter` node’s expression IS residual', () => {
    expect(predicateInResidualFilters(VARREDURA_SCAN_CHEIO, /\$contaOuterRef/)).toBe(true);
  });

  it('a node-local `filter:` line is a PUSH-DOWN, never residual', () => {
    const pushDown = plano(
      '• SequentialScan',
      `|  index: ${CG}`,
      '|  filter: (equal_any($contaOuterRef, ["integracao/x"]))',
    );
    expect(predicateInResidualFilters(pushDown, /\$contaOuterRef/)).toBe(false);
  });

  it('stops at the Filter node’s own stats — a later line naming the field is not its expression', () => {
    const depois = plano(
      '• Filter',
      '|  expression: $gt($preco, 1)',
      '|  Execution:',
      '|  expression: equal_any($contaOuterRef, [])',
    );
    expect(predicateInResidualFilters(depois, /\$contaOuterRef/)).toBe(false);
  });

  it('stops at the next node — a projection’s `expression:` below a Filter is not the filter', () => {
    const projecao = plano(
      '• Filter',
      '|  expression: $eq($estado, "a")',
      '└── • Extend',
      '     |  expression: $contaOuterRef',
    );
    expect(predicateInResidualFilters(projecao, /\$contaOuterRef/)).toBe(false);
    expect(predicateInResidualFilters(projecao, /\$estado/)).toBe(true);
  });
});

describe('temSortResidual / nomesDeNos / uniqueNodes / scansSemIdentificador', () => {
  it('a Sort, TopN or TopK node is a residual sort; a streaming SortedMerge is not', () => {
    expect(temSortResidual('└── • Sort\n')).toBe(true);
    expect(temSortResidual('• TopN')).toBe(true);
    expect(temSortResidual('• TopK')).toBe(true);
    expect(temSortResidual('• SortedMerge')).toBe(false);
    expect(temSortResidual(VARREDURA_SAUDAVEL)).toBe(false);
  });

  it('lists every distinct node name once', () => {
    expect(nomesDeNos(VARREDURA_SCAN_CHEIO)).toEqual(['Limit', 'Filter', 'TableScan']);
  });

  it('dedupes identically-shaped nodes only', () => {
    const repetido = parseAccessNodes(`${VARREDURA_SAUDAVEL}\n${VARREDURA_SAUDAVEL}`);
    expect(repetido).toHaveLength(2);
    expect(uniqueNodes(repetido)).toHaveLength(1);
  });

  it('an identifier-less ROOT scan is a full scan; a partition-bounded one is not', () => {
    const { cheios, porParticao } = scansSemIdentificador(
      parseAccessNodes(
        plano(
          '• TableScan',
          '|  kind: **/produtoMercadoLivre',
          '• TableScan',
          '|  kind: /produtos/p1/variacaoMercadoLivre',
          '|  partition: /produtos/p1',
          '• TableScan',
          '|  kind: /avisos',
          '|  partition: /',
        ),
      ),
    );
    expect(cheios.map((n) => n.kind)).toEqual(['**/produtoMercadoLivre', '/avisos']);
    expect(porParticao.map((n) => n.kind)).toEqual(['/produtos/p1/variacaoMercadoLivre']);
  });
});

describe('contadoresDeExecucao / contadorDeLeitura', () => {
  it('parses every numeric stat — separators dropped, units ignored, non-numbers skipped', () => {
    const [no] = parseAccessNodes(
      plano(
        '• SequentialScan',
        `|  index: ${CG}`,
        '|  Execution:',
        '|   records returned: 2',
        '|   index entries scanned: 1,234',
        '|   latency: 1.5 ms',
        '|   peak memory: n/a',
      ),
    );
    expect(contadoresDeExecucao(no!)).toEqual({
      'records returned': 2,
      'index entries scanned': 1234,
      latency: 1.5,
    });
  });

  it('the READ counter is a scanned one, the largest — never `returned`, which a full scan also keeps small', () => {
    const [saudavel] = parseAccessNodes(VARREDURA_SAUDAVEL);
    expect(contadorDeLeitura(saudavel!)).toEqual({ rotulo: 'index entries scanned', valor: 3 });

    const [varios] = parseAccessNodes(
      plano(
        '• SequentialScan',
        '|  Execution:',
        '|   documents scanned: 7',
        '|   index entries scanned: 9',
        '|   records returned: 500',
      ),
    );
    expect(contadorDeLeitura(varios!)).toEqual({ rotulo: 'index entries scanned', valor: 9 });

    // An `entries` label that only says what was RETURNED is not a read counter,
    // even though `entries` alone would select it.
    const [entradasDevolvidas] = parseAccessNodes(
      plano(
        '• SequentialScan',
        '|  Execution:',
        '|   index entries scanned: 3',
        '|   index entries returned: 500',
      ),
    );
    expect(contadorDeLeitura(entradasDevolvidas!)).toEqual({
      rotulo: 'index entries scanned',
      valor: 3,
    });

    const [soRetorno] = parseAccessNodes(
      plano('• SequentialScan', '|  Execution:', '|   records returned: 2'),
    );
    expect(contadorDeLeitura(soRetorno!)).toBeNull();
  });

  it('somaDeLeituras: SUMS every node (one stream per `in` value) — and one silent node voids the sum', () => {
    const nos = parseAccessNodes(
      plano(
        '• SequentialScan',
        '|  Execution:',
        '|   index entries scanned: 4',
        '• SequentialScan',
        '|  Execution:',
        '|   index entries scanned: 3',
        '|   records scanned: 1',
      ),
    );
    // Summed, not maxed: 4 + 3, never max(4, 3) — each stream read its own share.
    expect(somaDeLeituras(nos)).toEqual({ rotulo: 'index entries scanned', valor: 7, nos: 2 });

    const [primeiro] = nos;
    const [semContador] = parseAccessNodes(
      '• SequentialScan\n|  Execution:\n|   records returned: 9',
    );
    // A partial sum would UNDERSTATE the read — the direction that passes a bad plan.
    expect(somaDeLeituras([primeiro!, semContador!])).toBeNull();
    expect(somaDeLeituras([])).toBeNull();

    const [outroRotulo] = parseAccessNodes('• TableScan\n|  Execution:\n|   records scanned: 2');
    expect(somaDeLeituras([primeiro!, outroRotulo!])).toEqual({
      rotulo: 'index entries scanned + records scanned',
      valor: 6,
      nos: 2,
    });
  });
});

describe('INDICE_DA_VARREDURA_RE — the COLLECTION_GROUP entry, and only it', () => {
  it.each([
    ['**/produtoMercadoLivre (contaOuterRef ASC, __key__ ASC)@[id = A]', true],
    ['**/produtoMercadoLivre (contaOuterRef ASC, __name__ ASC)@[id = A]', true],
    // The COLLECTION-scope twin cannot serve a group query.
    ['/produtoMercadoLivre (contaOuterRef ASC, __key__ ASC)@[id = A]', false],
    ['/produtos/p/produtoMercadoLivre (contaOuterRef ASC)@[id = A]', false],
    ['**/produtoMercadoLivre (contaOuterRef DESC, __key__ ASC)@[id = A]', false],
    ['**/variacaoMercadoLivre (contaOuterRef ASC, __key__ ASC)@[id = A]', false],
  ])('%s → %s', (identifier, esperado) => {
    expect(INDICE_DA_VARREDURA_RE.test(identifier)).toBe(esperado);
  });
});

describe('julgarPlanoDaVarredura — the #1200 walk', () => {
  type Opcoes = Parameters<typeof julgarPlanoDaVarredura>[1];
  const codigos = (plan: string, opcoes?: Opcoes) =>
    julgarPlanoDaVarredura(plan, opcoes).motivos.map((m) => m.codigo);

  /** One access node on the CG entry: its range lines, push-down and read counter. */
  const noCg = ({
    ranges = [] as string[],
    filter = null as string | null,
    lidos = null as number | null,
  }) =>
    plano(
      '• SequentialScan',
      `|  index: ${CG}`,
      ...(ranges.length > 0 ? ['|  ranges:', ...ranges.map((r) => `|   |----${r}`), '|'] : []),
      ...(filter == null ? [] : [`|  filter: ${filter}`]),
      ...(lidos == null ? [] : ['|  Execution:', `|   index entries scanned: ${lidos}`]),
    );
  const CONTA = '["documents/integracao/x", "integracao/x"]';
  const CURSOR = '(EntityRef[produtos/a/produtoMercadoLivre/l2]..+∞)';
  const PUSH_DOWN = '(equal_any($contaOuterRef, ["documents/integracao/x", "integracao/x"]))';
  /** The cursor tested PER ENTRY inside the scan — the line a healthy push-down also prints. */
  const CURSOR_NO_FILTRO =
    '(and(equal_any($contaOuterRef, ["integracao/x"]), $gt($__key__, EntityRef[produtos/a/produtoMercadoLivre/l2])))';

  it('PASSES the bounded CG range scan on its SHAPE — the conta a closed value line, the cursor a key lower bound', () => {
    const v = julgarPlanoDaVarredura(VARREDURA_SAUDAVEL, { comCursor: true, leituraMaxima: 6 });
    expect(v.motivos).toEqual([]);
    expect(v.alvo?.identifier).toBe(CG);
    expect(v.leitura).toEqual({ rotulo: 'index entries scanned', valor: 3, nos: 1 });
    expect(v.detalhe).toBe(
      `contaOuterRef value bound on ${CG}, the keyset cursor a key lower bound; ` +
        'read 3 (index entries scanned, 1 node(s)) ≤ 6',
    );
    // No ceiling, no cursor: still a PASS on the shape, and the line says what decided it.
    expect(julgarPlanoDaVarredura(VARREDURA_SAUDAVEL).detalhe).toBe(
      `contaOuterRef value bound on ${CG}; read 3 (index entries scanned, 1 node(s))`,
    );
    expect(julgarPlanoDaVarredura(noCg({ ranges: [CONTA, CURSOR] })).detalhe).toBe(
      `contaOuterRef value bound on ${CG}; no read counter printed — judged on the range bounds alone`,
    );
  });

  it('a push-down beside a closed value line is still a shape PASS', () => {
    expect(
      codigos(noCg({ ranges: [CONTA, CURSOR], filter: PUSH_DOWN }), { comCursor: true }),
    ).toEqual([]);
  });

  it('NEAR-MISS: the CG entry ridden `(-∞..+∞)` with only an `equal_any` push-down FAILS — it is the shape of a walk of every conta', () => {
    const walk = noCg({ ranges: ['(-∞..+∞)'], filter: PUSH_DOWN });
    expect(codigos(walk)).toEqual(['indice-sem-limite']);
    // A ceiling with no counter to hold it against proves nothing either.
    expect(codigos(walk, { leituraMaxima: 6 })).toEqual(['indice-sem-limite']);
    const [motivo] = julgarPlanoDaVarredura(walk).motivos;
    expect(motivo?.mensagem).toMatch(/node-local filter/);
    expect(motivo?.mensagem).toMatch(/MERCADO_LIVRE_STOCK_SYNC_ENABLED/);
  });

  it('…and that same push-down passes ONLY on a read counter within the ceiling', () => {
    const dentro = julgarPlanoDaVarredura(
      noCg({ ranges: ['(-∞..+∞)'], filter: PUSH_DOWN, lidos: 4 }),
      { leituraMaxima: 6 },
    );
    expect(dentro.motivos).toEqual([]);
    expect(dentro.detalhe).toBe(
      `contaOuterRef push-down on ${CG}; read 4 (index entries scanned, 1 node(s)) ≤ 6` +
        ' — the READ COUNTERS, not the plan shape, prove the scan stayed bounded',
    );
    expect(
      codigos(noCg({ ranges: ['(-∞..+∞)'], filter: PUSH_DOWN, lidos: 40 }), { leituraMaxima: 6 }),
    ).toEqual(['leitura-excessiva']);
    // A counter with no ceiling is a number, not a proof.
    expect(codigos(noCg({ ranges: ['(-∞..+∞)'], filter: PUSH_DOWN, lidos: 4 }))).toEqual([
      'indice-sem-limite',
    ]);
  });

  it('a conta line OPEN on one side is not a conta bound', () => {
    expect(codigos(noCg({ ranges: ['(-∞..["integracao/x"]]'] }))).toEqual(['indice-sem-limite']);
  });

  it('with a cursor: FAILS a cursor tested inside the scan instead of seeked — unless the counter proves the seek', () => {
    const testado = noCg({ ranges: [CONTA], filter: CURSOR_NO_FILTRO });
    expect(codigos(testado, { comCursor: true })).toEqual(['cursor-sem-limite']);
    // Page 1 carries no cursor, so there is nothing to seek.
    expect(codigos(testado)).toEqual([]);

    const comLidos = (lidos: number) => noCg({ ranges: [CONTA], filter: CURSOR_NO_FILTRO, lidos });
    expect(codigos(comLidos(4), { comCursor: true, leituraMaxima: 6 })).toEqual([]);
    expect(codigos(comLidos(8), { comCursor: true, leituraMaxima: 6 })).toEqual([
      'leitura-excessiva',
    ]);
  });

  it('with a cursor: EVERY node on the index must seek it', () => {
    const umSemCursor = plano(noCg({ ranges: [CONTA, CURSOR] }), noCg({ ranges: [CONTA] }));
    expect(codigos(umSemCursor, { comCursor: true })).toEqual(['cursor-sem-limite']);
  });

  it('one node per `in` value: the counters are SUMMED, so two streams that each walk their value FAIL', () => {
    const duasCorrentes = (lidos: number) =>
      plano(noCg({ ranges: [CONTA, CURSOR], lidos }), noCg({ ranges: [CONTA, CURSOR], lidos }));
    expect(codigos(duasCorrentes(4), { comCursor: true, leituraMaxima: 6 })).toEqual([
      'leitura-excessiva',
    ]);
    expect(codigos(duasCorrentes(2), { comCursor: true, leituraMaxima: 6 })).toEqual([]);
  });

  it('a counter that CONTRADICTS a healthy shape wins — the read is the bill', () => {
    expect(codigos(VARREDURA_SAUDAVEL, { comCursor: true, leituraMaxima: 2 })).toEqual([
      'leitura-excessiva',
    ]);
    // The ceiling is INCLUSIVE: reading exactly the most a bounded page may read passes.
    expect(codigos(VARREDURA_SAUDAVEL, { comCursor: true, leituraMaxima: 3 })).toEqual([]);
  });

  it('FAILS the full scan three ways — no index, no node on the entry, the predicate residual', () => {
    expect(codigos(VARREDURA_SCAN_CHEIO)).toEqual([
      'scan-sem-indice',
      'indice-ausente',
      'conta-residual',
    ]);
    const [indiceAusente] = julgarPlanoDaVarredura(VARREDURA_SCAN_CHEIO).motivos.filter(
      (m) => m.codigo === 'indice-ausente',
    );
    // The message says what to DO, not just what is wrong.
    expect(indiceAusente?.mensagem).toMatch(/not READY/);
    expect(indiceAusente?.mensagem).toMatch(/MERCADO_LIVRE_STOCK_SYNC_ENABLED/);
  });

  it('FAILS a plan on the COLLECTION-scope twin as `indice-ausente`', () => {
    expect(
      codigos(
        plano(
          '• SequentialScan',
          '|  index: /produtoMercadoLivre (contaOuterRef ASC)@[id = B]',
          '|  ranges:',
          '|   |----["integracao/x"]',
        ),
      ),
    ).toEqual(['indice-ausente']);
  });

  it('FAILS the right index ridden with NO bound on contaOuterRef', () => {
    expect(
      codigos(plano('• SequentialScan', `|  index: ${CG}`, '|  ranges:', '|   |----(-∞..+∞)', '|')),
    ).toEqual(['indice-sem-limite']);
  });

  it('a bound on the CURSOR alone is not a bound on the conta — still `indice-sem-limite`', () => {
    // Every conta's links from the cursor on, in key order: bounded, but by the
    // wrong field. Only a contaOuterRef bound keeps the walk inside one conta.
    expect(
      codigos(
        plano(
          '• SequentialScan',
          `|  index: ${CG}`,
          '|  ranges:',
          '|   |----(-∞..+∞)',
          '|   |----(EntityRef[produtos/a/produtoMercadoLivre/l2]..+∞)',
          '|',
        ),
      ),
    ).toEqual(['indice-sem-limite']);
  });

  it('FAILS a residual keyset cursor (the walk turns quadratic) and a residual Sort', () => {
    expect(
      codigos(
        plano(
          '• Sort',
          '└── • Filter',
          '     |  expression: $gt($__key__, EntityRef[produtos/a/produtoMercadoLivre/l2])',
          VARREDURA_SAUDAVEL,
        ),
      ),
    ).toEqual(['cursor-residual', 'sort-residual']);
  });

  it('a partition-bounded identifier-less node is NOT a full scan', () => {
    expect(
      codigos(
        plano(
          VARREDURA_SAUDAVEL,
          '• TableScan',
          '|  kind: /produtos/a/variacaoMercadoLivre',
          '|  partition: /produtos/a',
        ),
      ),
    ).toEqual([]);
  });
});

describe('julgarPlanoDaFaixaDeAvisos — the #1200 key range', () => {
  const INICIO = 'anuncioForaDaSincronizacao:e2e-x:';
  const FAIXA_LIMITADA = plano(
    '• Limit',
    '└── • TableScan',
    '     |  kind: /avisos',
    '     |  ranges:',
    `     |   |----[EntityRef[avisos/${INICIO}]..EntityRef[avisos/anuncioForaDaSincronizacao:e2e-x;])`,
    '     |',
    '     |  Execution:',
    '     |   records scanned: 2',
  );

  /** One TableScan on avisos: its range lines, push-down and read counter. */
  const noAvisos = ({
    ranges = [] as string[],
    filter = null as string | null,
    lidos = null as number | null,
  }) =>
    plano(
      '• TableScan',
      '|  kind: /avisos',
      ...(ranges.length > 0 ? ['|  ranges:', ...ranges.map((r) => `|   |----${r}`), '|'] : []),
      ...(filter == null ? [] : [`|  filter: ${filter}`]),
      ...(lidos == null ? [] : ['|  Execution:', `|   records scanned: ${lidos}`]),
    );
  const codigos = (plan: string, opcoes?: Parameters<typeof julgarPlanoDaFaixaDeAvisos>[1]) =>
    julgarPlanoDaFaixaDeAvisos(plan, opcoes).motivos.map((m) => m.codigo);

  it('PASSES a key range CLOSED at both ends, even with no index identifier (the primary key is no declared index)', () => {
    const v = julgarPlanoDaFaixaDeAvisos(FAIXA_LIMITADA, { inicio: INICIO, leituraMaxima: 4 });
    expect(v.motivos).toEqual([]);
    expect(v.detalhe).toBe(
      'closed key range on (no identifier, kind /avisos) — the range start is printed in its ' +
        'bound; read 2 (records scanned, 1 node(s)) ≤ 4',
    );
    expect(v.leitura).toEqual({ rotulo: 'records scanned', valor: 2, nos: 1 });
  });

  it('the range start in the bound strengthens the PASS line but is never required', () => {
    const v = julgarPlanoDaFaixaDeAvisos(FAIXA_LIMITADA, { inicio: 'outro:prefixo:' });
    expect(v.motivos).toEqual([]);
    expect(v.detalhe).toBe(
      'closed key range on (no identifier, kind /avisos); read 2 (records scanned, 1 node(s))',
    );
  });

  it('NEAR-MISS: a range bounded at the START only FAILS — it reads to the end of the collection', () => {
    const meiaFaixa = noAvisos({ ranges: [`[EntityRef[avisos/${INICIO}]..+∞)`] });
    expect(codigos(meiaFaixa)).toEqual(['faixa-sem-limite']);
    expect(codigos(meiaFaixa, { leituraMaxima: 4 })).toEqual(['faixa-sem-limite']);
    expect(julgarPlanoDaFaixaDeAvisos(meiaFaixa).motivos[0]?.mensagem).toMatch(/ONE side/);
    // …and the mirror image, bounded at the END only.
    expect(codigos(noAvisos({ ranges: ['(-∞..EntityRef[avisos/anuncio:x;])'] }))).toEqual([
      'faixa-sem-limite',
    ]);
  });

  it('a key PUSH-DOWN over an unbounded scan is no bound by its shape either', () => {
    expect(
      codigos(
        noAvisos({
          ranges: ['(-∞..+∞)'],
          filter: `(and($gte($__key__, EntityRef[avisos/${INICIO}]), $lt($__key__, EntityRef[avisos/x;])))`,
        }),
      ),
    ).toEqual(['faixa-sem-limite']);
  });

  it('a half-open range passes ONLY on a read counter within the ceiling', () => {
    const lida = (lidos: number) =>
      noAvisos({ ranges: [`[EntityRef[avisos/${INICIO}]..+∞)`], lidos });
    const dentro = julgarPlanoDaFaixaDeAvisos(lida(3), { leituraMaxima: 4 });
    expect(dentro.motivos).toEqual([]);
    expect(dentro.detalhe).toBe(
      'key range NOT closed in the plan on (no identifier, kind /avisos); read 3 (records ' +
        'scanned, 1 node(s)) ≤ 4 — the READ COUNTERS, not the plan shape, prove the scan stayed bounded',
    );
    expect(codigos(lida(30), { leituraMaxima: 4 })).toEqual(['leitura-excessiva']);
  });

  it('a counter that CONTRADICTS a closed range wins', () => {
    expect(codigos(FAIXA_LIMITADA, { leituraMaxima: 1 })).toEqual(['leitura-excessiva']);
  });

  it('FAILS an unbounded walk of avisos, a residual key filter, and a Sort', () => {
    const v = julgarPlanoDaFaixaDeAvisos(
      plano(
        '• Sort',
        '└── • Filter',
        '     |  expression: $gte($__key__, EntityRef[avisos/x])',
        '     └── • TableScan',
        '          |  kind: /avisos',
        '          |  ranges:',
        '          |   |----(-∞..+∞)',
      ),
    );
    expect(v.motivos.map((m) => m.codigo)).toEqual([
      'faixa-sem-limite',
      'faixa-residual',
      'sort-residual',
    ]);
  });

  it('FAILS a plan with no node on avisos at all — the verdict cannot be read', () => {
    expect(julgarPlanoDaFaixaDeAvisos(VARREDURA_SAUDAVEL).motivos.map((m) => m.codigo)).toEqual([
      'sem-no-de-avisos',
    ]);
  });
});

describe('classic explain (a database that accepts it)', () => {
  it('recognises Enterprise’s refusal — and nothing broader', () => {
    expect(
      RECUSA_EXPLAIN_ENTERPRISE_RE.test(
        '3 INVALID_ARGUMENT: Explain options are not supported in RunQuery API for Enterprise edition',
      ),
    ).toBe(true);
    expect(
      RECUSA_EXPLAIN_ENTERPRISE_RE.test('9 FAILED_PRECONDITION: The query requires an index'),
    ).toBe(false);
  });

  it('classicoServeVarredura: the GROUP-scope (contaOuterRef ASC, __name__ ASC) entry only', () => {
    expect(
      classicoServeVarredura([
        { query_scope: 'Collection group', properties: '(contaOuterRef ASC, __name__ ASC)' },
      ]),
    ).toBe(true);
    expect(
      classicoServeVarredura([
        { query_scope: 'Collection', properties: '(contaOuterRef ASC, __name__ ASC)' },
      ]),
    ).toBe(false);
    expect(
      classicoServeVarredura([
        { query_scope: 'Collection group', properties: '(contaOuterRef ASC, estado ASC)' },
      ]),
    ).toBe(false);
    expect(classicoServeVarredura([])).toBe(false);
  });

  it('classicoServeFaixa: the primary key alone — and an empty list is no pass', () => {
    expect(classicoServeFaixa([{ query_scope: 'Collection', properties: '(__name__ ASC)' }])).toBe(
      true,
    );
    expect(
      classicoServeFaixa([
        { query_scope: 'Collection', properties: '(__name__ ASC)' },
        { query_scope: 'Collection', properties: '(resolvidoEm ASC, __name__ ASC)' },
      ]),
    ).toBe(false);
    expect(classicoServeFaixa([])).toBe(false);
  });
});
