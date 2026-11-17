/**
 * **Discard the pending ERP edits of ONE published Shopee listing** — reload
 * Shopee's CURRENT content into the `prodshopee` link and clear the pending flag
 * (`edicaoErpPendenteEm`). The operator saved an edit in the ERP (PR2's route
 * stamps `edicaoErpRevisao` + `edicaoErpPendenteEm`, nothing is sent until the
 * next «Republicar»), changed their mind, and asks for what Shopee holds back.
 *
 * The decisions, in order — each names its rule-7 tier:
 *
 *  1. **Gate, ZERO Shopee calls** (tier **3**, tell the human): the link must
 *     exist and be this conta's (404 `INEXISTENTE`), be an editable published
 *     listing (409 `ANUNCIO_NAO_EDITAVEL` — a draft, a native kit, a removed or
 *     superseded link), and carry the revision the operator SAW
 *     (`corpo.revisao`, 409 `CONFLITO` with `conflitos: []` — another tab edited
 *     since). A link with nothing pending answers `descartado: false` here: no
 *     Shopee read, no write.
 *  2. **One read** of the listing (`deps.lerAnuncio`, the importer's
 *     `ItemLido`), made AFTER the gate's snapshot. Shopee errors propagate to
 *     the route.
 *  3. **Guarded write** (tier **1**): `update(patch, {lastUpdateTime})` against
 *     the GATE's snapshot — the one taken BEFORE the Shopee read, so a
 *     write-back landing while that read is in flight makes the write lose. A
 *     lost precondition re-runs steps 1–3 (a fresh link read AND a fresh
 *     Shopee read) — never re-applies the captured decision — so an edit that
 *     bumped the revision in between surfaces as 409 `CONFLITO`; the third
 *     loss is the same 409. A flag a republish cleared meanwhile reads
 *     `descartado: false`.
 *
 * ⚠️ **What it writes**: the ten `CAMPOS_DE_EDICAO_ERP_SHOPEE` as
 * `dadosLinkListagem` just read them from Shopee (the import's own builder, over
 * NO stored document — never a `...existente` spread), plus
 * `edicaoErpPendenteEm: null` and `ultimaModificacao`. The content keys are
 * picked through `soCamposDeEdicaoErpShopee`, never named here (the provenance
 * stamp of the logistics list rides along with them, and the backstop in
 * `logisticaProveniencia.test.ts` counts the writers of that literal).
 *
 * ⚠️ **What it never touches** (D-C): `edicaoErpRevisao` — the discard does NOT
 * bump it, so a publish already in flight, built from that same revision, still
 * records what it sent at its write-backs. Nor `item_status`, `estadoAnuncio`,
 * the prices, `tax_info`, the stock or any other link key, and it writes no
 * produto and no `variashopee`.
 *
 * Clock-free and Next-free like the rest of `anuncios/`: `deps.nowMs`
 * (MILLISECONDS) is the route's ONE clock read.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  CODIGO_RASCUNHO_SHOPEE,
  anuncioShopeeEditavel,
  edicaoErpPendenteShopee,
  revisaoDeEdicaoErpShopee,
  soCamposDeEdicaoErpShopee,
  vinculoShopeeEhDaConta,
  type CorpoDescartarEdicoesAnuncioShopee,
} from '@delfrance/schemas';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';

import type { ItemLido } from '../produtos/itemLido';
import { dadosLinkListagem } from '../produtos/mapeamento';
import { RecusaDeRascunhoShopeeError } from './rascunho';

/** What the discard needs from its route. */
export interface DescartarEdicoesDeps {
  readonly db: Firestore;
  /** MILLISECONDS — the route's clock, read ONCE per request. */
  readonly nowMs: number;
  /** The one Shopee read: the listing's current content, as the importer reads it. */
  readonly lerAnuncio: (itemId: number) => Promise<ItemLido>;
}

export interface ResultadoDescartarEdicoesShopee {
  readonly linkDocId: string;
  /** `false` ⇒ nothing was pending (or it cleared meanwhile): nothing written. */
  readonly descartado: boolean;
}

/** How many times the write re-reads after losing to a concurrent write — bounded, never a spin. */
export const TENTATIVAS_DO_DESCARTE = 3;

/* -------------------------------------------------------------------------- */
/*                                 the refusals                                */
/* -------------------------------------------------------------------------- */

