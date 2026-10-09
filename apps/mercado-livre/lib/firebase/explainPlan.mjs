// @ts-check
/**
 * Pure readers of a Firestore **Enterprise** explain plan — the `text` output of
 * a pipeline's `execute({ explainOptions: { mode: 'analyze', outputFormat:
 * 'text' } })` — and the two verdicts the #1200 link audit stands on.
 *
 * ONE copy, two consumers (the #1369 rule — two files that "mirror" each other
 * drift toward plausible while disagreeing):
 *  - `scripts/check-stock-indexes.mjs`, the MANUAL staging gate a human runs;
 *  - `lib/marketplace/estoque/auditoriaNaoEnumerados.staging.test.ts`, the
 *    automated suite `ci-mercado-livre.yml` runs against staging on every
 *    in-scope PR, which asserts every verdict a PASS on the audit's own pages.
 * Plain `.mjs` + JSDoc (`@ts-check`, so `tsc` still checks it through the
 * importing test) because the script runs under bare `node`, which cannot import
 * TypeScript. Nothing here touches Firestore: every function takes the plan TEXT
 * and is unit-tested offline in `explainPlan.test.ts`.
 *
 * ---- Why a PIPELINE plan at all. Enterprise refuses classic explain — `3
 * INVALID_ARGUMENT: Explain options are not supported in RunQuery API for
 * Enterprise edition` — so a classic query's own plan is unobservable from a
 * client. What CAN be explained is the pipeline translation of the same query
 * (a PROXY) — and both consumers take it from the SDK itself,
 * `db.pipeline().createFrom(<the classic query's PROJECTION-LESS half>)`
 * (`consultaDaVarreduraSemProjecao` / `consultaDosAvisosAbertosSemProjecao`),
 * never from a hand-built pipeline that could drift from the query it stands
 * for. Projection-less because `createFrom` emits a query's `select` BEFORE the
 * `exists(__name__)` / `sort(__name__)` stages it derives from the order, so the
 * key is gone and the proxy returns zero rows and no plan (the stage list is in
 * `consultaDaVarreduraSemProjecao`'s docblock). Read precisely what a proxy
 * verdict proves: a proxy that rides no node on the expected index means that
 * index is not READY in the project (readiness does not depend on the API) — a
 * real FAIL; a proxy PASS proves the index is READY and serves the predicate,
 * NOT the classic query's own plan, which only Query Insights confirms after a
 * real run. ⚠️ The same limit binds a proxy FAIL on anything but readiness: a
 * sort node, a residual Filter or an over-read are choices the planner made for
 * the PIPELINE the SDK built — one with an explicit `sort` stage and the cursor
 * as `where` stages (`Query._pipeline()`, `@google-cloud/firestore` 8.6.0) —
 * and are PROXY-PLAN FINDINGS, never established facts about the classic
 * request production sends.
 *
 * ---- The dialect, RECALIBRATED on real staging plans on 2026-10-08 and
 * 2026-10-09 (`@google-cloud/firestore` 8.6.0, `createFrom` of the #1200
 * queries plus read-only near-misses; the captured texts are the fixtures under
 * `__planos__/`, ids redacted). The format is not machine-stable, so every
 * consumer also PRINTS the plan. What a plan looks like:
 *  - a header — `Execution:` (`results returned`, `data bytes read`, `entity
 *    row scanned`, `index row scanned`) and `Billing:` (`read units`) — then a
 *    `Tree:` of `• <Node>` bullets: `Compute`, `Fetch` (documents by record id),
 *    `Limit`, `MajorSort`, `Filter`, and the access node, a `SequentialScan`;
 *  - the access node names its index — `index: <scope>/produtoMercadoLivre
 *    (contaOuterRef ASC, __key__ ASC)@[id = …]`, where a COLLECTION_GROUP
 *    entry's `<scope>` is a double-star segment and a COLLECTION one's is empty
 *    (and `__name__` prints as `__key__`) — and
 *    its bounds as a TREE under `ranges: /`, one level per index field:
 *    `|----["documents/integracao/<conta>"]` and, indented under it, the keyset
 *    cursor `|----(EntityRef[partitionRef=…, path=/produtos/…]..oid(000…))`.
 *    ⚠️ An UNBOUNDED scan prints `ranges: /` with NO line under it at all (the
 *    older `(-∞..+∞)` spelling is still honoured), and `..oid(000…))` is the end
 *    of the reference type — `+∞` for a document key, so a key range ending
 *    there is open at the top;
 *  - every page carries a residual `• Filter` whose expression is only
 *    `exists($contaOuterRef_3) AND exists($__key___4)` (`post-filtered rows: 0`)
 *    — an existence test on rows the range already bounded, which reads nothing
 *    more. Only a COMPARISON in a Filter is the predicate served residually;
 *  - the open-avisos read (2026-10-09) prints `index: /avisos (resolvidoEm
 *    ASC)@[id = …]` bounded by the point `|----[null]`; its Filter re-checks
 *    `($resolvidoEm_4 == null)` over that very range (`post-filtered rows: 0`),
 *    and the SDK's `sort(__name__)` prints as a `• MajorSort` above a `Fetch`
 *    with `order: UNDEFINED`, sorting the rows it returns —
 *    {@link julgarPlanoDosAvisosAbertos} says why neither costs a row;
 *  - per-node `Execution:` counters, the read one being `records scanned`.
 * The node NAME is not the verdict: a `SequentialScan` with an `index:` line and
 * a closed range tree IS an index range seek, while the same node with a bare
 * `ranges: /` reads its whole index.
 *
 * ⚠️ What the 2026-10-08 recalibration MEASURED — two PROXY-PLAN FINDINGS —
 * and what the audit does about each since 2026-10-09:
 *  - `• MajorSort` is an in-memory sort (Firebase's Enterprise "Optimize query
 *    performance" page: the index cannot deliver the order; coalesced with a
 *    limit it is a TopN, which still consumes its WHOLE input). The walk's
 *    proxy over `contaOuterRef in [both ref forms]` gets one: page 1 of an
 *    8-link conta read 8 index rows to return 2, page 2 read 6, the last page 2
 *    — every page reads the conta's whole remainder. One `==` per ref form
 *    prints `• Limit` instead and reads exactly the page (2 of 2, with and
 *    without a cursor). So the AUDIT walks one ref form at a time
 *    (`linksNaoEnumerados.ts`, `contaRef`), and that page is what the staging
 *    suite asserts a PASS on; the price phase keeps its `in` — its own query,
 *    left as it is;
 *  - a document-KEY range on `avisos` has NO seekable access path: no avisos
 *    index leads with `__key__`, and every shape tried — cursors, `where`
 *    filters on the key, a start bound only, no bound — rode
 *    `/avisos (resolvidoEm ASC)` with a bare `ranges: /`, read the whole
 *    collection and cut the range in a residual Filter. So the audit reads no
 *    key range at all: ONE read per run of the OPEN avisos
 *    (`resolvidoEm == null`), which that same index serves as a closed `[null]`
 *    point range ({@link julgarPlanoDosAvisosAbertos}).
 * ⚠️ Both answers rest on the PROXY. Every capture is a pipeline, and the
 * billing lines do not separate the shapes (page 1 at 8 index rows and the last
 * page at 2 both bill `read units: 3`), so the classic queries' own plans are
 * confirmed only in Query Insights after a real audit run.
 *
 * ⚠️ A `• Filter` NODE is a RESIDUAL filter (rows read, THEN discarded); a
 * node-local `filter:` LINE inside an access node — an older spelling, never
 * printed on 2026-10-08 — is a PUSH-DOWN into the scan. Only the former counts
 * against a plan as RESIDUAL — but a push-down is not a BOUND either: a scan over
 * an unbounded range evaluating `equal_any(...)` per entry prints the same
 * `filter:` line as one that seeks per value, and reads the whole index. So the
 * #1200 verdicts accept a bound from the SHAPE only when it is a range line
 * closed on the side that matters; anything weaker passes only when the plan's
 * own read counters prove the scan stayed inside the expected range
 * (`leituraMaxima`).
 */

