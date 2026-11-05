/**
 * The product import's JOB LIFECYCLE (master plan step 9): every read and write of the job
 * document `importacoesLojaIntegrada/{jobId}` outside its creation (`inicio.ts`), and the reads
 * the job routes answer from. The contract — the document, its phases, its options, the task and
 * the route answers — is `packages/schemas/src/importacaoLojaIntegrada.ts`; this module only
 * orders the reads and guards the writes.
 *
 * ⚠️ It calls nothing outside the ERP: no package client, no context loader, no credential, no
 * pacer, no read switch. The three job routes (status, cancel, items) reach it and nothing else of
 * the import, and `estrutura.test.ts` walks their closures with the label routing route's rules.
 * So it must never import the context loader or a value of the package.
 *
 * ## Who writes the job document (root rule 7, one row each)
 *
 * | Write | Racing writer | Guard |
 * | --- | --- | --- |
 * | the create (`inicio.ts`) | a second start | tier 0 on an auto id; the 409 guard by query |
 * | a unit checkpoint ({@link gravarCheckpointDaUnidadeLi}) | the cancel; another dispatch of the same `seq` | tier 1, chained |
 * | the end-of-dispatch checkpoint ({@link gravarCheckpointDoFimDoDespachoLi}) | the same | tier 1, chained; the ONLY write that bumps `seq` |
 * | a terminal stamp ({@link encerrarImportacaoLi}) | the cancel; another dispatch | tier 1, read-decide-write |
 * | the cancel ({@link cancelarImportacaoLi}) | a checkpoint; a terminal stamp | tier 1 on the route's read |
 *
 * Every one of them is `update(patch, { lastUpdateTime })`. Chained: a dispatch writes on the
 * `writeTime` its own previous write returned, starting from its job read, so ANY other write in
 * between — a cancel above all — fails the next checkpoint with `FAILED_PRECONDITION` (9; a removed
 * document fails it with 9 too, since the stamp replaces the SDK's `exists` check). No write in this
 * app names the multi-document read-and-write API (`estrutura.test.ts`), so there is no
 * transaction-inventory row.
 *
 * ## `seq` — which dispatch may run
 *
 * The task carries the `seq` it was enqueued for; the document stores the current one
 * ({@link decidirDespachoLi}):
 *
 *  - `payload.seq == stored.seq` and the job is `pendente` or `executando` ⇒ `executar`;
 *  - `payload.seq == stored.seq − 1` and the job is `executando` ⇒ `continuacao`: this task already
 *    wrote its end-of-dispatch checkpoint and its hand-off may have failed. It only re-enqueues the
 *    NAMED successor (`idTarefaImportacaoLi(jobId, stored.seq)`; an existing one is success) and
 *    stops;
 *  - anything else ⇒ `nada`: a stale chain, a finished or cancelled job.
 *
 * A unit checkpoint keeps `seq`; only the end-of-dispatch checkpoint writes `seq + 1`, so a dispatch
 * retried before its last checkpoint resumes from its last unit checkpoint, and one retried after it
 * finds `stored − 1` and only hands off. The queue's LAST attempt has no retry to do that: it
 * re-reads the job itself ({@link relerJobLi}), and one found at `stored − 1` is handed off there,
 * never stamped for that failure — with the dispatch's own delay when the stored job holds ITS end
 * patch ({@link patchDoFimDoDespachoLi}, {@link guardaOPatchLi}: a checkpoint that LANDED while its
 * call surfaced an error), else as a courtesy at the conservative 60 s that never stamps
 * (`despacho.ts`, "Whose hand-off").
 *
 * ## A lost checkpoint is never re-applied
 *
 * A checkpoint's patch is derived from the dispatch's progress, which started from its job read. On
 * a lost precondition the job is re-read and the patch is DROPPED, never written over the winner:
 *
 *  - the stored job holds the patch AS WRITTEN — every one of its fields — ⇒ it is OUR write
 *    ({@link guardaOPatchLi}), and the checkpoint counts as `gravado` on the stored stamp. The
 *    Admin SDK retries a commit on its own (ABORTED, UNAVAILABLE, RESOURCE_EXHAUSTED) with the same
 *    precondition: when the first commit landed and only its reply was lost, the retry meets the
 *    stamp of its own write and answers 9. Read as a lost race, the end-of-dispatch checkpoint
 *    would stop with nothing queued and the job would sit `executando` at `seq + 1`;
 *  - the job no longer runs at this `seq` (cancelled, ended, gone, or its `seq` moved) ⇒ `parar`,
 *    with the fresh read and its stamp: a job found ONE `seq` ahead and still `executando` (another
 *    dispatch of this `seq` ended its slice, and may never hand off — never this one, whose own
 *    landed write reads `gravado` above) gets a COURTESY hand-off of its named successor from the
 *    dispatch (`despacho.ts`, "Whose hand-off"), never a stamp;
 *  - it still runs at this `seq` — another dispatch of the same `seq` wrote it (a cut dispatch the
 *    platform kept alive, say) ⇒ {@link LiImportacaoConcorrenteError}. The task THROWS, and Cloud
 *    Tasks' retry resumes from whatever is stored.
 *
 * A terminal stamp is different: its cause (the switch, the conta, the attempts, the valve, the end
 * of the work) does not come from the job's progress, so a lost one re-reads and re-decides — and
 * stamps only a job that still runs at its `seq` (at most {@link MAX_TENTATIVAS_ESCRITA_JOB_LI}).
 * A stamp or a cancel whose own write is found stored counts as written, the same way.
 *
 * ## Is it our write? ({@link guardaOPatchLi}) — the fold
 *
 * The RAW stored document against the patch, field by field, through the app's one JSON comparator
 * (`core/igualdadeJsonLi.ts`), which folds key order and nothing else. Equal: every patch field
 * stored with the same value (the progress, `status`, the ms stamps, `seq`). Distinct: any one field
 * differing — another writer's stamp one millisecond apart, a cursor one unit further, `1` vs
 * `'1'`. Every patch carries the writer's own ms stamp, so another writer's patch matches ours
 * only when it is ours in every byte; adopting such a write changes nothing.
 *
 * ## Units
 *
 * Every stamp written here is MILLISECONDS (`atualizadoEmMs`, `concluidoEmMs`), from the caller's
 * clock (`agoraMs`); this module reads no clock.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 *  - The conta's jobs: `integracaoId == <conta> orderBy iniciadoEmMs desc limit 10` — exactly the
 *    `importacoesLojaIntegrada (integracaoId ASC, iniciadoEmMs DESC)` composite declared in
 *    `firestore.indexes.json` and pinned by `importacaoLojaIntegrada.indexes.test.ts`. A third
 *    clause would need its own index in the same commit.
 *  - One job: a read by id.
 *  - One page of a job's report: its own `itens` subcollection in DOCUMENT-KEY order
 *    (`orderBy(FieldPath.documentId())`, `startAfter(<the previous page's last id>)`,
 *    `limit(LIMITE_ITENS_IMPORTACAO_LI + 1)`), no filter. Key order is the collection's native
 *    order, so no composite is involved and the read stops after the page; the subcollection holds
 *    one job's items only. If a measurement on the new project ever shows it scanning beyond the
 *    page, the `__name__`-only index is the remedy.
 */
