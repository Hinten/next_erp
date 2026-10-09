/**
 * The monthly link audit's Firestore half (#1200) against the REAL staging
 * database — **Enterprise** edition — run by `ML staging Enterprise queries` in
 * ci-mercado-livre.yml (`test:staging`, vitest.staging.config.ts).
 *
 * Why it exists: before this suite none of the audit's queries had ever run on
 * Enterprise. The offline suite fakes Firestore; the emulator suite
 * (`auditoriaNaoEnumerados.firestore.test.ts`) runs the STANDARD-edition
 * emulator, which auto-creates every index; and Enterprise refuses classic
 * `explain()`, so the plans of the audit's two classic queries — the
 * collection-group walk and the run's open-avisos read — were never observed.
 * On Enterprise a missing index does not fail: it full-scans and bills the scan.
 *
 * What it proves, each case red if the behaviour breaks:
 *  (a) the audit's walk — ONE stored ref form at a time, `contaOuterRef ==` —
 *      over REAL `DocumentReference` keyset cursors, each form drained at
 *      `pageLimit: 2` from its own first page, reads every link seeded on X
 *      exactly once — never X2's (above X) or W's (below it) — (sum of `lidos`
 *      == X's seeded count, each form's cursors == that form's independently
 *      sorted paths) and classifies every finding, `limpos` included;
 *  (b) the pre-resolve re-read agrees with (a), produto by produto;
 *  (c) the tier-1 heal really adds the conta on a real transaction KEEPING the
 *      array's other entry, refuses a produto with only a closed link without
 *      writing, and never resurrects a missing produto;
 *  (d) the run's open-avisos read (`listarAvisosAbertos`) on real documents:
 *      every OPEN row this run seeded, never its RESOLVED one — and the
 *      in-memory filter the audit runs over it keeps exactly X's rows of this
 *      tipo and canal: not another canal's, another tipo's, a prefix-sharing
 *      conta's, nor a malformed id's;
 *  (e) PLAN + COST: the SDK's own pipeline translation (`createFrom`) — the
 *      PROXY, since Enterprise refuses classic explain — of the walk's FIRST and
 *      LAST pages in EACH ref form, and of the open-avisos read, judged by the
 *      SAME `lib/firebase/explainPlan.mjs` verdicts the manual
 *      `scripts/check-stock-indexes.mjs` gate uses, every verdict asserted a
 *      PASS. The proxy explains the production builders' PROJECTION-LESS half
 *      (`…SemProjecao` — `createFrom` of a query with `select` returns zero rows
 *      and no plan) and must read the very rows the production query reads. The
 *      walk's PASS proves the proxy rides the COLLECTION_GROUP
 *      `produtoMercadoLivre(contaOuterRef, __name__)` index (the index is
 *      READY), bounded on `contaOuterRef`, SEEKING its cursor and unsorted — by
 *      the plan's range tree, and by read counters under a ceiling this seed's
 *      failure modes provably exceed (a push-down or a per-entry cursor prints
 *      the same lines as the walk it must rule out). The avisos PASS proves the
 *      read rides `avisos(resolvidoEm)` as the closed `[null]` point range and
 *      scans exactly the rows it returns — a range that ran on into the resolved
 *      history would scan this run's resolved row too.
 *      ⚠️ Both pass since 2026-10-09, and they were not always going to: on
 *      2026-10-08 the walk's `in` over both ref forms was sorted by a
 *      `MajorSort` (page 1 read all 8 of X's links to return 2) and the avisos
 *      KEY RANGE it then read had no seekable access path at all — the
 *      proxy-plan findings (`explainPlan.mjs`'s header) that made the audit walk
 *      one form at a time and read the open avisos once per run. A red here is a
 *      regression of either decision, never a pin to relax.
 *
 * ---- Safety and isolation, because this writes to a shared project:
 *  - every id it writes carries this run's prefix `e2e-ml1200-<8 hex>`, so two
 *    runs (CI push + PR, two developers) never see each other's rows — the walk
 *    is bounded by a per-run conta id, and every avisos assertion is scoped to
 *    this run's ids (the open-avisos read spans staging's whole bell);
 *  - it NEVER creates an `integracao` doc: the conta id is a bare string in
 *    `contaOuterRef` and the aviso keys. An active ML integração would be picked
 *    up by the real stock and price sweeps on staging;
 *  - it NEVER calls `runAuditoriaNaoEnumerados`, which enumerates every real
 *    staging conta and resolves tipo-wide — only the scoped primitives;
 *  - ⚠️ (d) and (e) need OPEN avisos — the read under test lists nothing else —
 *    and an open row is what the staging bell (`resolvidoEm == null`, newest
 *    `criadoEm` first, 50 rows) reads. ONE thing keeps them off every
 *    operator's screen: `destinatarioUid` names a per-run uid no operator has,
 *    and the bell drops a row addressed to somebody else
 *    (`apps/web/lib/avisos/useAvisos.ts`). On a bell holding fewer than 50 open
 *    rows — staging's, today — they ARE inside its window, and that filter is
 *    all that hides them. The early `criadoEm`
 *    ({@link CRIADO_NO_INICIO_DOS_TEMPOS_US}) does something narrower: under a
 *    newest-first read they sort LAST, so they never take a real row's place in
 *    the bell's 50 nor in Shopee pass (b)'s page of 200
 *    (`reservaTravadaSweep.ts`). Their lifetime is the suite's own: `afterAll`
 *    deletes them. The one row (d)/(e) need RESOLVED is seeded resolved, at the
 *    fixed {@link RESOLVIDO_SENTINELA_US};
 *  - `afterAll` deletes every produto SUBTREE it wrote (links, and the
 *    `historicoDeModificacoes` rows the deployed `onProdutoChanged` adds) plus
 *    every aviso, then VERIFIES the deletion and fails the suite if anything is
 *    left — and that the stale sweep's reads reached every one of them;
 *    `beforeAll` first reclaims this suite's own leftovers older than
 *    {@link IDADE_SOBRA_MS} from a crashed run ({@link varrerSobrasAntigas},
 *    bounded index reads only). The `e2e-` prefix also puts its produtos in
 *    reach of the web e2e lanes' age-gated stale sweep.
 *
 * ---- ⚠️ The deployed link trigger is a second writer, and it is handled, not
 * assumed away. `onProdutoMercadoLivreLinkChanged` (the ML functions codebase)
 * fires on every link this suite writes and `arrayUnion`s the conta onto the
 * produto — which would silently HEAL the class-2 drift (a) and (c) need before
 * the walk could see it. So the seed waits for that heal to land on the drifted
 * produto (evidence its event was processed; it fires once per write), THEN
 * re-asserts the drift, and every case that depends on it re-reads it first and
 * says so plainly if something rewrote it. When the trigger is not deployed the
 * wait simply times out after {@link ESPERA_GATILHO_MS}.
 */
import { randomBytes } from 'node:crypto';
import type {
  BulkWriter,
  DocumentReference,
  Firestore,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MICROS_LOWER_BOUND } from '@delfrance/core/datetime';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import {
  avisoCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  CANAL_AVISO,
  SEVERIDADE_AVISO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  RECUSA_EXPLAIN_ENTERPRISE_RE,
  classicoServeAvisosAbertos,
  classicoServeVarredura,
  julgarPlanoDaVarredura,
  julgarPlanoDosAvisosAbertos,
} from '@/lib/firebase/explainPlan.mjs';
import { STAGING } from '@/vitest.staging.setup';

