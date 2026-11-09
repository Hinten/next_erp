/**
 * The product import's TAX-REVIEW LIST (master plan step 9, "complete"): the produtos whose taxes
 * an import may have changed — a produto it created, the produtos of a categoria it created, a
 * produto it left without a category, a produto whose EMPTY category it filled — each a document
 * `revisao/{produtoId}` of the job. Every one of those changes how the NF-e resolves the produto's
 * taxes, and none of them may be closed by anything but EVIDENCE that a person set the taxes.
 *
 * ## Adding an entry ({@link adicionarARevisaoFiscalLi}) — the plan's row 5
 *
 * Tier 0 at the produto's id, in this job's own subcollection, whose only writer is this job (one
 * dispatch at a time, `seq`-checked): `create()`, and on `ALREADY_EXISTS` the stored entry is read
 * and the two are MERGED ({@link fundirEntradasRevisaoFiscalLi}: every motivo of both, the earliest
 * "since"), written back whole only when the merge changed it. A retried unit meets its own entry
 * and writes nothing.
 *
 * ## The `revisao` phase — an `aplicar` job's last phase, one unit at a time
 *
 * Every unit calls nothing outside Firestore (the budget's `familia` row,
 * {@link unidadeDaRevisaoFiscalLi}), and returns the job's new `revisao` cursor for the dispatch's
 * checkpoint: state in, state out, and a unit retried before its checkpoint redoes the same page
 * (every write is idempotent).
 *
 * **1. The carry-forward.** The list is durable across jobs: this job copies the open entries of
 * the conta's earlier `aplicar` jobs. The conta's jobs are walked newest first, one page of
 * {@link LIMITE_IMPORTACOES_LISTADAS_LI} per unit, through the one indexed query
 * (`consultaImportacoesDaContaLi`, `job.ts`), skipping this job and every Simular job (a simulation
 * changed nothing, so its list is no one's). EVERY `aplicar` job met is a source, and the walk stops
 * after the first one that ended `concluido`: a concluded job finished its own re-check, so its
 * list already holds everything older that is still open. A job that failed or was cancelled
 * before its re-check holds only part of the list (its own entries, and whatever it had carried),
 * so the walk goes past it — taking only the newest previous job would silently drop every entry
 * an interrupted job never carried. A source is copied one page of
 * {@link PAGINA_TRANSPORTE_REVISAO_LI} entries per unit, each through the add above (an entry this
 * job already holds is merged, never duplicated), keeping the job that FIRST listed it. The job's
 * `revisao.anteriorJobId` names the newest source.
 *
 * **2. The re-check.** This job's whole list, one page of {@link PAGINA_CONFERENCIA_REVISAO_LI} per
 * unit, in the produto ids' order. An entry LEAVES — its document is deleted from this job's list —
 * only on evidence ({@link evidenciaFiscalDoProdutoLi}):
 *  - a `regraImposto` names the produto or its category (the NF-e cascade's own tier-4 match,
 *    `regraImpostoCasaComProduto`, on its produto and category arms: the NCM a rule could name lives
 *    in the very tax settings this list asks a person to review);
 *  - the produto has its own `imposto` document;
 *  - its CURRENT category (read from the produto, as the cascade reads it) has one;
 *  - or the produto no longer exists: a deleted produto is never invoiced, and an entry no
 *    evidence could ever close would keep the aviso open for good. (⚠️ A deviation from the plan's
 *    "nothing closes it but evidence", kept for the owner's review: it is also what closes the entry
 *    a create's or an add's batch left when that batch then lost — `familiaDoJob.ts`, "The tax
 *    review", writes the entry BEFORE the write it records.)
 * Nothing else removes an entry: a later job that changes nothing carries it forward unchanged.
 * The phase ends with the open count, for the tax-review aviso (`avisosImportacao.ts`).
 *
 * (⚠️ Also a deviation from the plan's "the conta's previous `aplicar` job": the carry-forward walks
 * past a failed or cancelled `aplicar` job to the newest CONCLUDED one, for the reason above.)
 *
 * ## The cursor
 *
 * The job contract gives the phase one text cursor (`revisao.cursorProdutoId`) and the source's id
 * (`revisao.anteriorJobId`). The phase needs where it is (carrying from a source, or re-checking),
 * the position inside it and, while re-checking, the entries kept so far — so the text is TAGGED,
 * written and read here only:
 *  - `null` — nothing done yet;
 *  - `a:<jobId>` — every job down to `<jobId>` (newest first) is handled: find the next source;
 *  - `c:<jobId>:<produtoId>` / `u:<jobId>:<produtoId>` — copying source `<jobId>` after
 *    `<produtoId>` (empty: from its start); `u` marks the walk's LAST source (it ended `concluido`);
 *  - `r:<abertos>:<produtoId>` — re-checking after `<produtoId>` (empty: from the start), with
 *    `<abertos>` entries kept so far.
 * A job id is the start route's auto id (`ID_IMPORTACAO_LI_REGEX`: no `:`), so the first `:` after
 * it ends it; a produto id is everything after. A text this module cannot read starts the phase
 * over from `null` — safe, every step is idempotent. Only jobs whose id that grammar admits are
 * walked past or copied (every job the start route creates).
 *
 * ## The reads, against the indexes (root rule 1)
 *
 *  - The conta's jobs: `integracaoId == <conta> orderBy iniciadoEmMs desc limit 10`, plus
 *    `startAfter(<the last job handled>)` — the declared
 *    `importacoesLojaIntegrada (integracaoId ASC, iniciadoEmMs DESC)` composite serves every page
 *    (`revisaoFiscal.test.ts` checks it against `firestore.indexes.json`); the job a page resumes
 *    after is read by id.
 *  - A job's `revisao` subcollection is read WHOLE — unfiltered, unordered, no limit, so no index —
 *    ONCE per dispatch per list ({@link criarLeitorDeListasRevisaoLi}), and paged IN MEMORY in the
 *    produto ids' code-unit order (the cursor's `<produtoId>` is the last id handled in that order).
 *    ⚠️ Never a document-key RANGE (`orderBy(documentId())` + `startAfter` + a limit): Enterprise
 *    keeps no implicit key index, and with none LEADING with `__name__` declared for `revisao` such
 *    a page is cut residually after scanning the WHOLE list (measured on staging, #1874) — and the
 *    list is durable, carried from job to job, so N/page pages over N entries would make every
 *    `aplicar` job, an only-link one included, cost the square of the list. Read whole, a list costs
 *    one scan per dispatch the phase spans; a `revisao (__name__ ASC)` index (#1874's remedy) would
 *    make true range pages possible, a window deploy of its own.
 *  - Per entry, at most THREE reads: the produto by id (its existence and its CURRENT category, which
 *    the cascade reads too), then `produtos/{id}/imposto` `limit(1)` and `categorias/{id}/imposto`
 *    `limit(1)` — unfiltered, so no index — skipped as soon as a rule or an earlier read is evidence.
 *    (The plan priced "≤ 2 reads per item": the produto read it left out is required.)
 *  - Every `regraImposto` (the `regras` collection group, unfiltered: every rule of every operação
 *    is wanted), read ONCE per dispatch that re-checks ({@link criarLeitorDeRegrasImpostoLi}), and
 *    only when a page holds an entry. Each is `safeParse`d and a rule that does not parse is
 *    DROPPED, as the cascade drops it: a rule the NF-e never applies covers nothing. (The plan said
 *    once per JOB; the job contract has no field to carry them between dispatches, so a re-check
 *    spanning K dispatches reads them K times.)
 *
 * ## Errors (root rule 6)
 *
 * Only `ALREADY_EXISTS` on an add is caught, narrowed by its code; every other Firestore failure
 * propagates and the task retries the unit.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter. Every stamp is ms.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import {
  impostoCategoriaCollection,
  impostoProdutoCollection,
  importacaoLojaIntegradaCollection,
  produtoCollection,
  regraImpostoCollection,
  revisaoFiscalImportacaoLiCollection,
} from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin/grpcErrors';
import { parseCategoriaUid, regraImpostoCasaComProduto } from '@delfrance/data/admin/imposto';
import {
  ID_IMPORTACAO_LI_REGEX,
  type ImportacaoLojaIntegrada,
  LIMITE_IMPORTACOES_LISTADAS_LI,
  MODO_IMPORTACAO_LI,
  type MotivoRevisaoFiscalLi,
  type RegraImposto,
  type RevisaoFiscalLi,
  STATUS_IMPORTACAO_LI,
  modoImportacaoLiSchema,
  motivoRevisaoFiscalLiSchema,
  regraImpostoSchema,
  revisaoFiscalLiSchema,
  statusImportacaoLiSchema,
} from '@delfrance/schemas';
import type { z } from 'zod';

import { consultaImportacoesDaContaLi } from './job';
import { UNIDADE_IMPORTACAO_LI, type UnidadeImportacaoLi } from './orcamento';

/** Entries of a source copied per unit. */
export const PAGINA_TRANSPORTE_REVISAO_LI = 100;

