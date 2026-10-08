/**
 * The kit arms' link WRITERS (step 19, #1527) — the ONLY module under `kits/`
 * that writes a `prodshopee` or a `variashopee` document. No transaction: every
 * write here is rule 7 tier 0 (an upsert or a `create()` at an id no other run
 * can compute) or a last-read-wins write of values just READ from Shopee
 * (reconcile R-k) — #2 with ONE tier-1 guard, a `lastUpdateTime` precondition
 * that keeps it from moving a link OUT of `removido` (R1-RT7-05).
 *
 * ## The three writes of a create, in order (L9)
 *
 * 1. {@link escreverVinculoDoKit} — the ONE write right after a successful
 *    `add_kit_item`, at `idDoVinculoDeKit(integracaoId, item_id)`. A fresh
 *    `item_id` is new, so no other create can compute that id; step 9's import
 *    of the same kit computes it too (R-u), so a concurrent import and the
 *    create land on ONE document instead of two. `merge`, never `set`:
 *    `parseMerge` validates only the keys present, so the import's status keys
 *    survive. It writes the LITERAL `kitNativo: true` — `add_kit_item`'s own 200
 *    is the proof — so a crash before the read-back still leaves steps 12/13
 *    treating the listing as a kit (R-1).
 * 2. {@link escreverLeituraDoKit} — "#2", what the read-back REPORTED:
 *    `item_status`, `estadoAnuncio` (the `statusAnuncio.ts` fold), `deboost`,
 *    `item_name` and `kitNativo: ehKitDe(base)`, which overwrites the literal.
 *    Also the recriar's old-link write (PR 6) and the `removido` of a linked kit
 *    the scan did not list and that read deleted (S2C-02). Never out of
 *    `removido`: a guarded `update(…, { lastUpdateTime })` (R1-RT7-05).
 * 3. {@link escreverVariacoesDoKit} — one `variashopee` row per (link, model),
 *    under the CHILD. An existing row (found in the WRITTEN link's rows, never
 *    the target's — V2R1-03) gets a flat `mergeIfExists({ receitaKitConferida })`
 *    and nothing else; a missing one is `create()`d at
 *    `idDaVariacaoDeKit(linkDocId, model_id)` with `linhaVariacaoDeKit(…)`, and
 *    an ALREADY_EXISTS (step 9's import wrote it first, at the same id) falls
 *    back to that re-stamp. Never a full `set`: it would erase step 13's
 *    `preco*` and the model sync's `modeloAusenteEm`/`model_status`.
 *
 * ## The stamp is the CALLER's decision
 *
 * `receitaKitConferida` is `chaveReceitaKitErp` of the child's ERP recipe, and
 * only when the READ-BACK of that child's kit model just folded EQUAL to the
 * projection (`mesmaReceitaKitShopee`, `aplicarKit.ts` decides it). This module
 * writes the value it is handed and decides nothing: a `null` on an EXISTING row
 * writes nothing at all — a distinct read-back leaves the old stamp, and the L4
 * aviso decision reads that stamp against the child's current fingerprint.
 *
 * ⚠️ The bare word for a multi-document atomic block stays out of this file:
 * `firestore-transaction-inventory.test.js` greps raw text, and every `kits/*.ts`
 * is transaction-free by design (R-k).
 *
 * Next-free and clock-free: `deps.nowMs` is the one clock.
 */
