/**
 * The monthly link audit's Firestore half (#1200) against the REAL staging
 * database — **Enterprise** edition — run by `ML staging Enterprise queries` in
 * ci-mercado-livre.yml (`test:staging`, vitest.staging.config.ts).
 *
 * Why it exists: before this suite none of the audit's queries had ever run on
 * Enterprise. The offline suite fakes Firestore; the emulator suite
 * (`auditoriaNaoEnumerados.firestore.test.ts`) runs the STANDARD-edition
 * emulator, which auto-creates every index; and Enterprise refuses classic
 * `explain()`, so the plans of the two new classic queries — the
 * collection-group walk and the avisos key range — were never observed. On
 * Enterprise a missing index does not fail: it full-scans and bills the scan.
 *
 * What it proves, each case red if the behaviour breaks:
 *  (a) the conta-bounded walk over REAL `DocumentReference` keyset cursors,
 *      drained at `pageLimit: 2`, reads every seeded link exactly once (sum of
 *      `lidos` == seeded count, cursors == the independently sorted paths) and
 *      classifies every finding, `limpos` included;
 *  (b) the pre-resolve re-read agrees with (a), produto by produto;
 *  (c) the tier-1 heal really adds the conta on a real transaction KEEPING the
 *      array's other entry, refuses a produto with only a closed link without
 *      writing, and never resurrects a missing produto;
 *  (d) the avisos key range on real ids: exactly this conta's rows — not a
 *      prefix-sharing conta's, not the raw range-end id, not another tipo's,
 *      not the near-misses seeded on either side of the range;
 *  (e) PLAN + COST: the SDK's own pipeline translation (`createFrom`) of the
 *      walk's LAST page rides the COLLECTION_GROUP
 *      `produtoMercadoLivre(contaOuterRef, __name__)` index bounded on
 *      `contaOuterRef` and SEEKING its cursor, and that of the avisos range is a
 *      key scan closed at both ends — each proven by the plan's range lines, or
 *      else by its read counters under a ceiling this seed's failure modes
 *      provably exceed (a push-down or a per-entry cursor prints the same lines
 *      as the walk it must rule out). Judged by the SAME
 *      `lib/firebase/explainPlan.mjs` verdicts the manual
 *      `scripts/check-stock-indexes.mjs` gate uses.
 *
 * ---- Safety and isolation, because this writes to a shared project:
 *  - every id it writes carries this run's prefix `e2e-ml1200-<8 hex>`, so two
 *    runs (CI push + PR, two developers) never see each other's rows — the walk
 *    and the key range are both bounded by a per-run conta id;
 *  - it NEVER creates an `integracao` doc: the conta id is a bare string in
 *    `contaOuterRef` and the aviso keys. An active ML integração would be picked
 *    up by the real stock and price sweeps on staging;
 *  - it NEVER calls `runAuditoriaNaoEnumerados`, which enumerates every real
 *    staging conta and resolves tipo-wide — only the scoped primitives;
 *  - its avisos are seeded already RESOLVED (`resolvidoEm` set), so the bell
 *    (`resolvidoEm == null`) never shows them;
 *  - `afterAll` deletes every produto SUBTREE it wrote (links, and the
 *    `historicoDeModificacoes` rows the deployed `onProdutoChanged` adds) plus
 *    every aviso, then VERIFIES the deletion and fails the suite if anything is
 *    left; `beforeAll` first reclaims this suite's own leftovers older than
 *    {@link IDADE_SOBRA_MS} from a crashed run. The `e2e-` prefix also puts its
 *    produtos in reach of the web e2e lanes' age-gated stale sweep.
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
import {
  type BulkWriter,
  type DocumentReference,
  FieldPath,
  type Firestore,
} from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  classicoServeFaixa,
  classicoServeVarredura,
  julgarPlanoDaFaixaDeAvisos,
  julgarPlanoDaVarredura,
} from '@/lib/firebase/explainPlan.mjs';
import { STAGING } from '@/vitest.staging.setup';

import { adicionarContaSeViva, contaRefForms } from '../anuncios/integracoesComProduto';
import {
  CODIGO_NAO_ENUMERADO,
  type CodigoNaoEnumerado,
  type LinkNaoEnumerado,
  type LinksNaoEnumeradosPage,
  consultaDaVarredura,
  fetchLinksNaoEnumeradosPage,
  reclassificarProdutoNaoEnumerado,
} from '../anuncios/linksNaoEnumerados';
import {
  chaveDoAviso,
  consultaDaFaixaDeChaves,
  faixaDeChavesDaConta,
  listarAvisosDaConta,
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
 * At most this many leftover produtos per stale sweep — a run leaves seven, so
 * one pass reclaims several crashed runs and the next run picks up the rest,
 * while the sweep stays well inside `beforeAll`'s hook timeout.
 */
