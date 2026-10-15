/**
 * Resolve a hand-picked selection of produtos to their family ANCHORS (#1529,
 * step 21).
 *
 * The produtos table hands a bulk push whatever the operator checked — a family
 * anchor or a variation CHILD — while the listing (`prodshopee`) hangs off the
 * anchor. A requested child is therefore a request for its anchor's listing:
 * the rows name the ANCHOR, and a requested id with no listing to act on is
 * reported under its OWN id. That is the cross-channel contract
 * `apps/web/lib/marketplace/estoque/types.ts` states for every registered
 * channel.
 *
 * Two callers today — the manual stock push's shared plan
 * (`estoque/planejarEnvioEstoque.ts`, which both its `--live`/route path and
 * its `enviar:estoque` dry run call) and the listing status action
 * (`anuncios/pausarAnuncio.ts`) — so it lives in `core/` rather than in
 * whichever one happened to need it first.
 *
 * ⚠️ The manual PRICE push does not call this module: `precos/enviarPrecoManual.ts`
 * keeps its private `paiDe` and `conferirContabilidadeDePreco` (step 21,
 * residual 19). Both wrap the SAME {@link naoDocId} rule this module imports, so
 * the hop cannot drift between the three pushes; only a two-line wrapper is
 * written twice.
 *
 * Operation-neutral by construction: no depósito, no quantity, no price, no
 * listing, and no clock.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';

import { naoDocId } from '../anuncios/corpoPublicacao';

/** The two produto fields the resolution reads — and the only two it may read. */
const CAMPOS_DA_RESOLUCAO = ['nome', 'paiId'] as const;

/**
 * The ONE field the label read takes. No `paiId`, so that read can never become
 * a second hop.
 */
const CAMPOS_DO_ROTULO = ['nome'] as const;

export interface AnchorsShopee {
  /** Anchor ids, deduped, in first-seen request order. */
  anchorIds: string[];
  /**
   * Requested id → the anchor it resolved to (itself when it is an anchor).
   * A requested id with no document is absent — it is in {@link naoEncontrados}.
   */
  anchorDe: Map<string, string>;
  /**
   * Id → its stored `nome`, `null` when that is not a usable string: every
   * requested id, AND every anchor a requested id resolved to. The anchor's rows
   * carry the ANCHOR's name, so a selection of only a variation child still names
   * the listing it moved (the price push's `nomeDoAnchor` precedent,
   * `precos/enviarPrecoManual.ts`). An id with no document has no entry.
   */
  nomeDe: Map<string, string | null>;
  /** Requested ids with no produto document, in request order. */
  naoEncontrados: string[];
}

/**
 * The pure rule: a `paiId` that names a document wins, else the produto is its
 * own anchor.
 *
 * ⚠️ "Names a document" is {@link naoDocId}'s rule, never truthiness: `''`,
 * `'a/b'`, `'..'` and a non-string (`42`, `null`, absent) all leave the produto
 * as its OWN anchor. A truthy `'a/b'` would otherwise be handed to `.doc()` as a
 * PATH and address a document nobody named.
 */
export function anchorDoProduto(id: string, dados: Record<string, unknown> | undefined): string {
  const pai = dados?.['paiId'];
  return typeof pai === 'string' && !naoDocId(pai) ? pai : id;
}

/** A stored `nome`, when it is a usable one. A blank name is an absence, never an empty label. */
function nomeUtilizavel(dados: Record<string, unknown>): string | null {
  const nome = dados['nome'];
  return typeof nome === 'string' && nome.trim() !== '' ? nome : null;
}

/**
 * Resolve each requested id to its family anchor with ONE masked batch key read
 * (`getAll(…, { fieldMask: ['nome', 'paiId'] })`) — a key read, so there is no
 * index to ride and none to miss (root `CLAUDE.md` rule 1). Only when an anchor
 * was not itself requested, ONE more masked key read fetches those anchors'
 * `nome` for their rows (`fieldMask: ['nome']`: a label, never a second hop).
 *
 * Exactly ONE hop. A two-deep `paiId` chain is pathological: the hop lands on a
 * produto that is itself a child, whose family read finds no listing, and the
 * caller REPORTS the requested id — it is never dropped.
 *
 * The snapshots are reconciled BY ID (`snap.id`), never by position, and the
 * request is deduped first. An empty selection reads nothing: `getAll` with no
 * reference rejects.
 */
