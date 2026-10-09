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
 * ---- The fixtures are REAL. `__planos__/*.txt` are plan texts captured on the
 * staging Enterprise database — `createFrom` of the audit's queries
 * (projection-less, see `consultaDaVarreduraSemProjecao`), plus read-only probes
 * of the shapes around them — with only the project id and the per-run hex
 * redacted. Each near-miss is DERIVED from one of them by a minimal, named edit
 * ({@link derivar}, which fails loudly when the text it edits is gone), so a
 * near-miss differs from a real plan in exactly the line that makes it fail.
 * Captured on 2026-10-09 by the staging suite, from the PRODUCTION builders:
 *  - `varredura-forma-{0,1}-{primeira,ultima}-pagina` — THE audit's walk, one
 *    `contaOuterRef ==` per stored ref form, its first page and its last (a
 *    `startAfter` cursor): `• Limit`, no sort, each reading exactly its page;
 *  - `avisos-abertos` — THE audit's open-avisos read: `avisos(resolvidoEm)` as
 *    the closed `[null]` point, scanning exactly the 7 rows it returned — with
 *    a residual `== null` re-check that discarded nothing and a `MajorSort` (the
 *    SDK's key order) that cut nothing.
 * Captured on 2026-10-08, the evidence that decided those two shapes:
 *  - `varredura-ultima-pagina` — the walk the audit USED to run (and the price
 *    phase still does), last page: `in` over both ref forms + a cursor. Bounded
 *    and seeking — and sorted (`MajorSort`);
 *  - `varredura-primeira-pagina` — the same `in` walk, page 1: the sort read all
 *    8 of the conta's links to return 2;
 *  - `varredura-uma-forma` / `-cursor` — read-only probes of ONE `==` ref form,
 *    page 1 / with a cursor: `• Limit`, reading exactly the page;
 *  - `varredura-sem-conta-no-indice` — the right CG index, no conta bound (a
 *    bare `ranges: /`); `varredura-sem-conta-por-chave` — key order with no
 *    conta at all, riding another index;
 *  - `faixa-de-avisos` — the avisos KEY RANGE the audit used to read;
 *    `-por-where` / `-so-inicio` — the same range as key filters / bounded at
 *    the start only. All three ride `avisos(resolvidoEm)` UNBOUNDED and scan the
 *    whole collection — real near-misses of the open-avisos verdict.
 * Every one of them is a PIPELINE plan — a PROXY of the classic query
 * (`explainPlan.mjs`'s header), not the classic query's own plan.
 * ⚠️ The two-form plan with its sort swapped for a Limit is not a correct plan
 * at all — its scan emits two conta streams conta-major, so a Limit over it
 * returns the wrong page — so it is kept, labelled HYPOTHETICAL, only as the
 * near-miss `fluxos-sem-merge` must catch.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  INDICE_DA_VARREDURA_RE,
  LIMITE_INFERIOR_DE_CHAVE_RE,
  NUMERIC_BOUND_RE,
  RECUSA_EXPLAIN_ENTERPRISE_RE,
  UNBOUNDED_RE,
  VARIAVEL_CHAVE_RE,
  VARIAVEL_CONTA_RE,
  INDICE_DOS_AVISOS_ABERTOS_RE,
  PONTO_NULO_RE,
  VARIAVEL_RESOLVIDO_RE,
  classicoServeAvisosAbertos,
  classicoServeVarredura,
  contadorDeLeitura,
  contadoresDeExecucao,
  contadoresDoCabecalho,
  filtrosResiduaisSobre,
  fluxosDeConta,
  julgarPlanoDaVarredura,
  julgarPlanoDosAvisosAbertos,
  limiteFechado,
  linhasDeIndiceLidas,
  nomesDeNos,
  nosDoPlano,
  parseAccessNodes,
  predicateInResidualFilters,
  scansSemIdentificador,
  seekaChave,
  semTestesDeExistencia,
  somaDeLeituras,
  sortsQueCortam,
  temMerge,
  temSortResidual,
  uniqueNodes,
} from './explainPlan.mjs';

/* -------------------------------- fixtures -------------------------------- */

/** A real plan captured on staging (2026-10-08, ids redacted). */
function planoReal(nome: string): string {
  // CRLF-tolerant: a Windows checkout without the repo's `eol=lf` must not
  // turn every line into `…\r`, which no reader here expects.
  return readFileSync(new URL(`./__planos__/${nome}.txt`, import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

/**
 * A near-miss DERIVED from a real plan: each `[de, para]` replaces EXACTLY one
 * occurrence of `de`. Throws when `de` is absent or ambiguous, so a re-captured
 * fixture cannot silently turn a near-miss into a copy of the real plan.
 */
function derivar(plano: string, ...trocas: [de: string, para: string][]): string {
  let out = plano;
  for (const [de, para] of trocas) {
    const partes = out.split(de);
    if (partes.length !== 2) {
      throw new Error(`derivar: ${JSON.stringify(de)} occurs ${partes.length - 1} times`);
    }
    out = partes.join(para);
  }
  return out;
}

const ULTIMA_PAGINA = planoReal('varredura-ultima-pagina');
const PRIMEIRA_PAGINA = planoReal('varredura-primeira-pagina');
const UMA_FORMA = planoReal('varredura-uma-forma');
const UMA_FORMA_CURSOR = planoReal('varredura-uma-forma-cursor');
const SEM_CONTA_NO_INDICE = planoReal('varredura-sem-conta-no-indice');
const SEM_CONTA_POR_CHAVE = planoReal('varredura-sem-conta-por-chave');
const FAIXA_DE_AVISOS = planoReal('faixa-de-avisos');
const FAIXA_POR_WHERE = planoReal('faixa-de-avisos-por-where');
const FAIXA_SO_INICIO = planoReal('faixa-de-avisos-so-inicio');
/** THE audit's walk, from the production builder: `[form, page, plan]`. */
const PAGINAS_DA_AUDITORIA = [0, 1].flatMap((forma) =>
  (['primeira', 'ultima'] as const).map(
    (pagina) => [forma, pagina, planoReal(`varredura-forma-${forma}-${pagina}-pagina`)] as const,
  ),
);
const AVISOS_ABERTOS = planoReal('avisos-abertos');

const CG = '**/produtoMercadoLivre (contaOuterRef ASC, __key__ ASC)@[id = CICAgJil0IYK]';
const INDICE_AVISOS = '/avisos (resolvidoEm ASC)@[id = CICAgJjUgIcJ]';
const CONTA_0 = '|----["documents/integracao/e2e-ml1200-<RUN>-x"]';
const CONTA_1 = '|----["integracao/e2e-ml1200-<RUN>-x"]';
/** The keyset cursor as the real dialect prints it — a key range from the cursor up. */
const CURSOR_K =
  '|----(EntityRef[partitionRef=<PROJECT>#default, path=/produtos/e2e-ml1200-<RUN>-k/produtoMercadoLivre/l1]..oid(000000000000000000000000))';
const CURSOR_A =
  '|----(EntityRef[partitionRef=<PROJECT>#default, path=/produtos/e2e-ml1200-<RUN>-a/produtoMercadoLivre/l1]..oid(000000000000000000000000))';
/** The walk's ceiling in the staging suite: one `==` stream reads EXACTLY its page of 2. */
const TETO_DA_VARREDURA = 2;
/** The open-avisos ceiling in the staging suite: the rows the read returned — 7 in the capture. */
const TETO_DOS_AVISOS = 7;

/**
 * How many of the staging seed's links sort just BELOW X's lower ref form — the
 * neighbour conta W (`auditoriaNaoEnumerados.staging.test.ts`). What an
 * unbounded scan that stops at its Limit must cross on page 1 before X's first.
 */
const VIZINHOS_ABAIXO = 3;

/** The real walk's `• MajorSort` block, and the `• Limit` a ONE-stream scan prints instead. */
const MAJOR_SORT_DA_VARREDURA = [
  '• MajorSort',
  '            |  fields: [$__key___4 ASC]',
  '            |  output: [$rid_2]',
  '            |  limit: 2',
].join('\n');
const LIMIT_DA_VARREDURA = ['• Limit', '            |  limit: 2'].join('\n');
/**
 * ⚠️ HYPOTHETICAL and INCORRECT — never a PASS exemplar. The real last page
 * with its sort swapped for a Limit: its scan opens TWO conta streams
 * (`fields: [$contaOuterRef_3, $__key___4, …]`, `key ordering length: 3`), so
 * rows leave it conta-major and a Limit straight over it would return the first
 * two links of ONE ref form — the wrong page. That is precisely why the planner
 * printed a MajorSort. It exists to prove `fluxos-sem-merge` fires; the only
 * PASS exemplars are the real one-form `• Limit` plans (`varredura-uma-forma*`).
 */
const ULTIMA_PAGINA_LIMIT_HIPOTETICA = derivar(ULTIMA_PAGINA, [
  MAJOR_SORT_DA_VARREDURA,
  LIMIT_DA_VARREDURA,
]);

/** The real exists-only residual Filter every walk page prints. */
const FILTRO_SO_EXISTENCIA = 'expression: (exists($contaOuterRef_3) AND exists($__key___4))';

/* --------------------------------- parsing -------------------------------- */

describe('parseAccessNodes on real plans', () => {
  it('the `in` walk’s last page: ONE SequentialScan on the CG entry, its ranges as a TREE — a cursor under each conta stream', () => {
    const nos = parseAccessNodes(ULTIMA_PAGINA);
    expect(nos).toHaveLength(1);
    const [no] = nos;
    expect(no).toMatchObject({
      type: 'SequentialScan',
      // 1-BASED: the line a human counts in the printed plan.
      line: 59,
      identifier: CG,
      kind: null,
      partition: null,
      filter: null,
      boundLines: [CONTA_0, CURSOR_K, CONTA_1, CURSOR_K],
      boundedLines: [CONTA_0, CURSOR_K, CONTA_1, CURSOR_K],
      faixas: [
        { linha: CONTA_0, filhas: [{ linha: CURSOR_K, filhas: [] }] },
        { linha: CONTA_1, filhas: [{ linha: CURSOR_K, filhas: [] }] },
      ],
    });
    expect(no?.execution).toEqual([
      'Execution:',
      'records returned: 2',
      'latency: 28.43 ms',
      'records scanned: 2',
      'data bytes read: 420 B',
    ]);
  });

  it('the old avisos key range: an index scan on resolvidoEm with a BARE `ranges: /` — no bound line, an empty tree', () => {
    const [no] = parseAccessNodes(FAIXA_DE_AVISOS);
    expect(no).toMatchObject({
      type: 'SequentialScan',
      identifier: INDICE_AVISOS,
      partition: '/',
      boundLines: [],
      faixas: [],
    });
  });

  it('the open-avisos read: the same index, its ONE root the closed `[null]` point', () => {
    const [no] = parseAccessNodes(AVISOS_ABERTOS);
    expect(no).toMatchObject({
      type: 'SequentialScan',
      identifier: INDICE_AVISOS,
      partition: '/',
      boundLines: ['|----[null]'],
      faixas: [{ linha: '|----[null]', filhas: [] }],
    });
    expect(limiteFechado('|----[null]')).toBe(true);
  });

  it('a line nests under the nearest one printed further LEFT, and a root-column line pops back to the root', () => {
    // Derived: a third level under the first stream's cursor.
    const tresNiveis = derivar(ULTIMA_PAGINA, [
      `${CURSOR_K}\n                               ${CONTA_1}`,
      `${CURSOR_K}\n                                         |----[1L]\n                               ${CONTA_1}`,
    ]);
    const [no] = parseAccessNodes(tresNiveis);
    expect(no?.faixas).toEqual([
      {
        linha: CONTA_0,
        filhas: [{ linha: CURSOR_K, filhas: [{ linha: '|----[1L]', filhas: [] }] }],
      },
      { linha: CONTA_1, filhas: [{ linha: CURSOR_K, filhas: [] }] },
    ]);
  });

  it('sees a node type it has never been told about, as long as it is a `…Scan`', () => {
    const outroNome = derivar(ULTIMA_PAGINA, ['• SequentialScan', '• HypotheticalRangeScan']);
    expect(parseAccessNodes(outroNome).map((n) => n.type)).toEqual(['HypotheticalRangeScan']);
    // …and only those: Compute, Fetch, MajorSort, Filter are not access nodes.
    expect(nomesDeNos(ULTIMA_PAGINA)).toEqual([
      'Compute',
      'Fetch',
      'MajorSort',
      'Filter',
      'SequentialScan',
    ]);
  });
});

describe('the bound readers', () => {
  it('UNBOUNDED_RE: the older fully-open spelling only — never a half-bounded line', () => {
    expect(UNBOUNDED_RE.test('|----(-∞..+∞)')).toBe(true);
    expect(UNBOUNDED_RE.test('|----(-inf..+inf)')).toBe(true);
    expect(UNBOUNDED_RE.test('|----[1,234L..+∞)')).toBe(false);
    expect(UNBOUNDED_RE.test(CURSOR_K)).toBe(false);
    expect(UNBOUNDED_RE.test(CONTA_0)).toBe(false);
  });

  it('NUMERIC_BOUND_RE: a numeric range — not a digit-laden id, not the cursor’s parenthesised `oid(000…)`', () => {
    expect(NUMERIC_BOUND_RE.test('|----[1,782,652,331,060,000L..+∞)')).toBe(true);
    expect(NUMERIC_BOUND_RE.test('|----[1234L]')).toBe(true);
    expect(NUMERIC_BOUND_RE.test('|----(-1..500L]')).toBe(true);
    expect(NUMERIC_BOUND_RE.test('|----["depositos/checkstock-1785244325954-dep"]')).toBe(false);
    expect(NUMERIC_BOUND_RE.test(CURSOR_K)).toBe(false);
  });

  it('limiteFechado: the real conta point is closed; the real cursor range — open at `oid(000…)` — is NOT', () => {
    expect(limiteFechado(CONTA_0)).toBe(true);
    expect(limiteFechado('|----["documents/integracao/x", "integracao/x"]')).toBe(true);
    expect(limiteFechado('|----[null]')).toBe(true);
    // An id that merely CONTAINS `inf` (or `oid`) is a value, not an infinite end.
    expect(limiteFechado('|----["integracao/inf-1"]')).toBe(true);
    expect(limiteFechado('|----["integracao/oid(0)"]')).toBe(true);
    // `oid(000…)` is the first value past the reference type: +∞ for a key.
    expect(limiteFechado(CURSOR_K)).toBe(false);
    expect(limiteFechado('|----(EntityRef[produtos/a]..+∞)')).toBe(false);
    expect(limiteFechado('|----(-∞..["integracao/x"]]')).toBe(false);
    expect(limiteFechado('|----[1,234L..+∞)')).toBe(false);
    expect(limiteFechado('|----(-∞..+∞)')).toBe(false);
    expect(limiteFechado('|----(-inf..+inf)')).toBe(false);
  });

  it('LIMITE_INFERIOR_DE_CHAVE_RE: the real cursor line is a key LOWER bound — a conta value is not', () => {
    expect(LIMITE_INFERIOR_DE_CHAVE_RE.test(CURSOR_K)).toBe(true);
    expect(
      LIMITE_INFERIOR_DE_CHAVE_RE.test('|----[EntityRef[avisos/a]..EntityRef[avisos/b])'),
    ).toBe(true);
    expect(LIMITE_INFERIOR_DE_CHAVE_RE.test('|----(-∞..EntityRef[produtos/a])')).toBe(false);
    expect(LIMITE_INFERIOR_DE_CHAVE_RE.test(CONTA_0)).toBe(false);
  });

  it('seekaChave: asked per stream — a cursor under one conta value says nothing about the other', () => {
    const [no] = parseAccessNodes(ULTIMA_PAGINA);
    expect(no?.faixas.map(seekaChave)).toEqual([true, true]);
    const [umSo] = parseAccessNodes(
      derivar(ULTIMA_PAGINA, [
        `${CONTA_1}\n                                    ${CURSOR_K}`,
        CONTA_1,
      ]),
    );
    expect(umSo?.faixas.map(seekaChave)).toEqual([true, false]);
  });
});

/* -------------------------------- residuals ------------------------------- */

describe('residual Filters: an existence test is not the predicate, a comparison is', () => {
  it('semTestesDeExistencia strips `exists($v)` and nothing else', () => {
    expect(semTestesDeExistencia(FILTRO_SO_EXISTENCIA)).not.toMatch(/\$/);
    // Near-misses: the comparison survives, and a look-alike function is no `exists`.
    expect(semTestesDeExistencia('(exists($a) AND ($b > 1))')).toMatch(/\$b/);
    expect(semTestesDeExistencia('not_exists($c)')).toMatch(/\$c/);
  });

  it('the plan variables: numbered as printed, and nothing that merely starts the same', () => {
    for (const v of ['$contaOuterRef', '$contaOuterRef_3'])
      expect(VARIAVEL_CONTA_RE.test(v)).toBe(true);
    expect(VARIAVEL_CONTA_RE.test('$contaOuterRefLegado')).toBe(false);
    for (const v of ['$__key__', '$__name__', '$__key___4', '$__name___1', '$key_5']) {
      expect(VARIAVEL_CHAVE_RE.test(v), v).toBe(true);
    }
    for (const v of ['$keyFoo', '$contaOuterRef_3', '$rid_2']) {
      expect(VARIAVEL_CHAVE_RE.test(v), v).toBe(false);
    }
  });

  it('the real walk’s exists-only Filter is NOT residual for either predicate', () => {
    expect(predicateInResidualFilters(ULTIMA_PAGINA, VARIAVEL_CONTA_RE)).toBe(false);
    expect(predicateInResidualFilters(ULTIMA_PAGINA, VARIAVEL_CHAVE_RE)).toBe(false);
  });

  it('NEAR-MISS: the same Filter with the cursor or the conta COMPARED in it is residual', () => {
    const cursor = derivar(ULTIMA_PAGINA, [
      FILTRO_SO_EXISTENCIA,
      'expression: (exists($contaOuterRef_3) AND exists($__key___4) AND ($__key___4 > ref(x)))',
    ]);
    expect(predicateInResidualFilters(cursor, VARIAVEL_CHAVE_RE)).toBe(true);
    expect(predicateInResidualFilters(cursor, VARIAVEL_CONTA_RE)).toBe(false);
    const conta = derivar(ULTIMA_PAGINA, [
      FILTRO_SO_EXISTENCIA,
      'expression: (exists($contaOuterRef_3) AND ($contaOuterRef_3 == "integracao/x"))',
    ]);
    expect(predicateInResidualFilters(conta, VARIAVEL_CONTA_RE)).toBe(true);
  });

  it('the old avisos key range IS residual on the key — `$key_5`, compared both ways', () => {
    expect(predicateInResidualFilters(FAIXA_DE_AVISOS, VARIAVEL_CHAVE_RE)).toBe(true);
    expect(predicateInResidualFilters(FAIXA_DE_AVISOS, VARIAVEL_CONTA_RE)).toBe(false);
  });

  it('only a `• Filter` node’s expression counts — a node-local `filter:` line is a push-down', () => {
    const pushDown = derivar(UMA_FORMA, [
      '                       key ordering length: 3',
      '                       filter: (equal_any($contaOuterRef_3, ["integracao/x"]))\n' +
        '                       key ordering length: 3',
    ]);
    // The real Filter above it is exists-only, so nothing residual remains.
    expect(predicateInResidualFilters(pushDown, VARIAVEL_CONTA_RE)).toBe(false);
    expect(parseAccessNodes(pushDown)[0]?.filter).toBe(
      '(equal_any($contaOuterRef_3, ["integracao/x"]))',
    );
  });

  it('a Filter block ends at its own stats and at the next node', () => {
    const depoisDasEstatisticas = derivar(ULTIMA_PAGINA, [
      '|   post-filtered rows: 0',
      '|   post-filtered rows: 0\n                |  expression: ($contaOuterRef_3 == "x")',
    ]);
    expect(predicateInResidualFilters(depoisDasEstatisticas, VARIAVEL_CONTA_RE)).toBe(false);
  });
});

describe('temSortResidual', () => {
  it('the real walk’s `• MajorSort` IS a sort; the one-form walk’s `• Limit` is not', () => {
    expect(temSortResidual(ULTIMA_PAGINA)).toBe(true);
    expect(temSortResidual(FAIXA_DE_AVISOS)).toBe(true);
    expect(temSortResidual(AVISOS_ABERTOS)).toBe(true);
    for (const [, , plano] of PAGINAS_DA_AUDITORIA) expect(temSortResidual(plano)).toBe(false);
    expect(temSortResidual(UMA_FORMA)).toBe(false);
    expect(temSortResidual(UMA_FORMA_CURSOR)).toBe(false);
    expect(temSortResidual(ULTIMA_PAGINA_LIMIT_HIPOTETICA)).toBe(false);
  });

  it('any name ENDING in Sort, plus TopN / TopK — never a streaming SortedMerge', () => {
    for (const nome of ['Sort', 'MinorSort', 'TopN', 'TopK']) {
      expect(temSortResidual(derivar(UMA_FORMA, ['• Limit', `• ${nome}`])), nome).toBe(true);
    }
    expect(temSortResidual(derivar(UMA_FORMA, ['• Limit', '• SortedMerge']))).toBe(false);
  });
});

describe('temMerge / fluxosDeConta — several conta streams need a sort or a merge above them', () => {
  it('temMerge: any name CONTAINING Merge — never a Union (it concatenates), a sort or a Limit', () => {
    for (const nome of ['SortedMerge', 'MergeUnion', 'Merge']) {
      expect(temMerge(derivar(UMA_FORMA, ['• Limit', `• ${nome}`])), nome).toBe(true);
    }
    for (const nome of ['Union', 'MajorSort', 'Limit']) {
      expect(temMerge(derivar(UMA_FORMA, ['• Limit', `• ${nome}`])), nome).toBe(false);
    }
    // No captured plan has ever printed one.
    for (const plano of [
      ULTIMA_PAGINA,
      PRIMEIRA_PAGINA,
      UMA_FORMA,
      FAIXA_DE_AVISOS,
      AVISOS_ABERTOS,
    ]) {
      expect(temMerge(plano)).toBe(false);
    }
  });

  it('fluxosDeConta: one per root range, one per value of a root point SET — none on a bare `ranges: /`', () => {
    const fluxos = (plano: string) => parseAccessNodes(plano).map(fluxosDeConta);
    expect(fluxos(ULTIMA_PAGINA)).toEqual([2]);
    expect(fluxos(PRIMEIRA_PAGINA)).toEqual([2]);
    expect(fluxos(UMA_FORMA)).toEqual([1]);
    expect(fluxos(UMA_FORMA_CURSOR)).toEqual([1]);
    expect(fluxos(SEM_CONTA_NO_INDICE)).toEqual([0]);
    // One root line holding BOTH ref forms is still two streams.
    expect(
      fluxos(derivar(UMA_FORMA, [CONTA_0, '|----["documents/integracao/x", "integracao/x"]'])),
    ).toEqual([2]);
    // A range root is one stream, whatever its ends spell.
    expect(fluxos(derivar(UMA_FORMA, [CONTA_0, '|----(-∞..+∞)']))).toEqual([1]);
  });
});

/* --------------------------------- counters ------------------------------- */

describe('the read counters', () => {
  it('per node: every numeric stat, a byte count at its exact `(N B)` value', () => {
    expect(contadoresDeExecucao(parseAccessNodes(ULTIMA_PAGINA)[0]!)).toEqual({
      'records returned': 2,
      latency: 28.43,
      'records scanned': 2,
      'data bytes read': 420,
    });
    expect(contadoresDeExecucao(parseAccessNodes(FAIXA_DE_AVISOS)[0]!)['data bytes read']).toBe(
      1115,
    );
  });

  it('plan-wide: the header above `Tree:` — and an id is not a counter', () => {
    expect(contadoresDoCabecalho(ULTIMA_PAGINA)).toEqual({
      'results returned': 2,
      // `query id: 23b4cf93…` is NOT the number 23.
      'request peak memory usage': 8192,
      'data bytes read': 755,
      'entity row scanned': 2,
      'index row scanned': 2,
      'read units': 3,
    });
    expect(linhasDeIndiceLidas(PRIMEIRA_PAGINA)).toBe(8);
    expect(linhasDeIndiceLidas(SEM_CONTA_POR_CHAVE)).toBe(25);
    expect(linhasDeIndiceLidas(derivar(UMA_FORMA, ['Tree:', 'Arvore:']))).toBeNull();
  });

  it('the READ counter is `records scanned` — never `returned`, which a full scan keeps small too', () => {
    const [no] = parseAccessNodes(PRIMEIRA_PAGINA);
    expect(contadorDeLeitura(no!)).toEqual({ rotulo: 'records scanned', valor: 8 });
    const [devolveMuito] = parseAccessNodes(
      derivar(UMA_FORMA, [
        '                        records returned: 2',
        '                        records returned: 500',
      ]),
    );
    expect(contadorDeLeitura(devolveMuito!)).toEqual({ rotulo: 'records scanned', valor: 2 });
    const [semLeitura] = parseAccessNodes(
      derivar(UMA_FORMA, ['                        records scanned: 2\n', '']),
    );
    expect(contadorDeLeitura(semLeitura!)).toBeNull();
  });

  it('somaDeLeituras: SUMS the nodes — and one silent node voids the sum', () => {
    const nos = [...parseAccessNodes(ULTIMA_PAGINA), ...parseAccessNodes(PRIMEIRA_PAGINA)];
    // Summed, never maxed: each stream read its own share.
    expect(somaDeLeituras(nos)).toEqual({ rotulo: 'records scanned', valor: 10, nos: 2 });
    const [semLeitura] = parseAccessNodes(
      derivar(UMA_FORMA, ['                        records scanned: 2\n', '']),
    );
    // A partial sum would UNDERSTATE the read — the direction that passes a bad plan.
    expect(somaDeLeituras([nos[0]!, semLeitura!])).toBeNull();
    expect(somaDeLeituras([])).toBeNull();
  });
});

describe('uniqueNodes / scansSemIdentificador', () => {
  it('dedupes identically-shaped nodes only', () => {
    const repetido = parseAccessNodes(`${UMA_FORMA}\n${UMA_FORMA}\n${UMA_FORMA_CURSOR}`);
    expect(repetido).toHaveLength(3);
    expect(uniqueNodes(repetido)).toHaveLength(2);
  });

  it('an identifier-less ROOT scan is a full scan; a partition-bounded one is not', () => {
    const semIndice = derivar(FAIXA_DE_AVISOS, [`index: ${INDICE_AVISOS}\n`, '']);
    expect(scansSemIdentificador(parseAccessNodes(semIndice)).cheios).toHaveLength(1);
    const porParticao = derivar(semIndice, ['partition: /\n', 'partition: /produtos/p1\n']);
    const { cheios, porParticao: particionados } = scansSemIdentificador(
      parseAccessNodes(porParticao),
    );
    expect(cheios).toEqual([]);
    expect(particionados.map((n) => n.partition)).toEqual(['/produtos/p1']);
    // The real plans all name an index.
    expect(scansSemIdentificador(parseAccessNodes(ULTIMA_PAGINA)).cheios).toEqual([]);
  });
});

describe('INDICE_DA_VARREDURA_RE — the COLLECTION_GROUP entry, and only it', () => {
  it.each([
    [CG, true],
    ['**/produtoMercadoLivre (contaOuterRef ASC, __name__ ASC)@[id = A]', true],
    // The other CG index the real key-order probe rode.
    ['**/produtoMercadoLivre (isUserProductModel ASC, __key__ ASC)@[id = CICAgJil0IYJ]', false],
    // The COLLECTION-scope twin cannot serve a group query.
    ['/produtoMercadoLivre (contaOuterRef ASC, __key__ ASC)@[id = A]', false],
    ['/produtos/p/produtoMercadoLivre (contaOuterRef ASC)@[id = A]', false],
    ['**/produtoMercadoLivre (contaOuterRef DESC, __key__ ASC)@[id = A]', false],
    [INDICE_AVISOS, false],
  ])('%s → %s', (identifier, esperado) => {
    expect(INDICE_DA_VARREDURA_RE.test(identifier)).toBe(esperado);
  });
});

/* ---------------------------------- verdicts ------------------------------ */

describe('julgarPlanoDaVarredura — the #1200 walk, on real plans', () => {
  type Opcoes = Parameters<typeof julgarPlanoDaVarredura>[1];
  const codigos = (plan: string, opcoes?: Opcoes) =>
    julgarPlanoDaVarredura(plan, opcoes).motivos.map((m) => m.codigo);
  const comCursor = { comCursor: true, leituraMaxima: TETO_DA_VARREDURA };

  it.each(PAGINAS_DA_AUDITORIA)(
    'PASSES THE audit’s page — form %i, %s page, the production builder’s real plan',
    (_forma, pagina, plano) => {
      const v = julgarPlanoDaVarredura(plano, {
        comCursor: pagina === 'ultima',
        leituraMaxima: TETO_DA_VARREDURA,
      });
      expect(v.motivos).toEqual([]);
      expect(v.alvo?.identifier).toBe(CG);
      expect(v.leitura).toEqual({ rotulo: 'records scanned', valor: 2, nos: 1 });
      expect(v.leituraTotal).toBe(2);
      // One stream, one ref form.
      expect(parseAccessNodes(plano).map(fluxosDeConta)).toEqual([1]);
      // A last page that does not SEEK fails: the shape checks it, not the label.
      if (pagina === 'primeira') {
        expect(
          julgarPlanoDaVarredura(plano, { comCursor: true }).motivos.map((m) => m.codigo),
        ).toEqual(['cursor-sem-limite']);
      }
    },
  );

  it('PASSES the 2026-10-08 one-form probe with a cursor on its SHAPE — conta a closed value, cursor a key lower bound, read == page', () => {
    const v = julgarPlanoDaVarredura(UMA_FORMA_CURSOR, comCursor);
    expect(v.motivos).toEqual([]);
    expect(v.alvo?.identifier).toBe(CG);
    expect(v.leitura).toEqual({ rotulo: 'records scanned', valor: 2, nos: 1 });
    expect(v.leituraTotal).toBe(2);
    expect(v.detalhe).toBe(
      `contaOuterRef value bound on ${CG}, the keyset cursor a key lower bound; ` +
        `read 2 (records scanned, 1 node(s)) ≤ ${TETO_DA_VARREDURA}`,
    );
    // Page 1 of the same walk, no cursor.
    expect(codigos(UMA_FORMA, { leituraMaxima: TETO_DA_VARREDURA })).toEqual([]);
  });

  it('REAL FAIL: the `in` walk’s last page (the price phase’s; the audit’s until 2026-10-09) is bounded and seeks — and SORTS, its one finding', () => {
    const v = julgarPlanoDaVarredura(ULTIMA_PAGINA, comCursor);
    expect(v.motivos.map((m) => m.codigo)).toEqual(['sort-residual']);
    expect(v.motivos[0]?.mensagem).toMatch(/MajorSort/);
    expect(v.motivos[0]?.mensagem).toMatch(/one `==` per ref form/);
    // Said as what it is: a finding about the PROXY, not the classic query.
    expect(v.motivos[0]?.mensagem).toMatch(/PROXY plan/);
    expect(v.motivos[0]?.mensagem).toMatch(/proxy-plan finding/);
  });

  it('HYPOTHETICAL NEAR-MISS: the sort swapped for a Limit over the same two conta streams is the WRONG page — `fluxos-sem-merge`', () => {
    // Bounded, seeking and within the ceiling: every OTHER check passes it, so
    // this is the one that keeps it from reading as the healthy shape.
    expect(codigos(ULTIMA_PAGINA_LIMIT_HIPOTETICA, comCursor)).toEqual(['fluxos-sem-merge']);
    expect(
      julgarPlanoDaVarredura(ULTIMA_PAGINA_LIMIT_HIPOTETICA, comCursor).motivos[0]?.mensagem,
    ).toMatch(/2 conta streams .* the wrong page/);
    // Page 1 the same way, read cut to the page.
    const primeiraComLimit = derivar(
      PRIMEIRA_PAGINA,
      [MAJOR_SORT_DA_VARREDURA, LIMIT_DA_VARREDURA],
      ['                        records scanned: 8', '                        records scanned: 2'],
      [' index row scanned: 8', ' index row scanned: 2'],
    );
    expect(codigos(primeiraComLimit, { leituraMaxima: TETO_DA_VARREDURA })).toEqual([
      'fluxos-sem-merge',
    ]);
    // A Union concatenates — it is no merge.
    expect(
      codigos(derivar(ULTIMA_PAGINA_LIMIT_HIPOTETICA, ['• Limit', '• Union']), comCursor),
    ).toEqual(['fluxos-sem-merge']);
    // A merge-named node above the streams answers it — and ONLY it. Not a PASS
    // exemplar: no merge plan has ever been observed.
    const comMerge = derivar(ULTIMA_PAGINA, ['• MajorSort', '• SortedMerge']);
    expect(codigos(comMerge, comCursor)).not.toContain('fluxos-sem-merge');
    // One stream needs neither: the real one-form Limit plans stay clean.
    expect(codigos(UMA_FORMA_CURSOR, comCursor)).not.toContain('fluxos-sem-merge');
  });

  it('REAL FAIL: the `in` walk’s page 1 shows what the sort costs — all 8 of the conta’s links read for 2 rows', () => {
    expect(codigos(PRIMEIRA_PAGINA, { leituraMaxima: TETO_DA_VARREDURA })).toEqual([
      'leitura-excessiva',
      'sort-residual',
    ]);
    // With no ceiling the shape still catches it; the counter is a second,
    // dialect-independent witness of the same sort.
    expect(codigos(PRIMEIRA_PAGINA)).toEqual(['sort-residual']);
  });

  it('REAL NEAR-MISS: the right CG index with a bare `ranges: /` FAILS — though it read only the 2 rows a page may', () => {
    const v = julgarPlanoDaVarredura(SEM_CONTA_NO_INDICE, { leituraMaxima: TETO_DA_VARREDURA });
    expect(v.motivos.map((m) => m.codigo)).toEqual(['indice-sem-limite']);
    // The counter was within the ceiling: the SHAPE decided, as it must when
    // no conta is bound at all.
    expect(v.leitura?.valor).toBeLessThanOrEqual(TETO_DA_VARREDURA);
    expect(v.motivos[0]?.mensagem).toMatch(/MERCADO_LIVRE_STOCK_SYNC_ENABLED/);
  });

  it('REAL NEAR-MISS: key order with no conta rides ANOTHER index — and the plan-wide counter shows the walk', () => {
    const v = julgarPlanoDaVarredura(SEM_CONTA_POR_CHAVE, { leituraMaxima: TETO_DA_VARREDURA });
    expect(v.motivos.map((m) => m.codigo)).toEqual([
      'indice-ausente',
      'leitura-excessiva',
      'sort-residual',
    ]);
    // No node rides the CG entry, so only the header total can say it.
    expect(v.leitura).toBeNull();
    expect(v.leituraTotal).toBe(25);
    expect(v.motivos.find((m) => m.codigo === 'leitura-excessiva')?.mensagem).toMatch(
      /25 \(index row scanned, whole query\)/,
    );
    expect(v.motivos[0]?.mensagem).toMatch(/not READY/);
  });

  it('DERIVED: the conta bound removed from the one-form page (a bare `ranges: /`) FAILS', () => {
    const semConta = derivar(UMA_FORMA_CURSOR, [
      `\n                               ${CONTA_0}\n                                    ${CURSOR_A}`,
      '',
    ]);
    expect(codigos(semConta, comCursor)).toEqual(['indice-sem-limite']);
  });

  it('DERIVED: ONE of the two conta streams unbounded FAILS — a bounded sibling cannot speak for it', () => {
    // From the REAL last page, so its own finding (the sort) rides along.
    const umAberto = derivar(ULTIMA_PAGINA, [
      `${CONTA_1}\n                                    ${CURSOR_K}`,
      '|----(-∞..+∞)',
    ]);
    // Within the ceiling, and still a FAIL: no node is bounded on the conta.
    expect(codigos(umAberto, comCursor)).toEqual(['indice-sem-limite', 'sort-residual']);
  });

  it('DERIVED: the cursor NOT seeked fails on the shape — and on the counter once it reads what that costs', () => {
    const semCursor = derivar(UMA_FORMA_CURSOR, [
      `\n                                    ${CURSOR_A}`,
      '',
    ]);
    expect(codigos(semCursor, { comCursor: true })).toEqual(['cursor-sem-limite']);
    // Page 1 carries no cursor, so there is nothing to seek.
    expect(codigos(semCursor)).toEqual([]);
    // A per-entry cursor on the last page re-reads every earlier link of the
    // conta: the suite's seed puts that at 8, past the ceiling.
    const custoReal = derivar(
      semCursor,
      ['                        records scanned: 2', '                        records scanned: 8'],
      [' index row scanned: 2', ' index row scanned: 8'],
    );
    expect(codigos(custoReal, comCursor)).toEqual(['leitura-excessiva']);
    // Only a counter WITHIN a known ceiling may excuse the shape.
    expect(julgarPlanoDaVarredura(semCursor, comCursor).detalhe).toMatch(
      /tested in the scan; read 2 .* — the READ COUNTERS, not the plan shape/,
    );
    // …and only the JUDGED node's counter: the plan-wide total may fail a plan,
    // never pass one — with the node's own counter gone, a total within the
    // ceiling says nothing about which node read it.
    const semContadorDoNo = derivar(semCursor, [
      '                        records scanned: 2\n',
      '',
    ]);
    expect(codigos(semContadorDoNo, comCursor)).toEqual(['cursor-sem-limite']);
  });

  it('DERIVED: the cursor seeking on ONE stream only FAILS on the shape', () => {
    const umStream = derivar(ULTIMA_PAGINA, [
      `${CONTA_1}\n                                    ${CURSOR_K}`,
      CONTA_1,
    ]);
    expect(codigos(umStream, { comCursor: true })).toEqual(['cursor-sem-limite', 'sort-residual']);
  });

  it('DERIVED: a conta push-down over a bare `ranges: /` on page 1 passes ONLY on counters — which is why the staging seed puts a neighbour just BELOW the conta', () => {
    // The real one-form page 1, its conta bound turned into a node-local
    // `equal_any` push-down over an UNBOUNDED range: the shape of a walk of
    // every conta's links, tested entry by entry.
    const pushDown = derivar(
      UMA_FORMA,
      [`\n                               ${CONTA_0}`, ''],
      [
        '                       key ordering length: 3',
        '                       filter: (equal_any($contaOuterRef_3, ["documents/integracao/x"]))\n' +
          '                       key ordering length: 3',
      ],
    );
    expect(parseAccessNodes(pushDown)[0]?.faixas).toEqual([]);
    // The shape alone never passes it.
    expect(codigos(pushDown)).toEqual(['indice-sem-limite']);
    // ⚠️ The documented hole: a scan that stops at its Limit reads only what
    // sorts BELOW the conta plus the page. With nothing below it read 2, inside
    // the ceiling, and the counters PASS it — no cursor, so no cursor check.
    expect(codigos(pushDown, { leituraMaxima: TETO_DA_VARREDURA })).toEqual([]);
    expect(julgarPlanoDaVarredura(pushDown, { leituraMaxima: TETO_DA_VARREDURA }).detalhe).toMatch(
      /push-down .* the READ COUNTERS, not the plan shape/,
    );
    // With the staging seed's W below X, the same scan crosses W's entries
    // first, and the counter now sees the walk.
    const lidas = VIZINHOS_ABAIXO + 2;
    const comVizinhos = derivar(
      pushDown,
      [
        '                        records scanned: 2',
        `                        records scanned: ${lidas}`,
      ],
      [' index row scanned: 2', ` index row scanned: ${lidas}`],
    );
    expect(lidas).toBeGreaterThan(TETO_DA_VARREDURA);
    expect(codigos(comVizinhos, { leituraMaxima: TETO_DA_VARREDURA })).toEqual([
      'leitura-excessiva',
    ]);
  });

  it('DERIVED: the plan-wide counter fails a plan whose judged node reads within the ceiling', () => {
    const totalAlto = derivar(UMA_FORMA_CURSOR, [' index row scanned: 2', ' index row scanned: 9']);
    expect(codigos(totalAlto, comCursor)).toEqual(['leitura-excessiva']);
    // The ceiling is INCLUSIVE: reading exactly the most a bounded page may read passes.
    expect(codigos(UMA_FORMA_CURSOR, { comCursor: true, leituraMaxima: 2 })).toEqual([]);
    expect(codigos(UMA_FORMA_CURSOR, { comCursor: true, leituraMaxima: 1 })).toEqual([
      'leitura-excessiva',
    ]);
  });

  it('DERIVED: the cursor or the conta COMPARED in the residual Filter FAILS', () => {
    const cursorResidual = derivar(UMA_FORMA_CURSOR, [
      FILTRO_SO_EXISTENCIA,
      'expression: (exists($contaOuterRef_3) AND exists($__key___4) AND ($__key___4 > ref(x)))',
    ]);
    expect(codigos(cursorResidual, comCursor)).toEqual(['cursor-residual']);
    const contaResidual = derivar(UMA_FORMA_CURSOR, [
      FILTRO_SO_EXISTENCIA,
      'expression: (exists($contaOuterRef_3) AND ($contaOuterRef_3 == "integracao/x"))',
    ]);
    expect(codigos(contaResidual, comCursor)).toEqual(['conta-residual']);
  });

  it('DERIVED: the CG index renamed to its COLLECTION-scope twin is `indice-ausente`', () => {
    const colecao = derivar(UMA_FORMA_CURSOR, [
      CG,
      '/produtoMercadoLivre (contaOuterRef ASC)@[id = B]',
    ]);
    expect(codigos(colecao, comCursor)).toEqual(['indice-ausente']);
  });

  it('DERIVED: an identifier-less root scan is `scan-sem-indice`', () => {
    const semIndice = derivar(UMA_FORMA_CURSOR, [`index: ${CG}\n`, '']);
    expect(codigos(semIndice, comCursor)).toEqual(['scan-sem-indice', 'indice-ausente']);
  });
});

describe('nosDoPlano / filtrosResiduaisSobre / sortsQueCortam — what a Filter discarded, what a sort cut', () => {
  it('nosDoPlano: every node in PRINT order, each with its own counters', () => {
    const nos = nosDoPlano(AVISOS_ABERTOS);
    expect(nos.map((n) => n.nome)).toEqual([
      'Compute',
      'MajorSort',
      'Compute',
      'Fetch',
      'Filter',
      'SequentialScan',
    ]);
    expect(nos.find((n) => n.nome === 'Filter')?.contadores).toMatchObject({
      'records returned': 7,
      'post-filtered rows': 0,
    });
    expect(nos.at(-1)?.contadores['records scanned']).toBe(7);
  });

  it('filtrosResiduaisSobre: the Filter COMPARING the variable — never an exists-only one', () => {
    expect(filtrosResiduaisSobre(AVISOS_ABERTOS, VARIAVEL_RESOLVIDO_RE).map((n) => n.nome)).toEqual(
      ['Filter'],
    );
    // The walk's Filter only tests existence; the key range's compares the key.
    expect(filtrosResiduaisSobre(ULTIMA_PAGINA, VARIAVEL_CONTA_RE)).toEqual([]);
    expect(filtrosResiduaisSobre(FAIXA_DE_AVISOS, VARIAVEL_RESOLVIDO_RE)).toEqual([]);
    expect(filtrosResiduaisSobre(FAIXA_DE_AVISOS, VARIAVEL_CHAVE_RE)).toHaveLength(1);
  });

  it('sortsQueCortam: a sort CUTS when the node below it returned more — 8 into 2 cuts, 2 into 2 and 7 into 7 do not', () => {
    expect(sortsQueCortam(PRIMEIRA_PAGINA).map((n) => n.nome)).toEqual(['MajorSort']);
    expect(sortsQueCortam(ULTIMA_PAGINA)).toEqual([]);
    expect(sortsQueCortam(AVISOS_ABERTOS)).toEqual([]);
    // A count gone from either side is unprovable: it counts as a cut.
    const semContagem = derivar(AVISOS_ABERTOS, [
      '|   records returned: 7\n    |   latency: 27.67 ms',
      '|   latency: 27.67 ms',
    ]);
    expect(sortsQueCortam(semContagem).map((n) => n.nome)).toEqual(['MajorSort']);
  });
});

describe('julgarPlanoDosAvisosAbertos — the #1200 open-avisos read, on real plans', () => {
  type Opcoes = Parameters<typeof julgarPlanoDosAvisosAbertos>[1];
  const codigos = (plan: string, opcoes?: Opcoes) =>
    julgarPlanoDosAvisosAbertos(plan, opcoes).motivos.map((m) => m.codigo);
  const comTeto = { leituraMaxima: TETO_DOS_AVISOS };

  const INDICE_AVISOS_LINHA = `index: ${INDICE_AVISOS}`;
  const PONTO_NULO = '|----[null]';
  const RANGES_NULO = `                       ranges: /\n                               ${PONTO_NULO}\n`;
  const FILTRO_RECONFERE = '|   post-filtered rows: 0';
  /** The MajorSort's INPUT — the Compute right below it — as the capture printed it. */
  const ENTRADA_DO_SORT = '|   records returned: 7\n        |   latency: 27.00 ms';

  it('PASSES the real read: the [null] point on avisos(resolvidoEm), read == the 7 rows returned', () => {
    const v = julgarPlanoDosAvisosAbertos(AVISOS_ABERTOS, comTeto);
    expect(v.motivos).toEqual([]);
    expect(v.alvo?.identifier).toBe(INDICE_AVISOS);
    expect(v.leitura).toEqual({ rotulo: 'records scanned', valor: 7, nos: 1 });
    expect(v.leituraTotal).toBe(7);
    // The two things the proxy prints that cost nothing are SAID, not hidden.
    expect(v.detalhe).toBe(
      `the [null] point range on ${INDICE_AVISOS}; read 7 (records scanned, 1 node(s)) ≤ 7 — ` +
        'the residual resolvidoEm re-check discarded nothing; the sort (the proxy’s key order) ' +
        'cut nothing',
    );
    // With no ceiling the shape alone passes it.
    expect(codigos(AVISOS_ABERTOS)).toEqual([]);
  });

  it('REAL NEAR-MISS: every key-range shape the audit used to read rides the SAME index UNBOUNDED', () => {
    for (const plano of [FAIXA_DE_AVISOS, FAIXA_POR_WHERE, FAIXA_SO_INICIO]) {
      expect(parseAccessNodes(plano)[0]?.identifier).toBe(INDICE_AVISOS);
      expect(codigos(plano)).toContain('abertos-sem-limite');
      // …and a ceiling of the rows it returned sees the walk too.
      expect(codigos(plano, { leituraMaxima: 2 })).toContain('leitura-excessiva');
    }
    expect(julgarPlanoDosAvisosAbertos(FAIXA_DE_AVISOS).motivos[0]?.mensagem).toMatch(
      /resolved avisos after the open ones/,
    );
  });

  it.each([
    ['a bare `ranges: /`', '                       ranges: /\n'],
    [
      'a half-open range from null on',
      `                       ranges: /\n                               |----[null..+∞)\n`,
    ],
    [
      'a set holding another value',
      `                       ranges: /\n                               |----[null, 1L]\n`,
    ],
    [
      'the older fully-open spelling',
      `                       ranges: /\n                               |----(-∞..+∞)\n`,
    ],
  ])(
    'DERIVED: the [null] point widened to %s FAILS on its shape — whatever the counters say',
    (_n, ranges) => {
      const aberto = derivar(AVISOS_ABERTOS, [RANGES_NULO, ranges]);
      // Within the ceiling (the capture's counters), and still a FAIL — and the
      // `== null` Filter is now what SELECTS, so it is no re-check any more.
      expect(codigos(aberto, comTeto)).toEqual(['abertos-sem-limite', 'resolvido-residual']);
    },
  );

  it('DERIVED: a residual resolvidoEm comparison that DISCARDED rows — or prints no count — FAILS', () => {
    expect(
      codigos(derivar(AVISOS_ABERTOS, [FILTRO_RECONFERE, '|   post-filtered rows: 3']), comTeto),
    ).toEqual(['resolvido-residual']);
    expect(codigos(derivar(AVISOS_ABERTOS, [`${FILTRO_RECONFERE}\n`, '']), comTeto)).toEqual([
      'resolvido-residual',
    ]);
  });

  it('DERIVED: the same re-check over an UNBOUNDED range is the predicate served residually', () => {
    const semLimite = derivar(AVISOS_ABERTOS, [RANGES_NULO, '                       ranges: /\n']);
    expect(codigos(semLimite)).toEqual(['abertos-sem-limite', 'resolvido-residual']);
  });

  it('DERIVED: a sort that CUTS its input — or prints no count — FAILS', () => {
    const corta = derivar(AVISOS_ABERTOS, [
      ENTRADA_DO_SORT,
      '|   records returned: 12\n        |   latency: 27.00 ms',
    ]);
    expect(codigos(corta, comTeto)).toEqual(['sort-residual']);
    expect(julgarPlanoDosAvisosAbertos(corta).motivos[0]?.mensagem).toMatch(/MajorSort, plan line/);
    const semContagem = derivar(AVISOS_ABERTOS, [
      '|   records returned: 7\n    |   latency: 27.67 ms',
      '|   latency: 27.67 ms',
    ]);
    expect(codigos(semContagem, comTeto)).toEqual(['sort-residual']);
  });

  it('DERIVED: counters above the rows returned FAIL — the judged node or the whole query', () => {
    expect(
      codigos(
        derivar(AVISOS_ABERTOS, [
          '                        records scanned: 7',
          '                        records scanned: 9',
        ]),
        comTeto,
      ),
    ).toEqual(['leitura-excessiva']);
    expect(
      codigos(derivar(AVISOS_ABERTOS, [' index row scanned: 7', ' index row scanned: 9']), comTeto),
    ).toEqual(['leitura-excessiva']);
    // The ceiling is INCLUSIVE.
    expect(codigos(AVISOS_ABERTOS, { leituraMaxima: 6 })).toEqual(['leitura-excessiva']);
  });

  it('DERIVED: the bell’s composite instead of the single-field entry is `indice-ausente`', () => {
    const composto = derivar(AVISOS_ABERTOS, [
      INDICE_AVISOS,
      '/avisos (resolvidoEm ASC, criadoEm DESC)@[id = B]',
    ]);
    // With the [null] point gone from the expected index, the `== null` Filter is
    // what selects: it is no re-check any more.
    expect(codigos(composto, comTeto)).toEqual(['indice-ausente', 'resolvido-residual']);
  });

  it('DERIVED: an identifier-less root scan is `scan-sem-indice`; a plan with no avisos node is `indice-ausente`', () => {
    const semIndice = derivar(AVISOS_ABERTOS, [`${INDICE_AVISOS_LINHA}\n`, '']);
    expect(codigos(semIndice, comTeto)).toEqual([
      'scan-sem-indice',
      'indice-ausente',
      'resolvido-residual',
    ]);
    expect(codigos(UMA_FORMA_CURSOR)).toEqual(['indice-ausente']);
  });

  it('the index and point readers — the single-field entry and the [null] point only', () => {
    for (const [identifier, esperado] of [
      [INDICE_AVISOS, true],
      ['/avisos (resolvidoEm ASC, __key__ ASC)@[id = A]', true],
      ['/avisos (resolvidoEm ASC, criadoEm DESC)@[id = A]', false],
      ['/avisos (resolvidoEm DESC)@[id = A]', false],
      ['**/avisos (resolvidoEm ASC)@[id = A]', false],
      ['/avisosLeitura (resolvidoEm ASC)@[id = A]', false],
    ] as const) {
      expect(INDICE_DOS_AVISOS_ABERTOS_RE.test(identifier), identifier).toBe(esperado);
    }
    expect(PONTO_NULO_RE.test(PONTO_NULO)).toBe(true);
    for (const linha of ['|----[null..+∞)', '|----[null, 1L]', '|----["null"]', '|----(-∞..+∞)']) {
      expect(PONTO_NULO_RE.test(linha), linha).toBe(false);
    }
    for (const v of ['$resolvidoEm', '$resolvidoEm_4'])
      expect(VARIAVEL_RESOLVIDO_RE.test(v)).toBe(true);
    expect(VARIAVEL_RESOLVIDO_RE.test('$resolvidoEmUs')).toBe(false);
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

  it('classicoServeAvisosAbertos: the COLLECTION-scope (resolvidoEm ASC, __name__ ASC) entry alone', () => {
    expect(
      classicoServeAvisosAbertos([
        { query_scope: 'Collection', properties: '(resolvidoEm ASC, __name__ ASC)' },
      ]),
    ).toBe(true);
    // The bell's composite, the primary key, a group scope, or a second index: no.
    for (const usados of [
      [
        {
          query_scope: 'Collection',
          properties: '(resolvidoEm ASC, criadoEm DESC, __name__ DESC)',
        },
      ],
      [{ query_scope: 'Collection', properties: '(__name__ ASC)' }],
      [{ query_scope: 'Collection group', properties: '(resolvidoEm ASC, __name__ ASC)' }],
      [
        { query_scope: 'Collection', properties: '(resolvidoEm ASC, __name__ ASC)' },
        { query_scope: 'Collection', properties: '(__name__ ASC)' },
      ],
      [],
    ]) {
      expect(classicoServeAvisosAbertos(usados), JSON.stringify(usados)).toBe(false);
    }
  });
});