import { adicionarContaSeViva, contaRefForms } from '../anuncios/integracoesComProduto';
import {
  CODIGO_NAO_ENUMERADO,
  type CodigoNaoEnumerado,
  type LinkNaoEnumerado,
  type LinksNaoEnumeradosPage,
  consultaDaVarredura,
  consultaDaVarreduraSemProjecao,
  fetchLinksNaoEnumeradosPage,
  reclassificarProdutoNaoEnumerado,
} from '../anuncios/linksNaoEnumerados';
import {
  AVISOS_ABERTOS_MAX,
  avisosDaConta,
  chaveDoAviso,
  classificarAvisosAbertos,
  consultaDosAvisosAbertos,
  consultaDosAvisosAbertosSemProjecao,
  listarAvisosAbertos,
  planoDoAviso,
} from './auditoriaNaoEnumerados';

/* --------------------------------- the run --------------------------------- */

/** Every id this suite writes starts with this — the scope of its stale sweep. */
const PREFIXO_DA_SUITE = 'e2e-ml1200-';
/** This run's prefix: `e2e-ml1200-<8 hex>`. */
const RUN = `${PREFIXO_DA_SUITE}${randomBytes(4).toString('hex')}`;

/** A leftover older than this is a crashed run's, never a live one's. */
const IDADE_SOBRA_MS = 2 * 60 * 60 * 1000;
/**
 * At most this many leftover links per ref form, and resolved witnesses, per
 * stale sweep — a run leaves eight links in one form and seven in the other, and
 * one witness, so one pass reclaims several crashed runs and the next run picks
 * up the rest, while the sweep stays well inside `beforeAll`'s hook timeout.
 */
const LIMITE_DE_SOBRAS = 50;
/** How long the seed waits for the deployed link trigger's heal to land. */
const ESPERA_GATILHO_MS = 30_000;
/** The walk's page size here — small, so every drain crosses several cursors. */
const PAGINA = 2;

/** The synthetic conta. No `integracao` doc ever exists for it. */
const X = `${RUN}-x`;
/** Shares X's WHOLE id as a prefix — the walk's `==` and the avisos conta filter's near-miss. */
const X2 = `${X}2`;
/** The other conta the drifted produto's array already carries. */
const OUTRA = `${RUN}-outra`;
/** `paiId` of the variation child — a parent that is never created. */
const PAI = `${RUN}-pai`;
/**
 * The neighbour conta just BELOW X in both ref forms (`…-w` sorts before `…-x`)
 * — the witness (e)'s walk floor stands on. An unbounded scan that stops at its
 * Limit reads only what sorts before X's first index entry plus the page, so
 * with nothing seeded below X a walk of every conta's links can read inside the
 * ceiling on the FIRST page (no cursor, so no cursor check) and pass on its
 * counters. X2 sits ABOVE X and OUTRA has no links: neither is that witness.
 */
const W = `${RUN}-w`;
/** Where W's links hang: a produto document that is never created. */
const PRODUTO_DO_VIZINHO = `${RUN}-v`;
/** W's links PER REF FORM — each form's run sorts just below X's same form. */
const LINKS_DO_VIZINHO_POR_FORMA = 3;

/** Produto ids — lower-case suffixes, so their key order is their letter order. */
const P = {
  /** Drifted family parent: a live link on X, but the array lost X (class 2). */
  derivado: `${RUN}-a`,
  /** Variation child with a live link (class 3). */
  filho: `${RUN}-b`,
  /** `paiId: ''` — neither null nor an id. */
  paiVazio: `${RUN}-c`,
  /** Healthy anchor — what the walk must call clean. */
  saudavel: `${RUN}-h`,
  /** Only a CLOSED link on X, and the array lacks X: the heal must refuse. */
  soFechado: `${RUN}-k`,
  /** A never-published link (no item id): noise, never a finding. */
  nuncaPublicado: `${RUN}-n`,
  /** The orphan: a live link whose produto document does not exist. */
  orfao: `${RUN}-o`,
} as const;

interface LinkSemeado {
  produtoId: string;
  linkId: string;
  conta: string;
  dados: Record<string, unknown>;
}

const forma = (conta: string, i: 0 | 1): string => contaRefForms(conta)[i]!;

/**
 * Every link, RAW — through the handle's `docRef`, never `set()`: the bare
 * `integracao/<id>` ref form and a link with no item id are legacy shapes the
 * link schema rejects, and they are exactly what the walk must still read.
 */
const LINKS: readonly LinkSemeado[] = [
  {
    produtoId: P.derivado,
    linkId: 'l1',
    conta: X,
    dados: { id: 'MLB-A', estado: 'a', contaOuterRef: forma(X, 0) },
  },
  {
    produtoId: P.derivado,
    linkId: 'l2',
    conta: X,
    dados: { id: 'MLB-A-velho', estado: 'c', contaOuterRef: forma(X, 1) },
  },
  {
    produtoId: P.filho,
    linkId: 'l1',
    conta: X,
    dados: { id: 'MLB-B', estado: 'a', contaOuterRef: forma(X, 1) },
  },
  {
    produtoId: P.paiVazio,
    linkId: 'l1',
    conta: X,
    dados: { id: 'MLB-C', estado: 'a', contaOuterRef: forma(X, 0) },
  },
  {
    produtoId: P.saudavel,
    linkId: 'l1',
    conta: X,
    dados: { id: 'MLB-H', estado: 'a', contaOuterRef: forma(X, 1) },
  },
  // X2's live link sits on the SAME produto: the `==` must not admit it into X's walk.
  {
    produtoId: P.saudavel,
    linkId: 'l2',
    conta: X2,
    dados: { id: 'MLB-H2', estado: 'a', contaOuterRef: forma(X2, 0) },
  },
  {
    produtoId: P.soFechado,
    linkId: 'l1',
    conta: X,
    dados: { id: 'MLB-K', estado: 'c', contaOuterRef: forma(X, 0) },
  },
  {
    produtoId: P.nuncaPublicado,
    linkId: 'l1',
    conta: X,
    dados: { estado: 'a', contaOuterRef: forma(X, 0) },
  },
  {
    produtoId: P.orfao,
    linkId: 'l1',
    conta: X,
    dados: { id: 'MLB-O', estado: 'a', contaOuterRef: forma(X, 1) },
  },
  // W, the neighbour BELOW X, alternating ref forms. CLOSED, so no link counts
  // toward W's membership and the deployed link trigger reads and writes
  // nothing for them (`planLinkChange` fast path) — on a produto never created.
  ...Array.from(
    { length: 2 * LINKS_DO_VIZINHO_POR_FORMA },
    (_, i): LinkSemeado => ({
      produtoId: PRODUTO_DO_VIZINHO,
      linkId: `l${i + 1}`,
      conta: W,
      dados: { id: `MLB-W${i + 1}`, estado: 'c', contaOuterRef: forma(W, i % 2 === 0 ? 0 : 1) },
    }),
  ),
];

/** X's links in `__name__` order — derived from the seed, never read back. */
function caminhosOrdenados(links: readonly LinkSemeado[]): string[] {
  return links
    .map((l) => ({ produtoId: l.produtoId, linkId: l.linkId }))
    .sort((a, b) =>
      a.produtoId === b.produtoId
        ? a.linkId < b.linkId
          ? -1
          : 1
        : a.produtoId < b.produtoId
          ? -1
          : 1,
    )
    .map(({ produtoId, linkId }) =>
      produtoMercadoLivreLinkCollection.docPath({ produtoId }, linkId),
    );
}

/** Every link of X, both ref forms. */
const CAMINHOS_DE_X = caminhosOrdenados(LINKS.filter((l) => l.conta === X));
/**
 * X's links PER STORED REF FORM, each in `__name__` order — what the audit's
 * walk reads, one form after the other (`contaRefForms(X)` order).
 */
