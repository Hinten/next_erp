/**
 * Route a listing's persisted Mercado Livre rejection onto the screen.
 *
 * The publisher writes `produtoMercadoLivre.causas` — ML's `cause[]` parsed and
 * already resolved to control keys (`apps/mercado-livre/lib/marketplace/publishFalhas.ts`)
 * — and the editor subscribes to the link doc live. That is deliberately the
 * ONLY channel: it repaints the right listing the moment the publish fails,
 * survives a reload and a second operator, and is the only channel at all for
 * the price sync and the stock sweep, which fail with nobody watching an HTTP
 * response.
 *
 * Three buckets, because ML's causes are not uniform:
 *
 *  - **`gerais`** — EVERY blocking cause. This is the complete list and the one
 *    the operator reads; the banner is never a leftovers bin.
 *  - **`porCampo`** — the subset that resolved to a control, so the control can
 *    ALSO show it. Purely additive: it says *where to fix*, it never replaces
 *    the banner entry.
 *
 * ⚠️ `porCampo` deliberately does NOT remove a cause from `gerais`, and that
 * asymmetry is the whole correctness argument. Resolving to a control is not the
 * same as being VISIBLE on one: `campos` is resolved server-side against the
 * payload we SENT, which by design carries attributes the editor never renders
 * (`SELLER_PACKAGE_*`, `WEIGHT`, `SIZE_GRID_ID`, `SELLER_SKU`), and several
 * controls come and go — `listing_type_id` becomes read-only once published,
 * `descricao` hides behind a collapsible, and an `attributes.X` row vanishes when
 * the operator changes category. An earlier cut kept single-control causes out of
 * `gerais`; combined with the strip suppressing the raw `errors` fallback, a
 * rejection pinned to an unrendered control was displayed NOWHERE — strictly
 * worse than the `ML 400: Validation error` line this feature replaced. Any
 * scheme where the banner depends on what the form happens to render is one
 * refactor away from that hole, so the banner depends on nothing.
 *  - **`avisos`** — `type: 'warning'`. ML's docs are explicit that it already
 *    applied these itself, so painting a field red for one would report a
 *    problem that does not exist.
 */
import type { MlCausa, ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { ML_CAUSA_TIPO } from '@delfrance/schemas';

export interface CausasSplit {
  /** Control key → the messages to show on it. A SUBSET of `gerais`, never a partition. */
  porCampo: Record<string, string[]>;
  /** Every blocking cause — the complete list, shown above the form. */
  gerais: MlCausa[];
  /** Non-blocking causes ML resolved on its own. */
  avisos: MlCausa[];
  /** Any cause at all — the strip falls back to plain `errors` when false. */
  temCausas: boolean;
}

const VAZIO: CausasSplit = { porCampo: {}, gerais: [], avisos: [], temCausas: false };

export function splitCausas(link: Pick<ProdutoMercadoLivreLink, 'causas'>): CausasSplit {
  const causas = (link.causas ?? []).filter(
    (c): c is MlCausa => c != null && typeof c.mensagem === 'string' && c.mensagem.length > 0,
  );
  if (causas.length === 0) return VAZIO;

  const porCampo: Record<string, string[]> = {};
  const gerais: MlCausa[] = [];
  const avisos: MlCausa[] = [];

  for (const causa of causas) {
    if (causa.tipo === ML_CAUSA_TIPO.aviso) {
      avisos.push(causa);
      continue;
    }
    // `tipo` absent means ML did not label it. Treated as BLOCKING: a shape we
    // failed to classify is one the operator still has to act on, and the cost
    // of the two mistakes is not symmetric.
    // Unconditional — see the ⚠️ in the module docblock. A cause is listed
    // whether or not it found a control, because "found a control" does not
    // imply that control is on screen.
    gerais.push(causa);
    const campos = (causa.campos ?? []).filter((c) => c.length > 0);
    for (const campo of campos) (porCampo[campo] ??= []).push(causa.mensagem);
  }

  return { porCampo, gerais, avisos, temCausas: true };
}

/** What one control shows — the first message, since an input holds one line. */
export function erroDoCampo(
  porCampo: Record<string, string[]> | undefined,
  campo: string,
): string | undefined {
  return porCampo?.[campo]?.[0];
}

/**
 * The attribute-row errors, keyed by ML attribute id — the shape
 * `AtributosSection` already takes, so server causes merge into the local
 * validation channel instead of growing a second one.
 */
export function errosDeAtributos(porCampo: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [campo, mensagens] of Object.entries(porCampo)) {
    if (!campo.startsWith('attributes.')) continue;
    const id = campo.slice('attributes.'.length);
    if (id.length > 0 && mensagens[0] != null) out[id] = mensagens[0];
  }
  return out;
}

/** `error · code — message [refs]`, for the banner. Mirrors the persisted line. */
export function textoDaCausa(causa: MlCausa): string {
  const refs = (causa.referencias ?? []).filter((r) => r.length > 0);
  const tail = refs.length > 0 ? ` (${refs.join(', ')})` : '';
  return `${causa.mensagem}${tail}`;
}

/**
 * Merge control→messages maps. Used to put every server-side complaint on the
 * same controls: Mercado Livre's rejection of a write of ours, ML's POLICY
 * moderation of the listing itself (`moderacoesPorCampo`, #1087), and our
 * pre-flight 422 refusal. They answer different questions ("ML refused this" vs
 * "ML moderated the listing" vs "we would not even send it") and a listing can
 * legitimately carry all three at once.
 */
export function mergeServerErrors(
  ...mapas: ReadonlyArray<Record<string, string[]>>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const mapa of mapas) {
    for (const [campo, mensagens] of Object.entries(mapa)) {
      if (mensagens.length === 0) continue;
      (out[campo] ??= []).push(...mensagens);
    }
  }
  return out;
}