/* ----------------------------- the access nodes ---------------------------- */

/**
 * @typedef {object} AccessNode
 * @property {string} type The bullet's node name (`SequentialScan`, `TableScan`, …).
 * @property {number} line 1-BASED bullet position in the printed plan — how a
 *   human counts the lines of the plan text dumped above it.
 * @property {string | null} identifier The `index:`/`identifier:` value carrying
 *   `@[id = …]`, or null for an identifier-less node.
 * @property {string | null} kind `TableScan` names its target with `kind:`.
 * @property {string | null} partition The `partition:` value, when printed.
 * @property {string | null} filter The node-local `filter:` push-down line.
 * @property {string[]} boundLines Every constraint value line (`|----…`), flat,
 *   in print order, each sliced from its `|----` marker.
 * @property {string[]} boundedLines `boundLines` minus the unbounded `(-∞..+∞)`.
 * @property {Faixa[]} faixas The same lines as the TREE the plan prints: the
 *   roots are the ranges on the index's first field, each holding the ranges on
 *   the next field beneath it. Empty on a bare `ranges: /` — an UNBOUNDED scan
 *   — and never on a node that printed any range line.
 * @property {string[]} execution The node's `Execution:` stat lines, trimmed.
 */

/**
 * One range of the `ranges:` tree: its line (sliced from `|----`) and the
 * ranges on the next index field that it holds — e.g. a conta value with the
 * keyset cursor under it.
 *
 * @typedef {object} Faixa
 * @property {string} linha
 * @property {Faixa[]} filhas
 */

/**
 * The completely-unbounded range line — `(-∞..+∞)` — never counts as a bound;
 * a half-bounded range (`[1,234L..+∞)`, a timestamp cutoff) DOES. ⚠️ In the
 * 2026-10-08 dialect an unbounded scan prints NO line at all (a bare
 * `ranges: /`); this spelling is kept for the older one.
 */
export const UNBOUNDED_RE = /\(-(?:∞|inf)\s*\.\.\s*\+?(?:∞|inf)\)/i;

/**
 * A NUMERIC constraint bound: `[1,782,652,331,060,000L..+∞)`, `[1234L]`,
 * `(-1..500L]`. Anchored at the `|----` marker and shape-matched, never
 * digit-matched: `["depositos/checkstock-1785244325954-dep"]` is full of digits,
 * and the keyset bound `(EntityRef[…]..oid(000…))` ends in a parenthesised
 * number — neither may read as a timestamp range.
 */
export const NUMERIC_BOUND_RE = /^\|-+\s*[[(]\s*-?[\d,]+L?\s*(?:\.\.|[\])])/;

/** A range whose LOWER end is `-∞`: `(-∞..…`. */
const INICIO_INFINITO_RE = /[[(]\s*-(?:∞|inf)\s*\.\./i;
/**
 * A range whose UPPER end is `+∞` — `…..+∞)` — or `oid(000…)`, the first value
 * past the reference type, which is how the 2026-10-08 dialect ends a range on
 * the document key that has no upper bound: `(EntityRef[…]..oid(000…))` is
 * every key after the cursor.
 */
const FIM_INFINITO_RE = /\.\.\s*(?:\+?(?:∞|inf)|oid\(0+\))\s*[\])]/i;

/**
 * Is a constraint line closed on BOTH sides — a point set
 * (`["integracao/x", "documents/integracao/x"]`, `[null]`) or a finite range
 * (`[1L..5L]`)? A half-open line
 * (`[EntityRef[…]..+∞)`, `(EntityRef[…]..oid(000…))`, `(-∞..["integracao/x"]]`)
 * is a bound on ONE side only: the scan runs on to the edge of the index on the
 * other. Matched on the range syntax, never on a bare `inf` substring, so an id
 * containing `inf` stays a value.
 *
 * @param {string} linha
 * @returns {boolean}
 */
export function limiteFechado(linha) {
  return !INICIO_INFINITO_RE.test(linha) && !FIM_INFINITO_RE.test(linha);
}

/**
 * A LOWER bound on the document key — `(EntityRef[…]..`, `[EntityRef[…]..` —
 * which is how a keyset cursor (`__name__ > <ref>`) prints when it is a SEEK
 * rather than a per-entry test: in the real dialect, one such line indented
 * under each conta value the cursor applies to.
 */