const FORMAS_DE_X = contaRefForms(X).map((ref) => ({
  ref,
  caminhos: caminhosOrdenados(LINKS.filter((l) => l.conta === X && l.dados.contaOuterRef === ref)),
}));

/**
 * The most index rows a BOUNDED page may read — summed over every node on the
 * CG index, and as the plan's whole `index row scanned`: EXACTLY the page.
 * Calibrated on the real one-form plans of 2026-10-08 (`__planos__/
 * varredura-uma-forma*.txt`): one `contaOuterRef ==` stream reads the rows it
 * returns (`records scanned` == the page, with and without a cursor, and no
 * extra row for reaching the end of its range).
 */
const LEITURA_MAXIMA_DA_VARREDURA = PAGINA;
/**
 * The seeded link entries that sort BELOW a ref form in the CG index. Plain
 * string order is Firestore's order here: every ref is ASCII, where UTF-16 and
 * UTF-8 order agree.
 */
function abaixoDaForma(ref: string): number {
  return LINKS.filter((l) => {
    const r = l.dados.contaOuterRef;
    return typeof r === 'string' && r < ref;
  }).length;
}
/**
 * The FEWEST rows any failure mode reads on THIS seed, over X's ref forms: a
 * cursor tested per entry reads every one of the form's links to reach its last
 * page, a sort reads every one of them on the first page, and an UNBOUNDED scan
 * (a push-down over a bare `ranges: /`) that stops at its Limit reads
 * everything sorted below the form's first entry plus the page — which is why W
 * is seeded, just below X's lower form (the higher one has every lower-form ref
 * of the seed below it). X2 sorts ABOVE X: a scan that stops at its Limit never
 * reaches it, so it is no witness here. (e) asserts the ceiling sits below this,
 * so a seed or page-size change cannot quietly make the counter check unable to
 * tell a walk from a seek.
 */
const PISO_DAS_FALHAS_DA_VARREDURA = Math.min(
  ...FORMAS_DE_X.map(({ ref, caminhos }) => Math.min(caminhos.length, abaixoDaForma(ref) + PAGINA)),
);

/** What (a) must find and (b) must re-derive, per produto. `null` = clean / not a finding. */
const ESPERADO: Readonly<Record<string, CodigoNaoEnumerado | null>> = {
  [P.derivado]: CODIGO_NAO_ENUMERADO.contaForaDoProduto,
  [P.filho]: CODIGO_NAO_ENUMERADO.linkEmVariacao,
  [P.paiVazio]: CODIGO_NAO_ENUMERADO.paiIdInvalido,
  [P.saudavel]: null,
  [P.soFechado]: null,
  [P.nuncaPublicado]: null,
  [P.orfao]: CODIGO_NAO_ENUMERADO.produtoAusente,
};

/** Ids handed to cleanup BEFORE each write, so a half-done seed is still reclaimed. */
const escritos = { produtos: new Set<string>(), avisos: new Set<string>() };

/* --------------------------------- helpers --------------------------------- */

/** Exclusive upper bound of a prefix range — the last character incremented. */
function fimDoPrefixo(prefixo: string): string {
  return `${prefixo.slice(0, -1)}${String.fromCharCode(prefixo.charCodeAt(prefixo.length - 1) + 1)}`;
}

/**
 * Diagnostic output for the CI log — the plans and the read counters, which are
 * the calibration evidence for `explainPlan.mjs` (`no-console` allows only
 * `console.warn`/`error`, and this is neither).
 */
function relatar(linha: string): void {
  process.stdout.write(`${linha}\n`);
}

/**
 * A verdict in one line: PASS, or FAIL with its codes — then how the plan was
 * bounded, or else which node was judged. ⚠️ `detalhe` is computed BEFORE the
 * residual and sort checks (so on such a FAIL it still describes the bounds, and
 * printed bare it reads like a pass) and is null once a bound or counter check
 * failed — which is not the same as "no node on the index".
 */
function resumoDoVeredicto(v: {
  motivos: readonly { codigo: string }[];
  detalhe: string | null;
  alvo: { identifier: string | null } | null;
}): string {
  const estado =
    v.motivos.length === 0 ? 'PASS' : `FAIL [${v.motivos.map((m) => m.codigo).join(', ')}]`;
  const como =
    v.detalhe ??
    (v.alvo == null
      ? 'no node on the expected index/collection carries a bound'
      : `judged node ${v.alvo.identifier ?? '(no identifier)'}`);
  return `${estado} — ${como}`;
}

/**
 * A failure counter plus the FIRST rejection — `BulkWriter.delete` rejects per
 * document, never per batch, so the count alone would say "something failed"
 * with no cause (a permission or quota failure must be visible).
 */
interface Contagem {
  falhas: number;
  primeiroErro?: unknown;
}

/**
 * Queue one delete on `writer`. A per-document rejection is RECORDED, never
 * swallowed: counted, and the first one kept for the error a failed cleanup
 * throws — the `deleteDocumentSubtree` precedent (packages/data
 * `deleteSubtree.ts`, `firstError ??= err`). It does not rethrow there because
 * a delete promise is not awaited per document; the cleanup's verdict is.
 */
function apagar(writer: BulkWriter, ref: DocumentReference, contagem: Contagem): void {
  writer.delete(ref).catch((err: unknown) => {
    contagem.falhas += 1;
    contagem.primeiroErro ??= err;
  });
}

/** Fold the subtree reports into the shared count, once their writer has closed. */
function somarRelatorios(
  contagem: Contagem,
  relatorios: readonly Awaited<ReturnType<typeof deleteDocumentSubtree>>[],
): void {
  for (const r of relatorios) {
    contagem.falhas += r.failedDeletes;
    if (r.firstError !== undefined) contagem.primeiroErro ??= r.firstError;
  }
}

/** The first recorded rejection, as one log-safe line. */
function descreverErro(err: unknown): string {
  return isGrpcStatusError(err) ? `${err.code} ${err.message}` : String(err);
}

async function contasDo(db: Firestore, produtoId: string): Promise<unknown> {
  const snap = await produtoCollection.docRef(db, {}, produtoId).get();
  return (snap.data() as Record<string, unknown> | undefined)?.integracoesComProduto;
}

async function semearProduto(
  db: Firestore,
  produtoId: string,
  paiId: string | null,
  contas: string[],
): Promise<void> {
  escritos.produtos.add(produtoId);
  // Through the handle's validated `set()`: a COMPLETE produto (schema
  // defaults), so nothing else reading staging's produtos meets a half-shaped
  // one. `nome` carries the run prefix like every other id here.
  await produtoCollection.set(db, {}, produtoId, {
    nome: produtoId,
    paiId,
    integracoesComProduto: contas,
  });
}

/**
 * A per-run uid no operator has: the bell drops a row addressed to somebody
 * else (header, "Safety").
 */
const DESTINATARIO_NENHUM = `${RUN}-ninguem`;
/**
 * `criadoEm` of every seeded OPEN row — early 1973, so they sort LAST under a
 * newest-first read and never displace a real row from its page (header,
 * "Safety"; it does not HIDE them — `destinatarioUid` does). `MICROS_LOWER_BOUND`
 * because it is the smallest number the handle stores verbatim: below it
 * `microsSinceEpoch` reads a number as MILLISECONDS and stores it ×1000 (the
 * `1_000_000` this used to be landed as `1_000_000_000` — measured on staging,
 * 2026-10-09).
 */