import {
  ESTADO_ANUNCIO_SHOPEE,
  linhaVariacaoDeKit,
  toOuterRef,
  type EstadoAnuncioShopee,
} from '@delfrance/schemas';
import {
  integracaoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import { isAlreadyExists, isFailedPrecondition } from '@delfrance/data/admin/grpcErrors';
import type { ShopeeAddKitItemRequest } from '@delfrance/integrations-shopee';

import { ETAPA_PUBLICACAO } from '../anuncios/errosPublicacao';
import type { PublicarAnuncioDeps } from '../anuncios/publicarAnuncio';
import { agendadoParaMsDe, estadoDoAnuncio } from '../anuncios/statusAnuncio';
import { ehKitDe, itemStatusDe, type ItemLido } from '../produtos/itemLido';
import {
  caminhoDoLinkDaListagem,
  itemStatusDeLink,
  modelStatusDeLink,
} from '../produtos/mapeamento';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from './idsKit';

/** What every writer here needs — a structural subset of the kit arms' `KitDeps`. */
export type DepsDeVinculoKit = Pick<PublicarAnuncioDeps, 'db' | 'integracaoId' | 'nowMs'>;

/* -------------------------------------------------------------------------- */
/*                         (1) the link write after add                       */
/* -------------------------------------------------------------------------- */

/**
 * The ONE link write after a successful `add_kit_item` — step 11's write-back
 * #1 field set (`publicarAnuncio.ts`) minus the item-only keys (category,
 * condition, attributes, brand, tax), plus the literal `kitNativo: true`.
 *
 * `publicadoEm` and `dataCadastro` are written unconditionally: the document is
 * new by construction (its id derives from an `item_id` Shopee just minted). The
 * one exception is R-u's import race, where the two values are seconds apart.
 *
 * @returns the link doc id — `idDoVinculoDeKit(integracaoId, itemId)`.
 */
export async function escreverVinculoDoKit(
  deps: DepsDeVinculoKit,
  a: {
    /** K — the kit produto, owner of the link. */
    readonly produtoId: string;
    /** The `item_id` `add_kit_item` answered. */
    readonly itemId: number;
    /** The body that was SENT — the values written are the ones Shopee accepted. */
    readonly corpo: ShopeeAddKitItemRequest;
  },
): Promise<string> {
  const linkDocId = idDoVinculoDeKit(deps.integracaoId, a.itemId);
  const s = a.corpo.item_setting;
  await produtoShopeeLinkCollection.merge(deps.db, { produtoId: a.produtoId }, linkDocId, {
    // Always canonical, never a stored value — the conta filter every reader
    // applies is this field.
    contaProdutoShopeeOuterRef: toOuterRef(integracaoCollection.docPath({}, deps.integracaoId)),
    item_id: a.itemId,
    // ⚠️ LITERAL: `add_kit_item`'s 200 proves it. The read-back overwrites it
    // with what Shopee reports (R-1).
    kitNativo: true,
    item_name: s.item_name,
    description: s.description,
    logistic_info: s.logistic_info,
    ultimaPublicacao: { em: deps.nowMs, etapa: ETAPA_PUBLICACAO.addKitItem, itemId: a.itemId },
    ultimaModificacao: deps.nowMs,
    publicadoEm: deps.nowMs,
    dataCadastro: deps.nowMs,
  });
  return linkDocId;
}

/* -------------------------------------------------------------------------- */
/*                         (2) #2 — the read-back write                       */
/* -------------------------------------------------------------------------- */

/**
 * What a kit read said about one listing.
 *
 * - `item` — a full read-back (`lerAnuncioShopee`): every #2 field is written.
 * - `status` — only a `get_item_base_info` STATUS is known (the batched read of
 *   a linked kit the scan did not list, S2C-02), or nothing at all: `null` = the
 *   row was ABSENT (a purged kit, S2C-07). Only `estadoAnuncio` is written —
 *   nothing was read about `deboost`, the name or the kit tag, so nothing is
 *   claimed about them.
 */
export type LeituraDoKit =
  | { readonly kind: 'item'; readonly item: ItemLido }
  | { readonly kind: 'status'; readonly itemStatus: string | null };

/** What #2 wrote, for the caller's result. */
export interface LeituraDoKitEscrita {
  readonly estadoAnuncio: EstadoAnuncioShopee;
  /** The RAW read `item_status` (`null` on an absent row). */
  readonly itemStatus: string | null;
  /** `ehKitDe(base)` on a full read; `null` when only a status was read. */
  readonly kitNativo: boolean | null;
}

/**
 * How many times #2 re-reads the link after losing its precondition to a
 * concurrent writer before it surfaces the contention (`isFailedPrecondition`'s
 * contract: bounded, never a spin).
 */
const TENTATIVAS_DA_LEITURA_ESCRITA = 3;

/**
 * Write-back #2 of a kit link — values READ from Shopee (the shape of step 11's
 * write-back #2), with ONE guard (R1-RT7-05, rule 7 tier 1): **#2 never moves a
 * link OUT of `removido`.** A deleted Shopee listing never comes back, and the
 * only legitimate un-delete of a link is a human's `reverificar:anuncio` (a
 * different writer). Without the guard, a republish of an old kit racing a
 * recriar of it — from a second tab or operator — could read the kit `NORMAL`
 * before the recriar's `delete_item` and land its #2 AFTER the recriar's
 * `removido`, putting a deleted kit back as live beside its successor (every
 * publish then refuses `vinculos-ambiguos`, and step 13 prices a deleted item).
 *
 * The guard is read → decide → `update(patch, { lastUpdateTime })`: the link's
 * snapshot decides, and a concurrent write in between fails the precondition, so
 * the decision is RE-DERIVED from a fresh read (bounded) instead of re-applied. A
 * link that does not exist yet is written by a plain `merge`, as before. A
 * skipped write returns the STORED `removido`, so the run reports what the link
 * says. Every other transition is still last-read-wins (R-k): two reads of a
 * LIVE listing differ only by time.
 *
 * ⚠️ `kitNativo` is `ehKitDe(base)` of THIS read, never a literal: every writer
 * of the flag writes what it just read, the ONE exception being
 * {@link escreverVinculoDoKit}, whose literal `add_kit_item`'s 200 proves.
 */
export async function escreverLeituraDoKit(
  deps: Pick<DepsDeVinculoKit, 'db' | 'nowMs'>,
  a: { readonly produtoId: string; readonly linkDocId: string; readonly leitura: LeituraDoKit },
): Promise<LeituraDoKitEscrita> {
  if (a.leitura.kind === 'item') {
    const item = a.leitura.item;
    const itemStatus = itemStatusDe(item);
    const fold = estadoDoAnuncio(
      {
        kind: 'lido',
        itemStatus,
        deboost: item.base.deboost,
        agendadoParaMs: agendadoParaMsDe(item.base.scheduled_publish_time),
      },
      deps.nowMs,
    );
    const kitNativo = ehKitDe(item.base);
    const nome = item.base.item_name;
    const escrito = await gravarSemDesfazerRemocao(deps, a, fold.estado, {
      item_status: itemStatusDeLink(item),
      estadoAnuncio: fold.estado,
      deboost: fold.deboost,
      // `item_name` is a REQUIRED non-empty string on the link: a blank read
      // never overwrites the stored name.
      ...(typeof nome === 'string' && nome.trim() !== '' ? { item_name: nome } : {}),
      kitNativo,
      // A read-back that got this far followed a write that SUCCEEDED; a stale
      // failure stamp would make the operator's panel lie.
      falhaPublicacao: null,
      ultimaModificacao: deps.nowMs,
    });
    return { estadoAnuncio: escrito, itemStatus, kitNativo };
  }

  const itemStatus = a.leitura.itemStatus;
  const fold = estadoDoAnuncio(
    itemStatus === null
      ? { kind: 'ausente' }
      : { kind: 'lido', itemStatus, deboost: null, agendadoParaMs: null },
    deps.nowMs,
  );
  // ⚠️ `estadoAnuncio` only — the reverify's `arquivarRemovido` shape. The raw
  // status stays OFF the link here: a deleted status (`SELLER_DELETE`) is
  // written into `item_status` by a FULL read alone (the recriar's old-link
  // read-back, PR 6), which is the writer `shopeeItemStatusSchema`'s docblock
  // names for it.
  const escrito = await gravarSemDesfazerRemocao(deps, a, fold.estado, {
    estadoAnuncio: fold.estado,
    ultimaModificacao: deps.nowMs,
  });
  return { estadoAnuncio: escrito, itemStatus, kitNativo: null };
}

/**
 * The guarded #2 write (see {@link escreverLeituraDoKit}). Returns the estado
 * the link HOLDS afterwards: `novo` when written, the stored `removido` when the
 * guard skipped the write.
 */
async function gravarSemDesfazerRemocao(
  deps: Pick<DepsDeVinculoKit, 'db'>,
  a: { readonly produtoId: string; readonly linkDocId: string },
  novo: EstadoAnuncioShopee,
  patch: Record<string, unknown>,
): Promise<EstadoAnuncioShopee> {
  const dados = produtoShopeeLinkCollection.parseMerge(patch);
  const ref = produtoShopeeLinkCollection.docRef(deps.db, { produtoId: a.produtoId }, a.linkDocId);
  for (let tentativa = 1; ; tentativa += 1) {
    const snap = await ref.get();
    if (!snap.exists) {
      // No link yet: nothing to un-delete. The plain merge, as before.
      await produtoShopeeLinkCollection.merge(
        deps.db,
        { produtoId: a.produtoId },
        a.linkDocId,
        patch,
      );
      return novo;
    }
    const guardado = (snap.data() ?? {}).estadoAnuncio;
    if (guardado === ESTADO_ANUNCIO_SHOPEE.removido && novo !== ESTADO_ANUNCIO_SHOPEE.removido) {
      console.warn('[shopee/kits] #2 ignorado: o vínculo já está removido e não volta a viver', {
        produtoId: a.produtoId,
        linkDocId: a.linkDocId,
        estadoLido: novo,
      });
      return ESTADO_ANUNCIO_SHOPEE.removido;
    }
    try {
      await ref.update(dados as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return novo;
    } catch (err) {
      // A concurrent writer landed between the read and the write: re-read and
      // re-DECIDE (never re-apply the lost decision); bounded.
      if (!isFailedPrecondition(err) || tentativa >= TENTATIVAS_DA_LEITURA_ESCRITA) throw err;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                       (3) the kit-model variashopee rows                   */
/* -------------------------------------------------------------------------- */

/** One kit model bound to one child, as the completion decided it. */
export interface LinhaDeVariacaoDoKit {
  /** The CHILD that owns the row (a família de um: the member). */
  readonly filhoId: string;
  readonly modelId: number;
  /** From the READ-BACK — never the request position (R-l). */
  readonly tierIndex: readonly number[];
  /** RAW `get_model_list` status; folded here (an unknown token ⇒ `null`). */
  readonly modelStatus: string | null;
  /** The fingerprint when the read-back folded EQUAL, else `null`. */
  readonly receitaKitConferida: string | null;
}

/** A row of `ContextoKit.linhasDaConta` — the shape this writer reads. */
export interface LinhaDaContaLida {
  readonly produtoId: string;
  readonly docId: string;
  /** `idDoRef(produtoShopeeOuterRef)`; `null` = unreadable, never bound. */
  readonly linkDocId: string | null;
  readonly raw: Record<string, unknown>;
}

/** What {@link escreverVariacoesDoKit} did, per row. */
export interface ResultadoVariacoesDoKit {
  /** New rows `create()`d. */
  readonly criadas: number;
  /** Existing rows whose stamp was (re)written. */
  readonly recarimbadas: number;
  /** Existing rows left untouched (a distinct read-back writes no stamp). */
  readonly mantidas: number;
}

/**
 * Write one row per bound kit model of the WRITTEN link `linkDocId`.
 *
 * ⚠️ The existing-row lookup is (`linkDocId`, `model_id`) over the rows of THIS
 * link — on a recriar/converter that is not ctx's target (V2R1-03) — and the
 * row it finds is written where it LIVES: the row decides its owner.
 */
export async function escreverVariacoesDoKit(
  deps: DepsDeVinculoKit,
  a: {
    /** K — owner of the link the rows point at. */
    readonly linkProdutoId: string;
    readonly linkDocId: string;
    /** `ContextoKit.linhasDaConta` — every child's rows of this conta. */
    readonly linhasDaConta: readonly LinhaDaContaLida[];
    readonly linhas: readonly LinhaDeVariacaoDoKit[];
  },
): Promise<ResultadoVariacoesDoKit> {
  const contaRef = toOuterRef(integracaoCollection.docPath({}, deps.integracaoId));
  const linkPath = toOuterRef(caminhoDoLinkDaListagem(a.linkProdutoId, a.linkDocId));
  let criadas = 0;
  let recarimbadas = 0;
  let mantidas = 0;

  for (const linha of a.linhas) {
    const existente = a.linhasDaConta.find(
      (r) => r.linkDocId === a.linkDocId && r.raw.model_id === linha.modelId,
    );
    if (existente !== undefined) {
      if (linha.receitaKitConferida === null) {
        mantidas += 1;
        continue;
      }
      const escrito = await recarimbar(deps, existente.produtoId, existente.docId, linha);
      if (escrito) recarimbadas += 1;
      else mantidas += 1;
      continue;
    }

    const docId = idDaVariacaoDeKit(a.linkDocId, linha.modelId);
    const dados = variacaoShopeeLinkCollection.parse(
      linhaVariacaoDeKit({
        contaRef,
        linkPath,
        modelId: linha.modelId,
        tierIndex: linha.tierIndex,
        // ⚠️ Folded HERE (W1a): the builder stores what it is given, and the
        // schema's enum would refuse a status Shopee invents tomorrow.
        modelStatus: modelStatusDeLink(linha.modelStatus),
        receitaKitConferida: linha.receitaKitConferida,
      }),
    );
    try {
      await variacaoShopeeLinkCollection
        .docRef(deps.db, { produtoId: linha.filhoId }, docId)
        .create(dados);
      criadas += 1;
    } catch (err) {
      // Step 9's import wrote the same row at the same derived id first (R-u):
      // the row exists, so this run only re-stamps it.
      if (!isAlreadyExists(err)) throw err;
      if (linha.receitaKitConferida === null) {
        mantidas += 1;
        continue;
      }
      const escrito = await recarimbar(deps, linha.filhoId, docId, linha);
      if (escrito) recarimbadas += 1;
      else mantidas += 1;
    }
  }

  return { criadas, recarimbadas, mantidas };
}

/**
 * The flat re-stamp. `mergeIfExists`, never `merge`: a row deleted meanwhile
 * must not be resurrected carrying only the stamp (no `model_id`, no refs).
 */
async function recarimbar(
  deps: DepsDeVinculoKit,
  produtoId: string,
  docId: string,
  linha: LinhaDeVariacaoDoKit,
): Promise<boolean> {
  const escrito = await variacaoShopeeLinkCollection.mergeIfExists(deps.db, { produtoId }, docId, {
    receitaKitConferida: linha.receitaKitConferida,
  });
  if (!escrito) {
    console.warn('[shopee/kits] linha do modelo sumiu antes do carimbo; nada foi recriado', {
      produtoId,
      docId,
      modelId: linha.modelId,
    });
  }
  return escrito;
}
