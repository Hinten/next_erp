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
 *    in-scope PR.
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
 * `db.pipeline().createFrom(<the classic Query>)`, never from a hand-built
 * pipeline that could drift from the query it stands for. Read precisely what a
 * proxy verdict proves: a proxy that rides no node on the expected index means
 * that index is not READY in the project (readiness does not depend on the API)
 * — a real FAIL; a proxy PASS proves the index is READY and serves the
 * predicate, NOT the classic query's own plan, which only Query Insights
 * confirms after a real run.
 *
 * ---- The ACCESS-NODE dialect (calibrated on real staging plans, 2026-07-28;
 * the format is not machine-stable, so every consumer also PRINTS the plan). A
 * plan is parsed into access-node blocks: any `• <Name>Scan` bullet
 * (SequentialScan, SeekingScan, TableScan, …) or `• IndexSeek`, plus its body up
 * to the next `•` bullet. In this dialect the node NAME is not the verdict: a
 * `SequentialScan` carrying an `index: /<name>@[id = …]` identifier AND a bounded
 * `ranges:`/`constraints:` block IS an index range scan. A bound is a constraint
 * value line (`|----["integracao/…"]`, `[1,234L..+∞)`) — the bare unbounded
 * `(-∞..+∞)` line never counts.
 *
 * ⚠️ A `• Filter` NODE is a RESIDUAL filter (rows read, THEN discarded); a
 * node-local `filter:` LINE inside an access node is a PUSH-DOWN into the scan.
 * Only the former counts against a plan as RESIDUAL — but a push-down is not a
 * BOUND either. A scan whose ranges are all `(-∞..+∞)` and which evaluates
 * `equal_any(...)` per entry prints exactly the same `filter:` line as one that
 * seeks per value, and the first reads the whole index. So the #1200 verdicts
 * below accept a bound from the SHAPE only when it is a range line closed on
 * the side that matters; anything weaker passes only when the plan's own read
 * counters prove the scan stayed inside the expected range (`leituraMaxima`).
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
 * @property {string[]} boundLines Every constraint value line (`|----…`).
 * @property {string[]} boundedLines `boundLines` minus the unbounded `(-∞..+∞)`.
 * @property {string[]} execution The node's `Execution:` stat lines, trimmed.
 */

/**
 * The completely-unbounded range line — `(-∞..+∞)` — never counts as a bound;
 * a half-bounded range (`[1,234L..+∞)`, a timestamp cutoff) DOES.
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
/** A range whose UPPER end is `+∞`: `…..+∞)`. */
const FIM_INFINITO_RE = /\.\.\s*\+?(?:∞|inf)\s*[\])]/i;

/**
 * Is a constraint line closed on BOTH sides — a point set
 * (`["integracao/x", "documents/integracao/x"]`, `[null]`) or a finite range
 * (`[EntityRef[avisos/a:]..EntityRef[avisos/a;])`)? A half-open line
 * (`[EntityRef[…]..+∞)`, `(-∞..["integracao/x"]]`) is a bound on ONE side only:
 * the scan runs on to the edge of the index on the other. Matched on the range
 * syntax, never on a bare `inf` substring, so an id containing `inf` stays a
 * value.
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
 * rather than a per-entry test.
 */