/** Entries re-checked per unit (each at most three reads). */
export const PAGINA_CONFERENCIA_REVISAO_LI = 50;

/** The job's `revisao` field: the phase's state. */
export type EstadoRevisaoFiscalLi = ImportacaoLojaIntegrada['revisao'];

/* -------------------------------------------------------------------------- */
/*                                   An entry                                  */
/* -------------------------------------------------------------------------- */

/** What one add did. */
export type DesfechoRevisaoFiscalLi = 'criada' | 'fundida' | 'sem-mudanca';

/** Named members of {@link DesfechoRevisaoFiscalLi}. */
export const DESFECHO_REVISAO_FISCAL_LI = {
  criada: 'criada',
  fundida: 'fundida',
  semMudanca: 'sem-mudanca',
} as const satisfies Record<string, DesfechoRevisaoFiscalLi>;

/** The motivos of both, each once, in the schema's own order. */
function unirMotivos(
  a: readonly MotivoRevisaoFiscalLi[],
  b: readonly MotivoRevisaoFiscalLi[],
): MotivoRevisaoFiscalLi[] {
  return motivoRevisaoFiscalLiSchema.options.filter((m) => a.includes(m) || b.includes(m));
}

/**
 * Two entries of ONE produto, merged: every motivo of both (each once, in the schema's order), the
 * stored store id unless it has none, and the "since" (`desdeJobId` + `desdeMs`) of whichever was
 * listed FIRST — an entry with a stamp is earlier than one without; on a tie, `armazenada`'s. Pure.
 */
