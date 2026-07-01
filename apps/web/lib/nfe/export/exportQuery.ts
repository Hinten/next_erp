/**
 * Mass-export Firestore reads (#11), all via the Firebase **client** SDK.
 *
 * Server-side query only: `collectionGroup('nfev4')` filtered by `data_emissao`
 * range + optional `filialId` + optional `estado in [...]`. This Firestore
 * Enterprise edition runs every filter index-free (an unindexed query scans, it
 * never throws), so there is NO client-side filtering — each page streams straight
 * into the ZIP / CSV builders and the raw XML is never all held in memory.
 * (`data_emissao` and `[filialId, data_emissao]` are indexed for cost.)
 *
 * Rules already authorize this: `match /{path=**}/nfev4/{docId} { allow read: if
 * p('d_nfe', 1) }` is in the generated ruleset.
 */
import {
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  getCountFromServer,
  getDocs,
  startAfter,
} from 'firebase/firestore';
import { buildQuery, groupQuery, limit, orderByField, whereOp } from '@delfrance/data';
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import { nfeCollection } from '@/lib/data/nfeCollection';

import type { ExportFilter, ExportSource, NfeNote } from './types';

const NFEV4_GROUP = 'nfev4';
const PAGE = 500;

type NfeDoc = QueryDocumentSnapshot<NotaFiscalEletronica>;

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

/**
 * The full server-side query: `data_emissao` ms-epoch range + optional `filialId`
 * + optional `estado in [...]`, ordered by emission. Since #220 `data_emissao` is
 * a number, so the range compares ms directly. Output número-ordering is done by
 * the ZIP/CSV builders (they sort the buffered rows by `(série, número)`), so the
 * query carries no `numeracao` sort key.
 *
 * Every filter runs server-side: this Firestore Enterprise edition executes a
 * query with no matching index (it scans, it never throws), so `estado` rides
 * along index-free instead of being post-filtered in the browser. `data_emissao`
 * and `[filialId, data_emissao]` are indexed in `firestore.indexes.json` for cost
 * on the common date / date+filial queries. An empty `estados` means "todos" → no
 * `estado` constraint. `data_emissao` (plus the implicit document-key tiebreak)
 * orders the page cursor, so `startAfter(lastDoc)` pages completely with no
 * skipped or duplicated notes.
 */
export function buildExportQuery(db: Firestore, filter: ExportFilter): Query<NotaFiscalEletronica> {
  const base = groupQuery(db, NFEV4_GROUP, nfeCollection.converter);
  const constraints = [
    whereOp('data_emissao', '>=', filter.startMs),
    whereOp('data_emissao', '<=', filter.endMs),
  ];
  if (filter.filialId) constraints.push(whereOp('filialId', '==', filter.filialId));
  if (filter.estados.length) constraints.push(whereOp('estado', 'in', filter.estados));
  constraints.push(orderByField('data_emissao'));
  return buildQuery(base, constraints);
}

function toNote(d: NfeDoc): NfeNote {
  const n = d.data();
  return {
    id: d.id,
    path: d.ref.path,
    chave: n.chave ?? null,
    numeracao: n.numeracao,
    serie: n.serie,
    estado: n.estado,
    dataEmissao: n.data_emissao ?? null,
    xmlNfeProc: n.xml_nfe_proc ?? null,
  };
}

/** Paginated note stream — every filter is in the server query, so each page is
 * yielded as-is (no client-side filtering). Cursor pagination on `data_emissao`. */
export async function* pageNotes(db: Firestore, filter: ExportFilter): AsyncGenerator<NfeNote[]> {
  const baseQ = buildExportQuery(db, filter);
  let cursor: NfeDoc | undefined;

  for (;;) {
    const pageConstraints = cursor ? [limit(PAGE), startAfter(cursor)] : [limit(PAGE)];
    const snap = await getDocs(buildQuery(baseQ, pageConstraints));
    if (snap.empty) break;
    const docs = snap.docs as NfeDoc[];

    yield docs.map(toNote);

    if (docs.length < PAGE) break;
    cursor = docs[docs.length - 1];
  }
}

/** Lightweight preview for the screen: the server-side total + the first
 * `sampleSize` notes. Stops paging early. */
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

/** Pre-flight count + paged stream + filename stamp. Every filter is server-side,
 * so `preCount` (the count query) equals the scanned total — the builders assert
 * `processed === preCount` to guarantee a complete, never-truncated export. */
export async function buildExportSource(
  db: Firestore,
  filter: ExportFilter,
): Promise<ExportSource> {
  const countSnap = await getCountFromServer(buildExportQuery(db, filter));
  return {
    preCount: countSnap.data().count,
    stamp: rangeStamp(filter.startMs, filter.endMs),
    pages: pageNotes(db, filter),
  };
}