export async function resolverAnchorsShopee(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<AnchorsShopee> {
  const pedidos = [...new Set(produtoIds)];
  const resolvidos: AnchorsShopee = {
    anchorIds: [],
    anchorDe: new Map(),
    nomeDe: new Map(),
    naoEncontrados: [],
  };
  if (pedidos.length === 0) return resolvidos;

  const snaps = await db.getAll(...pedidos.map((id) => produtoCollection.docRef(db, {}, id)), {
    fieldMask: [...CAMPOS_DA_RESOLUCAO],
  });
  const lidos = new Map<string, Record<string, unknown>>();
  for (const snap of snaps) {
    if (snap.exists) lidos.set(snap.id, (snap.data() ?? {}) as Record<string, unknown>);
  }

  const vistos = new Set<string>();
  for (const id of pedidos) {
    const dados = lidos.get(id);
    if (dados === undefined) {
      resolvidos.naoEncontrados.push(id);
      continue;
    }
    resolvidos.nomeDe.set(id, nomeUtilizavel(dados));
    const anchor = anchorDoProduto(id, dados);
    resolvidos.anchorDe.set(id, anchor);
    if (!vistos.has(anchor)) {
      vistos.add(anchor);
      resolvidos.anchorIds.push(anchor);
    }
  }

  // The label read: only the anchors nobody requested, whose name the first
  // batch never saw. A dangling `paiId` simply finds no document — no entry.
  const foiPedido = new Set(pedidos);
  const anchorsNaoPedidos = resolvidos.anchorIds.filter((a) => !foiPedido.has(a));
  if (anchorsNaoPedidos.length > 0) {
    const rotulos = await db.getAll(
      ...anchorsNaoPedidos.map((id) => produtoCollection.docRef(db, {}, id)),
      { fieldMask: [...CAMPOS_DO_ROTULO] },
    );
    for (const snap of rotulos) {
      if (snap.exists) {
        resolvidos.nomeDe.set(
          snap.id,
          nomeUtilizavel((snap.data() ?? {}) as Record<string, unknown>),
        );
      }
    }
  }
  return resolvidos;
}

/**
 * ⚠️ THE ACCOUNTING INVARIANT, per anchor. Every requested id leaves in exactly
 * ONE place — its own "no listing" entry (`idsSemEnvio`), or the rows of the
 * anchor it resolved to (`anchorsDasLinhas`) — never both, never neither; no
 * "no listing" entry names an id nobody requested, none appears twice, and no
 * row names an anchor no requested id resolved to. A produto that vanishes under
 * a green summary is the failure this whole area is built against, so it THROWS
 * a plain `Error` rather than logging: a violation is a defect in the caller's
 * bookkeeping, never an input the operator could have sent.
 *
 * `tag` prefixes every message so the log says which push broke it.
 */
export function conferirContabilidadePorAnchor(
  tag: string,
  solicitados: readonly string[],
  anchorDe: ReadonlyMap<string, string>,
  anchorsDasLinhas: ReadonlySet<string>,
  idsSemEnvio: readonly string[],
): void {
  const pedidos = new Set(solicitados);
  const anchorsPedidos = new Set<string>();
  for (const id of solicitados) {
    const anchor = anchorDe.get(id);
    if (anchor !== undefined) anchorsPedidos.add(anchor);
  }

  const semEnvio = new Set<string>();
  for (const id of idsSemEnvio) {
    if (!pedidos.has(id)) {
      throw new Error(`${tag}: ${id} não foi solicitado e aparece entre os produtos sem envio`);
    }
    if (semEnvio.has(id)) {
      throw new Error(`${tag}: ${id} aparece DUAS vezes entre os produtos sem envio`);
    }
    semEnvio.add(id);
  }

  for (const anchor of anchorsDasLinhas) {
    if (!anchorsPedidos.has(anchor)) {
      throw new Error(`${tag}: a âncora ${anchor} aparece nas linhas e nenhum pedido resolve nela`);
    }
  }

  for (const id of solicitados) {
    const anchor = anchorDe.get(id);
    const nasLinhas = anchor !== undefined && anchorsDasLinhas.has(anchor);
    const semLinha = semEnvio.has(id);
    if (nasLinhas && semLinha) {
      throw new Error(`${tag}: ${id} aparece nas DUAS listas — contabilidade quebrada`);
    }
    if (!nasLinhas && !semLinha) {
      throw new Error(`${tag}: ${id} foi solicitado e não aparece em nenhuma lista`);
    }
  }
}