import {
  FieldPath,
  type DocumentSnapshot,
  type Firestore,
  type Timestamp,
} from 'firebase-admin/firestore';
import {
  importacaoLojaIntegradaCollection,
  itemImportacaoLiCollection,
} from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  type ImportacaoLojaIntegrada,
  LIMITE_IMPORTACOES_LISTADAS_LI,
  LIMITE_ITENS_IMPORTACAO_LI,
  type MotivoFalhaImportacaoLi,
  type RespostaImportacaoLi,
  type RespostaItensImportacaoLi,
  STATUS_EM_CURSO_IMPORTACAO_LI,
  STATUS_IMPORTACAO_LI,
  importacaoLojaIntegradaSchema,
  itemImportacaoLiSchema,
  respostaImportacaoLiSchema,
  respostaItensImportacaoLiSchema,
  statusImportacaoLiSchema,
} from '@delfrance/schemas';

import { deepEqual } from '../core/igualdadeJsonLi';

/** The flow every call and switch line of an import carries (`jsonPayload.fluxo`). */
export const FLUXO_IMPORTACAO_LI = 'importacao';

/** Read-decide-write attempts of a terminal stamp and of the cancel before giving up. */
export const MAX_TENTATIVAS_ESCRITA_JOB_LI = 3;

/**
 * Another dispatch of the SAME `seq` wrote the job between this dispatch's write and its precondition
 * (module header): the progress this dispatch derived is dropped, and the task throws so Cloud
 * Tasks' retry resumes from what is stored. Also thrown when a terminal stamp loses its precondition
 * {@link MAX_TENTATIVAS_ESCRITA_JOB_LI} times in a row. Transient by definition.
 *
 * A plain `Error`, not a `LiAppError`: it is about a job document, not a conta or its credential.
 */
