/**
 * When Mercado Livre moves a listing to another category, does an operator have
 * to look? (#847)
 *
 * ML recategorizes listings on its own — "recategorização automática" for items
 * published via API, and splits of its category tree — and reports it only as
 * an ordinary `items` notification. The `items` sync (and every other writer of
 * the listing link: publish's echo, a re-import, "Reverificar anúncio") stores
 * ML's value on `produtoMercadoLivre.category_id`; this module reacts to that
 * COMMITTED write, through the `onAnuncioCategoriaAlterada` trigger, whichever
 * writer made it. Deciding inside the `items` sync instead would miss every
 * change a different writer absorbed first.
 *
 * Why it matters: the produto's ERP category (`categoriaProdutoOuterRef`) picks
 * the price list's formulas — `formulasPorCategoria`, with the commission and
 * frete figures — and the NF-e tax rules. The ML importer names ERP categories
 * after ML's (`categorias/<MLB id>`), so after a recategorization the produto
 * keeps pricing with the OLD category's commission, and nothing said so. The
 * ERP category is never moved automatically (it also drives taxes); this module
 * raises an aviso so a human decides.
 *
 * Pure decisions first, IO below — the `integracoesComProduto.ts` split. ⚠️ No
 * transaction anywhere (and no entry in the transaction inventory): every
 * decision is re-derived from the CURRENT link and produto, the aviso writer and
 * resolver bring their own `lastUpdateTime` preconditions, and the producer
 * re-reads after writing (see {@link aplicarPlanoCategoriaDoLink}) — so a replayed
 * or concurrent event converges instead of racing (root `CLAUDE.md` rule 7).
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MlCategory,
  type MlListingPrices,
  MercadoLivreError,
} from '@delfrance/integrations-mercado-livre';
import { linkHasLiveListing, toOuterRefOrNull } from '@delfrance/schemas';
import {
  avisoCollection,
  categoriaCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { contaIdFromRef } from '@delfrance/data/admin/produtos';

import type { AvisoDeps } from '../core/avisoDeps';
import { MercadoLivreConfigError, MercadoLivreContaNotConfiguredError } from '../core/mercadoLivre';
import { getCategoriaCached } from '../categorias/mlMetadataCache';
import { buildCategoriaChain, criarCadeiaCategoria } from '../importacao/importCategoria';
import {
  type AlvoAvisoCategoria,
  MOTIVO_RESOLUCAO_CATEGORIA,
  type MotivoResolucaoCategoria,
  avisarCategoriaAlterada,
  chaveAnuncioCategoriaAlterada,
  resolverAvisoCategoria,
} from './avisoCategoria';

/* -------------------------------------------------------------------------- */
/*                               Pure decisions                               */
/* -------------------------------------------------------------------------- */

/**
 * The ERP category id a produto's `categoriaProdutoOuterRef` names, or `null`
 * when it names none.
 *
 * ⚠️ This decides SAMENESS — "is the ERP category still the one ML left?" — so
 * its scope matters in both directions: every stored form of one ref must
 * collapse (`documents/categorias/MLB1` ≡ `categorias/MLB1`), and nothing else
 * may (`MLB12` ≠ `MLB1`, `mlb1` ≠ `MLB1` — ML ids are opaque, case-sensitive
 * keys; a ref into any other collection, or a nested path, names no category).
 * `categoriaAnuncio.test.ts` pins both.
 */
export function categoriaErpIdDe(ref: unknown): string | null {
  const canonica = toOuterRefOrNull(ref);
  if (canonica == null) return null;
  const segmentos = canonica.slice('documents/'.length).split('/');
  if (segmentos.length !== 2 || segmentos[0] !== 'categorias') return null;
  return segmentos[1] ? segmentos[1] : null;
}

/** What one committed link write asks of this module, decided from the payload alone. */
export type PlanoCategoriaDoLink =
  | {
      readonly tipo: 'categoria';
      readonly integracaoId: string;
      /** The ML listing id — the same before and after, by construction. */
      readonly anuncio: string;
      /** The ML category the listing LEFT. */
      readonly anterior: string;
      /** The ML category the listing ENTERED. */
      readonly nova: string;
    }
  | {
      readonly tipo: 'fim';
      readonly integracaoId: string;
      readonly motivo: Extract<
        MotivoResolucaoCategoria,
        'anuncio-encerrado' | 'anuncio-desvinculado'
      >;
    };

