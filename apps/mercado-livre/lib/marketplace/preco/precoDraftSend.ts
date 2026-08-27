/**
 * The per-listing price SENDER — gates (1)-(8) of the ladder `precoSync.ts`
 * documents, lifted out of `processPriceSyncJob`'s drain loop so a second
 * caller can share it verbatim.
 *
 * Why it is its own module: the manual produto-scoped push (#804 S6) has to
 * send the same way the bulk job does, and a second implementation would be a
 * second place for the sent price to drift — exactly the reasoning
 * `estoqueManual.ts` gives for driving `processStockSendTask` verbatim rather
 * than writing an inline PUT. Everything that judges or mutates ONE listing
 * lives here; everything about a JOB (the checkpoint doc, the fila cursor, the
 * capped skip/failure lists, the re-enqueue) stays in `precoSync.ts`.
 *
 * ⚠️ This module must never import from `precoSync.ts` — that would close an
 * import cycle. `PriceSyncApi` therefore lives here and `precoSync.ts`
 * re-exports it under its original name.
 *
 * The gates, in order, with what each one decides. This list is the canonical
 * one — `precoSync.ts` documents the JOB and points here for the ladder, so do
 * not re-add a back-reference to it: the rationale lives with the code.
 *
 *  (1) fresh `GET /items/{id}` — a 429 asks the caller to pause, another 4xx
 *      records a `GET_PRODUTO_ERROR` failure, a dead credential stops the whole
 *      run, and 5xx/network RETHROW so the caller's own retry mechanism sees
 *      them (the Cloud Tasks queue for the job; nothing for a synchronous
 *      request, which is why the manual push reports them itself);
 *  (2) skip-if-equal (`PRECO_ANTIGO_IGUAL`) — also what makes a replayed send
 *      idempotent after a crash between the PUT and the checkpoint;
 *  (3) fresh status gate (`podeEnviarPreco`: `CLOSED` / `FORBIDDEN` /
 *      `STATUS_<x>`) plus the mid-migration tag skip (`AGUARDANDO_MIGRACAO`);
 *  (4) decrease guard (`PRECO_ANTIGO_MAIOR`) unless the caller allows it;
 *  (5) build the PRICE-ONLY body (per-variation for legacy `variations[]`);
 *  (6) `PUT /items/{id}` — `PRECO_NAO_MODIFICAVEL` is a terminal skip with NO
 *      link stamp, another deterministic 4xx is an `UPDATE_PRECO_ERROR` failure
 *      WITH the link stamped `estado 'E'`, and the pause / stop / rethrow arms
 *      are the same classes as (1);
 *  (7) verify the echoed price (`PRECO_NAO_ATUALIZADO` on mismatch, and
 *      deliberately no link stamp — the PUT was accepted, the listing is fine);
 *  (8) success writeback onto the link doc — everything except
 *      `ultimaModificacao` is for `item` drafts ONLY: the fresh status pair,
 *      `precoPublicado`, and the gated `moderacoes` clear. A `variationItem`
 *      draft writes `ultimaModificacao` alone. Two different reasons — sibling
 *      drafts share the parent link doc so `precoPublicado` would flip-flop, and
 *      `resp` describes a MEMBER while `linkDocId` names the FAMILY, so its
 *      status is not the family's to publish (#1252).
 *
 * Gate (9), the per-item checkpoint, belongs to the caller: the manual push has
 * no job document to checkpoint into.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { roundReais } from '@delfrance/core/money';
import { type EnvioPrecoFilaItem, precisaConsultarModeracao } from '@delfrance/schemas';
import {
  type MlItem,
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { podeEnviarPreco } from './precoPlan';
import { falhaPatch } from '../core/publishFalhas';

/** ML `tags` prefix marking an in-progress User-Products migration — both known
 * tags (`variations_migration_source` / `variations_migration_uptin`, which
 * `itemsStatusSync.ts` matches individually) share it. A mid-migration listing
 * must not be written to; the migration handoff (#441) re-links it and the
 * NEXT run covers the successor items. */
const MIGRATION_TAG_PREFIX = 'variations_migration_';

/** The minimal ML API surface a price send needs (injectable for tests). */
export interface PriceSyncApi {
  getItem(id: string): Promise<MlItem>;
  updateItem(id: string, payload: Record<string, unknown>): Promise<MlItem>;
}

