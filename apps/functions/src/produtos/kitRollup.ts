/**
 * `recalcularDimensoesKit` — recompute a kit's stored weight and box when one of
 * its components changes (#1152).
 *
 * ## Why this exists
 *
 * A kit's `pesoBrutoKg`/`pesoLiquidoKg` are a rollup of its components, but the
 * rollup only ever ran on the CLIENT, while a human had that kit's produto page
 * open. Nothing recomputed it from the other direction, so editing a component's
 * weight left every kit containing it stale forever. That is load-bearing:
 * `pesoPedido` reads the kit's STORED weight (deliberate legacy parity, #1093),
 * so a stale rollup silently produces a wrong freight quote and, once a label is
 * bought, a real carrier re-billing.
 *
 * ## Why a queue, when ADR 0014 rejected exactly this fan-out
 *
 * ADR 0014 rejected a component-driven fan-out over `componentesKitKeys` for
 * STOCK, on measured cost: ~2 000 kits share the same two components, and stock
 * moves on every single sale. Weight and dimensions are the opposite shape — they
 * change only on a rare operator edit — and this fan-out is queued, paged,
 * diffed and superseded rather than run inline on an ingestion path. Same query,
 * different economics; the ADR carries the note.
 *
 * ## Concurrency (root `CLAUDE.md` rule 7 / ADR 0011)
 *
 * Two distinct races, two different tiers:
 *
 *  - **Superseded input** — the operator edits the component again while a
 *    fan-out is still running. TIER 2 (event-clock watermark), with the VALUES
 *    as the clock: every dispatch re-reads the root produto and drops the task
 *    when the five fields no longer match the payload. See `carregarRaiz`.
 *  - **Concurrent writer on a kit** — someone else writes the kit document while
 *    we hold a computed patch for it. TIER 1: `update(..., { lastUpdateTime })`,
 *    so a concurrent change fails `FAILED_PRECONDITION` instead of silently
 *    clobbering. Those are collected and retried once from a fresh read.
 *
 * ## Reads
 *
 * Every component read is memoized for the life of the dispatch
 * ({@link CacheMedidas}) and every distinct component set is computed once
 * ({@link chaveComposicao}). With the shirt+print catalogue that turns ~4 000
 * reads and ~2 000 computations into a handful of each.
 *
 * ⚠️ Deliberately NOT `@delfrance/data/admin/cache`. A process-scoped TTL cache
 * would serve a warm instance the component's PRE-EDIT weight for up to `ttlMs`
 * and persist that onto every kit — the exact bug this function exists to fix,
 * and ADR 0012's own "never cache a value whose staleness is the defect". The
 * per-dispatch memo has a zero staleness bound and captures the whole win.
 */
import { FieldPath } from 'firebase-admin/firestore';
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  QueryDocumentSnapshot,
  Timestamp,
} from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  dimensoesDoKit,
  type ComponentesKit,
  type DimensoesKit,
  type ProdutoMedidas,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { tasksInvokerOptions } from '../tasksInvoker';
import {
  CAMPOS_ROLLUP_KIT,
  KITS_POR_PAGINA,
  PROFUNDIDADE_MAX_KIT,
  SEEDS_POR_CONSULTA,
  kitRollupPayloadSchema,
  lerValoresRollup,
  limitarSeeds,
  valoresRollupDiferem,
  type KitRollupPayload,
  type ValoresRollup,
} from './kitRollupPayload';
import {
  KIT_ROLLUP_MAX_ATTEMPTS,
  KIT_ROLLUP_QUEUE,
  createKitRollupScheduler,
  type KitRollupScheduler,
} from './kitRollupTasks';

/** The produto fields a component contributes to the rollup. */
const CAMPOS_MEDIDAS = [...CAMPOS_ROLLUP_KIT, 'paiId'] as const;

/** The kit fields one page needs. Enterprise bills data scanned — project. */
const CAMPOS_KIT = [...CAMPOS_ROLLUP_KIT, 'componentesKit', 'ehKit'] as const;