/**
 * Classify one link write from the Eventarc payload — ZERO reads.
 *
 * ⚠️ COST: these link docs are rewritten constantly for reasons that cannot
 * matter here (every stock-send error and price writeback merges
 * `estado`/`errors`/`ultimaModificacao`), so the overwhelming majority of events
 * must return `null` before anything touches Firestore — the
 * `onProdutoMercadoLivreLinkChanged` contract.
 *
 * Arm `categoria` — a recategorization of a LIVE listing: both sides exist, the
 * ML listing id is the same non-empty string before and after, and both
 * `category_id`s are strings that differ. Each exclusion is deliberate:
 *  - the first publish (`id` null → set) and a UPtin re-key (`id` changes) are
 *    a NEW listing, not ML moving an existing one;
 *  - a null → X fill has no "old" category to compare the ERP one with;
 *  - a draft (no `id`) is the operator's own choice, not ML's;
 *  - a listing that is not live sells nothing, so its commission is moot.
 *
 * Arm `fim` — the listing stopped being live, or its link was deleted: an open
 * aviso about its commission is moot and nothing else would ever close it.
 */
export function planCategoriaDoLink(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): PlanoCategoriaDoLink | null {
  if (before && linkHasLiveListing(before) && !(after && linkHasLiveListing(after))) {
    const integracaoId = contaIdFromRef(before.contaOuterRef);
    if (integracaoId == null) return null;
    return {
      tipo: 'fim',
      integracaoId,
      motivo: after
        ? MOTIVO_RESOLUCAO_CATEGORIA.encerrado
        : MOTIVO_RESOLUCAO_CATEGORIA.desvinculado,
    };
  }

  if (!before || !after || !linkHasLiveListing(after)) return null;
  const anuncio = after.id;
  if (typeof anuncio !== 'string' || anuncio.length === 0 || before.id !== anuncio) return null;
  const anterior = before.category_id;
  const nova = after.category_id;
  if (typeof anterior !== 'string' || typeof nova !== 'string' || anterior === nova) return null;
  const integracaoId = contaIdFromRef(after.contaOuterRef);
  if (integracaoId == null) return null;
  return { tipo: 'categoria', integracaoId, anuncio, anterior, nova };
}

export interface EntradaDecisaoCategoria {
  /** The ML category the listing LEFT (the event's `before`). */
  readonly anterior: string;
  /** The ML category the listing ENTERED (the event's `after`). */
  readonly nova: string;
  /** The link's category as stored NOW — `null` when absent. */
  readonly mlAtual: string | null;
  /** The produto's ERP category id NOW — {@link categoriaErpIdDe}. */
  readonly erpId: string | null;
  /** Whether this link's aviso is open right now. */
  readonly avisoAberto: boolean;
}

export type DecisaoAvisoCategoria =
  | {
      readonly acao: 'nada';
      readonly razao:
        | 'ml-mudou-de-novo'
        | 'ja-alinhada'
        | 'produto-sem-categoria'
        | 'categoria-erp-nao-segue-ml';
    }
  | { readonly acao: 'resolver'; readonly motivo: MotivoResolucaoCategoria }
  | { readonly acao: 'avisar'; readonly categoriaErpId: string; readonly categoriaMlId: string };

/**
 * The rule table. The FIRST matching row wins, and every input is the CURRENT
 * state, so a replayed or out-of-order event reaches the right answer:
 *
 * | Current state                                   | Decision                    |
 * |-------------------------------------------------|-----------------------------|
 * | the link no longer holds `nova`                 | nothing — a newer event owns it |
 * | ERP category = `nova` (aligned, or ML moved back) | resolve `alinhada` if open |
 * | the produto has no ERP category                 | nothing                     |
 * | ERP category = `anterior`, or an aviso is open  | raise / refresh             |
 * | anything else (a curated, non-ML ERP category)  | nothing                     |
 *
 * ⚠️ The NARROW raise is deliberate: only an ERP category equal to the one ML
 * just left is DEMONSTRABLY stale. A curated category is the operator's own
 * choice, and raising on every recategorization would leave rows nothing can
 * close (there is no dismiss button). The "aviso already open" half lets a
 * SECOND move refresh the row's params instead of leaving them describing a
 * category the listing has since left.
 */
