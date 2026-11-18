/**
 * The ERP reads of ONE stock send run (master plan step 12, PR 12-e) — every Firestore read the
 * run makes before it decides, each one the cheapest that answers its question. Next-free, `db`
 * a parameter, every access through a `@delfrance/data/admin/collections` handle (no raw
 * `collection()`). Enterprise bills DATA SCANNED (root `CLAUDE.md` rule 1), so every query here
 * rides an index `firestore.indexes.json` already declares, named by the constants the
 * `.where()` calls are BUILT from — `leituraEstoqueErp.test.ts` checks each one against the file.
 *
 * | read | shape | served by |
 * | --- | --- | --- |
 * | the produto | `getAll` of ONE ref, masked to {@link CAMPOS_PRODUTO_ESTOQUE_LI} | a point read |
 * | its own links | where-less listing of `produtos/{p}/produtolojaintegrada` | the produto's own partition, no index |
 * | its own record, by the payload's hint | point read, only when the hint IS the canonical id | — |
 * | its own record, otherwise | `depositoOuterRef in [both forms]`, `limit 3` | COLLECTION `estoques (depositoOuterRef, ultimaModificacao)`, prefix |
 * | a kit's components, by the payload's ids | ONE `getAll` of the canonical ids | point reads |
 * | the components still missing | GROUP `parentId in [≤30]`, `depositoOuterRef == form`, per form | COLLECTION_GROUP `estoques (parentId, depositoOuterRef, ultimaModificacao)`, prefix |
 * | the components whose CANONICAL record is still unread (none found, or only legacy ones: a row without `parentId` is invisible to the join) | the own-record query, per component | as the own record |
 * | "any record at any depósito?" | where-less listing, `limit 1` | the produto's own partition, no index |
 * | the duplicate-link probe | GROUP `contaLojaIntegrada == form`, `id in [n, 'n']`, per form | COLLECTION_GROUP `produtolojaintegrada (contaLojaIntegrada, id)` |
 *
 * ## A hint is used only when it IS the canonical record
 *
 * The canonical record `est-<produto>-<depósito>` (`makeEstoqueUid`) wins over any legacy auto-id
 * record beside it (`estoqueNoDepositoLi`). So a hint naming the canonical id answers the question
 * alone — whatever else sits at the depósito, that record is the one read — while a hint naming a
 * legacy record does not: a canonical record may sit beside it, and reading the legacy one would
 * send another S than the reconcile, which resolves by the same rule, and the two would undo each
 * other. Such a hint is not read at all; the query decides. A kit component's id from the payload
 * follows the same rule. A DELETE's task passes no hint (`processarEstoque.ts`): its hint names the
 * record that was deleted, so a point read of it would only ever miss.
 *
 * ## Both stored forms of a ref
 *
 * A record's `depositoOuterRef` and a link's `contaLojaIntegrada` are stored as
 * `documents/<col>/<id>` or as the bare `<col>/<id>` across the migrated corpus; Firestore
 * equality is exact, so every query and every in-code check names both forms. A spelling neither
 * form matches (a leading slash, a case change) is not found here; the daily reconcile's full walk
 * is where such a record shows.
 *
 * ## The owner comes from the PATH (#932)
 *
 * A record found by the group query belongs to the produto in its path, never to the `parentId`
 * it stores: a record whose stored owner disagrees with its path is attributed to its path, and a
 * component it does not then answer for is looked up again by its own collection.
 */
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  estoqueCollection,
  produtoCollection,
  produtoLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import { contaRefForms } from '@delfrance/data/admin/produtos';
import {
  type ComponentesKit,
  componentesKitEntries,
  contaDoLinkLi,
  depositoDaContaLi,
  formasDoDepositoLi,
  makeEstoqueUid,
  vinculoLiConta,
} from '@delfrance/schemas';

import {
  CAMPOS_INDICE_VINCULO_LI,
  GRUPO_VINCULO_LI,
  LIMITE_VINCULOS_LI,
} from '../pedidos/vinculoProdutoLi';
import { registroNoDepositoLi } from './planoEstoqueLi';
import {
  type DocEstoqueLi,
  type ProdutoEstoqueLi,
  caminhoEstoqueLi,
  segmentoDeCaminhoLi,
} from './quantidadeEstoqueLi';

export { CAMPOS_INDICE_VINCULO_LI, GRUPO_VINCULO_LI, LIMITE_VINCULOS_LI };

