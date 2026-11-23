/**
 * The MANUAL SELECTION read of the Amazon listings flows (step 13, PR 13-b):
 * from a hand-picked list of produtos, the anchor each one stands for and the
 * conta's SKUs of each anchor's family. A manual push route reads its
 * selection here (the stock one, `estoque/envioManualEstoque.ts`, binds its
 * own constant names), so every flow finds the same listings for the same
 * selection.
 *
 * ## The reads, in order
 *
 * 1. Per selected produto, ONE masked by-id read of its `paiId` and `nome`
 *    ({@link CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON}). A variation child hops ONE
 *    level to its anchor (`sondasDoProduto`'s parent); anything else is its own
 *    anchor. A produto with no document has no anchor.
 * 2. An anchor no selected id IS gets ONE more masked read of its `nome`
 *    alone ({@link CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON}), which also says
 *    whether it exists (never a second hop); a selected id already read is
 *    never read again. An anchor with no document is `ancorasAusentes`: no
 *    family is read for it.
 * 3. Per distinct existing anchor, its family: its children (`produtos where
 *    paiId == <anchor> orderBy nome`, keys only, on the declared `produtos
 *    (paiId ASC, nome ASC)` composite), plus every selected produto that
 *    resolved to it, and ONE listing of each member's own `prodAmazon`
 *    partition (the anchor's and each member's: no `where`, projected to
 *    {@link CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON}); the conta's SKUs among them
 *    in BOTH stored ref forms (`skusDaConta`), deduplicated and sorted.
 *
 * Every read goes through ONE limiter: at most
 * {@link LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON} in flight. A failed read is
 * rethrown untouched, once every read already started has settled (the
 * EARLIEST failure in list order).
 *
 * ⚠️ READ-ONLY, and safe on App Hosting: no write, no clock, no network, no
 * Amazon call, and nothing of the write engine, a task or a flow's valve.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoAmazonLinkCollection, produtoCollection } from '@delfrance/data/admin/collections';
import type { produtoAmazonLinkSchema, produtoSchema } from '@delfrance/schemas';

import { skusDaConta, sondasDoProduto } from './sondasVinculos';

/** The most Firestore reads the selection keeps in flight. */
export const LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON = 16;

/** The produto fields read 1 reads off a SELECTED produto: the parent pointer and the label. */
export const CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON = [
  'paiId',
  'nome',
] as const satisfies ReadonlyArray<keyof typeof produtoSchema.shape>;

/**
 * The ONE field read 2 reads off an anchor no selected id IS: its label for the
 * rows. No `paiId`, so that read can never become a second hop; whether the
 * document exists is what it also answers.
 */
export const CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON = ['nome'] as const satisfies ReadonlyArray<
  keyof typeof produtoSchema.shape
>;

/** The link fields `skusDaConta` reads (read 3's partition listings are projected to them). */
export const CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON = [
  'contaAmazonOuterRef',
  'sku',
] as const satisfies ReadonlyArray<keyof typeof produtoAmazonLinkSchema.shape>;

/**
 * The children seek's fields, in the declared composite's order: the equality
 * on the parent, then the order the index is sorted by.
 *
 * ⚠️ The order also filters: a child stored WITHOUT `nome` is not returned, so
 * an anchor's family misses its links unless that child was SELECTED (a
 * selected produto is always a member of its anchor's family). The produto
 * schema requires `nome` on every document, so such a child exists only
 * outside the schema.
 */
export const CAMPOS_INDICE_FILHOS_SELECAO_MANUAL_AMAZON = [
  'paiId',
  'nome',
] as const satisfies ReadonlyArray<keyof typeof produtoSchema.shape>;

/** What the selection read: each selected id's anchor, the labels, and each anchor's SKUs of the conta. */
export interface SelecaoManualAmazon {
  /** Selected id → its anchor; NO entry when the produto has no document. */
  readonly ancoraDe: ReadonlyMap<string, string>;
  /**
   * Every produto read that has a document (each selected one, each anchor
   * reached) → its stored `nome` when usable, else `null`.
   */
  readonly nomeDe: ReadonlyMap<string, string | null>;
  /** Anchors a selected child's `paiId` names that have NO document: no family is read for them. */
  readonly ancorasAusentes: ReadonlySet<string>;
  /**
   * EXISTING anchor → its family's SKUs of the conta, sorted; anchors in
   * first-seen request order.
   */
  readonly skusDaAncora: ReadonlyMap<string, readonly string[]>;
}

/**
 * At most `largura` calls of `executar` running at once; a freed slot passes
 * straight to the next waiter, so the bound holds under any interleaving.
 */
function limitador(largura: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let ativos = 0;
  const espera: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (ativos < largura) ativos += 1;
    else await new Promise<void>((liberar) => espera.push(liberar));
    try {
      return await fn();
    } finally {
      const proximo = espera.shift();
      if (proximo === undefined) ativos -= 1;
      else proximo();
    }
  };
}

/**
 * Every promise SETTLED — none left running behind the answer — then the
 * values, or the rejection of the EARLIEST one in list order, unchanged.
 */