/** gRPC `FAILED_PRECONDITION` — what a losing `lastUpdateTime` write returns. */
const GRPC_FAILED_PRECONDITION = 9;

export type KitRollupResultado = 'superseded' | 'raizAusente' | 'concluido' | 'continuando';

export interface KitRollupDeps {
  db: Firestore;
  scheduler: KitRollupScheduler;
}

/* -------------------------------------------------------------------------- */
/*                          component reads (memoized)                        */
/* -------------------------------------------------------------------------- */

const semPesoProprio = (m: ProdutoMedidas) => m.pesoBrutoKg === null || m.pesoLiquidoKg === null;
const semCaixaPropria = (m: ProdutoMedidas) =>
  !((m.alturaCm ?? 0) > 0 && (m.larguraCm ?? 0) > 0 && (m.profundidadeCm ?? 0) > 0);

export function projetarMedidas(data: Record<string, unknown> | undefined): ProdutoMedidas {
  return { ...lerValoresRollup(data), paiId: (data?.paiId as string | null | undefined) ?? null };
}

/**
 * Per-dispatch memo of component medidas. Populated in two waves per page, the
 * same rule the pedido loader uses: every component first, then the PARENT of
 * any component that supplies neither its own weight nor its own box — both
 * fallbacks read from this one map.
 */
export class CacheMedidas {
  private readonly porId = new Map<string, ProdutoMedidas | null>();
  leituras = 0;

  constructor(private readonly db: Firestore) {}

  /** What `dimensoesDoKit` takes: a plain id → medidas record. */
  mapa(): Record<string, ProdutoMedidas | null> {
    return Object.fromEntries(this.porId);
  }

  semear(id: string, medidas: ProdutoMedidas | null): void {
    this.porId.set(id, medidas);
  }

  async carregar(ids: readonly string[]): Promise<void> {
    await this.carregarFaltantes(ids);
    // Wave 2: parents of components that can supply neither their own weight nor
    // their own box. ⚠️ The box half is not symmetry — a variation very commonly
    // has a weight but no dimensions, and gating on the weight alone would leave
    // the estimator with no parent to fall back to, silently costing the kit its
    // real box.
    const pais: string[] = [];
    for (const id of ids) {
      const m = this.porId.get(id);
      if (!m?.paiId) continue;
      if (semPesoProprio(m) || semCaixaPropria(m)) pais.push(m.paiId);
    }
    await this.carregarFaltantes(pais);
  }