const LIMITE_DE_SOBRAS = 50;
/** How long the seed waits for the deployed link trigger's heal to land. */
const ESPERA_GATILHO_MS = 30_000;
/** The walk's page size here — small, so every drain crosses several cursors. */
const PAGINA = 2;

/** The synthetic conta. No `integracao` doc ever exists for it. */
const X = `${RUN}-x`;
/** Shares X's WHOLE id as a prefix — the key range's and the `in` filter's near-miss. */
const X2 = `${X}2`;
/** The other conta the drifted produto's array already carries. */
const OUTRA = `${RUN}-outra`;
/** `paiId` of the variation child — a parent that is never created. */
const PAI = `${RUN}-pai`;

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
  // X2's live link sits on the SAME produto: the `in` must not admit it into X's walk.
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
];

/** X's links in `__name__` order — derived from the seed, never read back. */
const CAMINHOS_DE_X = LINKS.filter((l) => l.conta === X)
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
  .map(({ produtoId, linkId }) => produtoMercadoLivreLinkCollection.docPath({ produtoId }, linkId));

/**
 * (e)'s walk probe: the cursor that leaves exactly {@link PAGINA} of X's links
 * after it — the LAST page, where the cursor sits deepest in the conta. A page
 * that SEEKS its cursor reads only what follows it; one that tests the cursor
 * entry by entry re-reads every earlier link of the conta first (the quadratic
 * walk), and a late page is where that difference is widest.
 */
const CURSOR_TARDIO = CAMINHOS_DE_X[CAMINHOS_DE_X.length - PAGINA - 1]!;
/**
 * The most index entries that late page may read when it is BOUNDED, summed
 * over every node on the CG index: its {@link PAGINA} rows plus, per `in` value
 * (each may run as its own stream), one buffered head and one end-of-range probe.
 */
const LEITURA_MAXIMA_DA_VARREDURA = PAGINA + 2 * contaRefForms(X).length;
/**
 * The FEWEST entries either failure mode reads on THIS seed: a cursor tested per
 * entry reads every one of X's links to reach the last page, and a walk of the
 * whole index reads at least X's and X2's. (e) asserts the ceiling sits below
 * it, so a seed or page-size change cannot quietly make the counter check
 * unable to tell a walk from a seek.
 */
const PISO_DAS_FALHAS_DA_VARREDURA = Math.min(CAMINHOS_DE_X.length, LINKS.length);

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
 * An aviso row, already RESOLVED, through the handle's validated `set()`.
 * Never `escreverAviso`: that creates an OPEN row the staging bell would show.
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
    resolvidoEm: agoraUs,
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
  /** X's row, canal mercadoLivre. */
  x1: chaveDoAviso(X, P.filho),
  /** X's row, canal shopee — the projection must carry the stored canal. */
  x2: chaveDoAviso(X, P.orfao),
  /** X2's row: `<tipo>:X2:…` sorts BELOW the range start only thanks to its `:`. */
  x2conta: chaveDoAviso(X2, P.saudavel),
  /** The range END itself, `<tipo>:X;` — a legal id that is NOT one of X's rows. */
  fim: `${chaveDeAviso({ tipo: TIPO, conta: X })};`,
  /** Just ABOVE the range end (`~` sorts after `;`), still below every other tipo. */
  acimaDoFim: `${chaveDeAviso({ tipo: TIPO, conta: X })};~`,
  /** The bare prefix `<tipo>:X` — just below the range start. */
  semEntidade: chaveDeAviso({ tipo: TIPO, conta: X }),
  /** `<tipo>:X-` — between the bare prefix and the range start (`-` sorts before `:`). */
  abaixoDoInicio: `${chaveDeAviso({ tipo: TIPO, conta: X })}-`,
  /** Same conta and entidade, ANOTHER tipo. */
  outroTipo: chaveDeAviso({
    tipo: TIPO_AVISO.estoqueAcimaDoDisponivel,
    conta: X,
    entidade: P.filho,
  }),
} as const;

/**
 * The most entries (e)'s avisos range may read when it is BOUNDED: X's two rows
 * plus an end-of-range probe at each end.
 */
const LEITURA_MAXIMA_DA_FAIXA = 2 + 2;
/**
 * The FEWEST entries a range open on either side reads on THIS seed: X's two
 * rows plus every seeded near-miss on the open side — and (e) asserts the
 * ceiling sits below it. Plain string order is Firestore's id order here: every
 * id is ASCII, where UTF-16 and UTF-8 order agree.
 */