/** The produto fields the run reads — the quantity's four (`ProdutoEstoqueLi`), and no other. */
export const CAMPOS_PRODUTO_ESTOQUE_LI = [
  'ehKit',
  'ehKitVirtual',
  'componentesKit',
  'statusProdutosMarketplace',
] as const;

/** The collection id of the stock records, under each produto. */
export const GRUPO_ESTOQUE_LI = 'estoques';

/**
 * The COLLECTION index the own-record query rides, in order; the query uses its first field
 * (an equality prefix). The SAME constant the `.where()` is built from.
 */
export const CAMPOS_INDICE_ESTOQUE_PROPRIO_LI = ['depositoOuterRef', 'ultimaModificacao'] as const;

/**
 * The COLLECTION_GROUP index the component join rides, in order; the join uses its first two
 * fields (an equality prefix). The SAME constant the `.where()` calls are built from.
 */
export const CAMPOS_INDICE_COMPONENTES_LI = [
  'parentId',
  'depositoOuterRef',
  'ultimaModificacao',
] as const;

/**
 * Records of one produto read at one depósito: three, so a canonical record beside TWO legacy ones
 * is still seen (with two, the query could hand back the two legacy ones and read `ambiguo` while
 * the canonical one exists). Same read cost band as two.
 */
export const LIMITE_ESTOQUE_PROPRIO_LI = 3;

/** The values one `in` filter may take (the SDK's cap). */
export const MAX_VALORES_IN_ESTOQUE_LI = 30;

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Readonly<Record<string, unknown>>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/**
 * The depósito readers — both stored forms of a ref (`formasDoDepositoLi`) and the conta's
 * depósito as a bare id (`depositoDaContaLi`) — live in `@delfrance/schemas`
 * (`estoqueErpLojaIntegrada.ts`), so a `tools/migrations` audit reads the identical answers;
 * re-exported here, so no importer changed.
 */
export { depositoDaContaLi, formasDoDepositoLi };

/** A masked produto read, as the quantity reads it — or `null` when the document is absent. */
function produtoDoSnapshotLi(snap: DocumentSnapshot | undefined): ProdutoEstoqueLi | null {
  if (snap === undefined || !snap.exists) return null;
  const dados: Readonly<Record<string, unknown>> = snap.data() ?? {};
  return {
    ehKit: proprio(dados, 'ehKit'),
    ehKitVirtual: proprio(dados, 'ehKitVirtual'),
    // RAW: the shared kit fold tolerates junk (`componentesKitEntries` filters the shape).
    componentesKit: (proprio(dados, 'componentesKit') ?? null) as ComponentesKit | null,
    statusProdutosMarketplace: proprio(dados, 'statusProdutosMarketplace'),
  };
}

/** The produto, masked to {@link CAMPOS_PRODUTO_ESTOQUE_LI}, or `null` when it does not exist. */
export async function lerProdutoEstoqueLi(
  db: Firestore,
  produtoId: string,
): Promise<ProdutoEstoqueLi | null> {
  const [snap] = await db.getAll(produtoCollection.docRef(db, {}, produtoId), {
    fieldMask: [...CAMPOS_PRODUTO_ESTOQUE_LI],
  });
  return produtoDoSnapshotLi(snap);
}

/** The most produtos one masked `getAll` of {@link lerProdutosEstoqueLi} names. */
export const MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI = 300;

/**
 * Many produtos, each masked to {@link CAMPOS_PRODUTO_ESTOQUE_LI} exactly as
 * {@link lerProdutoEstoqueLi} reads one (the same projection, one copy): ONE `getAll` per
 * {@link MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI} distinct ids, in order. Keyed by id; `null` for an
 * absent document. No read for an empty list. The daily reconcile reads a walk page's produtos so.
 */
export async function lerProdutosEstoqueLi(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<ReadonlyMap<string, ProdutoEstoqueLi | null>> {
  const unicos = [...new Set(produtoIds)];
  const lidos = new Map<string, ProdutoEstoqueLi | null>();
  for (let i = 0; i < unicos.length; i += MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI) {
    const fatia = unicos.slice(i, i + MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI);
    const snaps = await db.getAll(...fatia.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: [...CAMPOS_PRODUTO_ESTOQUE_LI],
    });
    fatia.forEach((id, n) => {
      lidos.set(id, produtoDoSnapshotLi(snaps[n]));
    });
  }
  return lidos;
}

