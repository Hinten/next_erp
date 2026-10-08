/**
 * The producer of the `anuncioCategoriaAlterada` aviso (#847), and the resolver
 * every one of its machine resolutions shares.
 *
 * Mercado Livre recategorizes listings on its own and reports it only as an
 * ordinary `items` notification. Once that value reaches the listing link (the
 * `items` sync, "Reverificar anúncio", publish's echo, a re-import), the
 * `onAnuncioCategoriaAlterada` trigger decides — in `categoriaAnuncio.ts` —
 * whether an operator has to look: the produto's ERP category is what selects
 * the price list's formulas (commission, frete) and the NF-e tax rules, and it
 * is never moved automatically.
 *
 * This module only writes: what to say and when is decided upstream.
 *
 * ## ⚠️ No unit conversion and no clock here
 *
 * `core/avisoDeps.ts` is the one ms → µs seam for ML avisos; every signature
 * below is MILLISECONDS and `nowMs` is always a parameter.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type ResultadoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { type AvisoDeps, agoraUsDe, depsDeEscrita } from '../core/avisoDeps';

/** The listing link an aviso is about — what its key is derived from. */
export interface AlvoAvisoCategoria {
  readonly integracaoId: string;
  /** The produto the link lives under — where the operator fixes the category. */
  readonly produtoId: string;
  /** The `produtoMercadoLivre` doc id. */
  readonly linkDocId: string;
}

/**
 * The dedup identity — and the Firestore document id — of the aviso.
 *
 * ⚠️ ONE row per LISTING LINK, with the link id in `janela`, its own segment.
 * A produto can carry two listings on one conta (and a draft's link id is the
 * integracaoId itself), so the produto alone would merge two listings' rows,
 * and concatenating the two ids into `entidade` would let the segment fold
 * (`:` → `_`) shift a boundary from one id into the other.
 *
 * ⚠️ The producer and every resolver MUST call this same function — a resolver
 * that derives its own key is how a row ends up standing forever.
 */
export function chaveAnuncioCategoriaAlterada(alvo: AlvoAvisoCategoria): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.anuncioCategoriaAlterada,
    conta: alvo.integracaoId,
    entidade: alvo.produtoId,
    janela: alvo.linkDocId,
  });
}

export interface EventoCategoriaAlterada extends AlvoAvisoCategoria {
  /** The ML listing id, rendered into the message — never part of the key. */
  readonly anuncio: string;
  /** The produto's ERP category id — what the price formulas key on. */
  readonly categoriaErpId: string;
  readonly categoriaErpNome: string | null;
  /** The category ML moved the listing INTO. */
  readonly categoriaMlId: string;
  readonly categoriaMlNome: string | null;
  /**
   * ML's `percentage_fee` for each category at the listing's price and type —
   * a PREVIEW, never a promise. Both or neither: one number alone compares
   * nothing, so the producer omits the pair unless ML answered for both.
   */
  readonly comissoes: { readonly erpPct: number; readonly mlPct: number } | null;
}

/**
 * Raise (or refresh) "ML moved this listing; the ERP category still names the
 * old one".
 *
 * `severidade: atencao` — the listing still sells; what may be wrong is the
 * commission every sale is priced on. `critico` is the only tier that escalates
 * out of the app.
 *
 * No `relogioEvento`: ML sends no clock for a recategorization, and the
 * decision upstream is re-derived from the CURRENT link and produto, so a
 * replayed event converges without one.
 */
export function avisarCategoriaAlterada(
  db: Firestore,
  evento: EventoCategoriaAlterada,
  deps: AvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.anuncioCategoriaAlterada,
      conta: evento.integracaoId,
      entidade: evento.produtoId,
      janela: evento.linkDocId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.mercadoLivre,
      // Structured params, never a rendered sentence — the pt-BR wording lives
      // in `apps/web/lib/avisos/mensagens.ts`. Optional names and fees are
      // spread-or-nothing: an absent param renders as the id / no sentence,
      // while `undefined` would be rejected by the SDK.
      params: {
        anuncio: evento.anuncio,
        categoriaErpId: evento.categoriaErpId,
        categoriaMlId: evento.categoriaMlId,
        ...(evento.categoriaErpNome ? { categoriaErpNome: evento.categoriaErpNome } : {}),
        ...(evento.categoriaMlNome ? { categoriaMlNome: evento.categoriaMlNome } : {}),
        ...(evento.comissoes
          ? {
              comissaoCategoriaErpPct: evento.comissoes.erpPct,
              comissaoCategoriaMlPct: evento.comissoes.mlPct,
            }
          : {}),
      },
      urlInterna: {
        // The PRODUTO — its category field is where the fix is. `campo: null`:
        // there is no single field to focus that also covers the variations.
        rota: ROTAS_AVISO.produto.build(evento.produtoId),
        campo: null,
      },
    },
    depsDeEscrita(deps),
  );
}

/**
 * Which fact closed the row. Persisted in `resolucaoMotivo`, so a closed aviso
 * still says WHY — and none of these is free to rename.
 */
export const MOTIVO_RESOLUCAO_CATEGORIA = {
  /** The produto's ERP category now IS the listing's ML category. */
  alinhada: 'categoria-erp-alinhada',
  /** The ERP category changed to something else: an operator reviewed and chose. */
  erpAlterada: 'categoria-erp-alterada',
  /** ML's fee is identical for both categories — nothing to reprice. */
  mesmaComissao: 'mesma-comissao',
  /** The listing stopped being live, so its commission no longer matters. */
  encerrado: 'anuncio-encerrado',
  /** The link itself was deleted. */
  desvinculado: 'anuncio-desvinculado',
} as const;
export type MotivoResolucaoCategoria =
  (typeof MOTIVO_RESOLUCAO_CATEGORIA)[keyof typeof MOTIVO_RESOLUCAO_CATEGORIA];

/**
 * The machine resolver this tipo names. Reports a TRANSITION, never the mere
 * existence of a document: an already-resolved or never-raised row answers
 * `false`, which is what keeps the callers' logs honest.
 */
export function resolverAvisoCategoria(
  db: Firestore,
  alvo: AlvoAvisoCategoria,
  motivo: MotivoResolucaoCategoria,
  deps: { nowMs: number },
): Promise<boolean> {
  return resolverAviso(db, chaveAnuncioCategoriaAlterada(alvo), motivo, {
    agoraUs: agoraUsDe(deps),
  });
}
