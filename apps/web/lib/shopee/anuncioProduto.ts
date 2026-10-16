/**
 * Pure helpers for the produto editor's **Shopee** tab (step 21, #1529,
 * `apps/web/app/(app)/produtos/_components/shopee/`): how a stored listing link
 * is LABELLED, ADDRESSED on the storefront and ORDERED on screen.
 *
 * ⚠️ Display only — no rule a server surface decides with lives here (#1369).
 * Whether a listing is still alive is `anuncioShopeeVivo`, whether it was
 * superseded is `ehVinculoSubstituido`, when a stored refusal is still worth
 * showing is `shopeeLinkLeitura.ts` — all from `@delfrance/schemas`, the
 * modules `apps/shopee` decides with. A browser copy of any of them is the
 * drift shape root `CLAUDE.md` names: both read correct while disagreeing.
 *
 * Total over `unknown`: a soft-read hands the tab the RAW link document when it
 * does not parse (a migrated row, a half-written one), so nothing here assumes
 * a field is typed.
 */
import {
  FUSO_FISCAL,
  anuncioShopeeVivo,
  ehVinculoSubstituido,
  estadoAnuncioShopeeSchema,
  type EstadoAnuncioShopee,
} from '@delfrance/schemas';

/**
 * The Brazilian storefront's product page. The legacy app built the same URL
 * (`.old/…/shopee/pages/produtoCadastro.dart:170-171`); no Shopee route
 * answers it, so it costs nothing to show.
 */
const PAGINA_DO_PRODUTO_SHOPEE = 'https://shopee.com.br/product';

/** A Shopee numeric id that can address something: a positive SAFE integer. */
function idEnderecavel(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/**
 * The listing's Shopee `item_id` as the tab prints it, or `null` for a link that
 * names no listing — a draft never published (`item_id: null`), or a stored
 * value that is not a positive safe integer. Display only: which links the
 * actions may address is the schemas' `podeMoverAnuncioShopee`.
 */
export function itemIdDoAnuncioShopee(itemId: unknown): number | null {
  return idEnderecavel(itemId) ? itemId : null;
}

/**
 * The listing's public page — `https://shopee.com.br/product/<shop_id>/<item_id>`
 * — or `null` unless BOTH ids are positive safe integers. A draft link
 * (`item_id: null`) and a conta not yet connected (`shop_id: null`) get no link,
 * never a `/product/null/…` that opens Shopee's 404.
 */
export function urlDoAnuncioShopee(shopId: unknown, itemId: unknown): string | null {
  if (!idEnderecavel(shopId) || !idEnderecavel(itemId)) return null;
  return `${PAGINA_DO_PRODUTO_SHOPEE}/${String(shopId)}/${String(itemId)}`;
}

/** What the operator reads for each folded `estadoAnuncio`. Exhaustive by type. */
export const ROTULO_ESTADO_ANUNCIO_SHOPEE = {
  ativo: 'Ativo',
  pausado: 'Pausado',
  agendado: 'Agendado',
  banido: 'Banido',
  em_revisao: 'Em revisão',
  removido: 'Removido',
  desconhecido: 'Status desconhecido',
} as const satisfies Record<EstadoAnuncioShopee, string>;

/** The badge colour for each folded `estadoAnuncio`. Exhaustive by type. */
export const COR_ESTADO_ANUNCIO_SHOPEE = {
  ativo: 'green',
  pausado: 'yellow',
  agendado: 'blue',
  banido: 'red',
  em_revisao: 'orange',
  removido: 'gray',
  desconhecido: 'gray',
} as const satisfies Record<EstadoAnuncioShopee, string>;

/**
 * The stored `estadoAnuncio`, or `null` when there is none this build can name.
 *
 * `null` is a reading of its own — NEVER FOLDED (every link step 9 imported) —
 * and the tab says "não verificado" for it, never a dead state. A string outside
 * the vocabulary (a newer backend's member, a corrupted row) reads the same
 * way: it is not evidence the listing is gone.
 */
export function estadoAnuncioShopeeLido(estado: unknown): EstadoAnuncioShopee | null {
  const lido = estadoAnuncioShopeeSchema.safeParse(estado);
  return lido.success ? lido.data : null;
}

/**
 * Date and time of a stored MILLISECONDS stamp, in São Paulo — or `null` when the
 * value is not a finite number, or is one no `Date` can hold.
 *
 * ⚠️ An EXPLICIT zone: the same stamp reads the same on every operator's
 * machine — the rule `falhaDoEnvio.ts` follows for the quota pause's end.
 */
const FORMATO_INSTANTE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_FISCAL,
  dateStyle: 'short',
  timeStyle: 'short',
});
/**
 * The largest |ms| an ECMAScript time value may hold (±100,000,000 days from
 * the epoch, ECMA-262 § 21.4.1.1). Finite is NOT enough: past it
 * `Intl.DateTimeFormat#format` THROWS a `RangeError` — and this helper runs
 * while rendering the status, refusal, violation and model rows, so one such
 * stored stamp would take the whole tab down instead of reading as "no date".
 */
const MAIOR_INSTANTE_MS = 8.64e15;
export function formatarInstanteShopee(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (Math.abs(ms) > MAIOR_INSTANTE_MS) return null;
  return FORMATO_INSTANTE.format(ms);
}

/**
 * Which group a link sorts into: live, then superseded, then everything else.
 *
 *  - **0 — live**: `anuncioShopeeVivo` and not superseded. The listing the
 *    operator most likely came to look at.
 *  - **1 — superseded**: still `anuncioShopeeVivo`, but replaced by another link
 *    (a converted ordinary listing, a recriar's old kit whose delete did not
 *    take). It may still be SELLING, so it stays above the dead ones.
 *  - **2 — not live**: `removido`, and a link never published (`item_id: null`
 *    is not alive for `anuncioShopeeVivo` either).
 *
 * Both predicates are the schemas' own — the one the denorm trigger scans
 * survivors with and the one publish skips a superseded link by.
 */
function faixaDoVinculo(dados: Record<string, unknown>): 0 | 1 | 2 {
  if (!anuncioShopeeVivo(dados)) return 2;
  return ehVinculoSubstituido(dados) ? 1 : 0;
}

/** `publicadoEm` when it is a finite number; a link never published sorts last in its group. */
function publicadoEmDe(dados: Record<string, unknown>): number | null {
  const v = dados.publicadoEm;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The order the tab lists one conta's links in: {@link faixaDoVinculo}, then the
 * most recently FIRST-published first (`publicadoEm` desc, absent last), then
 * the doc id — so two renders of the same snapshot never swap two blocks.
 * Returns a new array.
 */
export function ordenarVinculosShopee<
  T extends { readonly id: string; readonly data: Record<string, unknown> },
>(vinculos: readonly T[]): T[] {
  return [...vinculos].sort((a, b) => {
    const faixa = faixaDoVinculo(a.data) - faixaDoVinculo(b.data);
    if (faixa !== 0) return faixa;
    const pa = publicadoEmDe(a.data);
    const pb = publicadoEmDe(b.data);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