async function todosOuPrimeiraFalha<T>(promessas: readonly Promise<T>[]): Promise<T[]> {
  const saidas = await Promise.allSettled(promessas);
  const valores: T[] = [];
  for (const saida of saidas) {
    if (saida.status === 'rejected') throw saida.reason;
    valores.push(saida.value);
  }
  return valores;
}

/** Code-unit order, never a locale's. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A stored `nome`, when it is a usable label: a blank one is an absence, never an empty label. */
function nomeDoProduto(dados: Readonly<Record<string, unknown>>): string | null {
  const nome = dados.nome;
  return typeof nome === 'string' && nome.trim() !== '' ? nome : null;
}

/** One member's `prodAmazon` partition, whole and projected (read 3). */
async function lerVinculosDoMembro(
  db: Firestore,
  produtoId: string,
): Promise<Readonly<Record<string, unknown>>[]> {
  const snap = await produtoAmazonLinkCollection
    .ref(db, { produtoId })
    .select(...CAMPOS_VINCULO_SELECAO_MANUAL_AMAZON)
    .get();
  return snap.docs.map((d) => d.data());
}

/** The anchor's children, keys only (read 3). */
async function lerFilhosDaAncora(db: Firestore, ancoraId: string): Promise<string[]> {
  const [campoPai, campoOrdem] = CAMPOS_INDICE_FILHOS_SELECAO_MANUAL_AMAZON;
  const snap = await produtoCollection
    .ref(db, {})
    .where(campoPai, '==', ancoraId)
    .orderBy(campoOrdem)
    .select()
    .get();
  return snap.docs.map((d) => d.id);
}

/** Reads 1–3 (module header) of `produtoIds`, for `contaId`, every read through ONE limiter. */
export async function lerSelecaoManualAmazon(
  db: Firestore,
  contaId: string,
  produtoIds: readonly string[],
): Promise<SelecaoManualAmazon> {
  const executar = limitador(LARGURA_LEITURAS_SELECAO_MANUAL_AMAZON);
  /** One produto by id, masked to `campos`: its fields, or `null` with no document. */
  const lerProduto = (id: string, campos: readonly string[]) =>
    executar(async () => {
      const [snap] = await db.getAll(produtoCollection.docRef(db, {}, id), {
        fieldMask: [...campos],
      });
      return snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
    });

  // 1. Each selected produto's parent pointer and label, by id, masked.
  const lidos = await todosOuPrimeiraFalha(
    produtoIds.map((id) => lerProduto(id, CAMPOS_PRODUTO_SELECAO_MANUAL_AMAZON)),
  );
  const ancoraDe = new Map<string, string>();
  const nomeDe = new Map<string, string | null>();
  const semDocumento = new Set<string>();
  for (const [i, id] of produtoIds.entries()) {
    const dados = lidos[i] ?? null;
    if (dados === null) {
      semDocumento.add(id);
      continue;
    }
    nomeDe.set(id, nomeDoProduto(dados));
    // The probe set is the produto, then the parent its `paiId` names: the
    // parent, when there is one, is the anchor — ONE hop, never more.
    ancoraDe.set(id, sondasDoProduto(id, dados)[1] ?? id);
  }
  const distintas = [...new Set(ancoraDe.values())];

  // 2. An anchor no selected id IS: ONE label read, which also says whether
  // it exists. A selected id already read is never read again.
  const ancorasAusentes = new Set(distintas.filter((a) => semDocumento.has(a)));
  const naoLidas = distintas.filter((a) => !nomeDe.has(a) && !semDocumento.has(a));
  const rotulos = await todosOuPrimeiraFalha(
    naoLidas.map((a) => lerProduto(a, CAMPOS_ROTULO_ANCORA_SELECAO_MANUAL_AMAZON)),
  );
  for (const [i, ancora] of naoLidas.entries()) {
    const dados = rotulos[i] ?? null;
    if (dados === null) ancorasAusentes.add(ancora);
    else nomeDe.set(ancora, nomeDoProduto(dados));
  }
  const existentes = distintas.filter((a) => !ancorasAusentes.has(a));

  // 3. Each existing anchor's family: its children and every selected produto
  // that resolved to it (a selected child the seek does not return is still a
  // member), then every member's partition.
  const familias = await todosOuPrimeiraFalha(
    existentes.map(async (ancora) => {
      const [filhos, daAncora] = await Promise.allSettled([
        executar(() => lerFilhosDaAncora(db, ancora)),
        executar(() => lerVinculosDoMembro(db, ancora)),
      ]);
      if (filhos.status === 'rejected') throw filhos.reason;
      if (daAncora.status === 'rejected') throw daAncora.reason;
      const membros = new Set([
        ...filhos.value,
        ...produtoIds.filter((id) => ancoraDe.get(id) === ancora),
      ]);
      membros.delete(ancora);
      const dosMembros = await todosOuPrimeiraFalha(
        [...membros].map((membro) => executar(() => lerVinculosDoMembro(db, membro))),
      );
      const skus = new Set(skusDaConta(daAncora.value, contaId));
      for (const lista of dosMembros) {
        for (const sku of skusDaConta(lista, contaId)) skus.add(sku);
      }
      return [...skus].sort(compararTexto);
    }),
  );
  return {
    ancoraDe,
    nomeDe,
    ancorasAusentes,
    skusDaAncora: new Map(existentes.map((a, i) => [a, familias[i] ?? []] as const)),
  };
}