function inexistente(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 404,
    code: CODIGO_RASCUNHO_SHOPEE.inexistente,
    linkDocId,
    mensagem:
      `o anúncio ${linkDocId} não existe neste produto, ou é de outra conta. Recarregue a ` +
      'aba. Nada foi gravado.',
  });
}

function naoEditavel(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.anuncioNaoEditavel,
    linkDocId,
    mensagem:
      `o vínculo ${linkDocId} não é um anúncio publicado editável (rascunho, kit nativo, ` +
      'anúncio removido ou substituído). Recarregue a aba. Nada foi gravado.',
  });
}

function revisaoDesatualizada(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.conflito,
    linkDocId,
    conflitos: [],
    mensagem:
      `o anúncio ${linkDocId} foi editado desde que foi aberto. Recarregue para ver o que está ` +
      'gravado. Nada foi gravado.',
  });
}

function gravacoesConcorrentes(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.conflito,
    linkDocId,
    conflitos: [],
    mensagem:
      `não foi possível descartar as edições do anúncio ${linkDocId}: gravações concorrentes ` +
      `venceram ${String(TENTATIVAS_DO_DESCARTE)} vezes seguidas. Nada foi gravado; tente de novo.`,
  });
}

/**
 * The stored link, once it passes every gate the operator's request depends on.
 * Re-run on EVERY attempt against a fresh snapshot (rule 7: re-decide, never
 * re-apply).
 */
function vinculoDescartavel(
  snap: { readonly exists: boolean; data(): unknown },
  corpo: CorpoDescartarEdicoesAnuncioShopee,
): Record<string, unknown> {
  if (!snap.exists) throw inexistente(corpo.linkDocId);
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  if (!vinculoShopeeEhDaConta(raw, corpo.integracaoId)) throw inexistente(corpo.linkDocId);
  if (!anuncioShopeeEditavel(raw)) throw naoEditavel(corpo.linkDocId);
  if (revisaoDeEdicaoErpShopee(raw) !== corpo.revisao) throw revisaoDesatualizada(corpo.linkDocId);
  return raw;
}

/* -------------------------------------------------------------------------- */
/*                                 the discard                                 */
/* -------------------------------------------------------------------------- */

/**
 * Discard the pending edits — see the module docblock.
 *
 * @throws RecusaDeRascunhoShopeeError for 404 / 409; a Shopee error from
 *   `deps.lerAnuncio` and any Firestore failure other than a lost precondition
 *   propagate untouched.
 */
export async function descartarEdicoesDoAnuncioShopee(
  deps: DescartarEdicoesDeps,
  corpo: CorpoDescartarEdicoesAnuncioShopee,
): Promise<ResultadoDescartarEdicoesShopee> {
  const { integracaoId, produtoId, linkDocId } = corpo;
  const ref = produtoShopeeLinkCollection.docRef(deps.db, { produtoId }, linkDocId);

  for (let tentativa = 1; tentativa <= TENTATIVAS_DO_DESCARTE; tentativa += 1) {
    // (1) The gate, on a FRESH read every attempt — nothing is read from
    // Shopee until it passes. A republish that cleared the flag meanwhile
    // leaves nothing to discard.
    const snap = await ref.get();
    const raw = vinculoDescartavel(snap, corpo);
    if (!edicaoErpPendenteShopee(raw)) return { linkDocId, descartado: false };

    // (2) The Shopee read, AFTER the snapshot the write asserts: a write-back
    // landing while this read is in flight (it may have sent a body Shopee now
    // holds and this read predates) moves the stamp, so the write below loses
    // and the next attempt reads Shopee AGAIN — stale content is never written
    // over a link that changed under it. `editavel` proved `item_id` a positive
    // safe integer.
    const entrada = await deps.lerAnuncio(raw.item_id as number);

    // (3) The guarded write against the snapshot that decided (tier 1).
    const patch = produtoShopeeLinkCollection.parseMerge({
      ...soCamposDeEdicaoErpShopee(dadosLinkListagem(entrada, null, integracaoId, deps.nowMs)),
      edicaoErpPendenteEm: null,
      ultimaModificacao: deps.nowMs,
    });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return { linkDocId, descartado: true };
    } catch (err) {
      if (isFailedPrecondition(err) || isNotFound(err)) continue;
      throw err;
    }
  }
  throw gravacoesConcorrentes(linkDocId);
}