export interface PrecoDraftSendOpts {
  /** ONE clock read per dispatch/request — every persisted stamp reuses it. */
  nowMs: number;
  /** The run's explicit opt-in to price DECREASES (gate 4). */
  baixarPreco: boolean;
}

/**
 * What one draft did. Deterministic and exhaustive — the caller decides how to
 * record it (job counters, or an operator-facing report row).
 *
 * `precoAtual` rides along on every terminal branch that read the listing: the
 * manual push renders "de R$ 40,00 para R$ 50,00", which the bulk job's capped
 * skip list has no room for. The job ignores it.
 */
export type PrecoDraftOutcome =
  | { kind: 'enviado'; preco: number; precoAtual: number | null; variacoes: number | null }
  | { kind: 'pulado'; code: string; precoAtual: number | null }
  | { kind: 'falha'; code: string; error: string; precoAtual: number | null }
  /** ML rate-limited the conta. The draft is NOT consumed — the caller retries it. */
  | { kind: 'pausa'; err: MercadoLivreHttpError }
  /** Every remaining draft would fail identically (a dead credential). */
  | { kind: 'fatal'; erro: string };

/** The listing's CURRENT normal price — `base_price` (promo-independent) first,
 * the same `base_price ?? price` read the import uses; non-positive/absent → null. */
export function currentListingPrice(item: MlItem): number | null {
  const raw = item.base_price ?? item.price;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? roundReais(raw) : null;
}

/** One raw price field carries the sent preco (numeric + `roundReais`-equal). */
function priceFieldMatches(raw: unknown, preco: number): boolean {
  return typeof raw === 'number' && Number.isFinite(raw) && roundReais(raw) === preco;
}

/** One fresh/echoed variation entry already carries the sent preco — the ONE
 * predicate shared by gate 2's variations-aware skip and gate 7's
 * variations-body verifier. */
function variationAtPreco(v: { price?: number | null }, preco: number): boolean {
  return priceFieldMatches(v.price, preco);
}

/** Gate 7, single-price body: read the SAME promo-independent field order gate
 * 2 uses (`base_price ?? price`), then accept a match on EITHER field — an
 * active ML promotion legitimately makes the echoed `price` differ from the
 * standard price, so only both fields missing the sent preco is a failure. */
function verifyItemPrice(resp: MlItem, preco: number): boolean {
  return priceFieldMatches(resp.base_price, preco) || priceFieldMatches(resp.price, preco);
}

/** Gate 7, variations body: EVERY echoed variation must carry the new price;
 * ML sometimes omits `variations` on the PUT echo — fall back to item-level. */
function verifyVariationsPrice(resp: MlItem, preco: number): boolean {
  const vars = resp.variations ?? [];
  if (vars.length === 0) return verifyItemPrice(resp, preco);
  return vars.every((v) => variationAtPreco(v, preco));
}

/** ML's price-automation rejection — a 400 whose body is
 * `{ "error": "item.price.not_modifiable", ... }`. `MercadoLivreHttpError.body`
 * is the parsed JSON when the response was JSON and the raw text otherwise, so
 * narrow defensively before reading `error`. */
function isPriceNotModifiable(body: unknown): boolean {
  return (
    body != null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).error === 'item.price.not_modifiable'
  );
}

/**
 * Run one draft through the ladder. Never throws for a per-listing outcome —
 * only 5xx/network/unclassified errors propagate, so the caller's own retry
 * mechanism (the Cloud Tasks queue, or the manual push's bounded ladder) sees
 * them.
 */