const CRIADO_NO_INICIO_DOS_TEMPOS_US = MICROS_LOWER_BOUND;
/**
 * `resolvidoEm` of the RESOLVED witness — a FIXED value (2100-01-01, in µs), so
 * the stale sweep finds a crashed run's witness with one closed point on
 * `avisos(resolvidoEm)`, the `[null]` read's twin, instead of a document-key
 * range (see {@link varrerSobrasAntigas}). In the FUTURE on purpose: the daily
 * retention sweep (`sweepAvisosResolvidos`, apps/functions) deletes a resolved
 * row once `resolvidoEm < now − 90 days`, so a past sentinel would be in its
 * reach mid-run, and (d)/(e) need the witness to exist. Above
 * `MICROS_LOWER_BOUND`, so stored verbatim — (d) asserts it, because the point
 * read finds nothing the moment the handle rewrites it.
 */
const RESOLVIDO_SENTINELA_US = Date.UTC(2100, 0, 1) * 1000;

/**
 * An OPEN aviso row through the handle's validated `set()` — kept out of every
 * operator's bell (header, "Safety"). Never `escreverAviso`: that stamps
 * `criadoEm` now and addresses nobody, which is exactly what the bell shows.
 */
async function semearAvisoAberto(
  db: Firestore,
  chave: string,
  campos: Record<string, unknown>,
): Promise<void> {
  escritos.avisos.add(chave);
  await avisoCollection.set(db, {}, chave, {
    severidade: SEVERIDADE_AVISO.informativo,
    destinatarioUid: DESTINATARIO_NENHUM,
    criadoEm: CRIADO_NO_INICIO_DOS_TEMPOS_US,
    atualizadoEm: CRIADO_NO_INICIO_DOS_TEMPOS_US,
    resolvidoEm: null,
    ...campos,
  });
}

/**
 * An aviso row, already RESOLVED at {@link RESOLVIDO_SENTINELA_US}, through the
 * handle's validated `set()`.
 */
async function semearAvisoResolvido(
  db: Firestore,
  chave: string,
  campos: Record<string, unknown>,
): Promise<void> {
  escritos.avisos.add(chave);
  const agoraUs = Date.now() * 1000;
  await avisoCollection.set(db, {}, chave, {
    severidade: SEVERIDADE_AVISO.informativo,
    criadoEm: agoraUs,
    atualizadoEm: agoraUs,
    resolvidoEm: RESOLVIDO_SENTINELA_US,
    resolucaoMotivo: 'e2e-staging-seed',
    ...campos,
  });
}

/** The aviso fields `planoDoAviso` would write for this produto — minus the key parts. */
function avisoDoPlano(
  conta: string,
  produtoId: string,
  situacao: (typeof SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO)[keyof typeof SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO],
  itemId: string,
): Record<string, unknown> {
  const plano = planoDoAviso(conta, produtoId, situacao, new Set([itemId]));
  return {
    tipo: plano.tipo,
    canal: plano.canal,
    params: plano.params,
    motivo: plano.motivo,
    urlInterna: plano.urlInterna,
  };
}

/* --------------------------- the avisos it seeds --------------------------- */

const TIPO = TIPO_AVISO.anuncioForaDaSincronizacao;
const AVISO = {
  /** X's OPEN row, canal mercadoLivre — one of the two (d) must keep. */
  aberto1: chaveDoAviso(X, P.filho),
  /** X's other OPEN mercadoLivre row. */
  aberto2: chaveDoAviso(X, P.paiVazio),
  /** X's row, canal shopee — the read must project the stored canal. */
  outroCanal: chaveDoAviso(X, P.orfao),
  /** X2's row: X's whole id as a prefix — only the WHOLE conta segment tells them apart. */
  outraConta: chaveDoAviso(X2, P.saudavel),
  /** Same conta and entidade, ANOTHER tipo. */
  outroTipo: chaveDeAviso({
    tipo: TIPO_AVISO.estoqueAcimaDoDisponivel,
    conta: X,
    entidade: P.filho,
  }),
  /** This tipo and canal, no entidade — `<tipo>:X`, an id this producer never writes. */
  semEntidade: chaveDeAviso({ tipo: TIPO, conta: X }),
  /** This tipo and canal, a fourth segment — no `chaveDeAviso` output either. */
  segmentoExtra: `${chaveDoAviso(X, P.filho)}:x`,
  /**
   * X's row of this tipo and canal, RESOLVED: it would be one of X's rows were it
   * open, so the read must not return it — and it is the witness (e)'s floor
   * stands on: a range that runs past `[null]` into the resolved history scans it.
   */
  resolvido: chaveDoAviso(X, P.derivado),
} as const;

/** The rows seeded OPEN — every one of them is in the read's result. */
const AVISOS_ABERTOS: readonly string[] = [
  AVISO.aberto1,
  AVISO.aberto2,
  AVISO.outroCanal,
  AVISO.outraConta,
  AVISO.outroTipo,
  AVISO.semEntidade,
  AVISO.segmentoExtra,
];
/** The rows seeded RESOLVED — none of them is. */
const AVISOS_RESOLVIDOS: readonly string[] = [AVISO.resolvido];

/* ------------------------------ seed + cleanup ----------------------------- */

/** The two tipos this suite seeds — the only avisos its stale sweep may claim. */
const TIPOS_DA_SUITE: readonly string[] = [TIPO, TIPO_AVISO.estoqueAcimaDoDisponivel];

/** An aviso id this SUITE wrote: one of its tipos, then a suite-prefixed conta. */
function ehAvisoDaSuite(chave: string): boolean {
  return TIPOS_DA_SUITE.some((tipo) => chave.startsWith(`${tipo}:${PREFIXO_DA_SUITE}`));
}

/**
 * What the stale sweep reclaims: every produto (the root of its subtree) and
 * every aviso of this suite that `admitir` accepts. Shared by
 * {@link varrerSobrasAntigas} (admitting what is older than
 * {@link IDADE_SOBRA_MS}) and `afterAll` (admitting this run's ids — the check
 * that these reads REACH everything the seed writes: a leftover they cannot
 * reach stays on staging for good).
 *
 * ⚠️ No document-KEY range anywhere, and that is the point of its shape.
 * Neither collection has an index that LEADS with `__key__` (Enterprise creates
 * none), so a key range seeks nothing: the planner scans a whole index and cuts
 * the range in a residual Filter. On the plan proxy (the SDK's pipeline
 * translation, read as `lib/firebase/explainPlan.mjs` reads it) the produtos key
 * range this sweep used to open with read 221 index rows of
 * `produtos(paiId, integracoesComProduto, __key__)` to return 1, and its avisos
 * key ranges read every aviso through `avisos(resolvidoEm)` (staging,
 * 2026-10-09; `__planos__/faixa-de-avisos-por-where.txt` is that avisos shape).
 * Each read here is a closed range or point on a declared index instead, and
 * its proxy plan scanned exactly the rows it returned that same day:
 *  - the PRODUTOS are found through their links: the CG
 *    `produtoMercadoLivre(contaOuterRef, __name__)` index over the suite's
 *    prefix in each ref form (a `• Limit`, no sort). Every produto the seed
 *    writes gets a link under a suite conta, and one subtree delete per produto
 *    takes it, its links and the trigger's history rows together — the links of
 *    a produto document that never existed too. A produto a crash left with no
 *    link yet (the seed's first writes) is the web e2e lanes' `e2e-` sweep's;
 *  - the OPEN avisos ride `avisos(resolvidoEm)` as the `[null]` point — the
 *    audit's own read, keys only — and are kept here by id;
 *  - the RESOLVED witness rides the same index as the
 *    `[RESOLVIDO_SENTINELA_US]` point, which is why it is seeded at that value.
 * A produto is claimed only when its OWN id carries the suite prefix: a suite
 * conta's link under any other produto would be a bug somewhere, never a reason
 * to delete a real produto's subtree on a shared project.
 */
