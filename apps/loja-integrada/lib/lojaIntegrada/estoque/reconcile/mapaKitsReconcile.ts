/**
 * The WRITE side of the component → store-kits map (master plan step 12, PR 12-g): at the end of
 * the ERP link walk, per conta, the reconcile turns the snapshot's store kits into
 * `sincEstoqueLojaIntegrada/{conta}/kits/{componente}` headers and their `kitsFatias` shards —
 * the map the stock trigger's eager path and the `estoque-kits` fan-out read (`mapaKitsLi.ts`).
 *
 * ## From the snapshot alone ({@link montarMapaKitsLi}, pure)
 *
 * Every `v` entry with `k` carries its composition as the walk read it (`q`: each bounding
 * component → its quantity in the kit; `e`: each one → the record it resolved to at the conta's
 * depósito). So the map needs no read of a kit or a record: per component, its kits sorted by kit
 * id (`i`, the kit's store id, and the kit's whole `q`), `F` their count, `qMax` its largest
 * quantity in any of them, and `comps` every component of those kits → its record id
 * (deduplicated, the first kit in id order winning). A kit entry without a composition is left
 * out and counted. Every header is parsed with the REFINED schema before it is written — a bug
 * never ships a header the reader calls `invalido`.
 *
 * ## Bounded and resumable (`execucao.mapa` on the conta's root)
 *
 *  1. `escrita`: the components in id order after the cursor, one BATCH per budget unit
 *     (`mapa`), each batch at most {@link MAX_ESCRITAS_LOTE_MAPA_LI} writes and about
 *     {@link MAX_BYTES_LOTE_MAPA_LI} bytes. A component's header and ALL its shards are in ONE
 *     batch — atomic, so no reader ever sees a header beside shards of another run, and the
 *     reader's `completa` (every shard of the header's run, exactly `F` kits) holds as soon as the
 *     batch lands. `F` ≤ {@link MAX_KITS_EM_LINHA_ESTOQUE_LI} ⇒ inline (no shard); more ⇒ shards of
 *     at most {@link MAX_KITS_POR_FATIA_ESTOQUE_LI}. The cursor advances to the batch's last
 *     component.
 *  2. `varredura`, after EVERY component of the run is written: the headers and the shards of
 *     another run are deleted — a component in no store kit any more, a shard past its component's
 *     new `fatias` — listed with a projection of `execucaoId` alone (the conta's own partition, no
 *     index), deleted in batches of the same size. A sweep cut short lists again; what it deleted
 *     is gone. A shard past `fatias` is never read meanwhile (the reader reads shards 0..fatias−1).
 *  3. `feito`: ONE INFO line with the kits-per-component histogram.
 *
 * Every batch is the run document's (`gravarLoteReconcileLi`): it carries the lease's
 * precondition, so a chain that lost its lease can neither write nor sweep. The headers and shards
 * are written whole (`set`) and deleted with no precondition of their own: only the lease holder
 * writes them (`sincEstoqueLojaIntegrada.ts`, "Writers").
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  fatiaKitsComponenteEstoqueLiCollection,
  kitsComponenteEstoqueLiCollection,
} from '@delfrance/data/admin/collections';
import {
  ETAPA_MAPA_ESTOQUE_LI,
  type EntradaSnapshotEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  type KitDoComponenteEstoqueLi,
  MAX_KITS_EM_LINHA_ESTOQUE_LI,
  MAX_KITS_POR_FATIA_ESTOQUE_LI,
  fatiaKitsComponenteEstoqueLiSchema,
  idFatiaKitsEstoqueLi,
  kitsComponenteEstoqueLiSchema,
} from '@delfrance/schemas';

import type { EscritaSincLi } from './execucaoReconcile';
import type { EstadoContaReconcileLi } from './snapshotReconcile';

/** Writes one map batch carries beside the run document. */
export const MAX_ESCRITAS_LOTE_MAPA_LI = 400;

/** The bytes one map batch carries, about (Firestore's request limit is 10 MiB). */
export const MAX_BYTES_LOTE_MAPA_LI = 4_000_000;

/** One component's documents: its header and its shards (none when inline). */
export interface DocumentosDoComponenteLi {
  readonly componenteId: string;
  readonly cabecalho: Readonly<Record<string, unknown>>;
  readonly fatias: readonly (readonly [number, Readonly<Record<string, unknown>>])[];
  /** About the bytes of the header and its shards. */
  readonly bytes: number;
}