export const LIMITE_INFERIOR_DE_CHAVE_RE = /^\|-+\s*[[(]\s*EntityRef\[/;

/**
 * Does this range — or a range nested under it — carry a key LOWER bound
 * ({@link LIMITE_INFERIOR_DE_CHAVE_RE})? Asked per ROOT, so a cursor that seeks
 * on one `in` value's stream and not on the other's is caught.
 *
 * @param {Faixa} faixa
 * @returns {boolean}
 */
export function seekaChave(faixa) {
  return LIMITE_INFERIOR_DE_CHAVE_RE.test(faixa.linha) || faixa.filhas.some(seekaChave);
}

/**
 * Parse the plan into access-node blocks: a SequentialScan / SeekingScan /
 * IndexSeek / TableScan / EntityScan / CollectionScan bullet — plus ANY other
 * `• <Name>Scan`, so a node type this dialect has not shown us yet is still SEEN
 * rather than silently skipped — with every body line up to the next `•` bullet.
 * The identifier-less names are the point: a `TableScan` carries no `index:`
 * line at all, and a parser blind to it cannot report a raw scan.
 *
 * The `ranges:` block is read twice: flat (`boundLines`, for printing) and as
 * the TREE the dialect draws (`faixas`) — a line nests under the nearest
 * earlier line whose `|----` sits further left. The tree is what lets a verdict
 * ask "does EVERY conta stream seek its cursor?", which a flat list cannot.
 *
 * @param {string} plan
 * @returns {AccessNode[]}
 */
export function parseAccessNodes(plan) {
  const lines = plan.split('\n');
  /** @type {AccessNode[]} */
  const nodes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? '').match(
      /•\s+(SequentialScan|SeekingScan|IndexSeek|TableScan|EntityScan|CollectionScan|\w*Scan)\b/,
    );
    if (m == null) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/•\s+\w/.test(lines[j] ?? '')) {
        end = j;
        break;
      }
    }
    const block = lines.slice(i + 1, end);
    const idLine = block.find((l) => /\b(?:index|identifier):\s*\S.*@\[id\s*=/.test(l)) ?? null;
    const identifier =
      idLine == null ? null : idLine.replace(/^.*?\b(?:index|identifier):\s*/, '').trim();
    const partitionLine = block.find((l) => /\bpartition:\s*\S/.test(l)) ?? null;
    const partition =
      partitionLine == null ? null : partitionLine.replace(/^.*?\bpartition:\s*/, '').trim();
    // TableScan names its target with `kind:` instead of an index — kept so an
    // identifier-less node still says WHAT it scanned.
    const kindLine = block.find((l) => /\bkind:\s*\S/.test(l)) ?? null;
    const kind = kindLine == null ? null : kindLine.replace(/^.*?\bkind:\s*/, '').trim();
    const filterLine = block.find((l) => /\bfilter:\s*\(/.test(l)) ?? null;
    const filter = filterLine == null ? null : filterLine.replace(/^.*?\bfilter:\s*/, '').trim();
    /** @type {string[]} */
    const boundLines = [];
    /** @type {Faixa[]} */
    const faixas = [];
    // The open ranges by the COLUMN of their `|----` marker: a line nests under
    // the nearest earlier line printed further left, which is how the dialect
    // draws one index field per level.
    /** @type {{ coluna: number, faixa: Faixa }[]} */
    const pilha = [];
    let inConstraints = false;
    for (const l of block) {
      if (/\b(?:ranges|constraints):/.test(l)) {
        inConstraints = true;
        continue;
      }
      if (!inConstraints) continue;
      if (/Execution:/.test(l) || l.replace(/[|\s]/g, '') === '') {
        inConstraints = false;
        continue;
      }
      const coluna = l.indexOf('|----');
      if (coluna === -1) continue;
      const faixa = { linha: l.slice(coluna), filhas: /** @type {Faixa[]} */ ([]) };
      boundLines.push(faixa.linha);
      while (pilha.length > 0 && (pilha[pilha.length - 1]?.coluna ?? 0) >= coluna) pilha.pop();
      const pai = pilha[pilha.length - 1];
      if (pai == null) faixas.push(faixa);
      else pai.faixa.filhas.push(faixa);
      pilha.push({ coluna, faixa });
    }
    // Per-node `Execution:` stats — the only place a plan says how much a node
    // actually READ (a shape is not an order; the counts are).
    const execIdx = block.findIndex((l) => /\bExecution:/.test(l));
    const execution =
      execIdx === -1
        ? []
        : block
            .slice(execIdx)
            .map((l) => l.replace(/^[|\s]+/, '').trim())
            .filter((l) => l !== '');
    nodes.push({
      type: m[1] ?? '',
      // 1-BASED: `i` is an array index, and printing it raw is off by one
      // against the plan a human reads (review catch on #890).
      line: i + 1,
      identifier,
      kind,
      partition,
      filter,
      boundLines,
      boundedLines: boundLines.filter((l) => !UNBOUNDED_RE.test(l)),
      // Kept VERBATIM, `(-∞..+∞)` roots included: dropping one would let its
      // bounded siblings speak for a stream that reads its whole index.
      faixas,
      execution,
    });
  }
  return nodes;
}

/**
 * Dedupe identically-shaped nodes for printing (plans repeat subquery nodes).
 *
 * @param {AccessNode[]} list
 * @returns {AccessNode[]}
 */
export function uniqueNodes(list) {
  const seen = new Set();
  /** @type {AccessNode[]} */
  const out = [];
  for (const n of list) {
    const key = `${n.type}|${n.identifier}|${n.kind}|${n.filter}|${n.boundLines.join(';')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * A Filter expression with every bare existence test removed —
 * `(exists($contaOuterRef_3) AND exists($__key___4))` → `( AND )`. What is left
 * is what the Filter actually COMPARES.
 *
 * Why an existence test is not the predicate: the SDK's `createFrom` adds
 * `exists(<field>)` for every filtered and ordered field, and the plan
 * evaluates it in a residual Filter on EVERY page — healthy ones included
 * (`post-filtered rows: 0` on 2026-10-08). It runs on rows the range already
 * selected, so it reads nothing the range did not; counting it as the
 * predicate served residually would fail every plan this dialect prints.
 *
 * @param {string} expressao
 * @returns {string}
 */
export function semTestesDeExistencia(expressao) {
  return expressao.replace(/\bexists\(\s*\$\w+\s*\)/g, '');
}

/**
 * The plan's variable for `contaOuterRef` — `$contaOuterRef`, or numbered as
 * the 2026-10-08 dialect prints it (`$contaOuterRef_3`).
 */
export const VARIAVEL_CONTA_RE = /\$contaOuterRef(?:_\d+)?\b/;

/**
 * The plan's variable for the document key: `$__name__`, `$__key__`, numbered
 * (`$__key___4`), or `$key_5` — what a scan binding `key: $key_5` calls it (the
 * avisos plans). The `\b` keeps `$keyFoo` out.
 */
export const VARIAVEL_CHAVE_RE = /\$(?:__(?:name|key)__|key)(?:_+\d+)?\b/;

/**
 * Does the target predicate show up in a RESIDUAL `Filter` NODE — rows read and
 * then thrown away? Only `• Filter` blocks count, only their `expression:`
 * bodies, and only once the existence tests are stripped
 * ({@link semTestesDeExistencia}): a COMPARISON on the variable is the predicate
 * served residually, a bare `exists($var)` is not. A node-local `filter:` line
 * is the OPPOSITE finding (a push-down), so counting it would condemn the
 * healthy plan. A block runs from the `• Filter` bullet to the next `•` bullet
 * or its `Execution:` stats, whichever is first.
 *
 * @param {string} plan
 * @param {RegExp} predicateRe
 * @returns {boolean}
 */
export function predicateInResidualFilters(plan, predicateRe) {
  const lines = plan.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/•\s+Filter\b/.test(lines[i] ?? '')) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] ?? '';
      if (/•\s+\w/.test(l) || /\bExecution:/.test(l)) break;
      if (/\bexpression:\s/.test(l) && predicateRe.test(semTestesDeExistencia(l))) return true;
    }
  }
  return false;
}

/**
 * Every distinct `• <Node>` name in a plan — what a reader should scan for.
 *
 * @param {string} plan
 * @returns {string[]}
 */
export function nomesDeNos(plan) {
  return [...new Set([...plan.matchAll(/•\s+(\w+)/g)].map((m) => m[1] ?? ''))];
}

/**
 * A SORT node — the access path did not deliver key order, so the stage sorts
 * everything the scan produced before `limit` can cut it. Any bullet whose name
 * ENDS in `Sort` (`• Sort`, and `• MajorSort`, which is what the 2026-10-08
 * dialect prints), plus `• TopN` / `• TopK`. A streaming merge of sorted ranges
 * (`• SortedMerge`-style — `Sort` not at the end of the name), which an `in`
 * over two values could legitimately use, does not count.
 *
 * ⚠️ `MajorSort` beside a `limit:` line is NOT a cheap TopN: Firebase's
 * Enterprise performance guide calls it an in-memory sort, coalesced with the
 * limit into a TopN — which still reads its whole input. Measured on the walk's
 * PROXY: page 1 over an 8-link conta read all 8 index rows under it to return
 * 2. The pre-recalibration regex anchored `Sort` right after the bullet and so
 * never saw it.
 *
 * @param {string} plan
 * @returns {boolean}
 */
export function temSortResidual(plan) {
  return /•\s+(?:\w*Sort|TopN|TopK)\b/.test(plan);
}

/**
 * A node that MERGES several ordered streams into one order — any bullet whose
 * name contains `Merge` (`• SortedMerge`, `• MergeUnion`, …). ⚠️ NEVER OBSERVED:
 * no captured plan has printed one, so the spelling is a guess on purpose — a
 * real merge printed under another name fails `fluxos-sem-merge` (the safe
 * direction: a red that asks for recalibration, never a silent pass). A plain
 * `Union` is NOT a merge: it concatenates, which is exactly the wrong order.
 *
 * @param {string} plan
 * @returns {boolean}
 */
export function temMerge(plan) {
  return /•\s+\w*Merge\w*\b/.test(plan);
}

/**
 * @typedef {object} NoDoPlano
 * @property {string} nome The bullet's node name (`Filter`, `MajorSort`, …).
 * @property {number} linha 1-BASED bullet position in the printed plan.
 * @property {string[]} bloco The node's body lines, up to the next bullet.
 * @property {Record<string, number>} contadores Its own `Execution:` counters
 *   ({@link contadoresDeExecucao}'s shape).
 */

/**
 * Every `• <Node>` of a plan, in PRINT order, each with its own body and
 * counters. In this dialect every node has at most one child and prints it
 * right below itself, so a node's INPUT is what the node printed after it
 * returned.
 *
 * @param {string} plan
 * @returns {NoDoPlano[]}
 */
export function nosDoPlano(plan) {
  const lines = plan.split('\n');
  /** @type {NoDoPlano[]} */
  const nos = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? '').match(/•\s+(\w+)/);
    if (m == null) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/•\s+\w/.test(lines[j] ?? '')) {
        end = j;
        break;
      }
    }
    const bloco = lines.slice(i + 1, end);
    const execIdx = bloco.findIndex((l) => /\bExecution:/.test(l));
    const contadores =
      execIdx === -1
        ? {}
        : lerContadores(
            bloco
              .slice(execIdx)
              .map((l) => l.replace(/^[|\s]+/, '').trim())
              .filter((l) => l !== ''),
          );
    nos.push({ nome: m[1] ?? '', linha: i + 1, bloco, contadores });
  }
  return nos;
}

/**
 * The residual `• Filter` nodes whose expression COMPARES a variable matching
 * `predicateRe` (existence tests stripped, {@link semTestesDeExistencia}) — what
 * {@link predicateInResidualFilters} asks yes/no about, here with each node's
 * own counters, so a caller can ask what the Filter DISCARDED
 * (`post-filtered rows`).
 *
 * @param {string} plan
 * @param {RegExp} predicateRe
 * @returns {NoDoPlano[]}
 */
export function filtrosResiduaisSobre(plan, predicateRe) {
  return nosDoPlano(plan).filter(
    (n) =>
      n.nome === 'Filter' &&
      n.bloco.some((l) => /\bexpression:\s/.test(l) && predicateRe.test(semTestesDeExistencia(l))),
  );
}

/**
 * The sort nodes ({@link temSortResidual}'s names) that CUT their input — the
 * node printed right below one (its input) returned MORE rows than the sort did,
 * so the sort consumed rows the result does not hold — or that leave either
 * count unprinted (unprovable: the safe direction). A sort over exactly the rows
 * it returns orders them and reads nothing more.
 *
 * @param {string} plan
 * @returns {NoDoPlano[]}
 */
export function sortsQueCortam(plan) {
  const nos = nosDoPlano(plan);
  return nos.filter((n, i) => {
    if (!/^(?:\w*Sort|TopN|TopK)$/.test(n.nome)) return false;
    const saida = n.contadores['records returned'];
    const entrada = nos[i + 1]?.contadores['records returned'];
    return saida == null || entrada == null || entrada > saida;
  });
}

/**
 * How many conta-value STREAMS an access node's range tree opens: one per root
 * range, and one per value of a root printed as a point SET
 * (`["documents/integracao/x", "integracao/x"]` — two values, two streams). A
 * scan over the `(contaOuterRef, __key__)` index emits each stream in key order
 * but the streams one after another (conta-major), so two or more of them are
 * in `__name__` order only once something above sorts or merges them.
 *
 * @param {AccessNode} no
 * @returns {number}
 */
export function fluxosDeConta(no) {
  let fluxos = 0;
  for (const raiz of no.faixas) {
    const conjunto = /\.\./.test(raiz.linha) ? [] : (raiz.linha.match(/"(?:[^"\\]|\\.)*"/g) ?? []);
    fluxos += Math.max(1, conjunto.length);
  }
  return fluxos;
}

/**
 * The identifier-less access nodes, split by whether they are a raw scan.
 *
 * Negative-first: an identifier-less node over the ROOT partition is a full scan
 * (`cheios`). One with a non-root `partition:` (`porParticao`) is what a
 * `subcollection()` probe with no `where` legitimately compiles to — one
 * parent's subcollection, no predicate an index could serve — so it is reported,
 * never failed. Deduped with {@link uniqueNodes}.
 *
 * @param {AccessNode[]} nodes
 * @returns {{ cheios: AccessNode[], porParticao: AccessNode[] }}
 */
export function scansSemIdentificador(nodes) {
  const semId = uniqueNodes(nodes.filter((n) => n.identifier == null));
  return {
    cheios: semId.filter((n) => n.partition == null || n.partition === '/'),
    porParticao: semId.filter((n) => n.partition != null && n.partition !== '/'),
  };
}

/**
 * The numeric counters of one node's `Execution:` block, keyed by the lowercased
 * label: `records returned: 3` → `{ 'records returned': 3 }`, `latency: 1.5 ms`
 * → `{ latency: 1.5 }`. Thousands separators are dropped; a line whose value
 * does not START with a number is skipped (so `peak memory: n/a` adds nothing).
 *
 * A byte counter printed with a unit and its exact count —
 * `data bytes read: 1.09 KiB (1,115 B)` — reads as the exact count, 1115.
 *
 * ⚠️ The label set is the dialect's, not ours, and it is not machine-stable —
 * callers look labels up by pattern ({@link contadorDeLeitura}), never by
 * exact string.
 *
 * @param {AccessNode} node
 * @returns {Record<string, number>}
 */
export function contadoresDeExecucao(node) {
  return lerContadores(node.execution);
}

/**
 * `label: value` lines → `{ label: number }` (see {@link contadoresDeExecucao}).
 *
 * @param {readonly string[]} linhas
 * @returns {Record<string, number>}
 */
function lerContadores(linhas) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const l of linhas) {
    // `(?!\w)`: the number must END there — `query id: 23b4cf93…` is an id,
    // not the counter 23.
    const m = l.match(/^([A-Za-z][\w\s()/-]*?)\s*:\s*(-?[\d,]*\.?\d+)(?!\w)/);
    if (m == null) continue;
    const exato = l.match(/\(([\d,]+)\s*B\)/);
    const valor = Number((exato?.[1] ?? m[2] ?? '').replace(/,/g, ''));
    if (Number.isFinite(valor)) out[(m[1] ?? '').trim().toLowerCase()] = valor;
  }
  return out;
}

/**
 * The plan-wide counters printed ABOVE the `Tree:` — `results returned`,
 * `data bytes read`, `entity row scanned`, `index row scanned` and, from the
 * `Billing:` block, `read units` — keyed like {@link contadoresDeExecucao}.
 * Empty when the plan prints no header (an older dialect).
 *
 * `index row scanned` is the WHOLE query's index read: a second witness beside
 * the per-node sum, which only counts the nodes a verdict judges — a scan on
 * the wrong index is still in this total.
 *
 * @param {string} plan
 * @returns {Record<string, number>}
 */
export function contadoresDoCabecalho(plan) {
  const linhas = plan.split('\n');
  const fim = linhas.findIndex((l) => /^\s*Tree:\s*$/.test(l));
  if (fim === -1) return {};
  return lerContadores(linhas.slice(0, fim).map((l) => l.trim()));
}

/**
 * The whole query's index rows scanned ({@link contadoresDoCabecalho}), or null
 * when the plan does not print it.
 *
 * @param {string} plan
 * @returns {number | null}
 */
export function linhasDeIndiceLidas(plan) {
  return contadoresDoCabecalho(plan)['index row scanned'] ?? null;
}

/**
 * The counter that says how much a node READ — the labels the dialect uses for
 * index entries or documents scanned/examined — as `{ rotulo, valor }`, the
 * largest when several match; null when the node prints none.
 *
 * ⚠️ `returned` is deliberately NOT a read counter: a full scan that discards
 * everything but `limit` rows still returns only `limit`.
 *
 * @param {AccessNode} node
 * @returns {{ rotulo: string, valor: number } | null}
 */
export function contadorDeLeitura(node) {
  /** @type {{ rotulo: string, valor: number } | null} */
  let melhor = null;
  for (const [rotulo, valor] of Object.entries(contadoresDeExecucao(node))) {
    if (!/scanned|examined|\bseeks?\b|entries|rows read|documents read/.test(rotulo)) continue;
    if (/returned/.test(rotulo)) continue;
    if (melhor == null || valor > melhor.valor) melhor = { rotulo, valor };
  }
  return melhor;
}

/**
 * @typedef {object} Leitura
 * @property {string} rotulo The counter label(s) summed, `+`-joined when the
 *   nodes printed different ones.
 * @property {number} valor The total read across the nodes.
 * @property {number} nos How many access nodes were summed.
 */

/**
 * The READ counters of several access nodes, SUMMED — null when the list is
 * empty or ANY node prints none (a partial sum would understate the read, which
 * is the direction that passes a bad plan).
 *
 * Summed, never maxed, and never deduped: an `equal_any` over two values may
 * run as one seek per value, and each node then reads only its own share — a
 * per-node bound would pass two streams that each walk their whole value.
 *
 * @param {readonly AccessNode[]} nodes
 * @returns {Leitura | null}
 */
export function somaDeLeituras(nodes) {
  if (nodes.length === 0) return null;
  let valor = 0;
  const rotulos = new Set();
  for (const n of nodes) {
    const leitura = contadorDeLeitura(n);
    if (leitura == null) return null;
    valor += leitura.valor;
    rotulos.add(leitura.rotulo);
  }
  return { rotulo: [...rotulos].join(' + '), valor, nos: nodes.length };
}

/**
 * How a plan's read counters stand against the caller's ceiling:
 * `'excessiva'` when EITHER witness read past it — the judged nodes' sum, or the
 * whole query's `index row scanned` ({@link linhasDeIndiceLidas}); else
 * `'dentro'` when the judged nodes' sum is within it; else `'sem-prova'` (no
 * ceiling, or no per-node counter — the counters prove nothing either way).
 *
 * ⚠️ The plan-wide total may FAIL a plan, never PASS one: it does not say which
 * node read what, and a raw scan of documents rather than index rows does not
 * show in it at all.
 *
 * @param {Leitura | null} leitura
 * @param {number | null} leituraTotal
 * @param {number | null} leituraMaxima
 * @returns {'sem-prova' | 'dentro' | 'excessiva'}
 */
function julgarLeitura(leitura, leituraTotal, leituraMaxima) {
  if (leituraMaxima == null) return 'sem-prova';
  if (
    (leitura != null && leitura.valor > leituraMaxima) ||
    (leituraTotal != null && leituraTotal > leituraMaxima)
  ) {
    return 'excessiva';
  }
  return leitura == null ? 'sem-prova' : 'dentro';
}

/**
 * What an excessive read was, in one clause: the judged nodes' sum and/or the
 * plan-wide total, whichever printed.
 *
 * @param {Leitura | null} leitura
 * @param {number | null} leituraTotal
 * @returns {string}
 */
function descreverExcesso(leitura, leituraTotal) {
  const partes = [];
  if (leitura != null) partes.push(`${leitura.valor} (${leitura.rotulo}, judged nodes)`);
  if (leituraTotal != null) partes.push(`${leituraTotal} (index row scanned, whole query)`);
  return partes.join(' / ');
}

/**
 * The tail of a PASS line: what was read, against what ceiling — or that the
 * plan printed no counter at all, so the shape alone decided.
 *
 * @param {Leitura | null} leitura
 * @param {number | null} leituraMaxima
 * @returns {string}
 */
function descreverLeitura(leitura, leituraMaxima) {
  if (leitura == null) return '; no read counter printed — judged on the range bounds alone';
  const teto = leituraMaxima == null ? '' : ` ≤ ${leituraMaxima}`;
  return `; read ${leitura.valor} (${leitura.rotulo}, ${leitura.nos} node(s))${teto}`;
}

/* --------------------------- the #1200 verdicts --------------------------- */

/**
 * @typedef {object} Motivo
 * @property {string} codigo A stable code — what the unit tests pin.
 * @property {string} mensagem What it MEANS, in words an operator can act on.
 */

/**
 * @typedef {object} VeredictoDoPlano
 * @property {Motivo[]} motivos Empty ⇔ the plan passes.
 * @property {AccessNode[]} nos Every access node parsed.
 * @property {AccessNode | null} alvo The node judged on the expected index /
 *   collection: the best-bounded one, else one carrying a push-down, else null.
 * @property {string | null} detalhe How the plan was proven bounded, for a PASS
 *   line (null on a FAIL with no node to describe).
 * @property {Leitura | null} leitura The read counters summed over every node
 *   on the expected index / collection ({@link somaDeLeituras}).
 * @property {number | null} leituraTotal The plan-wide `index row scanned`
 *   ({@link linhasDeIndiceLidas}), null when not printed.
 */

/**
 * @typedef {object} OpcoesDoVeredicto
 * @property {number | null} [leituraMaxima] The most index rows a correctly
 *   BOUNDED plan of the probed page may read — summed over the judged nodes,
 *   and the plan-wide `index row scanned` total too. Given, it is enforced
 *   against those counters — a plan that read more FAILS whatever its shape —
 *   and it is the ONLY way a plan whose shape cannot prove the bound (a
 *   push-down, a half-open range) passes. ⚠️ Pass one only where the caller
 *   KNOWS the failure modes read more than it: the staging suite seeds
 *   neighbours on every side for exactly that, and asserts its ceilings sit
 *   below them. ⚠️ "Every side" includes BELOW: an unbounded scan that stops at
 *   its `Limit` reads only what sorts before the range plus the page, so on a
 *   page with no cursor a push-down over a bare `ranges: /` stays inside any
 *   ceiling unless something is seeded just below the range. On an unseeded
 *   collection a whole-index walk can read fewer entries than any ceiling, and
 *   the counter proves nothing.
 */

/**
 * The CG entry the walk must ride: `produtoMercadoLivre(contaOuterRef ASC,
 * __name__ ASC)`, scope COLLECTION_GROUP — which the dialect prints as a
 * double-star path segment before the collection id — declared since #1191.
 * `__name__` prints as `__key__` in this dialect.
 */
export const INDICE_DA_VARREDURA_RE =
  /^\*\*\/produtoMercadoLivre \(contaOuterRef ASC, __(?:name|key)__ ASC\)/;

/** The verdict a failing walk plan has to carry into every message. */
const CONSEQUENCIA_DA_VARREDURA =
  'The #1200 monthly audit (and the price job report) would scan the WHOLE ' +
  'produtoMercadoLivre collection group on every page — billed as data scanned. ' +
  'Do NOT turn MERCADO_LIVRE_STOCK_SYNC_ENABLED on in this project until it passes.';

/**
 * The walk's verdict (`fetchLinksNaoEnumeradosPage`'s pipeline translation:
 * `collectionGroup(produtoMercadoLivre)`, `contaOuterRef == <one ref form>` —
 * the audit's page — or `equal_any [both ref forms]` — the price phase's —
 * then `__name__ > <cursor>`, `sort(__name__)`, `limit`). It must:
 *  1. contain no identifier-less scan over the root partition — a collection
 *     group has no parent partition to excuse one;
 *  2. ride {@link INDICE_DA_VARREDURA_RE} BOUNDED on `contaOuterRef` — riding it
 *     unbounded (a bare `ranges: /`) is a walk of every conta's links. The SHAPE
 *     proves it only when EVERY node on the index has a range tree whose EVERY
 *     root is a closed value naming an `integracao/` ref ({@link limiteFechado})
 *     — one stream per ref form walked, none of them open; a push-down is the
 *     very shape of the unbounded walk, so it passes only on the read counters
 *     (`leituraMaxima`);
 *  3. when the probed page carries a cursor (`comCursor`), have it as a SEEK —
 *     a key lower bound ({@link LIMITE_INFERIOR_DE_CHAVE_RE}) under EVERY root
 *     ({@link seekaChave}), or read counters within `leituraMaxima`. A cursor
 *     tested per entry makes page N re-read every earlier page of the conta
 *     (the walk turns quadratic), and one stream that seeks says nothing about
 *     the other;
 *  4. carry neither predicate COMPARED in a residual `Filter` node — a residual
 *     `contaOuterRef` means rows were read then discarded, and a residual
 *     cursor is the quadratic walk of 3 with the test moved one node up. The
 *     `exists(...)` tests every page carries are not the predicate
 *     ({@link semTestesDeExistencia});
 *  5. have no sort node ({@link temSortResidual}) — the index did not deliver
 *     key order, so every page reads the conta's whole remainder before the
 *     limit. ⚠️ This is what the PRICE phase's `in` proxy fails on (2026-10-08,
 *     see the header): over two ref forms it prints `• MajorSort`, and page 1
 *     read every link of the conta. The audit's one-form page prints `• Limit`;
 *  6. with two or more conta streams ({@link fluxosDeConta}) summed over the
 *     nodes on the index, have a sort or a merge ({@link temMerge}) above them —
 *     a scan of several conta values emits them conta-major, so a `Limit`
 *     straight over it returns the first rows of ONE ref form: the WRONG page,
 *     not a cheaper one. The real `in` plan always sorts (5 catches that); this
 *     is what keeps "the sort swapped for a Limit" from reading as healthy;
 *  7. read no more than `leituraMaxima`, whatever the shape says — summed over
 *     the nodes on the index AND as the plan-wide `index row scanned`.
 *
 * @param {string} plan
 * @param {OpcoesDoVeredicto & { comCursor?: boolean }} [opcoes] `comCursor`:
 *   the probed page carries a keyset cursor, so 3 applies.
 * @returns {VeredictoDoPlano}
 */
export function julgarPlanoDaVarredura(plan, { comCursor = false, leituraMaxima = null } = {}) {
  const nos = parseAccessNodes(plan);
  /** @type {Motivo[]} */
  const motivos = [];

  for (const n of scansSemIdentificador(nos).cheios) {
    motivos.push({
      codigo: 'scan-sem-indice',
      mensagem:
        `an identifier-less ${n.type} (plan line ${n.line}) reads the collection group ` +
        `with NO index — a full scan. ${CONSEQUENCIA_DA_VARREDURA}`,
    });
  }

  const noIndice = nos.filter(
    (n) => n.identifier != null && INDICE_DA_VARREDURA_RE.test(n.identifier),
  );
  /** @param {AccessNode} n */
  const contaNaFaixa = (n) =>
    n.faixas.length > 0 &&
    n.faixas.every((f) => f.linha.includes('integracao/') && limiteFechado(f.linha));
  /** @param {AccessNode} n */
  const contaNoFiltro = (n) => n.filter != null && VARIAVEL_CONTA_RE.test(n.filter);
  /** @param {AccessNode} n */
  const cursorNaFaixa = (n) => n.faixas.length > 0 && n.faixas.every(seekaChave);

  const alvo = noIndice.find(contaNaFaixa) ?? noIndice.find(contaNoFiltro) ?? null;
  const leitura = somaDeLeituras(noIndice);
  const leituraTotal = linhasDeIndiceLidas(plan);
  const estadoDaLeitura = julgarLeitura(leitura, leituraTotal, leituraMaxima);
  const contaPelaForma = noIndice.length > 0 && noIndice.every(contaNaFaixa);
  const cursorPelaForma = !comCursor || (noIndice.length > 0 && noIndice.every(cursorNaFaixa));
  /** @type {string | null} */
  let detalhe = null;

  if (noIndice.length === 0) {
    motivos.push({
      codigo: 'indice-ausente',
      mensagem:
        'no access node rides the COLLECTION_GROUP produtoMercadoLivre(contaOuterRef ASC, ' +
        '__name__ ASC) index — it is declared in firestore.indexes.json since #1191, so the ' +
        'CG index is not READY on this project (deploy the indexes, then re-run). ' +
        CONSEQUENCIA_DA_VARREDURA,
    });
  } else if (alvo == null) {
    motivos.push({
      codigo: 'indice-sem-limite',
      mensagem:
        `the plan rides ${noIndice[0]?.identifier ?? 'the CG index'} but with NO bound on ` +
        'contaOuterRef (a bare `ranges: /`, or no closed conta value at its root) — it walks ' +
        'every conta’s links in key order. ' +
        CONSEQUENCIA_DA_VARREDURA,
    });
  } else {
    if (!contaPelaForma && estadoDaLeitura === 'sem-prova') {
      motivos.push({
        codigo: 'indice-sem-limite',
        mensagem:
          `the plan rides ${alvo.identifier} with contaOuterRef only as a node-local filter ` +
          '(or a range open on one side, or one stream of several unbounded) — the same lines ' +
          'a walk of EVERY conta’s links, tested entry by entry, prints — and no read counter ' +
          'within a known ceiling proves otherwise. Read the printed plan; if this dialect ' +
          'bounds the conta some other way, recalibrate explainPlan.mjs against it. ' +
          CONSEQUENCIA_DA_VARREDURA,
      });
    }
    if (!cursorPelaForma && estadoDaLeitura === 'sem-prova') {
      motivos.push({
        codigo: 'cursor-sem-limite',
        mensagem:
          `the keyset cursor (__name__ > <ref>) is not a key lower bound under every conta ` +
          `range on ${alvo.identifier} — tested per entry instead, page N re-reads every ` +
          'earlier page of the conta, so the walk turns quadratic in its link count — and no ' +
          'read counter within a known ceiling proves otherwise.',
      });
    }
  }
  if (estadoDaLeitura === 'excessiva') {
    motivos.push({
      codigo: 'leitura-excessiva',
      mensagem:
        `the walk read ${descreverExcesso(leitura, leituraTotal)} index rows where a bounded ` +
        `page reads at most ${leituraMaxima} — the scan is not confined to the page (past the ` +
        'cursor, when there is one), whatever its ranges print: a sort reading the conta’s ' +
        'whole remainder, a cursor tested per entry, or a walk of other contas’ links. Every ' +
        'page of the audit’s walk pays that read — billed as data scanned.',
    });
  }
  if (alvo != null && motivos.length === 0) {
    const conta = contaPelaForma
      ? `contaOuterRef value bound on ${alvo.identifier}`
      : `contaOuterRef push-down on ${alvo.identifier}`;
    const cursor = !comCursor
      ? ''
      : cursorPelaForma
        ? ', the keyset cursor a key lower bound'
        : ', the keyset cursor tested in the scan';
    const prova =
      contaPelaForma && cursorPelaForma
        ? ''
        : ' — the READ COUNTERS, not the plan shape, prove the scan stayed bounded';
    detalhe = `${conta}${cursor}${descreverLeitura(leitura, leituraMaxima)}${prova}`;
  }

  if (predicateInResidualFilters(plan, VARIAVEL_CONTA_RE)) {
    motivos.push({
      codigo: 'conta-residual',
      mensagem:
        'contaOuterRef is (also) compared in a residual Filter node — links are read, then ' +
        `discarded. ${CONSEQUENCIA_DA_VARREDURA}`,
    });
  }
  if (predicateInResidualFilters(plan, VARIAVEL_CHAVE_RE)) {
    motivos.push({
      codigo: 'cursor-residual',
      mensagem:
        'the keyset cursor (__name__ > <ref>) is compared in a residual Filter — page N ' +
        're-reads every earlier page of the conta, so the walk turns quadratic in its link count.',
    });
  }
  if (temSortResidual(plan)) {
    motivos.push({
      codigo: 'sort-residual',
      mensagem:
        'a sort node (Sort / MajorSort / TopN) in this PROXY plan — the index did not deliver ' +
        '__name__ order, so every page reads EVERY remaining link of the conta before the ' +
        'limit can cut it; were the classic query to execute the same way, the walk would be ' +
        'quadratic in the conta’s link count, in index rows. Measured on the staging proxy ' +
        '2026-10-08: `contaOuterRef in [both ref forms]` sorts this way (page 1 of an 8-link ' +
        'conta read 8 rows to return 2), while one `==` per ref form — the audit’s page — ' +
        'prints `• Limit` and reads exactly the page. On the price phase’s `in` page this is ' +
        'that known proxy-plan finding; on the audit’s one-form page it is a regression — ' +
        'read the printed plan.',
    });
  }
  const fluxos = noIndice.reduce((s, n) => s + fluxosDeConta(n), 0);
  if (fluxos >= 2 && !temSortResidual(plan) && !temMerge(plan)) {
    motivos.push({
      codigo: 'fluxos-sem-merge',
      mensagem:
        `the scan on the CG index opens ${fluxos} conta streams (one per \`in\` value) and ` +
        'nothing above it sorts or merges them — the scan emits them conta-major, so a Limit ' +
        'straight over it returns the first rows of ONE ref form: the wrong page, not a ' +
        'cheaper one. No such plan has been observed; if this dialect combines the streams ' +
        'some other way, recalibrate explainPlan.mjs against the printed plan.',
    });
  }

  return { motivos, nos, alvo, detalhe, leitura, leituraTotal };
}

/**
 * The declared single-field entry the open-avisos read must ride —
 * `avisos(resolvidoEm ASC)`, COLLECTION scope, which the dialect prints with an
 * EMPTY scope segment and no trailing key field (`/avisos (resolvidoEm ASC)@[id
 * = …]`; its `key ordering length: 2` is the key ordering each value's run).
 * The bell's composite `avisos(resolvidoEm ASC, criadoEm DESC)` is NOT it.
 */
export const INDICE_DOS_AVISOS_ABERTOS_RE =
  /^\/avisos \(resolvidoEm ASC(?:, __(?:name|key)__ ASC)?\)@/;

/** The plan's variable for `resolvidoEm` — `$resolvidoEm`, or numbered (`$resolvidoEm_3`). */
export const VARIAVEL_RESOLVIDO_RE = /\$resolvidoEm(?:_\d+)?\b/;

/**
 * The closed POINT range on null — `|----[null]` — and nothing wider: not a
 * half-open `[null..+∞)`, which runs on through every resolved row, and not a
 * set holding another value.
 */
export const PONTO_NULO_RE = /^\|-+\s*\[\s*null\s*\]\s*$/;

/** The verdict a failing open-avisos plan has to carry into every message. */
const CONSEQUENCIA_DOS_AVISOS =
  'The #1200 monthly audit reads the open avisos ONCE per run; unbounded, that read ' +
  'walks every aviso ever written, resolved history included — billed as data scanned, ' +
  'every month.';

/**
 * The open-avisos read's verdict (`listarAvisosAbertos`'s pipeline translation:
 * `collection(avisos)`, the `resolvidoEm == null` predicate, the
 * `exists(__name__)` and `sort(__name__)` the SDK derives for a query with no
 * order, `limit(AVISOS_ABERTOS_MAX + 1)`). It must:
 *  1. contain no identifier-less scan over the root partition — a whole-
 *     collection scan;
 *  2. ride {@link INDICE_DOS_AVISOS_ABERTOS_RE} — the declared single-field
 *     entry — with EVERY root of the range tree the closed point `[null]`
 *     ({@link PONTO_NULO_RE}): one run of the index, exactly the open rows. A
 *     bare `ranges: /`, or any range wider than the point, reads the resolved
 *     history after it. The SHAPE decides here — no read counter excuses a
 *     range that is not the point, because the read's whole purpose is to be
 *     the open rows and nothing else;
 *  3. SELECT on `resolvidoEm` in no residual `Filter` — rows read, then
 *     discarded ({@link filtrosResiduaisSobre}; an `exists(...)` test is not a
 *     comparison). ⚠️ The real plan (2026-10-09, `__planos__/avisos-abertos.txt`)
 *     DOES print `($resolvidoEm_4 == null)` in a Filter — over the scan's own
 *     `[null]` range, discarding nothing (`post-filtered rows: 0`): a re-check
 *     of what the range already holds. So a residual comparison is a finding
 *     unless EVERY node on the index is the `[null]` point AND the Filter
 *     printed that it discarded zero rows; one that discarded rows, sits over a
 *     wider range, or prints no count is the predicate served residually;
 *  4. have no sort that CUTS its input ({@link sortsQueCortam}). ⚠️ The real
 *     plan prints a `• MajorSort` on `$__name__` with `limit: 5,001`: the
 *     `sort(__name__)` stage the SDK derives for a query with no `orderBy`
 *     (`Query._pipeline()`), over a `Fetch` with `order: UNDEFINED`. It sorted
 *     7 rows into 7 — the whole `[null]` run IS the result, so the sort reads
 *     nothing the read does not return, unlike the walk's, which sorted a
 *     conta's whole remainder to return one PAGE of it. A sort that consumes
 *     more than it returns is that walk's failure, and fails here too. (The
 *     classic read itself does not even sort: on Enterprise it returned the open
 *     rows OUT of key order in the same run — nothing in the audit needs one);
 *  5. read no more than `leituraMaxima`, summed over the nodes on the index and
 *     as the plan-wide `index row scanned`. The staging suite passes the rows
 *     the read RETURNED: a bounded read scans exactly what it returns.
 *
 * @param {string} plan
 * @param {OpcoesDoVeredicto} [opcoes]
 * @returns {VeredictoDoPlano}
 */
export function julgarPlanoDosAvisosAbertos(plan, { leituraMaxima = null } = {}) {
  const nos = parseAccessNodes(plan);
  /** @type {Motivo[]} */
  const motivos = [];

  for (const n of scansSemIdentificador(nos).cheios) {
    motivos.push({
      codigo: 'scan-sem-indice',
      mensagem:
        `an identifier-less ${n.type} (plan line ${n.line}) reads avisos with NO index — a ` +
        `full scan. ${CONSEQUENCIA_DOS_AVISOS}`,
    });
  }

  const noIndice = nos.filter(
    (n) => n.identifier != null && INDICE_DOS_AVISOS_ABERTOS_RE.test(n.identifier),
  );
  /** @param {AccessNode} n */
  const noPontoNulo = (n) =>
    n.faixas.length > 0 && n.faixas.every((f) => PONTO_NULO_RE.test(f.linha));
  const alvo = noIndice.find(noPontoNulo) ?? noIndice[0] ?? null;
  const leitura = somaDeLeituras(noIndice);
  const leituraTotal = linhasDeIndiceLidas(plan);
  const estadoDaLeitura = julgarLeitura(leitura, leituraTotal, leituraMaxima);
  /** @type {string | null} */
  let detalhe = null;

  if (noIndice.length === 0) {
    motivos.push({
      codigo: 'indice-ausente',
      mensagem:
        'no access node rides the declared avisos(resolvidoEm ASC) entry — it is in ' +
        'firestore.indexes.json, so either it is not READY on this project or the planner ' +
        'chose another path (read the printed plan). ' +
        CONSEQUENCIA_DOS_AVISOS,
    });
  } else if (!noIndice.every(noPontoNulo)) {
    motivos.push({
      codigo: 'abertos-sem-limite',
      mensagem:
        `the plan rides ${alvo?.identifier ?? 'avisos(resolvidoEm)'} but not as the closed ` +
        '`[null]` point range (a bare `ranges: /`, or a range wider than null) — it reads ' +
        'the resolved avisos after the open ones. ' +
        CONSEQUENCIA_DOS_AVISOS,
    });
  }
  if (estadoDaLeitura === 'excessiva') {
    motivos.push({
      codigo: 'leitura-excessiva',
      mensagem:
        `the read scanned ${descreverExcesso(leitura, leituraTotal)} index rows where the ` +
        `open avisos are ${leituraMaxima} — it reads past the [null] run, whatever its ` +
        'ranges print.',
    });
  }
  const filtros = filtrosResiduaisSobre(plan, VARIAVEL_RESOLVIDO_RE);
  const soReconferem =
    noIndice.length > 0 &&
    noIndice.every(noPontoNulo) &&
    filtros.every((f) => f.contadores['post-filtered rows'] === 0);
  if (filtros.length > 0 && !soReconferem) {
    motivos.push({
      codigo: 'resolvido-residual',
      mensagem:
        'resolvidoEm is compared in a residual Filter node that SELECTS — over a range wider ' +
        'than [null], or discarding rows (post-filtered rows > 0, or no count printed): ' +
        'avisos are read, then discarded. ' +
        CONSEQUENCIA_DOS_AVISOS,
    });
  }
  const cortes = sortsQueCortam(plan);
  if (cortes.length > 0) {
    motivos.push({
      codigo: 'sort-residual',
      mensagem:
        `a sort node (${cortes.map((n) => `${n.nome}, plan line ${n.linha}`).join('; ')}) ` +
        'consumes MORE rows than it returns (or prints no count) — it reads rows the result ' +
        'does not hold before its limit cuts them: the scan was not the [null] run alone.',
    });
  }
  if (alvo != null && motivos.length === 0) {
    const notas = [
      filtros.length > 0 ? 'the residual resolvidoEm re-check discarded nothing' : null,
      temSortResidual(plan) ? 'the sort (the proxy’s key order) cut nothing' : null,
    ].filter((n) => n != null);
    detalhe =
      `the [null] point range on ${alvo.identifier}` +
      descreverLeitura(leitura, leituraMaxima) +
      (notas.length > 0 ? ` — ${notas.join('; ')}` : '');
  }
  return { motivos, nos, alvo, detalhe, leitura, leituraTotal };
}

/* ------------------------ classic explain (non-Enterprise) ------------------ */

/**
 * The message Enterprise answers a classic `explain()` with — the refusal that
 * makes every verdict above a PROXY. Matched loosely: it says something about
 * the API, nothing about the index.
 */
export const RECUSA_EXPLAIN_ENTERPRISE_RE = /not supported in RunQuery API for Enterprise/i;

/**
 * @typedef {{ query_scope?: unknown, properties?: unknown }} IndiceUsado
 */

/**
 * Where a database DOES accept classic explain: does `planSummary.indexesUsed`
 * name the walk's COLLECTION_GROUP `(contaOuterRef ASC, __name__ ASC)` entry?
 * Empty ⇒ false (no index at all is the failure, not a pass).
 *
 * @param {readonly IndiceUsado[]} usados
 * @returns {boolean}
 */
export function classicoServeVarredura(usados) {
  return usados.some(
    (u) =>
      /group/i.test(String(u.query_scope ?? '')) &&
      /^\(contaOuterRef ASC, __name__ ASC\)$/.test(String(u.properties ?? '')),
  );
}

/**
 * Where a database DOES accept classic explain: does `planSummary.indexesUsed`
 * name the COLLECTION-scope `(resolvidoEm ASC, __name__ ASC)` entry the
 * open-avisos read rides — and only it? Empty ⇒ false.
 *
 * @param {readonly IndiceUsado[]} usados
 * @returns {boolean}
 */
export function classicoServeAvisosAbertos(usados) {
  return (
    usados.length > 0 &&
    usados.every(
      (u) =>
        !/group/i.test(String(u.query_scope ?? '')) &&
        /^\(resolvidoEm ASC, __name__ ASC\)$/.test(String(u.properties ?? '')),
    )
  );
}