function pisoDasFalhasDaFaixa(inicio: string, fim: string): number {
  const chaves = Object.values(AVISO);
  const abaixo = chaves.filter((c) => c < inicio).length;
  const acima = chaves.filter((c) => c >= fim).length;
  return 2 + Math.min(abaixo, acima);
}

/* ------------------------------ seed + cleanup ----------------------------- */

/**
 * Reclaim THIS suite's leftovers from a crashed run — anything under
 * {@link PREFIXO_DA_SUITE} older than {@link IDADE_SOBRA_MS}, so a concurrent
 * live run is never touched. Every read is a bounded range (document key, or
 * the declared CG `contaOuterRef` index for an orphan link whose produto doc
 * never existed and so no produto key range can find). Best-effort: it logs and
 * moves on; the verified cleanup is `afterAll`'s.
 */
async function varrerSobrasAntigas(db: Firestore): Promise<number> {
  const corte = Date.now() - IDADE_SOBRA_MS;
  const velho = (snap: { createTime?: { toMillis(): number } }): boolean =>
    (snap.createTime?.toMillis() ?? Number.POSITIVE_INFINITY) < corte;
  const writer = db.bulkWriter();
  const contagem: Contagem = { falhas: 0 };
  const relatorios: Awaited<ReturnType<typeof deleteDocumentSubtree>>[] = [];
  let removidos = 0;
  try {
    const produtos = await produtoCollection
      .ref(db, {})
      .where(FieldPath.documentId(), '>=', PREFIXO_DA_SUITE)
      .where(FieldPath.documentId(), '<', fimDoPrefixo(PREFIXO_DA_SUITE))
      .select()
      .limit(LIMITE_DE_SOBRAS)
      .get();
    for (const doc of produtos.docs.filter(velho)) {
      const relatorio = await deleteDocumentSubtree(db, doc.ref, { writer });
      relatorios.push(relatorio);
      removidos += relatorio.documentsDeleted;
    }
    for (const prefixoRef of contaRefForms(PREFIXO_DA_SUITE)) {
      const links = await produtoMercadoLivreLinkCollection
        .groupQuery(db)
        .where('contaOuterRef', '>=', prefixoRef)
        .where('contaOuterRef', '<', fimDoPrefixo(prefixoRef))
        .select()
        .limit(LIMITE_DE_SOBRAS)
        .get();
      for (const doc of links.docs.filter(velho)) {
        apagar(writer, doc.ref, contagem);
        removidos += 1;
      }
    }
    for (const tipo of [TIPO, TIPO_AVISO.estoqueAcimaDoDisponivel]) {
      const inicio = `${tipo}:${PREFIXO_DA_SUITE}`;
      const avisos = await avisoCollection
        .ref(db, {})
        .where(FieldPath.documentId(), '>=', inicio)
        .where(FieldPath.documentId(), '<', fimDoPrefixo(inicio))
        .select()
        .limit(LIMITE_DE_SOBRAS)
        .get();
      for (const doc of avisos.docs.filter(velho)) {
        apagar(writer, doc.ref, contagem);
        removidos += 1;
      }
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
  // reaches through `listCollections()`.
  escritos.produtos.add(P.orfao);

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

  await semearAvisoResolvido(
    db,
    AVISO.x1,
    avisoDoPlano(X, P.filho, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao, 'MLB-B'),
  );
  await semearAvisoResolvido(db, AVISO.x2, {
    ...avisoDoPlano(X, P.orfao, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente, 'MLB-O'),
    canal: CANAL_AVISO.shopee,
  });
  await semearAvisoResolvido(
    db,
    AVISO.x2conta,
    avisoDoPlano(X2, P.saudavel, SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao, 'MLB-H2'),
  );
  // The near-misses on both sides of X's range: (d) proves the read excludes
  // them, and (e) needs them as the floor its read ceiling sits below.
  for (const chave of [AVISO.fim, AVISO.acimaDoFim, AVISO.semEntidade, AVISO.abaixoDoInicio]) {
    await semearAvisoResolvido(db, chave, { tipo: TIPO, canal: CANAL_AVISO.mercadoLivre });
  }
  await semearAvisoResolvido(db, AVISO.outroTipo, {
    tipo: TIPO_AVISO.estoqueAcimaDoDisponivel,
    canal: CANAL_AVISO.mercadoLivre,
  });

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
    .where('contaOuterRef', 'in', [...contaRefForms(X), ...contaRefForms(X2)])
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
 * translation of that very object (`createFrom`), never a hand-built pipeline
 * — so what is judged cannot drift from what production runs, page size and
 * projection included. Returns the row count and the printed plan text.
 */
async function explainProxy(
  db: Firestore,
  consulta: FirebaseFirestore.Query,
): Promise<{ linhas: number; plano: string }> {
  const snap = await db
    .pipeline()
    .createFrom(consulta)
    .execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
  return { linhas: snap.results.length, plano: snap.explainStats?.text ?? '' };
}

/* ---------------------------------- suite ---------------------------------- */

describe.skipIf(!STAGING)('the #1200 link audit on the real staging Firestore (Enterprise)', () => {
  let db: Firestore;
  let gatilhoObservado = false;
  /** (a)'s outcome, for (b) to agree with. */
  let achadosDaVarredura: LinkNaoEnumerado[] | null = null;
  let limposDaVarredura: string[] | null = null;

  beforeAll(async () => {
    db = getAdminFirestore();
    const reclamados = await varrerSobrasAntigas(db);
    if (reclamados > 0)
      relatar(`[staging] reclaimed ${reclamados} stale doc(s) under ${PREFIXO_DA_SUITE}`);
    ({ gatilhoObservado } = await semear(db));
    relatar(
      `[staging] run ${RUN} seeded; deployed link trigger ${gatilhoObservado ? 'observed and undone' : `not observed within ${ESPERA_GATILHO_MS / 1000}s`}`,
    );
    // POSITIVE existence: a mis-targeted database would make every later
    // "absent"/"empty" assertion pass for the wrong reason.
    expect((await produtoCollection.docRef(db, {}, P.saudavel).get()).exists).toBe(true);
  });

  afterAll(async () => {
    if (db == null) return;
    await limpar(db);
    let restos = await sobras(db);
    if (restos.length > 0) {
      // A deployed trigger can still be landing (the delete cascade, a late
      // history row); one more pass, then the verdict.
      await new Promise((r) => setTimeout(r, 3_000));
      await limpar(db);
      restos = await sobras(db);
    }
    expect(restos, `staging cleanup left documents behind under ${RUN}`).toEqual([]);
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

  it('(a) drains the conta-bounded walk over real cursors: every link exactly once, every finding classified', async () => {
    await exigirDeriva();

    const paginas: LinksNaoEnumeradosPage[] = [];
    let apos: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const pagina = await fetchLinksNaoEnumeradosPage(db, {
        integracaoId: X,
        pageLimit: PAGINA,
        afterLinkPath: apos,
      });
      paginas.push(pagina);
      if (pagina.nextAfterLinkPath == null) break;
      apos = pagina.nextAfterLinkPath;
    }

    const lidos = paginas.reduce((s, p) => s + p.lidos, 0);
    // EXACTLY the seeded count: fewer is a skipped page, more a repeated one —
    // or another conta's link (X2's sits on the same produto) admitted by `in`.
    expect(lidos, 'links read across the whole walk').toBe(CAMINHOS_DE_X.length);
    // The cursors are the seed's own sorted paths at every PAGINA-th step — the
    // walk resumed exactly after each REAL DocumentReference, never from the top.
    expect(paginas.map((p) => p.nextAfterLinkPath).filter((c) => c != null)).toEqual(
      CAMINHOS_DE_X.filter((_, i) => (i + 1) % PAGINA === 0),
    );
    // 8 links at 2 a page: four FULL pages, then the empty one that drains.
    expect(paginas.map((p) => p.lidos)).toEqual([2, 2, 2, 2, 0]);
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

  it('(d) the avisos key range on real ids: exactly this conta’s rows, with canal / params / aberto', async () => {
    const linhas = await listarAvisosDaConta(db, X);

    expect(linhas.map((l) => l.chave)).toEqual([AVISO.x1, AVISO.x2]);
    expect(linhas).toEqual([
      {
        chave: AVISO.x1,
        aberto: false,
        canal: CANAL_AVISO.mercadoLivre,
        params: {
          situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao,
          anuncio: 'MLB-B',
          anuncios: 1,
        },
      },
      {
        chave: AVISO.x2,
        aberto: false,
        canal: CANAL_AVISO.shopee,
        params: {
          situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente,
          anuncio: 'MLB-O',
          anuncios: 1,
        },
      },
    ]);
    // The near-misses EXIST — otherwise their absence above proves nothing.
    for (const chave of [
      AVISO.x2conta,
      AVISO.fim,
      AVISO.acimaDoFim,
      AVISO.semEntidade,
      AVISO.abaixoDoInicio,
      AVISO.outroTipo,
    ]) {
      expect((await avisoCollection.docRef(db, {}, chave).get()).exists, chave).toBe(true);
    }
  });

  it('(e) PLAN — the walk rides the COLLECTION_GROUP produtoMercadoLivre(contaOuterRef, __name__) index, bounded on the conta, and SEEKS its cursor', async () => {
    // Anti-vacuity: a ceiling at or above what a failure reads proves nothing.
    expect(
      LEITURA_MAXIMA_DA_VARREDURA,
      'the read ceiling must sit below what a non-seeking cursor or a whole-index walk reads ' +
        'on this seed — re-derive it (or seed more links) after changing PAGINA or LINKS',
    ).toBeLessThan(PISO_DAS_FALHAS_DA_VARREDURA);

    // The LAST page — the walk's very query object, cursor deepest in the conta.
    const consulta = consultaDaVarredura(db, {
      integracaoId: X,
      pageLimit: PAGINA,
      afterLinkPath: CURSOR_TARDIO,
    });

    // Classic first. Enterprise refuses it today; the day it does not, its real
    // plan is the better evidence.
    const usados = await explainClassico(consulta);
    if (usados != null) {
      expect(
        classicoServeVarredura(usados),
        `classic plan rides ${JSON.stringify(usados)}, not COLLECTION_GROUP (contaOuterRef ASC, __name__ ASC)`,
      ).toBe(true);
    }

    const { linhas, plano } = await explainProxy(db, consulta);
    relatar(
      `\n----- walk, last page — PROXY plan (createFrom of the walk's query) -----\n${plano}`,
    );
    expect(linhas, 'the last page of the proxy returned the wrong row count').toBe(PAGINA);
    expect(plano, 'the proxy returned no plan text').not.toBe('');

    // Bounded on the conta AND seeking the cursor — by the plan's range lines,
    // or else by its read counters within the ceiling (explainPlan.mjs). A
    // push-down alone, or a cursor tested per entry, prints the same lines as
    // the walk of every conta / the quadratic walk, so neither passes on shape.
    const veredicto = julgarPlanoDaVarredura(plano, {
      comCursor: true,
      leituraMaxima: LEITURA_MAXIMA_DA_VARREDURA,
    });
    relatar(
      `[staging] walk verdict: ${veredicto.detalhe ?? '(failed)'} — read counters ` +
        `${JSON.stringify(veredicto.leitura)}, ceiling ${LEITURA_MAXIMA_DA_VARREDURA}`,
    );
    expect(
      veredicto.motivos.map((m) => `${m.codigo}: ${m.mensagem}`),
      'the walk plan is not the bounded, cursor-seeking CG index scan the audit was built for',
    ).toEqual([]);
  });

  it('(e) PLAN — the avisos range is a bounded key scan, never a walk of the collection', async () => {
    const faixa = faixaDeChavesDaConta(X);
    expect(
      LEITURA_MAXIMA_DA_FAIXA,
      'the read ceiling must sit below what a range open on either side reads on this seed',
    ).toBeLessThan(pisoDasFalhasDaFaixa(faixa.inicio, faixa.fim));

    // The audit's very query object — its page size and projection included.
    const consulta = consultaDaFaixaDeChaves(db, faixa);

    const usados = await explainClassico(consulta);
    if (usados != null) {
      expect(classicoServeFaixa(usados), `classic plan rides ${JSON.stringify(usados)}`).toBe(true);
    }

    const { linhas, plano } = await explainProxy(db, consulta);
    relatar(
      `\n----- avisos key range — PROXY plan (createFrom of the audit's query) -----\n${plano}`,
    );
    // The proxy itself must agree with (d): X's two rows, nothing else.
    expect(linhas, 'the proxy range returned the wrong row count').toBe(2);
    expect(plano, 'the proxy returned no plan text').not.toBe('');

    const veredicto = julgarPlanoDaFaixaDeAvisos(plano, {
      inicio: faixa.inicio,
      leituraMaxima: LEITURA_MAXIMA_DA_FAIXA,
    });
    relatar(
      `[staging] avisos verdict: ${veredicto.detalhe ?? '(failed)'} — read counters ` +
        `${JSON.stringify(veredicto.leitura)}, ceiling ${LEITURA_MAXIMA_DA_FAIXA}`,
    );
    expect(
      veredicto.motivos.map((m) => `${m.codigo}: ${m.mensagem}`),
      'the avisos key range is not a key scan closed at both ends',
    ).toEqual([]);
  });
});