export class LiImportacaoConcorrenteError extends Error {
  readonly jobId: string;
  readonly seq: number;

  constructor(jobId: string, seq: number) {
    super(
      `Outra execução da importação ${jobId} (despacho ${String(seq)}) gravou o job ao mesmo ` +
        'tempo; nada desta execução foi gravado por cima.',
    );
    this.name = 'LiImportacaoConcorrenteError';
    this.jobId = jobId;
    this.seq = seq;
  }
}

/**
 * The cancel lost its precondition {@link MAX_TENTATIVAS_ESCRITA_JOB_LI} times in a row: the job
 * kept checkpointing between the route's read and its write. Nothing was written; the operator may
 * retry, and a retry re-decides from a fresh read.
 */
export class LiCancelamentoEmConflitoError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(
      `A importação ${jobId} gravou um avanço a cada tentativa de cancelar ` +
        `(${String(MAX_TENTATIVAS_ESCRITA_JOB_LI)} tentativas); nada foi gravado.`,
    );
    this.name = 'LiCancelamentoEmConflitoError';
    this.jobId = jobId;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   The reads                                 */
/* -------------------------------------------------------------------------- */

/** One job as read: the parsed document and its commit stamp (the next write's precondition). */
export interface JobLidoLi {
  readonly jobId: string;
  readonly job: ImportacaoLojaIntegrada;
  readonly versao: Timestamp;
  /**
   * The document's own `createTime`: the job's start on the SERVER's clock, which a link's
   * `createTime` is compared against (`vinculos.ts`, "A link this job created").
   */
  readonly criacao: Timestamp;
}

/** A read snapshot as a {@link JobLidoLi}, or `null` when the document is absent. */
function jobDoSnapshot(jobId: string, snap: DocumentSnapshot): JobLidoLi | null {
  if (!snap.exists || snap.updateTime === undefined || snap.createTime === undefined) return null;
  // STRICT: the job is written only through its own schema, so a document that does not parse is
  // corruption, never a shape to tolerate — the `ZodError` surfaces (a 500, or a task retry).
  return {
    jobId,
    job: importacaoLojaIntegradaSchema.parse(snap.data()),
    versao: snap.updateTime,
    criacao: snap.createTime,
  };
}

/** The job by id, or `null` when there is none. Throws `ZodError` on a document that does not parse. */
export async function lerJobLi(db: Firestore, jobId: string): Promise<JobLidoLi | null> {
  const snap = await importacaoLojaIntegradaCollection.docRef(db, {}, jobId).get();
  return jobDoSnapshot(jobId, snap);
}

/** A re-read after a lost write: the job, and its RAW stored fields ({@link guardaOPatchLi}). */
export interface ReleituraLi {
  readonly lido: JobLidoLi;
  readonly dados: unknown;
}

/**
 * The job by id with its RAW stored fields, or `null` when there is none: the read that asks "is
 * it our write?" ({@link guardaOPatchLi}) — here after a lost write, and in the dispatch's last
 * attempt about its own end-of-dispatch checkpoint (`despacho.ts`).
 */
export async function relerJobLi(db: Firestore, jobId: string): Promise<ReleituraLi | null> {
  const snap = await importacaoLojaIntegradaCollection.docRef(db, {}, jobId).get();
  const lido = jobDoSnapshot(jobId, snap);
  return lido === null ? null : { lido, dados: snap.data() };
}