export const LIMITE_INFERIOR_DE_CHAVE_RE = /^\|-+\s*[[(]\s*EntityRef\[/;

/**
 * Parse the plan into access-node blocks: a SequentialScan / SeekingScan /
 * IndexSeek / TableScan / EntityScan / CollectionScan bullet — plus ANY other
 * `• <Name>Scan`, so a node type this dialect has not shown us yet is still SEEN
 * rather than silently skipped — with every body line up to the next `•` bullet.
 * The identifier-less names are the point: a `TableScan` carries no `index:`
 * line at all, and a parser blind to it cannot report a raw scan.
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
      if (l.includes('|----')) boundLines.push(l.slice(l.indexOf('|----')));
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
 * Does the target predicate show up in a RESIDUAL `Filter` NODE — rows read and
 * then thrown away? Only `• Filter` blocks count, and only their `expression:`
 * bodies; a node-local `filter:` line is the OPPOSITE finding (a push-down), so
 * counting it would condemn the healthy plan. A block runs from the `• Filter`
 * bullet to the next `•` bullet or its `Execution:` stats, whichever is first.
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
      if (/\bexpression:\s/.test(l) && predicateRe.test(l)) return true;
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
 * A `Sort` NODE — the access path did not deliver key order, so the stage sorts
 * everything the scan produced before `limit` can cut it. Matched on the bare
 * name (`• Sort`, `• TopN`, `• TopK`), so a streaming merge of sorted ranges
 * (`• SortedMerge`-style, which an `in` over two values may legitimately need)
 * does not count.
 *
 * @param {string} plan
 * @returns {boolean}
 */
export function temSortResidual(plan) {
  return /•\s+(?:Sort|TopN|TopK)\b/.test(plan);
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
 * ⚠️ The label set is the dialect's, not ours, and it is not machine-stable —
 * callers look labels up by pattern ({@link contadorDeLeitura}), never by
 * exact string.
 *
 * @param {AccessNode} node
 * @returns {Record<string, number>}
 */
export function contadoresDeExecucao(node) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const l of node.execution) {
    const m = l.match(/^([A-Za-z][\w\s()/-]*?)\s*:\s*(-?[\d,]*\.?\d+)/);
    if (m == null) continue;
    const valor = Number((m[2] ?? '').replace(/,/g, ''));
    if (Number.isFinite(valor)) out[(m[1] ?? '').trim().toLowerCase()] = valor;
  }
  return out;
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
 * `'sem-prova'` when either is missing (the counters prove nothing either way),
 * else `'dentro'` / `'excessiva'`.
 *
 * @param {Leitura | null} leitura
 * @param {number | null} leituraMaxima
 * @returns {'sem-prova' | 'dentro' | 'excessiva'}
 */
function julgarLeitura(leitura, leituraMaxima) {
  if (leitura == null || leituraMaxima == null) return 'sem-prova';
  return leitura.valor <= leituraMaxima ? 'dentro' : 'excessiva';
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
 */

/**
 * @typedef {object} OpcoesDoVeredicto
 * @property {number | null} [leituraMaxima] The most entries a correctly
 *   BOUNDED plan of the probed page may read, summed over the judged nodes.
 *   Given, it is enforced against the plan's read counters — a plan that read
 *   more FAILS whatever its shape — and it is the ONLY way a plan whose shape
 *   cannot prove the bound (a push-down, a half-open range) passes. ⚠️ Pass one
 *   only where the caller KNOWS the failure modes read more than it: the
 *   staging suite seeds neighbours on every side for exactly that, and asserts
 *   its ceilings sit below them. On an unseeded collection a whole-index walk
 *   can read fewer entries than any ceiling, and the counter proves nothing.
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
 * `collectionGroup(produtoMercadoLivre)`, `contaOuterRef equal_any [both ref
 * forms]`, `__name__ > <cursor>`, `sort(__name__)`, `limit`). It must:
 *  1. contain no identifier-less scan over the root partition — a collection
 *     group has no parent partition to excuse one;
 *  2. ride {@link INDICE_DA_VARREDURA_RE} BOUNDED on `contaOuterRef` — riding it
 *     unbounded is a walk of every conta's links. The SHAPE proves it only when
 *     EVERY node on the index carries a closed constraint line naming an
 *     `integracao/` ref ({@link limiteFechado}); an `equal_any` push-down with
 *     `(-∞..+∞)` ranges is the very shape of that walk, so it passes only on
 *     the read counters (`leituraMaxima`);
 *  3. when the probed page carries a cursor (`comCursor`), have it as a SEEK —
 *     a key lower bound ({@link LIMITE_INFERIOR_DE_CHAVE_RE}) on every node on
 *     the index, or read counters within `leituraMaxima`. A cursor tested per
 *     entry, inside the scan's own `filter:` line, makes page N re-read every
 *     earlier page of the conta (the walk turns quadratic), and that line looks
 *     exactly like a healthy push-down;
 *  4. carry neither predicate in a residual `Filter` node — a residual
 *     `contaOuterRef` means rows were read then discarded, and a residual
 *     cursor is the quadratic walk of 3 with the test moved one node up;
 *  5. have no `Sort` node — the index did not deliver key order, so every page
 *     sorts the conta's whole link set before the limit;
 *  6. read no more than `leituraMaxima`, whatever the shape says.
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
    n.boundedLines.some((l) => l.includes('integracao/') && limiteFechado(l));
  /** @param {AccessNode} n */
  const contaNoFiltro = (n) => n.filter != null && /contaOuterRef/.test(n.filter);
  /** @param {AccessNode} n */
  const cursorNaFaixa = (n) => n.boundedLines.some((l) => LIMITE_INFERIOR_DE_CHAVE_RE.test(l));

  const alvo = noIndice.find(contaNaFaixa) ?? noIndice.find(contaNoFiltro) ?? null;
  const leitura = somaDeLeituras(noIndice);
  const estadoDaLeitura = julgarLeitura(leitura, leituraMaxima);
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
        'contaOuterRef — it walks every conta’s links in key order. ' +
        CONSEQUENCIA_DA_VARREDURA,
    });
  } else {
    if (!contaPelaForma && estadoDaLeitura === 'sem-prova') {
      motivos.push({
        codigo: 'indice-sem-limite',
        mensagem:
          `the plan rides ${alvo.identifier} with contaOuterRef only as a node-local filter ` +
          '(or a range open on one side) — the same lines a walk of EVERY conta’s links, ' +
          'tested entry by entry, prints — and no read counter within a known ceiling proves ' +
          'otherwise. Read the printed plan; if this dialect bounds the conta some other way, ' +
          'recalibrate explainPlan.mjs against it. ' +
          CONSEQUENCIA_DA_VARREDURA,
      });
    }
    if (!cursorPelaForma && estadoDaLeitura === 'sem-prova') {
      motivos.push({
        codigo: 'cursor-sem-limite',
        mensagem:
          `the keyset cursor (__name__ > <ref>) is not a key lower bound on ${alvo.identifier} ` +
          '— tested per entry instead, page N re-reads every earlier page of the conta, so ' +
          'the walk turns quadratic in its link count — and no read counter within a known ' +
          'ceiling proves otherwise.',
      });
    }
  }
  if (estadoDaLeitura === 'excessiva') {
    motivos.push({
      codigo: 'leitura-excessiva',
      mensagem:
        `the nodes on the CG index read ${leitura?.valor} entries (${leitura?.rotulo}) where a ` +
        `bounded page reads at most ${leituraMaxima} — the scan is not confined to the conta ` +
        `past the cursor, whatever its ranges print. ${CONSEQUENCIA_DA_VARREDURA}`,
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

  if (predicateInResidualFilters(plan, /\$contaOuterRef/)) {
    motivos.push({
      codigo: 'conta-residual',
      mensagem:
        'contaOuterRef is (also) served by a residual Filter node — links are read, then ' +
        `discarded. ${CONSEQUENCIA_DA_VARREDURA}`,
    });
  }
  if (predicateInResidualFilters(plan, /\$__(?:name|key)__/)) {
    motivos.push({
      codigo: 'cursor-residual',
      mensagem:
        'the keyset cursor (__name__ > <ref>) is a residual Filter — page N re-reads every ' +
        'earlier page of the conta, so the walk turns quadratic in its link count.',
    });
  }
  if (temSortResidual(plan)) {
    motivos.push({
      codigo: 'sort-residual',
      mensagem:
        'a Sort node — the index did not deliver __name__ order, so every page sorts the ' +
        'conta’s whole link set before the limit can cut it.',
    });
  }

  return { motivos, nos, alvo, detalhe, leitura };
}

/**
 * The avisos key range's verdict (`listarFaixaDeChaves`'s pipeline translation:
 * `collection(avisos)`, `__name__ >= <inicio>` AND `< <fim>`, `sort(__name__)`,
 * `limit`). The primary key is no declared index, so an access node here may
 * legitimately carry no `index:` line — what MUST hold is a BOUND on the key at
 * BOTH ends: every access node on `avisos` carrying a constraint line closed on
 * both sides ({@link limiteFechado}). A half-open `[EntityRef[avisos/<inicio>]..+∞)`
 * reads from the conta's first row to the END of the collection (the upper end
 * then tested per row), and a `(-∞..…)` one from the collection's start — each a
 * walk of every other conta's avisos, so neither passes on its shape; like a
 * key push-down, each passes only on read counters within `leituraMaxima`. It
 * must also carry the key in no residual `Filter` (the range read as a walk of
 * the collection, then cut), have no `Sort` node (a key-ordered read that still
 * sorts), and read no more than `leituraMaxima` whatever its shape.
 *
 * `inicio` (the range start the caller probed) is optional: when given and
 * printed in the bound, `detalhe` says so — a stronger PASS, never a requirement,
 * because the dialect may print the key as an `EntityRef[…]` rather than as text.
 *
 * @param {string} plan
 * @param {OpcoesDoVeredicto & { inicio?: string | null }} [opcoes]
 * @returns {VeredictoDoPlano}
 */
export function julgarPlanoDaFaixaDeAvisos(plan, { inicio = null, leituraMaxima = null } = {}) {
  const nos = parseAccessNodes(plan);
  /** @type {Motivo[]} */
  const motivos = [];
  const doAvisos = nos.filter((n) => /avisos/.test(`${n.identifier ?? ''} ${n.kind ?? ''}`));
  /** @param {AccessNode} n */
  const fechado = (n) => n.boundedLines.some(limiteFechado);
  /** @param {AccessNode} n */
  const algumLimite = (n) =>
    n.boundedLines.length > 0 || (n.filter != null && /\$__(?:name|key)__/.test(n.filter));

  const alvo = doAvisos.find(fechado) ?? doAvisos.find(algumLimite) ?? null;
  const leitura = somaDeLeituras(doAvisos);
  const estadoDaLeitura = julgarLeitura(leitura, leituraMaxima);
  const pelaForma = doAvisos.length > 0 && doAvisos.every(fechado);
  /** @type {string | null} */
  let detalhe = null;
  if (doAvisos.length === 0) {
    motivos.push({
      codigo: 'sem-no-de-avisos',
      mensagem:
        'no access node on avisos in the plan — the verdict cannot be read; print the plan ' +
        'and re-calibrate explainPlan.mjs against it.',
    });
  } else if (alvo == null) {
    motivos.push({
      codigo: 'faixa-sem-limite',
      mensagem:
        'the avisos scan carries NO key bound — the audit’s per-conta key range is read as a ' +
        'walk of the whole avisos collection, every conta, every month.',
    });
  } else if (!pelaForma && estadoDaLeitura === 'sem-prova') {
    motivos.push({
      codigo: 'faixa-sem-limite',
      mensagem:
        'the avisos key range is bounded on ONE side at most (a half-open range, or the key ' +
        'tested inside the scan) — read on to the edge of the collection, that is every other ' +
        'conta’s avisos, every month — and no read counter within a known ceiling proves ' +
        'otherwise. Read the printed plan; recalibrate explainPlan.mjs if this dialect closes ' +
        'the range some other way.',
    });
  }
  if (estadoDaLeitura === 'excessiva') {
    motivos.push({
      codigo: 'leitura-excessiva',
      mensagem:
        `the avisos scan read ${leitura?.valor} entries (${leitura?.rotulo}) where the bounded ` +
        `range reads at most ${leituraMaxima} — it is reading past the conta’s key range.`,
    });
  }
  if (alvo != null && motivos.length === 0) {
    const nome = alvo.identifier ?? `(no identifier${alvo.kind ? `, kind ${alvo.kind}` : ''})`;
    const contemInicio = inicio != null && alvo.boundedLines.some((l) => l.includes(inicio));
    detalhe =
      `${pelaForma ? 'closed key range' : 'key range NOT closed in the plan'} on ${nome}` +
      (contemInicio ? ' — the range start is printed in its bound' : '') +
      descreverLeitura(leitura, leituraMaxima) +
      (pelaForma ? '' : ' — the READ COUNTERS, not the plan shape, prove the scan stayed bounded');
  }
  if (predicateInResidualFilters(plan, /\$__(?:name|key)__/)) {
    motivos.push({
      codigo: 'faixa-residual',
      mensagem: 'the key range is a residual Filter — rows read, then cut.',
    });
  }
  if (temSortResidual(plan)) {
    motivos.push({
      codigo: 'sort-residual',
      mensagem: 'a Sort node on a key-ordered read — the key order was not delivered by the scan.',
    });
  }
  return { motivos, nos, alvo, detalhe, leitura };
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
 * Where a database DOES accept classic explain: a pure key-order read rides the
 * primary key and no declared composite. Empty ⇒ false.
 *
 * @param {readonly IndiceUsado[]} usados
 * @returns {boolean}
 */
export function classicoServeFaixa(usados) {
  return (
    usados.length > 0 && usados.every((u) => /^\(__name__ ASC\)$/.test(String(u.properties ?? '')))
  );
}