export function decidirAvisoCategoria(entrada: EntradaDecisaoCategoria): DecisaoAvisoCategoria {
  const { anterior, nova, mlAtual, erpId, avisoAberto } = entrada;
  if (mlAtual !== nova) return { acao: 'nada', razao: 'ml-mudou-de-novo' };
  if (erpId === nova) {
    return avisoAberto
      ? { acao: 'resolver', motivo: MOTIVO_RESOLUCAO_CATEGORIA.alinhada }
      : { acao: 'nada', razao: 'ja-alinhada' };
  }
  if (erpId == null) return { acao: 'nada', razao: 'produto-sem-categoria' };
  if (erpId === anterior || avisoAberto) {
    return { acao: 'avisar', categoriaErpId: erpId, categoriaMlId: nova };
  }
  return { acao: 'nada', razao: 'categoria-erp-nao-segue-ml' };
}

/**
 * ML's commission percentage from one fee preview, or `null` when it did not
 * say. A string or a non-finite number is not a percentage.
 */
export function percentualDaComissao(precos: MlListingPrices): number | null {
  const valor = precos.sale_fee_details?.percentage_fee;
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * Whether the ERP category and the new ML category cost the same commission.
 * Exact: ML answers the same number for the same fee (`16`, `11.5`), and a
 * tolerance here would hide a real difference behind a rounding rule nobody
 * chose.
 */
export function comissoesIguais(comissoes: { erpPct: number; mlPct: number }): boolean {
  return comissoes.erpPct === comissoes.mlPct;
}

/**
 * Classify one produto write from the Eventarc payload — ZERO reads. Non-null
 * only when the ERP category actually CHANGED: a rewrite of the same ref in
 * another stored form (`categorias/X` → `documents/categorias/X`) is not a
 * change, and neither is a create (no link can exist yet) or a delete (the
 * cascade deletes the links, and each closes its own aviso as `desvinculado`).
 */
export function planCategoriaDoProduto(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { readonly erpDepoisId: string | null } | null {
  if (!before || !after) return null;
  const antes = toOuterRefOrNull(before.categoriaProdutoOuterRef);
  const depois = toOuterRefOrNull(after.categoriaProdutoOuterRef);
  if (antes === depois) return null;
  return { erpDepoisId: categoriaErpIdDe(after.categoriaProdutoOuterRef) };
}

/* -------------------------------------------------------------------------- */
/*                                     IO                                     */
/* -------------------------------------------------------------------------- */

/** The ML surface this module needs — injectable for tests. */
export interface CategoriaAnuncioApi {
  getCategory(categoryId: string): Promise<MlCategory>;
  getListingPrices(input: {
    price: number;
    listingTypeId: string;
    categoryId?: string | null;
  }): Promise<MlListingPrices>;
}

export interface DepsCategoriaAnuncio extends AvisoDeps {
  /**
   * A seller-authenticated ML API for the conta. Called LAZILY — only when an
   * aviso is actually due — so the everyday decision costs no token refresh.
   */
  resolverApi: (integracaoId: string) => Promise<CategoriaAnuncioApi>;
}

export type ResultadoCategoriaAnuncio =
  | { readonly acao: 'nada'; readonly razao: string }
  | { readonly acao: 'resolvido'; readonly motivo: string; readonly transicao: boolean }
  | {
      readonly acao: 'avisado';
      readonly resultado: string;
      /** Set when the post-write re-read found the operator had already acted. */
      readonly resolvidoEmSeguida?: MotivoResolucaoCategoria;
    };

/**
 * Act on one {@link planCategoriaDoLink} verdict.
 *
 * Order, for the `categoria` arm:
 *  1. read the CURRENT link, produto and aviso — never trust the event payload's
 *     snapshot, which an Eventarc retry replays verbatim;
 *  2. decide ({@link decidirAvisoCategoria});
 *  3. only on a raise: enrich — names, the new category's chain created in the
 *     ERP catalogue (create-if-absent, so the operator can pick it), and ML's fee
 *     preview for both categories. Enrichment is BEST-EFFORT: an ML failure of
 *     any kind degrades to ids only, because losing the aviso to a decoration
 *     would be the worse outcome. Firestore failures still throw (retried);
 *  4. same commission on both sides ⇒ nothing to reprice: no aviso (and an open
 *     one closes as `mesma-comissao`);
 *  5. write the aviso;
 *  6. RE-READ the produto. If its ERP category moved while steps 1–5 ran, the
 *     produto trigger may have looked for this row before it existed — so
 *     resolve it here. Whichever of the two runs second sees the other's
 *     effect, which is what makes the pair converge without a transaction.
 */
export async function aplicarPlanoCategoriaDoLink(
  db: Firestore,
  link: { readonly produtoId: string; readonly linkDocId: string },
  plano: PlanoCategoriaDoLink,
  deps: DepsCategoriaAnuncio,
): Promise<ResultadoCategoriaAnuncio> {
  const alvo: AlvoAvisoCategoria = {
    integracaoId: plano.integracaoId,
    produtoId: link.produtoId,
    linkDocId: link.linkDocId,
  };

  if (plano.tipo === 'fim') {
    const transicao = await resolverAvisoCategoria(db, alvo, plano.motivo, deps);
    return { acao: 'resolvido', motivo: plano.motivo, transicao };
  }

  const [linkSnap, produtoSnap, avisoSnap] = await Promise.all([
    produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: link.produtoId }, link.linkDocId)
      .get(),
    produtoCollection.docRef(db, {}, link.produtoId).get(),
    avisoCollection.docRef(db, {}, chaveAnuncioCategoriaAlterada(alvo)).get(),
  ]);
  if (!linkSnap.exists) return { acao: 'nada', razao: 'link-removido' };
  const linkAtual = (linkSnap.data() ?? {}) as Record<string, unknown>;
  const aviso = avisoSnap.exists ? ((avisoSnap.data() ?? {}) as Record<string, unknown>) : null;

  const decisao = decidirAvisoCategoria({
    anterior: plano.anterior,
    nova: plano.nova,
    mlAtual: typeof linkAtual.category_id === 'string' ? linkAtual.category_id : null,
    erpId: erpIdDoSnapshot(produtoSnap),
    avisoAberto: aviso != null && aviso.resolvidoEm == null,
  });

  if (decisao.acao === 'nada') return { acao: 'nada', razao: decisao.razao };
  if (decisao.acao === 'resolver') {
    const transicao = await resolverAvisoCategoria(db, alvo, decisao.motivo, deps);
    return { acao: 'resolvido', motivo: decisao.motivo, transicao };
  }

  const extra = await enriquecer(db, deps, plano.integracaoId, linkAtual, decisao);

  if (extra.comissoes && comissoesIguais(extra.comissoes)) {
    // Nothing to reprice: the ERP category's formulas already carry ML's
    // commission. An open row from an earlier move closes; none is raised.
    const transicao = await resolverAvisoCategoria(
      db,
      alvo,
      MOTIVO_RESOLUCAO_CATEGORIA.mesmaComissao,
      deps,
    );
    return { acao: 'resolvido', motivo: MOTIVO_RESOLUCAO_CATEGORIA.mesmaComissao, transicao };
  }

  const { resultado } = await avisarCategoriaAlterada(
    db,
    {
      ...alvo,
      anuncio: plano.anuncio,
      categoriaErpId: decisao.categoriaErpId,
      categoriaErpNome: extra.erpNome,
      categoriaMlId: decisao.categoriaMlId,
      categoriaMlNome: extra.mlNome,
      comissoes: extra.comissoes,
    },
    deps,
  );

  // Step 6 — see the docblock. One read, only on the (rare) raise path.
  const erpDepois = erpIdDoSnapshot(await produtoCollection.docRef(db, {}, link.produtoId).get());
  if (erpDepois !== decisao.categoriaErpId) {
    const motivo =
      erpDepois === decisao.categoriaMlId
        ? MOTIVO_RESOLUCAO_CATEGORIA.alinhada
        : MOTIVO_RESOLUCAO_CATEGORIA.erpAlterada;
    await resolverAvisoCategoria(db, alvo, motivo, deps);
    return { acao: 'avisado', resultado, resolvidoEmSeguida: motivo };
  }
  return { acao: 'avisado', resultado };
}