/** The produto's OWN `produtolojaintegrada` documents, raw, every conta's (a where-less listing). */
export async function lerVinculosDoProdutoLi(db: Firestore, produtoId: string): Promise<unknown[]> {
  const snap = await produtoLojaIntegradaLinkCollection.ref(db, { produtoId }).get();
  return snap.docs.map((d) => d.data());
}

/**
 * The produto's own records at the conta's depósito (module header, "A hint is used only when it
 * IS the canonical record"): the canonical record by id when the hint names it and it is at the
 * depósito; otherwise the query, at most {@link LIMITE_ESTOQUE_PROPRIO_LI}. Resolving several to
 * one is `estoqueNoDepositoLi`'s.
 */
export async function lerEstoqueProprioLi(
  db: Firestore,
  produtoId: string,
  depositoId: string,
  hint: string | null,
): Promise<DocEstoqueLi[]> {
  const formas = formasDoDepositoLi(depositoId);
  if (hint !== null && hint === makeEstoqueUid(produtoId, depositoId)) {
    const snap = await estoqueCollection.docRef(db, { produtoId }, hint).get();
    const dados = snap.exists ? snap.data() : undefined;
    if (dados !== undefined && registroNoDepositoLi(dados, formas)) {
      return [{ caminho: estoqueCollection.docPath({ produtoId }, hint), dados }];
    }
  }
  return lerEstoqueNoDepositoPorConsultaLi(db, produtoId, formas);
}

/** The own-record query (the table above): `depositoOuterRef in [both forms]`, limited. */
async function lerEstoqueNoDepositoPorConsultaLi(
  db: Firestore,
  produtoId: string,
  formas: readonly string[],
): Promise<DocEstoqueLi[]> {
  const [campoDeposito] = CAMPOS_INDICE_ESTOQUE_PROPRIO_LI;
  const snap = await estoqueCollection
    .ref(db, { produtoId })
    .where(campoDeposito, 'in', [...formas])
    .limit(LIMITE_ESTOQUE_PROPRIO_LI)
    .get();
  return snap.docs.map((d) => ({ caminho: d.ref.path, dados: d.data() }));
}

/**
 * The kit components that BOUND the kit, with each one's quantity in the kit, in the shared
 * fold's own sense (`kitEstoqueDisponivel`: `limitarEstoque !== false` and a finite quantity above
 * 0), for a kit (`ehKit` or `ehKitVirtual`, exactly `true`) — none for anything else, in the
 * stored entries' order. An id that cannot be one path segment is left out: it cannot be read, so
 * it stays unresolved and counts 0 in the fold.
 */
function entradasQueLimitamLi(produto: ProdutoEstoqueLi): [string, number][] {
  if (produto.ehKit !== true && produto.ehKitVirtual !== true) return [];
  return componentesKitEntries(produto.componentesKit)
    .filter(([, kit]) => kit.limitarEstoque !== false)
    .filter(([, kit]) => Number.isFinite(kit.quantidade) && kit.quantidade > 0)
    .filter(([id]) => segmentoDeCaminhoLi(id))
    .map(([id, kit]): [string, number] => [id, kit.quantidade]);
}

/** The ids of {@link entradasQueLimitamLi}: what a send run reads at the depósito for a kit. */
export function componentesQueLimitamLi(produto: ProdutoEstoqueLi): string[] {
  return entradasQueLimitamLi(produto).map(([id]) => id);
}

/**
 * The same components, each → its quantity in the kit (the kits map's `q`, which the daily
 * reconcile records for a store kit): ONE filter with {@link componentesQueLimitamLi}, so the map
 * can never name a component the send run does not read, or miss one it does.
 */
export function quantidadesQueLimitamLi(produto: ProdutoEstoqueLi): Record<string, number> {
  return Object.fromEntries(entradasQueLimitamLi(produto));
}

/** Up to {@link MAX_VALORES_IN_ESTOQUE_LI} values per slice. */
function emFatias<T>(valores: readonly T[]): T[][] {
  const fatias: T[][] = [];
  for (let i = 0; i < valores.length; i += MAX_VALORES_IN_ESTOQUE_LI) {
    fatias.push(valores.slice(i, i + MAX_VALORES_IN_ESTOQUE_LI));
  }
  return fatias;
}

