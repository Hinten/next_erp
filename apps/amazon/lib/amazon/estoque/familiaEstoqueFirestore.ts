/**
 * The Firestore half of the Amazon stock sync's family read (step 12, PR
 * 12-e1): for ONE or MANY units at one depósito, every document
 * `membroParaEstoqueAmazon` (`familiaEstoque.ts`) is handed, each read MASKED
 * to the fields that module reads. This module only READS: the row rules (the
 * canonical id, else the partition row in either ref form) and the component
 * dono from the PATH are `familiaEstoque.ts`'s, and the quantity is the
 * shared core's (`quantidadeEstoqueAmazon`).
 *
 * ## The reads, in order
 *
 *  1. The units' produtos by id, in `getAll` calls of at most
 *     {@link MAX_REFS_GETALL_ESTOQUE_AMAZON} refs, masked to
 *     `CAMPOS_UNIDADE_ESTOQUE_AMAZON`. A unit whose document does not exist
 *     answers `null` (`unidade-ausente`): never a 0 derived from a missing
 *     produto.
 *  2. Which components each unit's quantity is folded over: the core's own
 *     answer, `componentesNaoResolvidos` of the unit with no row read yet —
 *     exactly the components the core will look up, and none for a produto
 *     the core does not treat as a kit. No second copy of "kit" or
 *     "constraining" lives here. A component key that is not a document id is
 *     never read: the core counts it missing, which floors the kit to 0 (the
 *     safe direction).
 *  3. Every estoque row at its CANONICAL id (`makeEstoqueUid`), units' own and
 *     components' together, DEDUPLICATED by produto across every unit of the
 *     call (kits share components: a component two kits name is read ONCE), in
 *     `getAll` calls of at most {@link MAX_REFS_GETALL_ESTOQUE_AMAZON} refs,
 *     masked to `CAMPOS_LINHA_ESTOQUE_AMAZON`. By id: no index.
 *  4. For each produto whose canonical row does not exist, ONE listing of its
 *     own `produtos/{id}/estoques` partition — no `where`, no order, no limit,
 *     projected (a classic `select`) to the same fields — at most
 *     {@link LARGURA_PARTICOES_ESTOQUE_AMAZON} at once. A partition read: no
 *     index. ⚠️ Whether Enterprise bounds this listing to the partition is
 *     unmeasured (a staging measurement before the window); the canonical id
 *     answers every row written since the canonical id existed, so the listing
 *     runs for legacy auto-id rows and for produtos with no row at the
 *     depósito.
 *
 * Every component row is handed over with its PATH, so its produto is the one
 * the path names, never its stored `parentId` (nullable at rest).
 *
 * ## Two entries
 *
 * {@link lerFamiliasEstoqueAmazon} runs reads 1–4. {@link lerMembrosEstoqueAmazon}
 * runs reads 2–4 for units the CALLER already read (with at least
 * `CAMPOS_UNIDADE_ESTOQUE_AMAZON`), so a caller that must read the units for
 * its own checks anyway — a batch dropping gone units and units that grew
 * variations — reads each produto once.
 *
 * ## What it answers
 *
 * Per unit id: the `MembroDaFamilia` the core reads, or `null` when the unit's
 * produto does not exist (only the first entry reads produtos). Its `estoque`
 * is `null` when the unit holds no row at the depósito (the core reads 0).
 *
 * Reads only: no write, no clock, no network.
 */
import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { componentesNaoResolvidos, type MembroDaFamilia } from '@delfrance/data/admin/estoque';
import { estoqueCollection, produtoCollection } from '@delfrance/data/admin/collections';
import { makeEstoqueUid, naoDocId } from '@delfrance/schemas';

import {
  CAMPOS_LINHA_ESTOQUE_AMAZON,
  CAMPOS_UNIDADE_ESTOQUE_AMAZON,
  type DocEstoqueLidoAmazon,
  type UnidadeLidaEstoqueAmazon,
  formasRefDepositoEstoqueAmazon,
  linhaEstoqueNoDepositoAmazon,
  membroParaEstoqueAmazon,
} from './familiaEstoque';

/** The most refs one `getAll` carries (module header, reads 1 and 3). */
export const MAX_REFS_GETALL_ESTOQUE_AMAZON = 300;