async function encontrarSobras(
  db: Firestore,
  admitir: (snap: QueryDocumentSnapshot) => boolean,
): Promise<{ produtos: DocumentReference[]; avisos: DocumentReference[] }> {
  const produtos = new Map<string, DocumentReference>();
  for (const prefixoRef of contaRefForms(PREFIXO_DA_SUITE)) {
    const links = await produtoMercadoLivreLinkCollection
      .groupQuery(db)
      .where('contaOuterRef', '>=', prefixoRef)
      .where('contaOuterRef', '<', fimDoPrefixo(prefixoRef))
      .select()
      .limit(LIMITE_DE_SOBRAS)
      .get();
    for (const doc of links.docs.filter(admitir)) {
      const produtoId = doc.ref.parent.parent?.id;
      if (produtoId == null || !produtoId.startsWith(PREFIXO_DA_SUITE)) continue;
      produtos.set(produtoId, produtoCollection.docRef(db, {}, produtoId));
    }
  }
  const avisos: DocumentReference[] = [];
  const pontos: readonly { resolvidoEm: number | null; limite: number }[] = [
    // The whole bell, keys only — capped where the audit caps the same read.
    { resolvidoEm: null, limite: AVISOS_ABERTOS_MAX + 1 },
    { resolvidoEm: RESOLVIDO_SENTINELA_US, limite: LIMITE_DE_SOBRAS },
  ];
  for (const { resolvidoEm, limite } of pontos) {
    const snap = await avisoCollection
      .ref(db, {})
      .where('resolvidoEm', '==', resolvidoEm)
      .select()
      .limit(limite)
      .get();
    for (const doc of snap.docs) {
      if (ehAvisoDaSuite(doc.id) && admitir(doc)) avisos.push(doc.ref);
    }
  }
  return { produtos: [...produtos.values()], avisos };
}

/**
 * Reclaim THIS suite's leftovers from a crashed run — anything under
 * {@link PREFIXO_DA_SUITE} older than {@link IDADE_SOBRA_MS}, so a concurrent
 * live run is never touched — found by {@link encontrarSobras}, whose every read
 * is bounded. Best-effort: it logs and moves on; the verified cleanup is
 * `afterAll`'s.
 */
async function varrerSobrasAntigas(db: Firestore): Promise<number> {
  const corte = Date.now() - IDADE_SOBRA_MS;
  const velho = (snap: QueryDocumentSnapshot): boolean => snap.createTime.toMillis() < corte;
  const writer = db.bulkWriter();
  const contagem: Contagem = { falhas: 0 };
  const relatorios: Awaited<ReturnType<typeof deleteDocumentSubtree>>[] = [];
  let removidos = 0;
  try {
    const { produtos, avisos } = await encontrarSobras(db, velho);
    for (const produto of produtos) {
      const relatorio = await deleteDocumentSubtree(db, produto, { writer });
      relatorios.push(relatorio);
      removidos += relatorio.documentsDeleted;
    }
    for (const aviso of avisos) {
      apagar(writer, aviso, contagem);
      removidos += 1;
    }
  } finally {
    await writer.close();
  }
  // Only final now: the subtree reports count failures their (shared) writer
  // settled during `close()`.
  somarRelatorios(contagem, relatorios);
  if (contagem.falhas > 0) {
    relatar(
      `[staging] stale sweep: ${contagem.falhas} delete(s) failed — the next run retries; ` +
        `first: ${descreverErro(contagem.primeiroErro)}`,
    );
  }
  return removidos;
}