/**
 * Whether the RAW stored job holds every field of `patch` with the value written (module header,
 * "Is it our write?"): the lost write was our own, stored before its reply was lost. Pure.
 */
export function guardaOPatchLi(dados: unknown, patch: Readonly<Record<string, unknown>>): boolean {
  if (typeof dados !== 'object' || dados === null) return false;
  return Object.entries(patch).every(
    ([chave, valor]) => Object.hasOwn(dados, chave) && deepEqual(Reflect.get(dados, chave), valor),
  );
}

/**
 * The job by id when it belongs to `contaId`; `null` when there is none AND when it is another
 * conta's — the routes answer both with ONE 404, so a caller of one conta cannot probe another's ids.
 */
export async function lerJobDaContaLi(
  db: Firestore,
  contaId: string,
  jobId: string,
): Promise<JobLidoLi | null> {
  const lido = await lerJobLi(db, jobId);
  return lido !== null && lido.job.integracaoId === contaId ? lido : null;
}

/** The conta's newest jobs, newest first: the one indexed query (module header). */
function consultaDaConta(db: Firestore, contaId: string) {
  return importacaoLojaIntegradaCollection
    .ref(db, {})
    .where('integracaoId', '==', contaId)
    .orderBy('iniciadoEmMs', 'desc')
    .limit(LIMITE_IMPORTACOES_LISTADAS_LI);
}

/**
 * The id of the conta's RUNNING job (`pendente` or `executando`) among its newest
 * {@link LIMITE_IMPORTACOES_LISTADAS_LI}, or `null`: the start guard.
 *
 * It reads each document's `status` RAW, never through the whole schema, so a job whose other
 * fields no longer parse still blocks a second start when its status says it runs. One running job
 * per conta means a running one is always among the newest: no start can be accepted while it runs.
 * Two starts in the same instant can both pass (there is no lock) — every write of a job is
 * idempotent, so the second run redoes work and changes nothing (the accepted residual).
 */
export async function jobEmCursoDaContaLi(db: Firestore, contaId: string): Promise<string | null> {
  const snap = await consultaDaConta(db, contaId).get();
  for (const doc of snap.docs) {
    const dados: unknown = doc.data();
    const bruto =
      typeof dados === 'object' && dados !== null ? Reflect.get(dados, 'status') : undefined;
    const status = statusImportacaoLiSchema.safeParse(bruto);
    if (status.success && STATUS_EM_CURSO_IMPORTACAO_LI.has(status.data)) return doc.id;
  }
  return null;
}

/** The conta's newest jobs, projected for the list route (newest first). */
export async function listarImportacoesDaContaLi(
  db: Firestore,
  contaId: string,
): Promise<RespostaImportacaoLi[]> {
  const snap = await consultaDaConta(db, contaId).get();
  return snap.docs.map((doc) =>
    projetarImportacaoLi(doc.id, importacaoLojaIntegradaSchema.parse(doc.data())),
  );
}

/**
 * The route answer of one job, built BY NAME and parsed through `respostaImportacaoLiSchema`: the
 * cursors, the maps, the selection's ids and — above all — `seq` (the continuation is the backend's
 * own) never ride along.
 */
export function projetarImportacaoLi(
  jobId: string,
  job: ImportacaoLojaIntegrada,
): RespostaImportacaoLi {
  return respostaImportacaoLiSchema.parse({
    jobId,
    integracaoId: job.integracaoId,
    status: job.status,
    fase: job.fase,
    motivo: job.motivo,
    modo: job.modo,
    alvo: job.alvo,
    acao: job.acao,
    categorias: job.categorias,
    fotos: job.fotos,
    selecionados: job.selecionados.length,
    simulacaoId: job.simulacaoId,
    iniciadoEmMs: job.iniciadoEmMs,
    atualizadoEmMs: job.atualizadoEmMs,
    concluidoEmMs: job.concluidoEmMs,
    contadores: job.contadores,
    listagem: {
      paginas: job.listagem.paginas,
      linhas: job.listagem.linhas,
      totalLi: job.listagem.totalLi,
      divergente: job.listagem.divergente,
    },
    pausas429: job.pausas429,
    fotosIndisponiveis: job.fotosIndisponiveis,
  });
}