/**
 * The produto trigger's resolver: the operator changed the produto's ERP
 * category, so every open aviso about its listings has been answered — as
 * `alinhada` where the new category is the listing's ML one, as `erpAlterada`
 * (reviewed, and chose otherwise) everywhere else.
 *
 * One unfiltered subcollection read (no index involved — a produto carries a
 * handful of links) plus one aviso read per link; it runs only on a real ERP
 * category change, which is rare.
 */
export async function resolverAvisosDoProduto(
  db: Firestore,
  produtoId: string,
  erpDepoisId: string | null,
  deps: { nowMs: number },
): Promise<number> {
  const links = await produtoMercadoLivreLinkCollection.ref(db, { produtoId }).get();
  let resolvidos = 0;
  for (const doc of links.docs) {
    const dados = doc.data() as Record<string, unknown>;
    const integracaoId = contaIdFromRef(dados.contaOuterRef);
    if (integracaoId == null) continue;
    const motivo =
      erpDepoisId != null && erpDepoisId === dados.category_id
        ? MOTIVO_RESOLUCAO_CATEGORIA.alinhada
        : MOTIVO_RESOLUCAO_CATEGORIA.erpAlterada;
    if (
      await resolverAvisoCategoria(db, { integracaoId, produtoId, linkDocId: doc.id }, motivo, deps)
    ) {
      resolvidos += 1;
    }
  }
  return resolvidos;
}