async function semear(db: Firestore): Promise<{ gatilhoObservado: boolean }> {
  await semearProduto(db, P.derivado, null, [OUTRA]);
  await semearProduto(db, P.filho, PAI, []);
  await semearProduto(db, P.paiVazio, '', [X]);
  await semearProduto(db, P.saudavel, null, [X]);
  await semearProduto(db, P.soFechado, null, [OUTRA]);
  await semearProduto(db, P.nuncaPublicado, null, []);
  // The orphan's id joins cleanup although no produto doc is written: its link
  // subcollection hangs under a missing parent, which `deleteDocumentSubtree`
  // reaches through `listCollections()`. W's produto is the same shape.
  escritos.produtos.add(P.orfao);
  escritos.produtos.add(PRODUTO_DO_VIZINHO);

  for (const l of LINKS) {
    await produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: l.produtoId }, l.linkId)
      .set(l.dados);
  }

  // The deployed link trigger: wait for its heal on the drifted produto, then
  // undo it (see the header). A produto write does not re-fire a LINK trigger.
  const limite = Date.now() + ESPERA_GATILHO_MS;
  let gatilhoObservado = false;
  while (Date.now() < limite) {
    const contas = await contasDo(db, P.derivado);
    if (Array.isArray(contas) && contas.includes(X)) {
      gatilhoObservado = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await produtoCollection.merge(db, {}, P.derivado, { integracoesComProduto: [OUTRA] });

  await semearAvisoAberto(
    db,
    AVISO.aberto1,
    avisoDoPlano(X, P.filho, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao, 'MLB-B'),
  );
  await semearAvisoAberto(
    db,
    AVISO.aberto2,
    avisoDoPlano(X, P.paiVazio, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.paiIdInvalido, 'MLB-C'),
  );
  await semearAvisoAberto(db, AVISO.outroCanal, {
    ...avisoDoPlano(X, P.orfao, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente, 'MLB-O'),
    canal: CANAL_AVISO.shopee,
  });
  await semearAvisoAberto(
    db,
    AVISO.outraConta,
    avisoDoPlano(X2, P.saudavel, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao, 'MLB-H2'),
  );
  await semearAvisoAberto(db, AVISO.outroTipo, {
    tipo: TIPO_AVISO.estoqueAcimaDoDisponivel,
    canal: CANAL_AVISO.mercadoLivre,
  });
  for (const chave of [AVISO.semEntidade, AVISO.segmentoExtra]) {
    await semearAvisoAberto(db, chave, { tipo: TIPO, canal: CANAL_AVISO.mercadoLivre });
  }
  await semearAvisoResolvido(
    db,
    AVISO.resolvido,
    avisoDoPlano(X, P.derivado, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao, 'MLB-A'),
  );

  return { gatilhoObservado };
}

/** Everything still standing after cleanup — empty when clean. */
async function sobras(db: Firestore): Promise<string[]> {
  const restos: string[] = [];
  for (const id of escritos.produtos) {
    const ref = produtoCollection.docRef(db, {}, id);
    if ((await ref.get()).exists) restos.push(ref.path);
    for (const col of await ref.listCollections()) {
      const um = await col.select().limit(1).get();
      if (!um.empty) restos.push(`${col.path}/…`);
    }
  }
  const links = await produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('contaOuterRef', 'in', [...contaRefForms(X), ...contaRefForms(X2), ...contaRefForms(W)])
    .select()
    .get();
  restos.push(...links.docs.map((d) => d.ref.path));
  for (const chave of escritos.avisos) {
    if ((await avisoCollection.docRef(db, {}, chave).get()).exists) restos.push(`avisos/${chave}`);
  }
  return restos;
}

async function limpar(db: Firestore): Promise<void> {
  const writer = db.bulkWriter();
  const contagem: Contagem = { falhas: 0 };
  const relatorios: Awaited<ReturnType<typeof deleteDocumentSubtree>>[] = [];
  try {
    for (const id of escritos.produtos) {
      relatorios.push(
        await deleteDocumentSubtree(db, produtoCollection.docRef(db, {}, id), { writer }),
      );
    }
    for (const chave of escritos.avisos) {
      apagar(writer, avisoCollection.docRef(db, {}, chave), contagem);
    }
  } finally {
    // Every queued delete settles here — the subtree reports' failure counts are
    // only final once the shared writer has closed.
    await writer.close();
  }
  somarRelatorios(contagem, relatorios);
  if (contagem.falhas > 0) {
    throw new Error(
      `staging cleanup: ${contagem.falhas} delete(s) failed under ${RUN} — first: ` +
        descreverErro(contagem.primeiroErro),
      { cause: contagem.primeiroErro },
    );
  }
}

/* ------------------------------- the explains ------------------------------ */

type IndicesUsados = Parameters<typeof classicoServeVarredura>[0];

/**
 * The classic explain, or `null` when Enterprise refuses it (the documented
 * refusal — a statement about the API, never about the index). Any other error
 * rethrows (rule 6).
 */
async function explainClassico(consulta: FirebaseFirestore.Query): Promise<IndicesUsados | null> {
  try {
    const { metrics } = await consulta.explain({ analyze: true });
    return (metrics.planSummary.indexesUsed ?? []) as IndicesUsados;
  } catch (err) {
    if (
      isGrpcStatusError(err) &&
      err.code === 3 &&
      RECUSA_EXPLAIN_ENTERPRISE_RE.test(err.message)
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Explain-analyze the PROXY of a classic query: the SDK's own pipeline
 * translation (`createFrom`) of the production builder's PROJECTION-LESS half
 * (`consultaDaVarreduraSemProjecao` / `consultaDosAvisosAbertosSemProjecao`) —
 * never a hand-built pipeline, so the predicate, order, page size and cursor
 * judged are the ones production runs. Returns the document path of every row
 * (so a case can hold them against the production query's own page) and the
 * printed plan text.
 *
 * ⚠️ Never the production object itself: `createFrom` emits its `select` BEFORE
 * the `exists(__name__)` / `sort(__name__)` stages it derives from the order,
 * the projection drops the key, and the pipeline returns zero rows and no
 * `explainStats` (staging, 2026-10-08 — the docblock of
 * `consultaDaVarreduraSemProjecao` has the stage list). That is why this FAILS
 * on zero rows or a missing plan rather than handing a case an empty string:
 * either is that quirk come back, or a predicate that matches nothing, and a
 * verdict over no plan proves nothing.
 */
async function explainProxy(
  db: Firestore,
  consulta: FirebaseFirestore.Query,
): Promise<{ caminhos: string[]; plano: string }> {
  const snap = await db
    .pipeline()
    .createFrom(consulta)
    .execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
  expect(
    snap.results.length,
    'the PROXY returned ZERO rows — if the explained query carries a select(), createFrom ' +
      'dropped the document key before its own exists(__name__)/sort(__name__) stages; explain ' +
      'the …SemProjecao builder instead',
  ).toBeGreaterThan(0);
  const plano = snap.explainStats?.text ?? '';
  expect(plano.trim(), 'the PROXY returned no explainStats plan text').not.toBe('');
  return { caminhos: snap.results.map((r) => r.ref?.path ?? '(no ref)'), plano };
}

/* ---------------------------------- suite ---------------------------------- */

describe.skipIf(!STAGING)('the #1200 link audit on the real staging Firestore (Enterprise)', () => {
  let db: Firestore;
  let gatilhoObservado = false;
  /** The seed finished — only then must the stale sweep's reads reach all of it. */
  let semeado = false;
  /** (a)'s outcome, for (b) to agree with. */
  let achadosDaVarredura: LinkNaoEnumerado[] | null = null;
  let limposDaVarredura: string[] | null = null;

  beforeAll(async () => {
    db = getAdminFirestore();
    const reclamados = await varrerSobrasAntigas(db);
    if (reclamados > 0)
      relatar(`[staging] reclaimed ${reclamados} stale doc(s) under ${PREFIXO_DA_SUITE}`);
    ({ gatilhoObservado } = await semear(db));
    semeado = true;
    relatar(
      `[staging] run ${RUN} seeded; deployed link trigger ${gatilhoObservado ? 'observed and undone' : `not observed within ${ESPERA_GATILHO_MS / 1000}s`}`,
    );
    // POSITIVE existence: a mis-targeted database would make every later
    // "absent"/"empty" assertion pass for the wrong reason.
    expect((await produtoCollection.docRef(db, {}, P.saudavel).get()).exists).toBe(true);
  });

  afterAll(async () => {
    if (db == null) return;
    // What the stale sweep's reads reach of THIS run — read before the cleanup
    // deletes it, judged after, so a failed read or check never skips the
    // cleanup. Whatever they cannot reach, a crashed run would leave for good.
    let alcancados: Awaited<ReturnType<typeof encontrarSobras>> | null = null;
    try {
      if (semeado) alcancados = await encontrarSobras(db, (snap) => snap.ref.path.includes(RUN));
    } finally {
      await limpar(db);
    }
    let restos = await sobras(db);
    if (restos.length > 0) {
      // A deployed trigger can still be landing (the delete cascade, a late
      // history row); one more pass, then the verdict.
      await new Promise((r) => setTimeout(r, 3_000));
      await limpar(db);
      restos = await sobras(db);
    }
    expect(restos, `staging cleanup left documents behind under ${RUN}`).toEqual([]);
    if (alcancados != null) {
      expect(
        alcancados.produtos.map((ref) => ref.id).sort(),
        'the stale sweep cannot reach every produto this run seeded — a crashed run would leave ' +
          'the rest on staging (every seeded produto must hang a link under a suite conta)',
      ).toEqual([...escritos.produtos].sort());
      expect(
        alcancados.avisos.map((ref) => ref.id).sort(),
        'the stale sweep cannot reach every aviso this run seeded — open rows ride [null], the ' +
          'resolved witness [RESOLVIDO_SENTINELA_US]',
      ).toEqual([...escritos.avisos].sort());
    }
  });

  /** The drift (a) and (c) depend on, re-read NOW — and said plainly if it is gone. */
  async function exigirDeriva(): Promise<void> {
    expect(
      await contasDo(db, P.derivado),
      `${P.derivado}.integracoesComProduto no longer reads [${OUTRA}] — something rewrote it ` +
        'after the seed reset it (most likely the deployed onProdutoMercadoLivreLinkChanged ' +
        `trigger arriving later than the ${ESPERA_GATILHO_MS / 1000}s the seed waited). The ` +
        'class-2 precondition is gone, so this case would prove nothing.',
    ).toEqual([OUTRA]);
  }

  it('(a) drains the audit’s walk — one ref form at a time — over real cursors: every link exactly once, every finding classified', async () => {
    await exigirDeriva();

    const paginas: LinksNaoEnumeradosPage[] = [];
    for (const { ref, caminhos } of FORMAS_DE_X) {
      // Each form from ITS first page: a cursor belongs to the form that made it.
      const daForma: LinksNaoEnumeradosPage[] = [];
      let apos: string | null = null;
      for (let i = 0; i < 20; i += 1) {
        const pagina = await fetchLinksNaoEnumeradosPage(db, {
          integracaoId: X,
          contaRef: ref,
          pageLimit: PAGINA,
          afterLinkPath: apos,
        });
        daForma.push(pagina);
        if (pagina.nextAfterLinkPath == null) break;
        apos = pagina.nextAfterLinkPath;
      }
      // The cursors are this form's own sorted paths at every PAGINA-th step — the
      // walk resumed exactly after each REAL DocumentReference, never from the top,
      // and never into the other form's links.
      expect(
        daForma.map((p) => p.nextAfterLinkPath).filter((c) => c != null),
        `${ref}: the cursors`,
      ).toEqual(caminhos.filter((_, i) => (i + 1) % PAGINA === 0));
      // 4 links at 2 a page: two FULL pages, then the empty one that drains.
      expect(
        daForma.map((p) => p.lidos),
        `${ref}: links read per page`,
      ).toEqual([2, 2, 0]);
      paginas.push(...daForma);
    }

    const lidos = paginas.reduce((s, p) => s + p.lidos, 0);
    // EXACTLY the seeded count: fewer is a skipped page, more a repeated one —
    // or another conta's link (X2's sits on the same produto) admitted by `==`.
    expect(lidos, 'links read across the whole walk').toBe(CAMINHOS_DE_X.length);
    // The noise guard: the closed and never-published links are read, not inspected.
    expect(paginas.reduce((s, p) => s + p.inspecionados, 0)).toBe(5);
    expect(paginas.reduce((s, p) => s + p.produtosLidos, 0)).toBe(5);

    const achados = paginas
      .flatMap((p) => p.naoEnumerados)
      .sort((a, b) => (a.produtoId < b.produtoId ? -1 : 1));
    expect(achados).toEqual([
      { produtoId: P.derivado, itemId: 'MLB-A', code: CODIGO_NAO_ENUMERADO.contaForaDoProduto },
      { produtoId: P.filho, itemId: 'MLB-B', code: CODIGO_NAO_ENUMERADO.linkEmVariacao },
      { produtoId: P.paiVazio, itemId: 'MLB-C', code: CODIGO_NAO_ENUMERADO.paiIdInvalido },
      { produtoId: P.orfao, itemId: 'MLB-O', code: CODIGO_NAO_ENUMERADO.produtoAusente },
    ]);
    const limpos = paginas.flatMap((p) => p.limpos);
    expect(limpos, 'the healthy anchor is the walk’s only clean produto').toEqual([P.saudavel]);

    achadosDaVarredura = achados;
    limposDaVarredura = limpos;
  });

  it('(b) the pre-resolve re-read agrees with the walk, produto by produto', async () => {
    await exigirDeriva();

    const relidos: Record<string, CodigoNaoEnumerado | null> = {};
    for (const produtoId of Object.keys(ESPERADO)) {
      relidos[produtoId] = await reclassificarProdutoNaoEnumerado(db, produtoId, X);
    }
    expect(relidos).toEqual(ESPERADO);

    // And with (a)'s OWN output, when (a) ran: same code for every finding,
    // null for every clean produto.
    if (achadosDaVarredura != null && limposDaVarredura != null) {
      for (const achado of achadosDaVarredura) expect(relidos[achado.produtoId]).toBe(achado.code);
      for (const limpo of limposDaVarredura) expect(relidos[limpo]).toBeNull();
    }
  });

  it('(c) the tier-1 heal on a real transaction: adds the conta keeping the array, refuses a closed-only produto without writing, never resurrects', async () => {
    await exigirDeriva();

    expect(await adicionarContaSeViva(db, P.derivado, X)).toBe(true);
    expect(await contasDo(db, P.derivado), 'healed — and the other conta’s entry kept').toEqual([
      OUTRA,
      X,
    ]);

    const antes = await produtoCollection.docRef(db, {}, P.soFechado).get();
    expect(await adicionarContaSeViva(db, P.soFechado, X)).toBe(false);
    const depois = await produtoCollection.docRef(db, {}, P.soFechado).get();
    expect(depois.get('integracoesComProduto')).toEqual([OUTRA]);
    expect(
      depois.updateTime?.isEqual(antes.updateTime!),
      'a refused heal must not write at all — the produto’s updateTime moved',
    ).toBe(true);

    // The orphan's link is live, so the survivor read says yes — and the commit
    // must still fail NOT_FOUND rather than create a one-field husk.
    expect(await adicionarContaSeViva(db, P.orfao, X)).toBe(false);
    expect((await produtoCollection.docRef(db, {}, P.orfao).get()).exists).toBe(false);
  });

  it('(d) the open-avisos read on real docs: every OPEN row, never a resolved one — and the in-memory filter keeps exactly X’s', async () => {
    // The production read, whole: staging's entire bell, every tipo and canal.
    const { linhas, truncada } = await listarAvisosAbertos(db);
    expect(truncada, 'staging holds more open avisos than AVISOS_ABERTOS_MAX').toBe(false);

    // This run's rows only — the rest of the bell is not this suite's.
    const daRodada = linhas.filter((l) => l.chave.includes(RUN));
    expect(daRodada.map((l) => l.chave).sort()).toEqual([...AVISOS_ABERTOS].sort());
    // The read PROJECTS what the audit decides on — the stored canal and tipo.
    expect(daRodada.find((l) => l.chave === AVISO.outroCanal)).toMatchObject({
      tipo: TIPO,
      canal: CANAL_AVISO.shopee,
    });
    expect(daRodada.find((l) => l.chave === AVISO.outroTipo)).toMatchObject({
      tipo: TIPO_AVISO.estoqueAcimaDoDisponivel,
      canal: CANAL_AVISO.mercadoLivre,
    });

    // The audit's in-memory filter over the real rows. Sorted before comparing:
    // with no `orderBy` the Enterprise read promises NO order — and gives none
    // (2026-10-09: X's two rows came back out of key order) — which the audit
    // never needs.
    const { doProdutor, foraDoFormato } = classificarAvisosAbertos(daRodada);
    expect([...avisosDaConta(doProdutor, X)].sort((a, b) => (a.chave < b.chave ? -1 : 1))).toEqual([
      {
        chave: AVISO.aberto1,
        prefixo: chaveDeAviso({ tipo: TIPO, conta: X }),
        produtoId: P.filho,
        params: {
          situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao,
          anuncio: 'MLB-B',
          anuncios: 1,
        },
      },
      {
        chave: AVISO.aberto2,
        prefixo: chaveDeAviso({ tipo: TIPO, conta: X }),
        produtoId: P.paiVazio,
        params: {
          situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.paiIdInvalido,
          anuncio: 'MLB-C',
          anuncios: 1,
        },
      },
    ]);
    expect(avisosDaConta(doProdutor, X2).map((a) => a.chave)).toEqual([AVISO.outraConta]);
    expect([...foraDoFormato].sort()).toEqual([AVISO.semEntidade, AVISO.segmentoExtra].sort());

    // The rows left out EXIST — otherwise their absence above proves nothing.
    for (const chave of AVISOS_RESOLVIDOS) {
      const snap = await avisoCollection.docRef(db, {}, chave).get();
      expect(snap.exists, chave).toBe(true);
      // Resolved — and at the sentinel EXACTLY: the stale sweep finds a crashed
      // run's witness by that one point, so a handle that rewrote the value
      // would leak every witness silently.
      expect(snap.get('resolvidoEm'), `${chave}: resolved at RESOLVIDO_SENTINELA_US`).toBe(
        RESOLVIDO_SENTINELA_US,
      );
    }
  });

  it('(e) PLAN — every page of the walk, in each ref form, rides the COLLECTION_GROUP produtoMercadoLivre(contaOuterRef, __name__) index as one bounded, seeking, unsorted stream', async () => {
    // Anti-vacuity: a ceiling at or above what a failure reads proves nothing.
    expect(
      LEITURA_MAXIMA_DA_VARREDURA,
      'the read ceiling must sit below what a non-seeking cursor, a sort or an unbounded scan ' +
        'reads on this seed — re-derive it (or seed more links) after changing PAGINA or LINKS',
    ).toBeLessThan(PISO_DAS_FALHAS_DA_VARREDURA);
    // …and the witness below X's lower form the floor counts is really seeded.
    expect(
      Math.min(...FORMAS_DE_X.map(({ ref }) => abaixoDaForma(ref))),
      'no seeded link sorts below X’s lower ref form — W is gone from LINKS',
    ).toBeGreaterThan(0);

    /**
     * Judge ONE page of the audit's walk — the production query object and its
     * projection-less proxy — and return its motivo CODES, labelled (the full
     * messages go to the CI log). Every page is judged (and printed) before the
     * case asserts, so a failure on one never hides another's plan.
     *
     * The FIRST page (no cursor) and the LAST (the cursor leaving exactly
     * {@link PAGINA} links of the form after it), because the two failure modes
     * a counter can see cost most at opposite ends: a page whose stage SORTS
     * reads every link of the form before its limit — on the last page that is
     * just the page — and a cursor tested entry by entry re-reads every earlier
     * link of the form first.
     */
    const julgarPagina = async (
      rotulo: string,
      contaRef: string,
      afterLinkPath: string | null,
      esperado: readonly string[],
    ): Promise<string[]> => {
      const pagina = { integracaoId: X, contaRef, pageLimit: PAGINA, afterLinkPath };
      const consulta = consultaDaVarredura(db, pagina);

      // Classic first. Enterprise refuses it today; the day it does not, its
      // real plan is the better evidence.
      const usados = await explainClassico(consulta);
      if (usados != null) {
        expect(
          classicoServeVarredura(usados),
          `${rotulo}: classic plan rides ${JSON.stringify(usados)}, not COLLECTION_GROUP (contaOuterRef ASC, __name__ ASC)`,
        ).toBe(true);
      }

      // The proxy explains the SAME page minus its projection (see explainProxy).
      const { caminhos, plano } = await explainProxy(
        db,
        consultaDaVarreduraSemProjecao(db, pagina),
      );
      relatar(
        `\n----- walk, ${rotulo} — PROXY plan (createFrom of the walk's query, no select) -----\n${plano}`,
      );
      // …and that page is the production query's own: the same rows in the
      // same order, derived from the seed.
      const producao = (await consulta.get()).docs.map((d) => d.ref.path);
      expect(producao, `the production query’s ${rotulo}`).toEqual(esperado);
      expect(caminhos, `${rotulo}: the proxy read a different page than production`).toEqual(
        producao,
      );

      // Bounded on the conta, seeking the cursor, unsorted — by the plan's
      // range tree, and within the ceiling by its read counters
      // (explainPlan.mjs). A push-down alone, or a cursor tested per entry,
      // prints the same lines as the walk of every conta / the quadratic walk,
      // so neither passes on shape; a sort fails whatever the counters say.
      const veredicto = julgarPlanoDaVarredura(plano, {
        comCursor: afterLinkPath != null,
        leituraMaxima: LEITURA_MAXIMA_DA_VARREDURA,
      });
      relatar(
        `[staging] walk verdict, ${rotulo}: ${resumoDoVeredicto(veredicto)} — read counters ` +
          `${JSON.stringify(veredicto.leitura)}, whole query ${veredicto.leituraTotal}, ` +
          `ceiling ${LEITURA_MAXIMA_DA_VARREDURA}`,
      );
      for (const m of veredicto.motivos) relatar(`  ${rotulo} — [${m.codigo}] ${m.mensagem}`);
      return veredicto.motivos.map((m) => `${rotulo} — ${m.codigo}`);
    };

    const codigos: string[] = [];
    for (const [i, { ref, caminhos }] of FORMAS_DE_X.entries()) {
      codigos.push(
        ...(await julgarPagina(`form ${i}, first page`, ref, null, caminhos.slice(0, PAGINA))),
        ...(await julgarPagina(
          `form ${i}, last page`,
          ref,
          caminhos[caminhos.length - PAGINA - 1]!,
          caminhos.slice(-PAGINA),
        )),
      );
    }
    expect(
      codigos,
      'a walk page’s proxy plan failed its verdict — read the plans printed above',
    ).toEqual([]);
  });

  it('(e) PLAN — the open-avisos read rides avisos(resolvidoEm) as the closed [null] point range and scans exactly the rows it returns', async () => {
    // The audit's very query object — its cap and projection included.
    const consulta = consultaDosAvisosAbertos(db);

    const usados = await explainClassico(consulta);
    if (usados != null) {
      expect(
        classicoServeAvisosAbertos(usados),
        `classic plan rides ${JSON.stringify(usados)}, not (resolvidoEm ASC, __name__ ASC)`,
      ).toBe(true);
    }

    // The proxy explains the SAME read minus its projection (see explainProxy).
    const { caminhos, plano } = await explainProxy(db, consultaDosAvisosAbertosSemProjecao(db));
    relatar(
      `\n----- open avisos — PROXY plan (createFrom of the audit's read, no select) -----\n${plano}`,
    );
    // It is the production read's result: this run's OPEN rows, never its
    // resolved one — compared on this run's ids only, because the rest of
    // staging's bell may move between two reads.
    const daRodada = (caminhosLidos: readonly string[]) =>
      caminhosLidos.filter((c) => c.includes(RUN)).sort();
    const caminhoDe = (chave: string) => avisoCollection.docRef(db, {}, chave).path;
    expect(daRodada(caminhos), 'the proxy read the wrong rows').toEqual(
      AVISOS_ABERTOS.map(caminhoDe).sort(),
    );
    expect(
      daRodada((await consulta.get()).docs.map((d) => d.ref.path)),
      'the proxy read different rows than the production query',
    ).toEqual(daRodada(caminhos));

    // The ceiling is the rows the proxy RETURNED: a bounded read scans exactly
    // those. Anti-vacuity: an unbounded or half-open scan of avisos(resolvidoEm)
    // also reads every RESOLVED aviso after the [null] run — so the ceiling
    // proves something only while at least one such row exists, sits in that
    // index (a numeric resolvidoEm) and is NOT among the rows returned.
    const teto = caminhos.length;
    expect(
      AVISOS_RESOLVIDOS.length,
      'no RESOLVED aviso is seeded — nothing would tell the [null] run from a walk of the index',
    ).toBeGreaterThan(0);
    for (const chave of AVISOS_RESOLVIDOS) {
      const snap = await avisoCollection.docRef(db, {}, chave).get();
      expect(typeof snap.get('resolvidoEm'), `${chave}: a resolved row in the index`).toBe(
        'number',
      );
      expect(daRodada(caminhos)).not.toContain(caminhoDe(chave));
    }

    const veredicto = julgarPlanoDosAvisosAbertos(plano, { leituraMaxima: teto });
    relatar(
      `[staging] open-avisos verdict: ${resumoDoVeredicto(veredicto)} — read counters ` +
        `${JSON.stringify(veredicto.leitura)}, whole query ${veredicto.leituraTotal}, ` +
        `ceiling ${teto} (rows returned)`,
    );
    for (const m of veredicto.motivos) relatar(`  open avisos — [${m.codigo}] ${m.mensagem}`);
    expect(
      veredicto.motivos.map((m) => m.codigo),
      'the open-avisos proxy plan failed its verdict — read the plan printed above',
    ).toEqual([]);
    // The counter itself, not just "within": the scan read EXACTLY what it returned.
    expect(veredicto.leitura?.valor, 'index rows scanned by the judged node(s)').toBe(teto);
  });
});