/**
 * Run `fn` over `itens` with at most `limite` running at once, the results in `itens`' order. With
 * `limite` 1 it is a plain sequential loop: the send run's order of reads, byte for byte. A
 * rejection propagates, and no new item starts after it. The daily reconcile's bulk reads use it
 * too (`reconcile/faseErp.ts`).
 */
export async function emParaleloLi<T, R>(
  itens: readonly T[],
  limite: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const saida: R[] = new Array<R>(itens.length);
  let proximo = 0;
  let falhou = false;
  const trabalhador = async (): Promise<void> => {
    while (!falhou && proximo < itens.length) {
      const i = proximo;
      proximo += 1;
      const item = itens[i] as T;
      let concluiu = false;
      try {
        saida[i] = await fn(item);
        concluiu = true;
      } finally {
        // No handler: a rejection propagates as is, and stops the others taking new items.
        if (!concluiu) falhou = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limite, itens.length)) }, () => trabalhador()),
  );
  return saida;
}

/**
 * EVERY record of the kit's bounding components found at the conta's depósito, so the plan can
 * see a component with two (module header): the payload's ids first, read by ONE `getAll` when
 * they name the canonical record (`estoqueIds`: component → record id, or `null`); then the group
 * join for those still missing, per stored form; then, for each one whose CANONICAL record is still
 * unread — none found, or only legacy ones, since a record with no `parentId` (the canonical one
 * included) is invisible to the join — the own-record query on its own collection, so a legacy hit
 * never hides the record that wins or a second legacy one. No read at all for a produto with no
 * bounding component.
 */
export async function lerComponentesNoDepositoLi(
  db: Firestore,
  produto: ProdutoEstoqueLi,
  depositoId: string,
  estoqueIds: Readonly<Record<string, string | null>> | null,
): Promise<DocEstoqueLi[]> {
  return lerRegistrosNoDepositoLi(db, componentesQueLimitamLi(produto), depositoId, estoqueIds);
}

/** {@link lerRegistrosNoDepositoLi}'s options. */
export interface OpcoesRegistrosNoDepositoLi {
  /**
   * How many of the group joins and of the own-collection queries may run at once (default 1:
   * one after another, the send run's order). The daily reconcile reads a whole walk page so.
   */
  readonly concorrencia?: number;
}

/**
 * EVERY record of the given produtos at the conta's depósito — the read
 * {@link lerComponentesNoDepositoLi} makes for a kit's bounding components, for ANY list of
 * produtos (the daily reconcile reads a walk page's own records and its kits' components through
 * it, so a send run and the reconcile can never resolve a produto's stock differently). In order:
 * the ids `idsConhecidos` names that ARE the canonical record (`makeEstoqueUid`), by ONE `getAll`;
 * then the group join for those still missing, per stored form, at most
 * {@link MAX_VALORES_IN_ESTOQUE_LI} per query; then the own-collection query for each one whose
 * CANONICAL record is still unread. No read at all for an empty list. Several records of one
 * produto all come back: resolving them is `estoqueNoDepositoLi`'s.
 */