/**
 * The grammar of the items route's `?depois=` cursor: what a report item's document id can be
 * (`itens/{liId}`, a store id's decimal digits), so the value is always a plain document id —
 * the key cursor's own requirement. A cursor naming no item still pages on by key order; nothing
 * here decides whether two ids are the same.
 */
const CURSOR_DE_ITENS_LI = /^[0-9]{1,16}$/;

/** Whether `depois` is a usable cursor of the items route ({@link CURSOR_DE_ITENS_LI}). */
export function ehCursorDeItensLi(depois: string): boolean {
  return CURSOR_DE_ITENS_LI.test(depois);
}

/**
 * One page of a job's report: at most {@link LIMITE_ITENS_IMPORTACAO_LI} items in document-key
 * order after `depois` (exclusive; `null` = the first page). `proximo` is the last item's id when
 * another item follows (read as the page's one extra document), else `null`. Each item parsed
 * STRICTLY (the job writes them through their schema), and the answer built through
 * `respostaItensImportacaoLiSchema`.
 *
 * The caller has already checked that the job is the conta's ({@link lerJobDaContaLi}).
 */
export async function lerItensDaImportacaoLi(
  db: Firestore,
  jobId: string,
  depois: string | null,
): Promise<RespostaItensImportacaoLi> {
  let consulta = itemImportacaoLiCollection.ref(db, { jobId }).orderBy(FieldPath.documentId());
  if (depois !== null) consulta = consulta.startAfter(depois);
  const snap = await consulta.limit(LIMITE_ITENS_IMPORTACAO_LI + 1).get();
  const pagina = snap.docs.slice(0, LIMITE_ITENS_IMPORTACAO_LI);
  const proximo =
    snap.docs.length > LIMITE_ITENS_IMPORTACAO_LI ? (pagina.at(-1)?.id ?? null) : null;
  return respostaItensImportacaoLiSchema.parse({
    itens: pagina.map((doc) => itemImportacaoLiSchema.parse(doc.data())),
    proximo,
  });
}

/* -------------------------------------------------------------------------- */
/*                               The seq decision                              */
/* -------------------------------------------------------------------------- */

/** What a dispatch enqueued for `seq` may do with the job as stored (module header). */
export type DecisaoDespachoLi = 'executar' | 'continuacao' | 'nada';

/** Named members of {@link DecisaoDespachoLi}. */
export const DECISAO_DESPACHO_LI = {
  executar: 'executar',
  continuacao: 'continuacao',
  nada: 'nada',
} as const satisfies Record<string, DecisaoDespachoLi>;

/** The `seq` check and the continuation check (module header). Pure. */
export function decidirDespachoLi(
  job: Pick<ImportacaoLojaIntegrada, 'status' | 'seq'>,
  seq: number,
): DecisaoDespachoLi {
  if (seq === job.seq && STATUS_EM_CURSO_IMPORTACAO_LI.has(job.status)) {
    return DECISAO_DESPACHO_LI.executar;
  }
  if (seq === job.seq - 1 && job.status === STATUS_IMPORTACAO_LI.executando) {
    return DECISAO_DESPACHO_LI.continuacao;
  }
  return DECISAO_DESPACHO_LI.nada;
}

/* -------------------------------------------------------------------------- */
/*                                The checkpoints                              */
/* -------------------------------------------------------------------------- */

/**
 * The job fields a checkpoint may write: the phase, the cursors, the catalogue's maps, the Simular
 * overlay, the counters, the 429 pauses and the photo flag. Never the status, `seq`, the motivo, the
 * end stamp, the conta or the options — each has its own writer. Whole values only: a cursor is
 * written as a whole object (a partial one would be completed with defaults by the schema and reset
 * its other fields), which the `Pick` of the parsed type enforces.
 */
export type ProgressoImportacaoLi = Partial<
  Pick<
    ImportacaoLojaIntegrada,
    | 'fase'
    | 'catalogo'
    | 'listagem'
    | 'lixeira'
    | 'orfaos'
    | 'familias'
    | 'aprendizado'
    | 'revisao'
    | 'mapaCategorias'
    | 'marcas'
    | 'aprendizadosSimulados'
    | 'contadores'
    | 'pausas429'
    | 'fotosIndisponiveis'
  >