  private async carregarFaltantes(ids: readonly string[]): Promise<void> {
    const faltantes = [...new Set(ids)].filter((id) => !this.porId.has(id));
    if (faltantes.length === 0) return;
    const refs = faltantes.map((id) => produtoCollection.docRef(this.db, {}, id));
    const snaps = await this.db.getAll(...refs, { fieldMask: [...CAMPOS_MEDIDAS] });
    this.leituras += snaps.length;
    for (const snap of snaps) {
      this.porId.set(snap.id, snap.exists ? projetarMedidas(snap.data()) : null);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                        composition memo + patch diff                       */
/* -------------------------------------------------------------------------- */

/**
 * A canonical key for a component map. ADR 0014's decisive number is that
 * thousands of kits share the SAME components, so keying the computation on the
 * composition collapses a whole page into a handful of `dimensoesDoKit` calls.
 * Sorted, so two kits listing the same components in a different insertion order
 * share one entry.
 */
export function chaveComposicao(componentes: ComponentesKit | null | undefined): string {
  return Object.entries(componentes ?? {})
    .map(([id, kit]) => `${id}:${kit.quantidade}`)
    .sort()
    .join('|');
}

/**
 * Only the fields that actually differ. Two consequences, both required: a
 * redelivery or a no-op change writes NOTHING, and a `null` (not derivable) is
 * never written over a stored value.
 */
export function patchDimensoes(
  atual: ValoresRollup,
  derivado: DimensoesKit,
): Record<string, number> {
  const patch: Record<string, number> = {};
  for (const campo of CAMPOS_ROLLUP_KIT) {
    const valor = derivado[campo];
    if (valor === null) continue;
    if (atual[campo] === valor) continue;
    patch[campo] = valor;
  }
  return patch;
}

/** A matched document that is actually a kit we can roll up. */
function ehKitComComponentes(snap: DocumentSnapshot | QueryDocumentSnapshot): boolean {
  const componentes = snap.get('componentesKit') as ComponentesKit | null | undefined;
  return snap.get('ehKit') === true && Object.keys(componentes ?? {}).length > 0;
}

function isPrecondicaoFalhou(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === GRPC_FAILED_PRECONDITION
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the job                                   */
/* -------------------------------------------------------------------------- */

interface Raiz {
  medidas: ProdutoMedidas;
  valores: ValoresRollup;
}

/**
 * Re-read the root produto and decide whether this task still represents the
 * current state — ADR 0011 **tier 2**, with the five VALUES as the clock.
 *
 * ⚠️ Not `updateTime`, and not `ultimaModificacao`. Both advance on an unrelated
 * edit (renaming the produto), which would drop a task that no successor task
 * replaces — the trigger only enqueues when a rollup field actually moved. The
 * values are the only clock that ticks exactly when a successor exists.
 * (`ultimaModificacao` is also `millisSinceEpoch` on produto while sibling
 * documents store microseconds — ADR 0011's named cross-unit trap.)
 */
async function carregarRaiz(db: Firestore, rootId: string): Promise<Raiz | null> {
  const snap = await produtoCollection.docRef(db, {}, rootId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return { medidas: projetarMedidas(data), valores: lerValoresRollup(data) };
}

/**
 * The seeds for the `componentesKitKeys` lookup: the changed produto, plus the
 * variation children that INHERIT from it.
 *
 * ⚠️ The children half is not optional. A component with no own weight resolves
 * its parent's, but `componentesKitKeys` lists the CHILD — so looking up the
 * parent id alone finds none of the kits that actually changed.
 */
export async function derivarSeeds(
  db: Firestore,
  rootId: string,
  raiz: Raiz,
): Promise<{ seeds: string[]; descartados: string[] }> {
  if (raiz.medidas.paiId != null) return limitarSeeds([rootId]);

  const filhos = await produtoCollection
    .ref(db, {})
    .where('paiId', '==', rootId)
    .select(...CAMPOS_MEDIDAS)
    .get();

  const ids = [rootId];
  for (const doc of filhos.docs) {
    if (doc.id === rootId) continue; // defensive: a produto can't be its own child
    const m = projetarMedidas(doc.data());
    if (semPesoProprio(m) || semCaixaPropria(m)) ids.push(doc.id);
  }
  return limitarSeeds(ids);
}

/** One page of kits that list any of `chunk` among their components. */
async function lerPaginaDeKits(
  db: Firestore,
  chunk: readonly string[],
  cursor: string | null,
): Promise<QueryDocumentSnapshot[]> {
  let q = produtoCollection
    .ref(db, {})
    .where('componentesKitKeys', 'array-contains-any', [...chunk])
    .orderBy(FieldPath.documentId())
    .select(...CAMPOS_KIT)
    .limit(KITS_POR_PAGINA);
  if (cursor !== null) q = q.startAfter(cursor);
  const snap = await q.get();
  return snap.docs;
}

/**
 * Recompute one page of kits and write only what changed.
 *
 * Returns the ids whose stored values actually moved — the input to the
 * nested-kit probe, which is why it is the CHANGED set and not the whole page.
 */
export async function processarPagina(
  db: Firestore,
  docs: readonly QueryDocumentSnapshot[],
  cache: CacheMedidas,
): Promise<{ alterados: string[]; ignorados: number; conflitos: number }> {
  const kits = docs.filter(ehKitComComponentes);
  const ignorados = docs.length - kits.length;

  await cache.carregar(
    kits.flatMap((doc) => Object.keys((doc.get('componentesKit') as ComponentesKit | null) ?? {})),
  );
  const medidas = cache.mapa();

  const porComposicao = new Map<string, DimensoesKit>();
  const pendentes: Array<{
    ref: DocumentReference;
    patch: Record<string, number>;
    updateTime: Timestamp;
  }> = [];

  for (const doc of kits) {
    const componentes = doc.get('componentesKit') as ComponentesKit;
    const chave = chaveComposicao(componentes);
    let derivado = porComposicao.get(chave);
    if (!derivado) {
      derivado = dimensoesDoKit(componentes, medidas);
      porComposicao.set(chave, derivado);
    }
    const patch = patchDimensoes(lerValoresRollup(doc.data()), derivado);
    if (Object.keys(patch).length === 0) continue;
    pendentes.push({ ref: doc.ref, patch, updateTime: doc.updateTime });
  }

  if (pendentes.length === 0) return { alterados: [], ignorados, conflitos: 0 };

  const alterados: string[] = [];
  const conflitantes: DocumentReference[] = [];
  const falhas: unknown[] = [];
  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    // FAILED_PRECONDITION means someone else wrote the kit between our read and
    // our write. Retrying with the SAME stale precondition can only fail again,
    // so take it out of BulkWriter's hands and re-derive it below.
    if (err.code === GRPC_FAILED_PRECONDITION) return false;
    return err.failedAttempts < 3;
  });
  // ⚠️ Every per-write promise must settle into `falhas`, never rethrow from
  // inside the callback: `close()` resolves without surfacing individual write
  // errors, so a rethrow here becomes an UNHANDLED rejection — fatal in Node 22,
  // and it would kill the dispatch after some of the page had already been
  // written. Collect, then rethrow once, on the main path.
  const escritas = pendentes.map(({ ref, patch, updateTime }) =>
    writer
      .update(ref, patch, { lastUpdateTime: updateTime })
      .then(() => {
        alterados.push(ref.id);
      })
      .catch((err: unknown) => {
        if (isPrecondicaoFalhou(err)) {
          conflitantes.push(ref);
          return;
        }
        falhas.push(err);
      }),
  );
  await writer.close();
  await Promise.all(escritas);
  if (falhas.length > 0) throw falhas[0];

  alterados.push(...(await reconciliarConflitos(db, conflitantes, porComposicao, medidas)));
  return { alterados, ignorados, conflitos: conflitantes.length };
}

/**
 * One bounded retry for the kits a concurrent writer beat us to: re-read,
 * recompute from the SAME memo, and write against the fresh `updateTime`.
 * Losing twice means a genuinely hot document — logged, and converged by the
 * next edit to any of its components rather than retried forever.
 */
async function reconciliarConflitos(
  db: Firestore,
  conflitantes: readonly DocumentReference[],
  porComposicao: ReadonlyMap<string, DimensoesKit>,
  medidas: Record<string, ProdutoMedidas | null>,
): Promise<string[]> {
  if (conflitantes.length === 0) return [];
  const snaps = await db.getAll(...conflitantes);
  const alterados: string[] = [];
  for (const snap of snaps) {
    if (!snap.exists || !ehKitComComponentes(snap)) continue;
    const componentes = snap.get('componentesKit') as ComponentesKit;
    const derivado =
      porComposicao.get(chaveComposicao(componentes)) ?? dimensoesDoKit(componentes, medidas);
    const patch = patchDimensoes(lerValoresRollup(snap.data()), derivado);
    if (Object.keys(patch).length === 0) continue;
    try {
      await snap.ref.update(patch, { lastUpdateTime: snap.updateTime! });
      alterados.push(snap.id);
    } catch (err: unknown) {
      if (isPrecondicaoFalhou(err)) {
        logger.warn(
          `${KIT_ROLLUP_QUEUE}: kit ${snap.id} perdeu a corrida duas vezes — mantido desatualizado`,
        );
        continue;
      }
      throw err;
    }
  }
  return alterados;
}

/**
 * Are any of these produtos themselves components of another kit?
 *
 * #239 forbids a kit-of-kit and the human UI enforces it (the picker plus
 * `produtoPageIssues`), so this normally returns `false` — one keys-only indexed
 * query per 30 changed kits, matching zero documents. It exists for the migrated
 * corpus and the picker-less agent/MCP path (#347), where a nested kit or an
 * outright cycle can still exist, and legacy `getPesoBrutoKg` was itself
 * recursive.
 */
export async function existeKitAninhado(db: Firestore, ids: readonly string[]): Promise<boolean> {
  for (let i = 0; i < ids.length; i += SEEDS_POR_CONSULTA) {
    const snap = await produtoCollection
      .ref(db, {})
      .where('componentesKitKeys', 'array-contains-any', ids.slice(i, i + SEEDS_POR_CONSULTA))
      .select()
      .limit(1)
      .get();
    if (!snap.empty) return true;
  }
  return false;
}

/** The next dispatch's payload, or `null` when every chunk is exhausted. */
export function proximaPagina(
  payload: KitRollupPayload,
  seeds: readonly string[],
  paginaCheia: boolean,
  ultimoId: string | null,
): KitRollupPayload | null {
  const base = { ...payload, seedIds: [...seeds] };
  if (paginaCheia && ultimoId !== null) return { ...base, cursor: ultimoId };
  const proximoOffset = payload.seedOffset + SEEDS_POR_CONSULTA;
  if (proximoOffset >= seeds.length) return null;
  return { ...base, seedOffset: proximoOffset, cursor: null };
}

/**
 * Continue into the kits that contain the kits we just changed — the nested-kit
 * case, which a healthy catalogue never has (see {@link existeKitAninhado}).
 * Bounded by `PROFUNDIDADE_MAX_KIT` and by `visitados`, so a cycle A ⊂ B ⊂ A
 * costs a fixed amount instead of looping forever.
 */
async function enfileirarCascata(
  deps: KitRollupDeps,
  payload: KitRollupPayload,
  alterados: readonly string[],
): Promise<void> {
  if (alterados.length === 0) return;
  const visitados = new Set(payload.visitados);
  const novos = alterados.filter((id) => !visitados.has(id));
  if (novos.length === 0) return;
  if (!(await existeKitAninhado(deps.db, novos))) return;

  if (payload.depth >= PROFUNDIDADE_MAX_KIT) {
    logger.warn(
      `${KIT_ROLLUP_QUEUE}: kits aninhados além da profundidade ${PROFUNDIDADE_MAX_KIT} a partir ` +
        `de ${payload.rootId} — cascata interrompida: ${novos.slice(0, 20).join(',')}`,
    );
    return;
  }

  const { seeds, descartados } = limitarSeeds(novos);
  if (descartados.length > 0) {
    logger.warn(
      `${KIT_ROLLUP_QUEUE}: ${descartados.length} kit(s) aninhados ignorados por limite de ` +
        `payload a partir de ${payload.rootId}`,
    );
  }
  await deps.scheduler.enqueue({
    rootId: payload.rootId,
    rootValores: payload.rootValores,
    seedIds: seeds,
    seedOffset: 0,
    cursor: null,
    depth: payload.depth + 1,
    visitados: [...visitados, ...seeds],
  });
}

/**
 * One dispatch: guard, page, write, and decide what happens next. Exported so
 * the emulator suite drives the real code instead of a copy.
 */
export async function processarKitRollup(
  deps: KitRollupDeps,
  payload: KitRollupPayload,
): Promise<KitRollupResultado> {
  const { db, scheduler } = deps;

  const raiz = await carregarRaiz(db, payload.rootId);
  if (!raiz) {
    logger.info(`${KIT_ROLLUP_QUEUE}: produto ${payload.rootId} não existe mais — descartada`);
    return 'raizAusente';
  }
  if (valoresRollupDiferem(raiz.valores, payload.rootValores)) {
    logger.info(
      `${KIT_ROLLUP_QUEUE}: produto ${payload.rootId} mudou desde o enfileiramento — tarefa ` +
        `superada, a edição mais nova tem a sua própria`,
    );
    return 'superseded';
  }

  let seeds = payload.seedIds;
  if (seeds === null) {
    const derivado = await derivarSeeds(db, payload.rootId, raiz);
    seeds = derivado.seeds;
    if (derivado.descartados.length > 0) {
      logger.warn(
        `${KIT_ROLLUP_QUEUE}: produto ${payload.rootId} tem variações demais — ` +
          `${derivado.descartados.length} ignoradas: ${derivado.descartados.join(',')}`,
      );
    }
  }

  const chunk = seeds.slice(payload.seedOffset, payload.seedOffset + SEEDS_POR_CONSULTA);
  if (chunk.length === 0) return 'concluido';

  const cache = new CacheMedidas(db);
  // The root's own medidas are already in hand from the guard read — seeding them
  // saves the page the one component read it is guaranteed to need.
  cache.semear(payload.rootId, raiz.medidas);

  const docs = await lerPaginaDeKits(db, chunk, payload.cursor);
  const { alterados, ignorados, conflitos } = await processarPagina(db, docs, cache);

  if (ignorados > 0) {
    logger.warn(
      `${KIT_ROLLUP_QUEUE}: ${ignorados} documento(s) casaram componentesKitKeys mas não são ` +
        `kits com componentes — ignorados (denorm defasado?)`,
    );
  }
  logger.info(
    `${KIT_ROLLUP_QUEUE}: raiz=${payload.rootId} chunk=${payload.seedOffset} ` +
      `pagina=${docs.length} alterados=${alterados.length} conflitos=${conflitos} ` +
      `leituras=${cache.leituras} profundidade=${payload.depth}`,
  );

  await enfileirarCascata(deps, payload, alterados);

  const proximo = proximaPagina(
    payload,
    seeds,
    docs.length === KITS_POR_PAGINA,
    docs.length > 0 ? docs[docs.length - 1]!.id : null,
  );
  if (proximo === null) return 'concluido';

  // Re-check the guard right before continuing: a page can take seconds, and the
  // operator may have edited again meanwhile. Same idiom as the ML mass import,
  // which re-reads its job doc immediately before re-enqueuing.
  const aindaAtual = await carregarRaiz(db, payload.rootId);
  if (!aindaAtual || valoresRollupDiferem(aindaAtual.valores, payload.rootValores)) {
    logger.info(
      `${KIT_ROLLUP_QUEUE}: produto ${payload.rootId} mudou durante a página — continuação ` +
        `cancelada`,
    );
    return 'superseded';
  }
  await scheduler.enqueue(proximo);
  return 'continuando';
}

/* -------------------------------------------------------------------------- */
/*                              task declaration                              */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ The export name below IS the deployed function AND the queue name; it must
 * equal {@link KIT_ROLLUP_QUEUE}.
 *
 * `maxConcurrentDispatches: 2` because two dispatches for the SAME root would
 * race each other's cursor, and a higher ceiling buys nothing: the work is one
 * paged walk, not N independent items.
 */
export const recalcularDimensoesKit = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    ...tasksInvokerOptions(),
    retryConfig: {
      maxAttempts: KIT_ROLLUP_MAX_ATTEMPTS,
      minBackoffSeconds: 10,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    rateLimits: { maxConcurrentDispatches: 2, maxDispatchesPerSecond: 2 },
    timeoutSeconds: 540,
  },
  async (req) => {
    let payload: KitRollupPayload;
    try {
      payload = kitRollupPayloadSchema.parse(req.data);
    } catch (err) {
      if (err instanceof z.ZodError) {
        // This queue only ever receives our own payloads — a malformed one is an
        // enqueue bug, and there is no document to park.
        logger.error(`${KIT_ROLLUP_QUEUE}: payload inválido, tarefa descartada — ${err.message}`);
        return;
      }
      throw err;
    }

    const resultado = await processarKitRollup(
      { db: getDb(), scheduler: createKitRollupScheduler() },
      payload,
    );
    logger.info(`${KIT_ROLLUP_QUEUE}: ${payload.rootId} → ${resultado}`);
  },
);