export function fundirEntradasRevisaoFiscalLi(
  armazenada: RevisaoFiscalLi,
  nova: RevisaoFiscalLi,
): RevisaoFiscalLi {
  const armazenadaPrimeiro =
    nova.desdeMs === null || (armazenada.desdeMs !== null && armazenada.desdeMs <= nova.desdeMs);
  const desde = armazenadaPrimeiro ? armazenada : nova;
  return {
    produtoId: armazenada.produtoId,
    motivos: unirMotivos(armazenada.motivos, nova.motivos),
    liId: armazenada.liId ?? nova.liId,
    desdeJobId: desde.desdeJobId ?? (armazenadaPrimeiro ? nova : armazenada).desdeJobId,
    desdeMs: desde.desdeMs,
  };
}

/**
 * Whether two entries hold the same thing, field by field — the motivos in order (both come out of
 * {@link fundirEntradasRevisaoFiscalLi} or the schema, in the schema's order). Equal: every field
 * the same. Distinct: one motivo more, another store id, another "since" job or stamp.
 */
export function mesmaEntradaRevisaoFiscalLi(a: RevisaoFiscalLi, b: RevisaoFiscalLi): boolean {
  return (
    a.produtoId === b.produtoId &&
    a.liId === b.liId &&
    a.desdeJobId === b.desdeJobId &&
    a.desdeMs === b.desdeMs &&
    a.motivos.length === b.motivos.length &&
    a.motivos.every((m, i) => b.motivos[i] === m)
  );
}