export async function lerRegistrosNoDepositoLi(
  db: Firestore,
  produtoIds: readonly string[],
  depositoId: string,
  idsConhecidos: Readonly<Record<string, string | null>> | null,
  opcoes: OpcoesRegistrosNoDepositoLi = {},
): Promise<DocEstoqueLi[]> {
  const componentes = [...new Set(produtoIds)];
  if (componentes.length === 0) return [];
  const concorrencia = opcoes.concorrencia ?? 1;
  const estoqueIds = idsConhecidos;
  const formas = formasDoDepositoLi(depositoId);
  const porDono = new Map<string, Map<string, DocEstoqueLi>>();
  const guardar = (doc: DocEstoqueLi, aceitos: ReadonlySet<string>): void => {
    const partes = caminhoEstoqueLi(doc.caminho);
    if (partes === null || !aceitos.has(partes.produtoId)) return;
    const grupo = porDono.get(partes.produtoId) ?? new Map<string, DocEstoqueLi>();
    grupo.set(doc.caminho, doc);
    porDono.set(partes.produtoId, grupo);
  };
  const todos = new Set(componentes);

  // 1. The payload's ids, when canonical: one getAll.
  const porId = componentes.filter((c) => {
    const id = estoqueIds === null ? undefined : proprio(estoqueIds, c);
    return id === makeEstoqueUid(c, depositoId);
  });
  if (porId.length > 0) {
    const snaps = await db.getAll(
      ...porId.map((c) =>
        estoqueCollection.docRef(db, { produtoId: c }, makeEstoqueUid(c, depositoId)),
      ),
    );
    for (const snap of snaps) {
      const dados = snap.exists ? snap.data() : undefined;
      if (dados !== undefined && registroNoDepositoLi(dados, formas)) {
        guardar({ caminho: snap.ref.path, dados }, todos);
      }
    }
  }

  // 2. The group join, per stored form, for the components still missing.
  const [campoDono, campoDeposito] = CAMPOS_INDICE_COMPONENTES_LI;
  const semRegistro = () => componentes.filter((c) => !porDono.has(c));
  const juncoes = emFatias(semRegistro()).flatMap((fatia) =>
    formas.map((forma) => ({ fatia, forma })),
  );
  const respostas = await emParaleloLi(juncoes, concorrencia, ({ fatia, forma }) =>
    estoqueCollection
      .groupQuery(db)
      .where(campoDono, 'in', fatia)
      .where(campoDeposito, '==', forma)
      .get(),
  );
  juncoes.forEach(({ fatia }, i) => {
    const aceitos = new Set(fatia);
    for (const d of respostas[i]?.docs ?? []) {
      guardar({ caminho: d.ref.path, dados: d.data() }, aceitos);
    }
  });

  // 3. A component whose CANONICAL record is still unread: its own collection. A join hit is not
  //    a complete answer — a record with no `parentId` (the canonical one included) is invisible
  //    to the join, so a component the join found only through legacy records may hide the record
  //    that wins, or a second legacy one that makes it ambiguous. The canonical record alone needs
  //    nothing more: it wins whatever sits beside it (`estoqueNoDepositoLi`).
  const temCanonico = (componente: string): boolean => {
    const canonico = makeEstoqueUid(componente, depositoId);
    return [...(porDono.get(componente)?.values() ?? [])].some(
      (doc) => caminhoEstoqueLi(doc.caminho)?.estoqueId === canonico,
    );
  };
  const semCanonico = componentes.filter((c) => !temCanonico(c));
  const proprios = await emParaleloLi(semCanonico, concorrencia, (componente) =>
    lerEstoqueNoDepositoPorConsultaLi(db, componente, formas),
  );
  semCanonico.forEach((componente, i) => {
    for (const registro of proprios[i] ?? []) guardar(registro, new Set([componente]));
  });

  return [...porDono.values()].flatMap((grupo) => [...grupo.values()]);
}

/** Whether the produto has a stock record at ANY depósito: a where-less listing, `limit 1`. */
export async function temEstoqueEmQualquerDepositoLi(
  db: Firestore,
  produtoId: string,
): Promise<boolean> {
  const snap = await estoqueCollection.ref(db, { produtoId }).limit(1).get();
  return !snap.empty;
}

/**
 * Whether ANOTHER produto holds a counting link of this conta to store product `idLi` — the
 * duplicate a run must never send through. One group query per stored form of the conta ref:
 * `contaLojaIntegrada == form` and `id in [<number>, '<text>']` (a link may store the id either
 * way, and `vinculoLiConta` counts both), then, in code, the conta and the counting predicate
 * (`contaDoLinkLi`, `vinculoLiConta`: a trashed link is no duplicate) and an owner — read off the
 * PATH — other than `produtoId`. `idLi` is the canonical decimal text of a positive safe integer.
 */
export async function sondarVinculoDuplicadoLi(
  db: Firestore,
  contaId: string,
  idLi: string,
  produtoId: string,
): Promise<boolean> {
  const [campoConta, campoId] = CAMPOS_INDICE_VINCULO_LI;
  const snaps = await Promise.all(
    contaRefForms(contaId).map((forma) =>
      produtoLojaIntegradaLinkCollection
        .groupQuery(db)
        .where(campoConta, '==', forma)
        .where(campoId, 'in', [Number(idLi), idLi])
        .limit(LIMITE_VINCULOS_LI)
        .get(),
    ),
  );
  return snaps.some((snap) =>
    snap.docs.some((d) => {
      const dono = d.ref.parent.parent?.id;
      const dados: Record<string, unknown> = d.data();
      return (
        dono !== undefined &&
        dono !== produtoId &&
        contaDoLinkLi(dados) === contaId &&
        vinculoLiConta(dados)
      );
    }),
  );
}