>;

/** The keys of {@link ProgressoImportacaoLi}, checked at run time too (an untyped caller). */
const CAMPOS_DE_PROGRESSO: ReadonlySet<string> = new Set([
  'fase',
  'catalogo',
  'listagem',
  'lixeira',
  'orfaos',
  'familias',
  'aprendizado',
  'revisao',
  'mapaCategorias',
  'marcas',
  'aprendizadosSimulados',
  'contadores',
  'pausas429',
  'fotosIndisponiveis',
]);

/** Where a dispatch writes: its job, the `seq` it runs at, and its chained precondition. */
export interface AlvoDoDespachoLi {
  readonly jobId: string;
  readonly seq: number;
  /** The `writeTime` of this dispatch's previous write, or its job read's `updateTime`. */
  readonly versao: Timestamp;
}

/** How a checkpoint ended. */
export type ResultadoCheckpointLi =
  /** Written: `versao` is the precondition of the next write. */
  | { readonly tipo: 'gravado'; readonly versao: Timestamp }
  /**
   * Not written, and the dispatch STOPS: the job is cancelled, ended, gone (`job: null`) or runs at
   * another `seq`. `job` is the fresh read and `versao` its `updateTime` (both `null` when gone):
   * a job found one `seq` ahead, still `executando`, gets a courtesy hand-off (`despacho.ts`), which
   * never writes the job, so `versao` chains nothing there.
   */
  | {
      readonly tipo: 'parar';
      readonly job: ImportacaoLojaIntegrada | null;
      readonly versao: Timestamp | null;
    };

/** The patch a checkpoint writes, exactly as written (and as {@link guardaOPatchLi} compares it). */
function patchDoCheckpoint(
  alvo: AlvoDoDespachoLi,
  progresso: ProgressoImportacaoLi,
  agoraMs: number,
  fimDoDespacho: boolean,
): Partial<ImportacaoLojaIntegrada> {
  for (const campo of Object.keys(progresso)) {
    if (!CAMPOS_DE_PROGRESSO.has(campo)) {
      throw new TypeError(`job: o checkpoint não escreve o campo '${campo}'`);
    }
  }
  return importacaoLojaIntegradaCollection.parseMerge({
    ...progresso,
    status: STATUS_IMPORTACAO_LI.executando,
    atualizadoEmMs: agoraMs,
    ...(fimDoDespacho ? { seq: alvo.seq + 1 } : {}),
  });
}

/**
 * The patch {@link gravarCheckpointDoFimDoDespachoLi} writes for the same arguments, byte for byte.
 * The dispatch keeps it to tell, on its last attempt, ITS landed end-of-dispatch checkpoint from
 * another dispatch's ({@link guardaOPatchLi} on a {@link relerJobLi}): every patch carries the
 * writer's own ms stamp (module header, "Is it our write?"). Pure.
 */
export function patchDoFimDoDespachoLi(
  alvo: AlvoDoDespachoLi,
  progresso: ProgressoImportacaoLi,
  agoraMs: number,
): Partial<ImportacaoLojaIntegrada> {
  return patchDoCheckpoint(alvo, progresso, agoraMs, true);
}

async function gravarCheckpoint(
  db: Firestore,
  alvo: AlvoDoDespachoLi,
  progresso: ProgressoImportacaoLi,
  agoraMs: number,
  fimDoDespacho: boolean,
): Promise<ResultadoCheckpointLi> {
  const patch = patchDoCheckpoint(alvo, progresso, agoraMs, fimDoDespacho);
  const ref = importacaoLojaIntegradaCollection.docRef(db, {}, alvo.jobId);
  try {
    const { writeTime } = await ref.update(patch, { lastUpdateTime: alvo.versao });
    return { tipo: 'gravado', versao: writeTime };
  } catch (err) {
    if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
  }
  // Lost: re-read, and NEVER re-apply this patch (module header).
  const relido = await relerJobLi(db, alvo.jobId);
  if (relido === null) return { tipo: 'parar', job: null, versao: null };
  // Our own write, stored before its reply was lost: written, on the stored stamp.
  if (guardaOPatchLi(relido.dados, patch)) return { tipo: 'gravado', versao: relido.lido.versao };
  if (decidirDespachoLi(relido.lido.job, alvo.seq) !== DECISAO_DESPACHO_LI.executar) {
    return { tipo: 'parar', job: relido.lido.job, versao: relido.lido.versao };
  }
  throw new LiImportacaoConcorrenteError(alvo.jobId, alvo.seq);
}