function erpIdDoSnapshot(snap: { exists: boolean; data(): unknown }): string | null {
  if (!snap.exists) return null;
  const dados = (snap.data() ?? {}) as Record<string, unknown>;
  return categoriaErpIdDe(dados.categoriaProdutoOuterRef);
}

interface Enriquecimento {
  erpNome: string | null;
  mlNome: string | null;
  comissoes: { erpPct: number; mlPct: number } | null;
}

/** Step 3 of {@link aplicarPlanoCategoriaDoLink} — best-effort by contract. */
async function enriquecer(
  db: Firestore,
  deps: DepsCategoriaAnuncio,
  integracaoId: string,
  link: Record<string, unknown>,
  decisao: { categoriaErpId: string; categoriaMlId: string },
): Promise<Enriquecimento> {
  // The ERP name costs no ML call — it is the ERP's own document.
  const categoriaErp = await categoriaCollection.docRef(db, {}, decisao.categoriaErpId).get();
  const erpNome = nomeDaCategoria(categoriaErp.exists ? categoriaErp.data() : null);

  let api: CategoriaAnuncioApi;
  try {
    api = await deps.resolverApi(integracaoId);
  } catch (err) {
    // ⚠️ Narrow (rule 6): an account that must reconnect, is not configured, or
    // a backend without the app credentials degrades to ids only. Anything
    // else — Firestore above all — is not ours to swallow.
    if (
      !(
        err instanceof MercadoLivreError ||
        err instanceof MercadoLivreContaNotConfiguredError ||
        err instanceof MercadoLivreConfigError
      )
    ) {
      throw err;
    }
    console.warn('[mercado-livre] categoria alterada: API do ML indisponível — aviso só com ids', {
      integracaoId,
      erro: err.message,
    });
    return { erpNome, mlNome: null, comissoes: null };
  }

  let mlNome: string | null = null;
  try {
    const cadeia = buildCategoriaChain(
      await getCategoriaCached(api, decisao.categoriaMlId),
      deps.nowMs,
    );
    // Create-if-absent: without the doc the operator could not even pick the
    // category ML moved the listing into. A Firestore failure here throws.
    await criarCadeiaCategoria(db, cadeia);
    mlNome = cadeia.docs.at(-1)?.data.nomeCompleto ?? null;
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
    console.warn('[mercado-livre] categoria alterada: detalhe da categoria nova indisponível', {
      integracaoId,
      categoria: decisao.categoriaMlId,
      erro: err.message,
    });
  }

  let comissoes: Enriquecimento['comissoes'] = null;
  const preco =
    typeof link.precoPublicado === 'number' && link.precoPublicado > 0 ? link.precoPublicado : null;
  const tipo =
    typeof link.listing_type_id === 'string' && link.listing_type_id.length > 0
      ? link.listing_type_id
      : null;
  // A UP family's parent carries no `precoPublicado`, so no preview there —
  // the aviso still goes out, without the commission sentence.
  if (preco != null && tipo != null) {
    try {
      const [erp, ml] = await Promise.all([
        api.getListingPrices({
          price: preco,
          listingTypeId: tipo,
          categoryId: decisao.categoriaErpId,
        }),
        api.getListingPrices({
          price: preco,
          listingTypeId: tipo,
          categoryId: decisao.categoriaMlId,
        }),
      ]);
      const erpPct = percentualDaComissao(erp);
      const mlPct = percentualDaComissao(ml);
      // Both or neither: one number alone compares nothing.
      if (erpPct != null && mlPct != null) comissoes = { erpPct, mlPct };
    } catch (err) {
      if (!(err instanceof MercadoLivreError)) throw err;
      console.warn('[mercado-livre] categoria alterada: prévia de comissão indisponível', {
        integracaoId,
        erro: err.message,
      });
    }
  }

  return { erpNome, mlNome, comissoes };
}

/** A categoria doc's display name: the full breadcrumb when stored, else its own name. */
function nomeDaCategoria(dados: unknown): string | null {
  if (dados == null || typeof dados !== 'object') return null;
  const { nomeCompleto, nome } = dados as Record<string, unknown>;
  if (typeof nomeCompleto === 'string' && nomeCompleto.length > 0) return nomeCompleto;
  if (typeof nome === 'string' && nome.length > 0) return nome;
  return null;
}