/** The map of one conta, as {@link montarMapaKitsLi} builds it. */
export interface MapaKitsMontadoLi {
  /** By component id, in id order. */
  readonly componentes: ReadonlyMap<string, DocumentosDoComponenteLi>;
  /** `v` kit entries the map leaves out: no composition recorded. */
  readonly kitsSemComposicao: number;
  /** Store kits in the map. */
  readonly kits: number;
}

const compararTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The documents of one component (module header): parsed, the header with the REFINED schema. */
function documentosDoComponente(
  execucaoId: string,
  componenteId: string,
  kits: ReadonlyMap<string, KitDoComponenteEstoqueLi>,
  comps: ReadonlyMap<string, string | null>,
): DocumentosDoComponenteLi {
  const ordenados = [...kits].sort(([a], [b]) => compararTexto(a, b));
  const F = ordenados.length;
  const qMax = Math.max(...ordenados.map(([, kit]) => kit.q[componenteId] ?? 0));
  const emLinha = F <= MAX_KITS_EM_LINHA_ESTOQUE_LI;
  const fatias: (readonly [number, Readonly<Record<string, unknown>>])[] = [];
  if (!emLinha) {
    for (let n = 0; n * MAX_KITS_POR_FATIA_ESTOQUE_LI < F; n += 1) {
      const parte = ordenados.slice(
        n * MAX_KITS_POR_FATIA_ESTOQUE_LI,
        (n + 1) * MAX_KITS_POR_FATIA_ESTOQUE_LI,
      );
      fatias.push([
        n,
        fatiaKitsComponenteEstoqueLiSchema.parse({ execucaoId, kits: Object.fromEntries(parte) }),
      ]);
    }
  }
  const cabecalho = kitsComponenteEstoqueLiSchema.parse({
    execucaoId,
    F,
    qMax,
    comps: Object.fromEntries([...comps].sort(([a], [b]) => compararTexto(a, b))),
    kits: emLinha ? Object.fromEntries(ordenados) : null,
    fatias: fatias.length,
  });
  const bytes =
    JSON.stringify(cabecalho).length + fatias.reduce((n, [, f]) => n + JSON.stringify(f).length, 0);
  return { componenteId, cabecalho, fatias, bytes };
}

/** The map of one conta from its snapshot entries (module header). Pure. */
export function montarMapaKitsLi(
  execucaoId: string,
  entradas: Iterable<readonly [string, EntradaSnapshotEstoqueLi]>,
): MapaKitsMontadoLi {
  const kitsPorComponente = new Map<string, Map<string, KitDoComponenteEstoqueLi>>();
  const compsPorComponente = new Map<string, Map<string, string | null>>();
  const doKit: [string, string, EntradaSnapshotEstoqueLi][] = [];
  let kitsSemComposicao = 0;
  for (const [idLi, entrada] of entradas) {
    if (entrada.f !== FLAG_ENTRADA_ESTOQUE_LI.valido || entrada.k !== true || entrada.p === null) {
      continue;
    }
    const q = entrada.q ?? null;
    const e = entrada.e ?? null;
    if (q === null || e === null || Object.keys(q).length === 0) {
      kitsSemComposicao += 1;
      continue;
    }
    doKit.push([entrada.p, idLi, entrada]);
  }
  // Kit-id order, so `comps` keeps the first kit's record of a component (module header).
  doKit.sort(([a], [b]) => compararTexto(a, b));
  for (const [kitId, idLi, entrada] of doKit) {
    const q = entrada.q ?? {};
    const e = entrada.e ?? {};
    for (const componenteId of Object.keys(q)) {
      const kits =
        kitsPorComponente.get(componenteId) ?? new Map<string, KitDoComponenteEstoqueLi>();
      kits.set(kitId, { i: idLi, q: { ...q } });
      kitsPorComponente.set(componenteId, kits);
      const comps = compsPorComponente.get(componenteId) ?? new Map<string, string | null>();
      for (const [c, registro] of Object.entries(e)) {
        if (!comps.has(c)) comps.set(c, registro);
      }
      compsPorComponente.set(componenteId, comps);
    }
  }
  const componentes = new Map<string, DocumentosDoComponenteLi>();
  for (const componenteId of [...kitsPorComponente.keys()].sort(compararTexto)) {
    componentes.set(
      componenteId,
      documentosDoComponente(
        execucaoId,
        componenteId,
        kitsPorComponente.get(componenteId) ?? new Map(),
        compsPorComponente.get(componenteId) ?? new Map(),
      ),
    );
  }
  return { componentes, kitsSemComposicao, kits: doKit.length };
}