/**
 * The checkpoint after ONE unit: the progress, `status: executando` and `atualizadoEmMs`, at the
 * SAME `seq`, on the chained precondition. A cancel landing between two units fails it, and the
 * dispatch stops at the next unit.
 *
 * @throws {LiImportacaoConcorrenteError} when another dispatch of the same `seq` wrote the job.
 */
export function gravarCheckpointDaUnidadeLi(
  db: Firestore,
  alvo: AlvoDoDespachoLi,
  progresso: ProgressoImportacaoLi,
  agoraMs: number,
): Promise<ResultadoCheckpointLi> {
  return gravarCheckpoint(db, alvo, progresso, agoraMs, false);
}

/**
 * The LAST checkpoint of a dispatch: the same, plus `seq: alvo.seq + 1`. Only after it lands does
 * the dispatch enqueue the successor `idTarefaImportacaoLi(jobId, alvo.seq + 1)`; a retry that finds
 * the bumped `seq` only re-enqueues it (the continuation check).
 *
 * @throws {LiImportacaoConcorrenteError} when another dispatch of the same `seq` wrote the job.
 */
export function gravarCheckpointDoFimDoDespachoLi(
  db: Firestore,
  alvo: AlvoDoDespachoLi,
  progresso: ProgressoImportacaoLi,
  agoraMs: number,
): Promise<ResultadoCheckpointLi> {
  return gravarCheckpoint(db, alvo, progresso, agoraMs, true);
}

/* -------------------------------------------------------------------------- */
/*                               The terminal stamps                           */
/* -------------------------------------------------------------------------- */

/** How a job ends from inside: done, or failed with its closed motivo. */
export type DesfechoImportacaoLi =
  | { readonly status: typeof STATUS_IMPORTACAO_LI.concluido }
  | {
      readonly status: typeof STATUS_IMPORTACAO_LI.falhou;
      readonly motivo: MotivoFalhaImportacaoLi;
    };

/** How a terminal stamp ended. */
export type ResultadoEncerramentoLi =
  | { readonly tipo: 'encerrado'; readonly versao: Timestamp }
  /** Nothing written: the job already ended, was cancelled, is gone or runs at another `seq`. */
  | { readonly tipo: 'ja-encerrado'; readonly job: ImportacaoLojaIntegrada | null };

/**
 * Stamp a job `concluido`, or `falhou` with its motivo, from the dispatch enqueued for `alvo.seq`
 * (the trigger's closed-valve stamp is the dispatch-0 case). Read-decide-write, tier 1: the first
 * attempt writes on `alvo.versao` when given (the dispatch's chain), otherwise on a fresh read; a
 * lost precondition re-reads and re-decides. Only a job that still runs at `alvo.seq`
 * ({@link decidirDespachoLi} = `executar`) is stamped, so a cancel that won is never overwritten.
 *
 * @throws {LiImportacaoConcorrenteError} after {@link MAX_TENTATIVAS_ESCRITA_JOB_LI} lost preconditions.
 */
