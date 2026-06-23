/**
 * Mass-export Firestore reads (#11), all via the Firebase **client** SDK.
 *
 * Server-side query: `collectionGroup('nfev4')` filtered by `data_emissao` range
 * + optional `filialId` equality (the composite index lives in
 * `firestore.indexes.json`). Estado + operação are post-filtered client-side
 * (cheap; avoids index combinatorics). The page stream is consumed by the ZIP /
 * CSV builders so the raw XML is never all held in memory.
 *
 * Rules already authorize this: `match /{path=**}/nfev4/{docId} { allow read: if
 * p('d_nfe', 1) }` is in the generated ruleset.
 */
import {
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  documentId,
  getCountFromServer,
  getDocs,
  startAfter,
  where,
} from 'firebase/firestore';
import { buildQuery, groupQuery, limit, orderByField, whereOp } from '@delfrance/data';
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import { nfeCollection } from '@/lib/data/nfeCollection';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

import type { ExportFilter, ExportSource, NfeNote } from './types';

const NFEV4_GROUP = 'nfev4';
const PAGE = 500;
/** Firestore caps `in` membership at 30 ids per query. */
const OPERACAO_BATCH = 30;

type NfeDoc = QueryDocumentSnapshot<NotaFiscalEletronica>;

/** ms-epoch bounds → ISO strings. `data_emissao` is stored UTC-normalized
 * (`z.string().datetime()` rejects offsets), matching `toISOString()`, so the
 * lexicographic range is correct. The caller passes local day bounds. */
export function dayBoundsIso(startMs: number, endMs: number): { startIso: string; endIso: string } {
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

/** `<YYYYMMDD>-<YYYYMMDD>` stamp for the artifact filename. */
export function rangeStamp(startMs: number, endMs: number): string {
  const ymd = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  };
  return `${ymd(startMs)}-${ymd(endMs)}`;
}

/** The server-side query shape (date range + optional filial), ordered by emission. */
export function buildExportQuery(db: Firestore, filter: ExportFilter): Query<NotaFiscalEletronica> {
  const { startIso, endIso } = dayBoundsIso(filter.startMs, filter.endMs);
  const base = groupQuery(db, NFEV4_GROUP, nfeCollection.converter);
  const constraints = [
    whereOp('data_emissao', '>=', startIso),
    whereOp('data_emissao', '<=', endIso),
  ];
  if (filter.filialId) constraints.push(whereOp('filialId', '==', filter.filialId));
  constraints.push(orderByField('data_emissao'));
  return buildQuery(base, constraints);
}

function toNote(d: NfeDoc): NfeNote {
  const n = d.data();
  return {
    id: d.id,
    chave: n.chave ?? null,
    numeracao: n.numeracao,
    serie: n.serie,
    estado: n.estado,
    dataEmissao: n.data_emissao ?? null,
    xmlNfeProc: n.xml_nfe_proc ?? null,
  };
}

/** Keep only notes whose parent pedido points at `operacaoId`. Batched parent
 * reads (30/`in` query) — the one extra cost when the operação filter is on. */
async function filterByOperacao(
  db: Firestore,
  docs: readonly NfeDoc[],
  operacaoId: string,
): Promise<NfeDoc[]> {
  const pedidoIds = [
    ...new Set(docs.map((d) => d.ref.parent.parent?.id).filter((x): x is string => !!x)),
  ];
  const matched = new Set<string>();
  for (let i = 0; i < pedidoIds.length; i += OPERACAO_BATCH) {
    const batch = pedidoIds.slice(i, i + OPERACAO_BATCH);
    const snap = await getDocs(
      buildQuery(pedidoCollection.ref(db, {}), [where(documentId(), 'in', batch)]),
    );
    for (const p of snap.docs) {
      const ref = dereferenceOuterRef(
        db,
        (p.data() as { operacaoPedidoOuterRef?: unknown }).operacaoPedidoOuterRef,
      );
      if (ref?.id === operacaoId) matched.add(p.id);
    }
  }
  return docs.filter((d) => {
    const pid = d.ref.parent.parent?.id;
    return pid != null && matched.has(pid);
  });
}

/** Paginated note stream. Each page is fetched server-side then estado/operação
 * filtered client-side. Pagination advances on the **full** page's last doc so
 * client-side filtering never skips notes. */
export async function* pageNotes(db: Firestore, filter: ExportFilter): AsyncGenerator<NfeNote[]> {
  const baseQ = buildExportQuery(db, filter);
  const estadoSet = filter.estados.length ? new Set(filter.estados) : null;
  let cursor: NfeDoc | undefined;

  for (;;) {
    const pageConstraints = cursor ? [limit(PAGE), startAfter(cursor)] : [limit(PAGE)];
    const snap = await getDocs(buildQuery(baseQ, pageConstraints));
    if (snap.empty) break;
    const docs = snap.docs as NfeDoc[];

    let kept: readonly NfeDoc[] = docs;
    if (estadoSet) kept = kept.filter((d) => estadoSet.has(d.data().estado));
    if (filter.operacaoId) kept = await filterByOperacao(db, kept, filter.operacaoId);

    if (kept.length) yield kept.map(toNote);

    if (docs.length < PAGE) break;
    cursor = docs[docs.length - 1];
  }
}

/** Lightweight preview for the screen: the server-side total + the first
 * `sampleSize` notes (post estado/operação filter). Stops paging early. */
export async function previewExport(
  db: Firestore,
  filter: ExportFilter,
  sampleSize = 50,
): Promise<{ preCount: number; sample: NfeNote[] }> {
  const countSnap = await getCountFromServer(buildExportQuery(db, filter));
  const sample: NfeNote[] = [];
  for await (const page of pageNotes(db, filter)) {
    for (const note of page) {
      sample.push(note);
      if (sample.length >= sampleSize) break;
    }
    if (sample.length >= sampleSize) break;
  }
  return { preCount: countSnap.data().count, sample };
}

/** Pre-flight count + paged stream + filename stamp. `exact` is true only when no
 * client-side filter narrows the set, so the builders can assert completeness. */
export async function buildExportSource(
  db: Firestore,
  filter: ExportFilter,
): Promise<ExportSource> {
  const countSnap = await getCountFromServer(buildExportQuery(db, filter));
  const preCount = countSnap.data().count;
  const exact = filter.estados.length === 0 && !filter.operacaoId;
  return {
    preCount,
    exact,
    stamp: rangeStamp(filter.startMs, filter.endMs),
    pages: pageNotes(db, filter),
  };
}
