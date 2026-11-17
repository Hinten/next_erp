/**
 * The product import's TAX-REVIEW LIST as READ (master plan step 9): a job's whole `revisao/*`
 * subcollection, its order, and one stored entry read field by field. Two surfaces read through
 * it — the `revisao` phase (`revisaoFiscal.ts`), which carries the list forward and re-checks it,
 * and the list route (`GET …/conta/[id]/importacoes/[jobId]/revisao`), which shows it to the
 * operator — so the screen shows exactly the list the phase works on, in the phase's order.
 *
 * ⚠️ It calls nothing outside the ERP: no package, no context loader, no pacer, no read switch. The
 * list route reaches it, and `estrutura.test.ts` walks that route's closure with the label routing
 * route's rules. That is why it is a module of its own: `revisaoFiscal.ts` reaches the package
 * through the dispatch's time budget (`orcamento.ts`).
 *
 * ## The read, against the indexes (root rule 1)
 *
 * A job's `revisao` subcollection is read WHOLE — unfiltered, unordered, no limit, so no index —
 * and sorted IN MEMORY in the produto ids' code-unit order; a page is cut from it in memory
 * ({@link paginaDaListaRevisaoLi}). ⚠️ Never a document-key RANGE (`orderBy(documentId())` +
 * `startAfter` + a limit): Enterprise keeps no implicit key index, so such a page scans the WHOLE
 * list before it is cut, and the list is durable, carried from job to job — `revisaoFiscal.ts`'s
 * header, "The reads", has the measurement and the arithmetic. The phase reads each list once per
 * dispatch ({@link criarLeitorDeListasRevisaoLi}); the route reads it once per request and answers
 * it whole ({@link lerRevisaoFiscalDaImportacaoLi}), because a page per request would re-read the
 * whole list for every page.
 *
 * ## A stored entry that does not parse ({@link lerEntradaRevisaoFiscalLi})
 *
 * Read field by field, never parsed whole, so one unreadable field never loses the entry: its
 * produto is the document's KEY (whatever the body says), a motivo this build does not know is left
 * out, and any other field that does not read is `null`. Dropping the entry would hide a produto
 * whose taxes need a look, and failing the whole answer would hide every other one; this way the
 * route still shows the produto (with what of it reads), and the phase still carries and re-checks
 * it — the re-check needs only the id.
 *
 * Next-free; `db` is a parameter.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { revisaoFiscalImportacaoLiCollection } from '@delfrance/data/admin/collections';
import {
  type RespostaRevisaoFiscalLi,
  type RevisaoFiscalLi,
  motivoRevisaoFiscalLiSchema,
  respostaRevisaoFiscalLiSchema,
  revisaoFiscalLiSchema,
} from '@delfrance/schemas';

/** One entry of a job's list as read: its id (the produto's), its raw data and its document. */
export interface EntradaListadaLi {
  readonly id: string;
  readonly dados: unknown;
  readonly ref: DocumentReference;
}

/** A job's WHOLE list, sorted by id (module header, "The read"), read once per reader. */
export type LeitorDeListasRevisaoLi = (jobId: string) => Promise<readonly EntradaListadaLi[]>;

/** The code-unit order the list is read and paged in (module header): a total order of ids. */
function compararIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A reader of a job's whole `revisao` list, memoised per job for ITS lifetime: one per dispatch, so
 * each list is read at most once per dispatch — never a key range (module header, "The read").
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
export function paginaDaListaRevisaoLi(
  lista: readonly EntradaListadaLi[],
  depois: string | null,
  n: number,
): EntradaListadaLi[] {
  const inicio = depois === null ? 0 : lista.findIndex((e) => compararIds(e.id, depois) > 0);
  return inicio < 0 ? [] : lista.slice(inicio, inicio + n);
}

/**
 * A stored entry read field by field (module header, "A stored entry that does not parse"): its id
 * is the produto (the document's key, whatever the body says), a motivo this build does not know is
 * left out, and any other field that does not read is `null`. Pure.
 */
export function lerEntradaRevisaoFiscalLi(produtoId: string, dados: unknown): RevisaoFiscalLi {
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
 * The list route's answer: job `jobId`'s WHOLE list, each entry read field by field, in the produto
 * ids' code-unit order, in ONE answer (`proximo: null`; the schema says why), built through
 * `respostaRevisaoFiscalLiSchema`. One unfiltered read of the subcollection, nothing else.
 *
 * The caller has already checked that the job is the conta's (`lerJobDaContaLi`, `job.ts`).
 */
export async function lerRevisaoFiscalDaImportacaoLi(
  db: Firestore,
  jobId: string,
): Promise<RespostaRevisaoFiscalLi> {
  const lista = await lerLista(db, jobId);
  return respostaRevisaoFiscalLiSchema.parse({
    entradas: lista.map((e) => lerEntradaRevisaoFiscalLi(e.id, e.dados)),
    proximo: null,
  });
}