export async function encerrarImportacaoLi(
  db: Firestore,
  alvo: { readonly jobId: string; readonly seq: number; readonly versao: Timestamp | null },
  desfecho: DesfechoImportacaoLi,
  agoraMs: number,
): Promise<ResultadoEncerramentoLi> {
  const patch = importacaoLojaIntegradaCollection.parseMerge({
    status: desfecho.status,
    motivo: desfecho.status === STATUS_IMPORTACAO_LI.falhou ? desfecho.motivo : null,
    atualizadoEmMs: agoraMs,
    concluidoEmMs: agoraMs,
  });
  const ref = importacaoLojaIntegradaCollection.docRef(db, {}, alvo.jobId);
  let versao = alvo.versao;
  let escritas = 0;
  for (;;) {
    if (versao === null) {
      const relido = await relerJobLi(db, alvo.jobId);
      if (relido === null) return { tipo: 'ja-encerrado', job: null };
      // After a lost write: our own stamp, stored before its reply was lost (module header).
      if (escritas > 0 && guardaOPatchLi(relido.dados, patch)) {
        return { tipo: 'encerrado', versao: relido.lido.versao };
      }
      if (decidirDespachoLi(relido.lido.job, alvo.seq) !== DECISAO_DESPACHO_LI.executar) {
        return { tipo: 'ja-encerrado', job: relido.lido.job };
      }
      if (escritas >= MAX_TENTATIVAS_ESCRITA_JOB_LI) {
        throw new LiImportacaoConcorrenteError(alvo.jobId, alvo.seq);
      }
      versao = relido.lido.versao;
    }
    escritas += 1;
    try {
      const { writeTime } = await ref.update(patch, { lastUpdateTime: versao });
      return { tipo: 'encerrado', versao: writeTime };
    } catch (err) {
      // Lost the race, or the doc was removed: re-read and re-decide. Never re-apply blindly.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
      versao = null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                   The cancel                                */
/* -------------------------------------------------------------------------- */

/** How a cancel ended. */
export type ResultadoCancelamentoLi =
  /** Stamped `cancelado`; `resposta` is the job as written, projected. */
  | { readonly tipo: 'cancelado'; readonly resposta: RespostaImportacaoLi }
  /** No such job, or another conta's (one answer). Nothing written. */
  | { readonly tipo: 'nao-encontrada' }
  /** The job already ended (`concluido`, `falhou` or `cancelado`). Nothing written. */
  | { readonly tipo: 'encerrada' };

/**
 * Cancel a running job (`pendente` or `executando`) of `contaId`: tier 1 on the route's own read,
 * re-read and re-decided on a lost precondition, at most {@link MAX_TENTATIVAS_ESCRITA_JOB_LI}
 * attempts. The dispatch needs no cooperation: its next checkpoint loses its precondition, re-reads,
 * sees `cancelado` and stops. A job with no worker at all (a dispatch that never ran) is recovered
 * the same way.
 *
 * @throws {LiCancelamentoEmConflitoError} after {@link MAX_TENTATIVAS_ESCRITA_JOB_LI} lost preconditions.
 */
export async function cancelarImportacaoLi(
  db: Firestore,
  contaId: string,
  jobId: string,
  agoraMs: number,
): Promise<ResultadoCancelamentoLi> {
  const ref = importacaoLojaIntegradaCollection.docRef(db, {}, jobId);
  const patch = importacaoLojaIntegradaCollection.parseMerge({
    status: STATUS_IMPORTACAO_LI.cancelado,
    atualizadoEmMs: agoraMs,
    concluidoEmMs: agoraMs,
  });
  let escritas = 0;
  for (;;) {
    // Every decision below is derived from THIS attempt's read.
    const relido = await relerJobLi(db, jobId);
    const lido = relido !== null && relido.lido.job.integracaoId === contaId ? relido.lido : null;
    if (lido === null) return { tipo: 'nao-encontrada' };
    // After a lost write: our own cancel, stored before its reply was lost (module header).
    if (escritas > 0 && guardaOPatchLi(relido?.dados, patch)) {
      return { tipo: 'cancelado', resposta: projetarImportacaoLi(jobId, lido.job) };
    }
    if (!STATUS_EM_CURSO_IMPORTACAO_LI.has(lido.job.status)) return { tipo: 'encerrada' };
    if (escritas >= MAX_TENTATIVAS_ESCRITA_JOB_LI) throw new LiCancelamentoEmConflitoError(jobId);
    escritas += 1;
    try {
      await ref.update(patch, { lastUpdateTime: lido.versao });
      return {
        tipo: 'cancelado',
        resposta: projetarImportacaoLi(jobId, { ...lido.job, ...patch }),
      };
    } catch (err) {
      // Lost the race, or the doc was removed: loop, re-read, re-decide. Never re-apply this write.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
}