/** The most partition listings in flight at once (module header, read 4). */
export const LARGURA_PARTICOES_ESTOQUE_AMAZON = 16;

/** What {@link lerFamiliasEstoqueAmazon} is handed. */
export interface EntradaFamiliasEstoqueAmazon {
  /** The units, as their links resolve them; repeats are read once. */
  readonly unidadeIds: readonly string[];
  /** The conta's depósito, as a document id. */
  readonly depositoId: string;
}

/** `itens` in consecutive slices of at most `tamanho`. */
function fatias<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/** A snapshot's data, or `null` when the document does not exist. */
function dadosDe(snap: DocumentSnapshot | undefined): Readonly<Record<string, unknown>> | null {
  if (snap?.exists !== true) return null;
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/**
 * `refs` read in `getAll` calls of at most {@link MAX_REFS_GETALL_ESTOQUE_AMAZON},
 * one after another, each masked to `campos`; the snapshots in the order asked.
 */
async function lerEmFatias(
  db: Firestore,
  refs: readonly DocumentReference[],
  campos: readonly string[],
): Promise<DocumentSnapshot[]> {
  const saida: DocumentSnapshot[] = [];
  for (const fatia of fatias(refs, MAX_REFS_GETALL_ESTOQUE_AMAZON)) {
    saida.push(...(await db.getAll(...fatia, { fieldMask: [...campos] })));
  }
  return saida;
}

/**
 * The produtos a unit's quantity reads rows of (module header, read 2): the
 * components the core folds over, as document ids, for the unit's masked raw.
 */
function componentesDaUnidade(id: string, raw: Readonly<Record<string, unknown>>): string[] {
  return componentesNaoResolvidos(membroParaEstoqueAmazon({ id, raw }, null, [])).filter(
    (componenteId) => !naoDocId(componenteId),
  );
}

/** One produto's whole `estoques` partition, projected (module header, read 4). */
async function lerParticao(db: Firestore, produtoId: string): Promise<DocEstoqueLidoAmazon[]> {
  const snap = await estoqueCollection
    .ref(db, { produtoId })
    .select(...CAMPOS_LINHA_ESTOQUE_AMAZON)
    .get();
  return snap.docs.map((d) => ({ caminho: d.ref.path, raw: d.data() }));
}

/** A document id, or a `RangeError` naming the field (nothing read). */
function exigirDocIdDaUnidade(id: string): void {
  if (naoDocId(id)) {
    throw new RangeError('familiaEstoqueFirestore.ts: unidadeId não é um id de documento');
  }
}

/**
 * The member of every unit in `entrada` at its depósito (module header): the
 * unit id → its `MembroDaFamilia`, or `null` when the unit's produto does not
 * exist. Reads the units (read 1), then {@link lerMembrosEstoqueAmazon}.
 *
 * @throws {RangeError} a unit id or a `depositoId` that is not a document id
 *   (nothing read).
 */
export async function lerFamiliasEstoqueAmazon(
  db: Firestore,
  entrada: EntradaFamiliasEstoqueAmazon,
): Promise<Map<string, MembroDaFamilia | null>> {
  const { depositoId } = entrada;
  formasRefDepositoEstoqueAmazon(depositoId);
  const unidadeIds = [...new Set(entrada.unidadeIds)];
  for (const id of unidadeIds) exigirDocIdDaUnidade(id);
  const saida = new Map<string, MembroDaFamilia | null>();
  if (unidadeIds.length === 0) return saida;

  // 1. The units, masked.
  const snapsUnidades = await lerEmFatias(
    db,
    unidadeIds.map((id) => produtoCollection.docRef(db, {}, id)),
    CAMPOS_UNIDADE_ESTOQUE_AMAZON,
  );
  const unidades: UnidadeLidaEstoqueAmazon[] = [];
  for (const [i, id] of unidadeIds.entries()) {
    const raw = dadosDe(snapsUnidades[i]);
    if (raw === null) saida.set(id, null);
    else unidades.push({ id, raw });
  }
  for (const [id, membro] of await lerMembrosEstoqueAmazon(db, { unidades, depositoId })) {
    saida.set(id, membro);
  }
  return saida;
}

/**
 * Reads 2–4 of the module header for units ALREADY READ by the caller: every
 * unit's `MembroDaFamilia` at its depósito, keyed by unit id, reading only
 * estoque rows (no produto). For a caller that holds the units' produtos from
 * its own masked read — which must carry `CAMPOS_UNIDADE_ESTOQUE_AMAZON` — so
 * no unit is read twice. A unit id given twice is read (and answered) once,
 * from its first entry.
 *
 * @throws {RangeError} a unit id or a `depositoId` that is not a document id
 *   (nothing read).
 */
export async function lerMembrosEstoqueAmazon(
  db: Firestore,
  entrada: {
    readonly unidades: readonly UnidadeLidaEstoqueAmazon[];
    /** The conta's depósito, as a document id. */
    readonly depositoId: string;
  },
): Promise<Map<string, MembroDaFamilia>> {
  const { depositoId } = entrada;
  formasRefDepositoEstoqueAmazon(depositoId);
  const porId = new Map<string, UnidadeLidaEstoqueAmazon>();
  for (const unidade of entrada.unidades) {
    exigirDocIdDaUnidade(unidade.id);
    if (!porId.has(unidade.id)) porId.set(unidade.id, unidade);
  }
  const unidades = [...porId.values()];
  const saida = new Map<string, MembroDaFamilia>();
  if (unidades.length === 0) return saida;

  // 2. The components each quantity folds over; 3. every canonical row, once.
  const componentesPorUnidade = new Map(
    unidades.map((u) => [u.id, componentesDaUnidade(u.id, u.raw)] as const),
  );
  const produtos = [
    ...new Set([...unidades.map((u) => u.id), ...[...componentesPorUnidade.values()].flat()]),
  ];
  const snapsCanonicos = await lerEmFatias(
    db,
    produtos.map((produtoId) =>
      estoqueCollection.docRef(db, { produtoId }, makeEstoqueUid(produtoId, depositoId)),
    ),
    CAMPOS_LINHA_ESTOQUE_AMAZON,
  );
  const canonicas = new Map<string, DocEstoqueLidoAmazon | null>();
  for (const [i, produtoId] of produtos.entries()) {
    const snap = snapsCanonicos[i];
    const raw = dadosDe(snap);
    canonicas.set(
      produtoId,
      raw === null || snap === undefined ? null : { caminho: snap.ref.path, raw },
    );
  }

  // 4. The partition of every produto with no canonical row, bounded.
  const semCanonica = produtos.filter((p) => canonicas.get(p) === null);
  const particoes = new Map<string, DocEstoqueLidoAmazon[]>();
  for (const fatia of fatias(semCanonica, LARGURA_PARTICOES_ESTOQUE_AMAZON)) {
    const lidas = await Promise.all(fatia.map((produtoId) => lerParticao(db, produtoId)));
    for (const [i, produtoId] of fatia.entries()) particoes.set(produtoId, lidas[i] ?? []);
  }

  const linha = (produtoId: string): DocEstoqueLidoAmazon | null =>
    linhaEstoqueNoDepositoAmazon({
      produtoId,
      depositoId,
      canonica: canonicas.get(produtoId) ?? null,
      particao: particoes.get(produtoId) ?? null,
    });
  for (const unidade of unidades) {
    const componentes = (componentesPorUnidade.get(unidade.id) ?? [])
      .map(linha)
      .filter((l): l is DocEstoqueLidoAmazon => l !== null);
    saida.set(unidade.id, membroParaEstoqueAmazon(unidade, linha(unidade.id), componentes));
  }
  return saida;
}

/**
 * ONE unit's member at its depósito ({@link lerFamiliasEstoqueAmazon} of one),
 * or `null` when the unit's produto does not exist.
 *
 * @throws {RangeError} a unit id or a `depositoId` that is not a document id.
 */
export async function lerFamiliaEstoqueAmazon(
  db: Firestore,
  unidadeId: string,
  depositoId: string,
): Promise<MembroDaFamilia | null> {
  const lidas = await lerFamiliasEstoqueAmazon(db, { unidadeIds: [unidadeId], depositoId });
  return lidas.get(unidadeId) ?? null;
}