/**
 * A stored entry read field by field, so one unreadable field never loses the entry: its id is the
 * produto (the document's key, whatever the body says), a motivo this build does not know is left
 * out, and any other field that does not read is `null`.
 */
function lerEntradaArmazenada(produtoId: string, dados: unknown): RevisaoFiscalLi {
  const campo = (chave: string): unknown =>
    typeof dados === 'object' && dados !== null ? Reflect.get(dados, chave) : undefined;
  const forma = revisaoFiscalLiSchema.shape;
  const motivosBrutos = campo('motivos');
  const motivos = Array.isArray(motivosBrutos)
    ? motivoRevisaoFiscalLiSchema.options.filter((m) => motivosBrutos.includes(m))
    : [];
  const liId = forma.liId.safeParse(campo('liId'));
  const desdeJobId = forma.desdeJobId.safeParse(campo('desdeJobId'));
  const desdeMs = forma.desdeMs.safeParse(campo('desdeMs'));
  return {
    produtoId,
    motivos,
    liId: liId.success ? liId.data : null,
    desdeJobId: desdeJobId.success ? desdeJobId.data : null,
    desdeMs: desdeMs.success ? desdeMs.data : null,
  };
}

/**
 * Put one produto on job `jobId`'s tax-review list (module header, "Adding an entry"): created, or
 * merged into the entry already there. Throws on an entry that does not parse — a coding bug, never
 * data — and on any Firestore failure but the `ALREADY_EXISTS` it arbitrates on.
 */