export async function enviarPrecoDraft(
  db: Firestore,
  draft: EnvioPrecoFilaItem,
  api: PriceSyncApi,
  opts: PrecoDraftSendOpts,
): Promise<PrecoDraftOutcome> {
  const { nowMs, baixarPreco } = opts;

  // ---- (1) Fresh GET — the skip/decrease/status gates below must judge the
  // listing as it is NOW, not as it was at plan time.
  let item: MlItem;
  try {
    item = await api.getItem(draft.itemId);
  } catch (err) {
    if (err instanceof MercadoLivreReauthRequiredError) {
      // A dead credential fails every remaining item identically —
      // reconnecting the conta is a human action, so stop the whole run.
      return { kind: 'fatal', erro: 'credencial do Mercado Livre expirada — reconecte a conta' };
    }
    if (err instanceof MercadoLivreHttpError) {
      if (err.status === 429) return { kind: 'pausa', err };
      if (err.status >= 400 && err.status < 500) {
        // Deterministic (404 gone, 403…) — record and move on.
        return { kind: 'falha', code: 'GET_PRODUTO_ERROR', error: err.message, precoAtual: null };
      }
      throw err; // 5xx — transient, the caller retries
    }
    throw err; // network / validation / anything unclassified — the caller retries
  }

  // The FRESH variation ids an `item` draft would PUT through (gate 5's legacy
  // variations body) — also gate 2's equality source: on a legacy variations
  // listing the item-level price is not authoritative, so the skip must judge
  // every variation. `variationItem` drafts PUT on their own MLB item and never
  // carry a variations body.
  const freshVariations =
    draft.kind === 'item' ? (item.variations ?? []).filter((v) => v.id != null) : [];

  // ---- (2) Skip-if-equal: the listing already carries this price. With
  // variations, EVERY one must already sit at the target price — one drifted
  // variation must still be corrected by the PUT.
  const current = currentListingPrice(item);
  const alreadyEqual =
    freshVariations.length > 0
      ? freshVariations.every((v) => variationAtPreco(v, draft.preco))
      : current != null && current === draft.preco;
  if (alreadyEqual) {
    return { kind: 'pulado', code: 'PRECO_ANTIGO_IGUAL', precoAtual: current };
  }

  // ---- (3) Fresh status gate + the mid-migration tag skip (see the
  // MIGRATION_TAG_PREFIX doc — mirrors itemsStatusSync's tag check).
  const gate = podeEnviarPreco(item.status, item.sub_status);
  if (!gate.ok) {
    return { kind: 'pulado', code: gate.code, precoAtual: current };
  }
  if ((item.tags ?? []).some((t) => t.startsWith(MIGRATION_TAG_PREFIX))) {
    return { kind: 'pulado', code: 'AGUARDANDO_MIGRACAO', precoAtual: current };
  }

  // ---- (4) Decrease guard: never lower a listing's price unless the run
  // explicitly allowed it.
  if (current != null && draft.preco < current && !baixarPreco) {
    return { kind: 'pulado', code: 'PRECO_ANTIGO_MAIOR', precoAtual: current };
  }

  // ---- (5) The price-only body — NEVER any other field (the 2026-03-18 hazard
  // in precoSync.ts's module doc: a price bundled with other fields is silently
  // ignored on automation-active items; price-only keeps the failure a loud 400
  // that gate 6 maps to PRECO_NAO_MODIFICAVEL).
  let body: Record<string, unknown>;
  let sentVariations = false;
  if (freshVariations.length > 0) {
    // Legacy model: a listing with variations only accepts its (uniform) price
    // through the variations array — one entry per FRESH variation id (stored
    // ids could miss a variation added since the last import).
    sentVariations = true;
    body = { variations: freshVariations.map((v) => ({ id: v.id, price: draft.preco })) };
  } else {
    // UP model (`variationItem`: the variation IS its own MLB item) and
    // variation-less listings — plain item-level price.
    body = { price: draft.preco };
  }

  // ---- (6) The ONE PUT this draft exists for.
  let resp: MlItem;
  try {
    resp = await api.updateItem(draft.itemId, body);
  } catch (err) {
    if (err instanceof MercadoLivreReauthRequiredError) {
      return { kind: 'fatal', erro: 'credencial do Mercado Livre expirada — reconecte a conta' };
    }
    if (err instanceof MercadoLivreHttpError) {
      if (err.status === 429) return { kind: 'pausa', err };
      if (err.status === 400 && isPriceNotModifiable(err.body)) {
        // The seller opted this item into ML's OWN price automation — our price
        // is rejected by design and the listing is healthy. Terminal SKIP, and
        // deliberately NO link stamp: `estado 'E'` would misreport a live
        // listing as broken.
        return { kind: 'pulado', code: 'PRECO_NAO_MODIFICAVEL', precoAtual: current };
      }
      if (err.status >= 400 && err.status < 500) {
        // Deterministic rejection — stamp the link exactly like
        // estoqueSend/publish do, record the failure, move on. `mergeIfExists`:
        // the draft's target was planned earlier in the run, so the link may
        // already be gone — never upsert a ghost.
        await produtoMercadoLivreLinkCollection.mergeIfExists(
          db,
          { produtoId: draft.produtoId },
          draft.linkDocId,
          { estado: 'E', ...falhaPatch(err, err.message, 'item'), ultimaModificacao: nowMs },
        );
        return {
          kind: 'falha',
          code: 'UPDATE_PRECO_ERROR',
          error: err.message,
          precoAtual: current,
        };
      }
      throw err; // 5xx — transient, the caller retries
    }
    throw err; // network / anything unclassified — the caller retries
  }

  // ---- (7) Verify the echo actually carries the new price (the silent-ignore
  // hazard's cousin: a 200 whose price did not stick). NO link stamp: the PUT
  // was accepted and the listing is healthy — `estado 'E'` would misreport it;
  // the failure row carries the diagnosis.
  const verified = sentVariations
    ? verifyVariationsPrice(resp, draft.preco)
    : verifyItemPrice(resp, draft.preco);
  if (!verified) {
    return {
      kind: 'falha',
      code: 'PRECO_NAO_ATUALIZADO',
      error: `resposta do Mercado Livre não confirmou o preço ${draft.preco}`,
      precoAtual: current,
    };
  }

  // ---- (8) Success writeback (estoqueSend's status-writeback shape).
  //
  // ⚠️ A `variationItem` draft writes NEITHER status NOR `precoPublicado`, and
  // the two omissions have different reasons.
  //
  // `precoPublicado` because sibling `variationItem` drafts all share the PARENT
  // link doc, and with `propagatePriceToChildren: false` a per-child stamp would
  // flip-flop to whichever child was sent last.
  //
  // The status pair because `resp` describes ONE MEMBER (`draft.itemId` is
  // `varLink.itemId`) while `draft.linkDocId` names the FAMILY's parent link —
  // so stamping it publishes one member's lifecycle as the family's. This is the
  // same one-member-speaks-for-the-family over-reach `estoqueSend` guards with
  // `ehMembro`, and until #1252 this path did it unguarded: a member coming back
  // `paused` or `under_review` on an otherwise accepted PUT wrote that to the
  // parent, where `estado` feeds `linkHasLiveListing` → `integracoesComProduto`,
  // the anchor pre-filter BOTH sweeps open with. One member could silently drop
  // a produto whose siblings were still selling.
  //
  // ⚠️ The two senders now agree ON THIS GATE. Do not "restore" the status write
  // here without also changing `estoqueSend.ts` — a family's status has exactly
  // one writer per path, and the `items` webhook's fold is the one that spans
  // members.
  //
  // ⚠️ They still diverge on the FAILURE direction, and that is not fixed here:
  // gate (6) above stamps `estado: 'E'` on the parent for a deterministic 4xx on
  // a member's PUT, where `estoqueSend`'s terminal branch routes a member through
  // `applyMemberStatusAndFold`. Both latch the family at `'E'`, which
  // `apps/mercado-livre/CLAUDE.md` records as a deliberate, loud, self-clearing
  // residual — so it is consistent enough to leave, but it is a real asymmetry
  // and "the senders agree" must not be read as covering it.
  const ehMembro = draft.kind === 'variationItem';
  const writeback: Record<string, unknown> = { ultimaModificacao: nowMs };
  if (!ehMembro) {
    writeback.estado = estadoFromMlStatus(resp.status);
    writeback.status = resp.status ?? null;
    writeback.sub_status = resp.sub_status ?? [];
    writeback.precoPublicado = draft.preco;
    // #1252, free: the gate is pure, so ML's own answer on the response we
    // already hold settles it with no `/moderations` call. Omitted on the other
    // arm — `mergeIfExists` is `update()`-backed, so an absent key leaves the
    // stored reason standing rather than recording a verdict we never asked for.
    if (!precisaConsultarModeracao(resp.status, resp.sub_status)) writeback.moderacoes = [];
  }
  // `mergeIfExists` — same reason as the failure stamp above.
  await produtoMercadoLivreLinkCollection.mergeIfExists(
    db,
    { produtoId: draft.produtoId },
    draft.linkDocId,
    writeback,
  );

  return {
    kind: 'enviado',
    preco: draft.preco,
    precoAtual: current,
    variacoes: sentVariations ? freshVariations.length : null,
  };
}