/** The kits-per-component histogram the end of a conta's map logs (module header, step 3). */
export function histogramaDeKitsLi(mapa: MapaKitsMontadoLi): Record<string, number> {
  const faixas: [string, number][] = [
    ['f1', 1],
    ['f2a5', 5],
    ['f6a30', 30],
    ['f31a100', 100],
    ['f101a1000', 1000],
  ];
  const saida: Record<string, number> = {
    f1: 0,
    f2a5: 0,
    f6a30: 0,
    f31a100: 0,
    f101a1000: 0,
    acimaDe1000: 0,
  };
  for (const { cabecalho } of mapa.componentes.values()) {
    const F = Number(cabecalho.F);
    const faixa = faixas.find(([, teto]) => F <= teto)?.[0] ?? 'acimaDe1000';
    saida[faixa] = (saida[faixa] ?? 0) + 1;
  }
  return saida;
}

/** One unit's writes of the `escrita` step, and the cursor after them. */
export interface LoteDeEscritaDoMapaLi {
  readonly escritas: readonly EscritaSincLi[];
  /** The last component the batch writes; `null` when nothing is left. */
  readonly ultimoComponenteId: string | null;
  readonly componentes: number;
}

/**
 * The next `escrita` batch of conta `contaId` after `cursor` (exclusive; `null` = from the first):
 * whole components only, in id order, within {@link MAX_ESCRITAS_LOTE_MAPA_LI} writes and
 * {@link MAX_BYTES_LOTE_MAPA_LI} bytes — a component that alone exceeds them still goes, alone.
 */
export function proximoLoteDeEscritaDoMapaLi(
  db: Firestore,
  contaId: string,
  mapa: MapaKitsMontadoLi,
  cursor: string | null,
): LoteDeEscritaDoMapaLi {
  const escritas: EscritaSincLi[] = [];
  let bytes = 0;
  let ultimo: string | null = null;
  let componentes = 0;
  for (const docs of mapa.componentes.values()) {
    if (cursor !== null && docs.componenteId <= cursor) continue;
    const n = 1 + docs.fatias.length;
    if (
      componentes > 0 &&
      (escritas.length + n > MAX_ESCRITAS_LOTE_MAPA_LI ||
        bytes + docs.bytes > MAX_BYTES_LOTE_MAPA_LI)
    ) {
      break;
    }
    for (const [f, fatia] of docs.fatias) {
      escritas.push({
        tipo: 'sobrescrever',
        ref: fatiaKitsComponenteEstoqueLiCollection.docRef(
          db,
          { integracaoId: contaId },
          idFatiaKitsEstoqueLi(docs.componenteId, f),
        ),
        dados: fatia,
      });
    }
    escritas.push({
      tipo: 'sobrescrever',
      ref: kitsComponenteEstoqueLiCollection.docRef(
        db,
        { integracaoId: contaId },
        docs.componenteId,
      ),
      dados: docs.cabecalho,
    });
    bytes += docs.bytes;
    ultimo = docs.componenteId;
    componentes += 1;
  }
  return { escritas, ultimoComponenteId: ultimo, componentes };
}

/**
 * The next `varredura` batch of conta `contaId`: the headers and shards whose `execucaoId` is not
 * `execucaoId` (or that carry none), at most {@link MAX_ESCRITAS_LOTE_MAPA_LI}, from two listings
 * projected to `execucaoId` alone (module header, step 2). Empty when nothing is left.
 */
export async function proximoLoteDeVarreduraDoMapaLi(
  db: Firestore,
  contaId: string,
  execucaoId: string,
): Promise<EscritaSincLi[]> {
  const ctx = { integracaoId: contaId };
  const [cabecalhos, fatias] = await Promise.all([
    kitsComponenteEstoqueLiCollection.ref(db, ctx).select('execucaoId').get(),
    fatiaKitsComponenteEstoqueLiCollection.ref(db, ctx).select('execucaoId').get(),
  ]);
  const velhos = [...cabecalhos.docs, ...fatias.docs].filter((d) => {
    const dados: Record<string, unknown> = d.data();
    return dados.execucaoId !== execucaoId;
  });
  return velhos
    .slice(0, MAX_ESCRITAS_LOTE_MAPA_LI)
    .map((d): EscritaSincLi => ({ tipo: 'apagar', ref: d.ref }));
}

/** Whether the conta's map is done (module header, step 3). */
export function mapaFeitoLi(estado: EstadoContaReconcileLi): boolean {
  return estado.raiz.execucao.mapa?.etapa === ETAPA_MAPA_ESTOQUE_LI.feito;
}