export async function adicionarARevisaoFiscalLi(
  db: Firestore,
  jobId: string,
  entrada: z.input<typeof revisaoFiscalLiSchema>,
): Promise<DesfechoRevisaoFiscalLi> {
  const nova = revisaoFiscalLiSchema.parse(entrada);
  if (nova.produtoId.includes('/')) {
    throw new RangeError('adicionarARevisaoFiscalLi: produtoId não é um id de documento');
  }
  const ref = revisaoFiscalImportacaoLiCollection.docRef(db, { jobId }, nova.produtoId);
  try {
    await ref.create({ ...nova });
    return DESFECHO_REVISAO_FISCAL_LI.criada;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const snap = await ref.get();
  const armazenada = snap.exists ? lerEntradaArmazenada(nova.produtoId, snap.data()) : null;
  const fundida = armazenada === null ? nova : fundirEntradasRevisaoFiscalLi(armazenada, nova);
  if (armazenada !== null && mesmaEntradaRevisaoFiscalLi(armazenada, fundida)) {
    return DESFECHO_REVISAO_FISCAL_LI.semMudanca;
  }
  // The only writer of this subcollection is this job (module header): the whole entry, written.
  await ref.set({ ...fundida });
  return DESFECHO_REVISAO_FISCAL_LI.fundida;
}

/* -------------------------------------------------------------------------- */
/*                                 The evidence                                */
/* -------------------------------------------------------------------------- */

/** Why an entry leaves the list (module header, "The re-check"). */
export type EvidenciaFiscalLi =
  | 'produto-ausente'
  | 'regra'
  | 'imposto-do-produto'
  | 'imposto-da-categoria';

/** Named members of {@link EvidenciaFiscalLi}. */
export const EVIDENCIA_FISCAL_LI = {
  produtoAusente: 'produto-ausente',
  regra: 'regra',
  impostoDoProduto: 'imposto-do-produto',
  impostoDaCategoria: 'imposto-da-categoria',
} as const satisfies Record<string, EvidenciaFiscalLi>;

/** Every tax rule the cascade could apply, read once by its caller (module header, "The reads"). */
export type LeitorDeRegrasImpostoLi = () => Promise<readonly RegraImposto[]>;

/**
 * A reader of every `regraImposto`, memoised for ITS lifetime: one per dispatch, so the rules are
 * read at most once per dispatch, and only when asked.
 */
export function criarLeitorDeRegrasImpostoLi(db: Firestore): LeitorDeRegrasImpostoLi {
  let lidas: Promise<readonly RegraImposto[]> | null = null;
  return () => {
    lidas ??= lerRegrasImposto(db);
    return lidas;
  };
}

async function lerRegrasImposto(db: Firestore): Promise<readonly RegraImposto[]> {
  const snap = await regraImpostoCollection.groupQuery(db).get();
  const regras: RegraImposto[] = [];
  for (const doc of snap.docs) {
    // Only an operação's `regras`: the group id alone would also reach another collection so named.
    const operacao = doc.ref.parent.parent;
    if (
      operacao === null ||
      doc.ref.parent.path !== regraImpostoCollection.resolvePath({ operacaoId: operacao.id })
    ) {
      continue;
    }
    const lida = regraImpostoSchema.safeParse({ id: doc.id, ...doc.data() });
    if (lida.success) regras.push(lida.data);
  }
  return regras;
}

/**
 * The evidence that produto `produtoId`'s taxes were set, or `null` (module header, "The
 * re-check"): the produto read first (gone ⇒ it leaves; its current category), then the rules,
 * then its own `imposto`, then its category's — each read skipped once an earlier one answered.
 */
export async function evidenciaFiscalDoProdutoLi(
  db: Firestore,
  produtoId: string,
  regras: readonly RegraImposto[],
): Promise<EvidenciaFiscalLi | null> {
  const produto = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!produto.exists) return EVIDENCIA_FISCAL_LI.produtoAusente;
  const dados: unknown = produto.data();
  const categoriaUid = parseCategoriaUid(
    typeof dados === 'object' && dados !== null ? (dados as Record<string, unknown>) : null,
  );
  const alvo = { produtoUid: produtoId, categoriaUid, ncm: null };
  if (regras.some((regra) => regraImpostoCasaComProduto(regra, alvo))) {
    return EVIDENCIA_FISCAL_LI.regra;
  }
  const doProduto = await impostoProdutoCollection.ref(db, { produtoId }).limit(1).get();
  if (!doProduto.empty) return EVIDENCIA_FISCAL_LI.impostoDoProduto;
  if (categoriaUid !== null) {
    const daCategoria = await impostoCategoriaCollection
      .ref(db, { categoriaId: categoriaUid })
      .limit(1)
      .get();
    if (!daCategoria.empty) return EVIDENCIA_FISCAL_LI.impostoDaCategoria;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                  The lists                                  */
/* -------------------------------------------------------------------------- */

/** One entry of a job's list as read: its id (the produto's), its raw data and its document. */
export interface EntradaListadaLi {
  readonly id: string;
  readonly dados: unknown;
  readonly ref: DocumentReference;
}

/** A job's WHOLE list, sorted by id (module header, "The reads"), read once per reader. */
export type LeitorDeListasRevisaoLi = (jobId: string) => Promise<readonly EntradaListadaLi[]>;

/** The code-unit order the phase pages in (module header, "The reads"): a total order of ids. */
function compararIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A reader of a job's whole `revisao` list, memoised per job for ITS lifetime: one per dispatch, so
 * each list is read at most once per dispatch — never a key range (module header, "The reads").
 */
export function criarLeitorDeListasRevisaoLi(db: Firestore): LeitorDeListasRevisaoLi {
  const lidas = new Map<string, Promise<readonly EntradaListadaLi[]>>();
  return (jobId) => {
    const ja = lidas.get(jobId);
    if (ja !== undefined) return ja;
    const lendo = lerLista(db, jobId);
    lidas.set(jobId, lendo);
    return lendo;
  };
}

async function lerLista(db: Firestore, jobId: string): Promise<readonly EntradaListadaLi[]> {
  const snap = await revisaoFiscalImportacaoLiCollection.ref(db, { jobId }).get();
  return snap.docs
    .map((d) => ({ id: d.id, dados: d.data(), ref: d.ref }))
    .sort((a, b) => compararIds(a.id, b.id));
}

/** At most `n` entries of `lista` whose id comes after `depois` (`null`: from the start). */
function paginaDaLista(
  lista: readonly EntradaListadaLi[],
  depois: string | null,
  n: number,
): EntradaListadaLi[] {
  const inicio = depois === null ? 0 : lista.findIndex((e) => compararIds(e.id, depois) > 0);
  return inicio < 0 ? [] : lista.slice(inicio, inicio + n);
}

/* -------------------------------------------------------------------------- */
/*                                  The cursor                                 */
/* -------------------------------------------------------------------------- */

type CursorRevisaoLi =
  | { readonly etapa: 'inicio' }
  | { readonly etapa: 'apos'; readonly jobId: string }
  | {
      readonly etapa: 'copiando';
      readonly jobId: string;
      readonly ultima: boolean;
      readonly depois: string | null;
    }
  | { readonly etapa: 'conferindo'; readonly abertos: number; readonly depois: string | null };

const INICIO: CursorRevisaoLi = { etapa: 'inicio' };

/** The tagged text (module header, "The cursor"); anything unreadable is the start. */
function lerCursor(texto: string | null): CursorRevisaoLi {
  if (texto === null) return INICIO;
  const etiqueta = texto.slice(0, 2);
  const resto = texto.slice(2);
  if (etiqueta === 'a:')
    return ID_IMPORTACAO_LI_REGEX.test(resto) ? { etapa: 'apos', jobId: resto } : INICIO;
  const separador = resto.indexOf(':');
  if (separador < 0) return INICIO;
  const cabeca = resto.slice(0, separador);
  const posicao = resto.slice(separador + 1);
  const depois = posicao === '' ? null : posicao;
  if ((etiqueta === 'c:' || etiqueta === 'u:') && ID_IMPORTACAO_LI_REGEX.test(cabeca)) {
    return { etapa: 'copiando', jobId: cabeca, ultima: etiqueta === 'u:', depois };
  }
  if (etiqueta === 'r:' && /^(0|[1-9][0-9]{0,14})$/.test(cabeca)) {
    return { etapa: 'conferindo', abertos: Number(cabeca), depois };
  }
  return INICIO;
}

function escreverCursor(cursor: CursorRevisaoLi): string | null {
  switch (cursor.etapa) {
    case 'inicio':
      return null;
    case 'apos':
      return `a:${cursor.jobId}`;
    case 'copiando':
      return `${cursor.ultima ? 'u' : 'c'}:${cursor.jobId}:${cursor.depois ?? ''}`;
    case 'conferindo':
      return `r:${String(cursor.abertos)}:${cursor.depois ?? ''}`;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  The phase                                  */
/* -------------------------------------------------------------------------- */

export interface DepsRevisaoFiscalLi {
  readonly db: Firestore;
  /** The conta whose earlier jobs are walked. */
  readonly contaId: string;
  /** THIS job: its list is the one written and re-checked, and it is never its own source. */
  readonly jobId: string;
  /** The tax rules, read at most once per dispatch ({@link criarLeitorDeRegrasImpostoLi}). */
  readonly regras: LeitorDeRegrasImpostoLi;
  /** The jobs' lists, each read at most once per dispatch ({@link criarLeitorDeListasRevisaoLi}). */
  readonly listas: LeitorDeListasRevisaoLi;
}

/** How one unit of the phase ended. */
export type PassoRevisaoFiscalLi =
  /** The phase goes on: `estado` is the cursor to checkpoint. */
  | {
      readonly tipo: 'progresso';
      readonly estado: EstadoRevisaoFiscalLi;
      /** Entries copied from a source by this unit. */
      readonly transportadas: number;
      /** Entries re-checked by this unit, and how many of them left. */
      readonly conferidas: number;
      readonly saidas: number;
    }
  /** The re-check reached the list's end: `abertos` entries remain (the aviso's count). */
  | {
      readonly tipo: 'concluido';
      readonly estado: EstadoRevisaoFiscalLi;
      readonly abertos: number;
      readonly conferidas: number;
      readonly saidas: number;
    };

/** Named members of {@link PassoRevisaoFiscalLi}'s `tipo`. */
export const PASSO_REVISAO_FISCAL_LI = {
  progresso: 'progresso',
  concluido: 'concluido',
} as const satisfies Record<string, PassoRevisaoFiscalLi['tipo']>;

/** The cost of the phase's every unit: no Loja Integrada call (module header). */
export function unidadeDaRevisaoFiscalLi(): UnidadeImportacaoLi {
  return UNIDADE_IMPORTACAO_LI.familia;
}

/**
 * Run the phase's next unit from `estado` (the job's `revisao` as last checkpointed) and return the
 * new state. Its writes are this job's own `revisao/*` entries only.
 */
export async function executarUnidadeDaRevisaoFiscalLi(
  deps: DepsRevisaoFiscalLi,
  estado: EstadoRevisaoFiscalLi,
): Promise<PassoRevisaoFiscalLi> {
  const cursor = lerCursor(estado.cursorProdutoId);
  switch (cursor.etapa) {
    case 'inicio':
      return procurarFonte(deps, estado, null);
    case 'apos':
      return procurarFonte(deps, estado, cursor.jobId);
    case 'copiando':
      return copiarPagina(deps, estado, cursor);
    case 'conferindo':
      return conferirPagina(deps, estado, cursor);
  }
}

function progresso(
  estado: EstadoRevisaoFiscalLi,
  cursor: CursorRevisaoLi,
  contagens: { transportadas?: number; conferidas?: number; saidas?: number } = {},
): PassoRevisaoFiscalLi {
  return {
    tipo: PASSO_REVISAO_FISCAL_LI.progresso,
    estado: { ...estado, cursorProdutoId: escreverCursor(cursor) },
    transportadas: contagens.transportadas ?? 0,
    conferidas: contagens.conferidas ?? 0,
    saidas: contagens.saidas ?? 0,
  };
}

/** A job's `modo` and `status`, read field by field (an unreadable `modo` is Simular's default). */
function lerFonte(dados: unknown): { aplicar: boolean; concluido: boolean } {
  const campo = (chave: string): unknown =>
    typeof dados === 'object' && dados !== null ? Reflect.get(dados, chave) : undefined;
  const modo = modoImportacaoLiSchema.safeParse(campo('modo'));
  const status = statusImportacaoLiSchema.safeParse(campo('status'));
  return {
    aplicar: modo.success && modo.data === MODO_IMPORTACAO_LI.aplicar,
    concluido: status.success && status.data === STATUS_IMPORTACAO_LI.concluido,
  };
}

/** One page of the conta's jobs after `aposJobId` (`null`: from the newest): the next source. */
async function procurarFonte(
  deps: DepsRevisaoFiscalLi,
  estado: EstadoRevisaoFiscalLi,
  aposJobId: string | null,
): Promise<PassoRevisaoFiscalLi> {
  let consulta = consultaImportacoesDaContaLi(deps.db, deps.contaId);
  if (aposJobId !== null) {
    const apos = await importacaoLojaIntegradaCollection.docRef(deps.db, {}, aposJobId).get();
    // A job gone since (never by this code): the walk starts over from the newest — idempotent.
    if (apos.exists) consulta = consulta.startAfter(apos);
  }
  const pagina = await consulta.get();
  for (const doc of pagina.docs) {
    if (doc.id === deps.jobId || !ID_IMPORTACAO_LI_REGEX.test(doc.id)) continue;
    const fonte = lerFonte(doc.data());
    if (!fonte.aplicar) continue;
    return progresso(
      { ...estado, anteriorJobId: estado.anteriorJobId ?? doc.id },
      { etapa: 'copiando', jobId: doc.id, ultima: fonte.concluido, depois: null },
    );
  }
  const retomavel = pagina.docs.filter((d) => ID_IMPORTACAO_LI_REGEX.test(d.id)).at(-1);
  if (pagina.docs.length < LIMITE_IMPORTACOES_LISTADAS_LI || retomavel === undefined) {
    // The conta's oldest job is behind us: the list is carried, the re-check starts.
    return progresso(estado, { etapa: 'conferindo', abertos: 0, depois: null });
  }
  return progresso(estado, { etapa: 'apos', jobId: retomavel.id });
}

/** One page of source `cursor.jobId`'s list, added to this job's. */
async function copiarPagina(
  deps: DepsRevisaoFiscalLi,
  estado: EstadoRevisaoFiscalLi,
  cursor: Extract<CursorRevisaoLi, { etapa: 'copiando' }>,
): Promise<PassoRevisaoFiscalLi> {
  const pagina = paginaDaLista(
    await deps.listas(cursor.jobId),
    cursor.depois,
    PAGINA_TRANSPORTE_REVISAO_LI,
  );
  await Promise.all(
    pagina.map((e) => {
      const lida = lerEntradaArmazenada(e.id, e.dados);
      // The job that FIRST listed it stays its "since"; an entry that names none is the source's.
      return adicionarARevisaoFiscalLi(deps.db, deps.jobId, {
        ...lida,
        desdeJobId: lida.desdeJobId ?? cursor.jobId,
      });
    }),
  );
  const transportadas = pagina.length;
  const ultimo = pagina.at(-1);
  if (transportadas === PAGINA_TRANSPORTE_REVISAO_LI && ultimo !== undefined) {
    return progresso(estado, { ...cursor, depois: ultimo.id }, { transportadas });
  }
  return progresso(
    estado,
    cursor.ultima
      ? { etapa: 'conferindo', abertos: 0, depois: null }
      : { etapa: 'apos', jobId: cursor.jobId },
    { transportadas },
  );
}

/** One page of this job's list, re-checked: an entry with evidence leaves, the rest are counted. */
async function conferirPagina(
  deps: DepsRevisaoFiscalLi,
  estado: EstadoRevisaoFiscalLi,
  cursor: Extract<CursorRevisaoLi, { etapa: 'conferindo' }>,
): Promise<PassoRevisaoFiscalLi> {
  // This job's list as this dispatch first read it: an entry this phase deletes sits behind the
  // cursor, and nothing adds one while the phase runs (the familias phase is over).
  const pagina = paginaDaLista(
    await deps.listas(deps.jobId),
    cursor.depois,
    PAGINA_CONFERENCIA_REVISAO_LI,
  );
  const regras = pagina.length === 0 ? [] : await deps.regras();
  const evidencias = await Promise.all(
    pagina.map((e) => evidenciaFiscalDoProdutoLi(deps.db, e.id, regras)),
  );
  const saem = pagina.filter((_, i) => evidencias[i] !== null);
  await Promise.all(saem.map((e) => e.ref.delete()));

  const conferidas = pagina.length;
  const saidas = saem.length;
  const abertos = cursor.abertos + conferidas - saidas;
  const depois = pagina.at(-1)?.id ?? cursor.depois;
  const proximo: CursorRevisaoLi = { etapa: 'conferindo', abertos, depois };
  if (conferidas === PAGINA_CONFERENCIA_REVISAO_LI) {
    return progresso(estado, proximo, { conferidas, saidas });
  }
  return {
    tipo: PASSO_REVISAO_FISCAL_LI.concluido,
    estado: { ...estado, cursorProdutoId: escreverCursor(proximo) },
    abertos,
    conferidas,
    saidas,
  };
}
