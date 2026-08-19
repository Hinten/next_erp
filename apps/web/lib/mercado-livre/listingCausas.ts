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
 *  - **`porCampo`** — a blocking cause naming a control. The control shows it.
 *  - **`gerais`** — a blocking cause naming NO control we own (`shipping.modes`,
 *    `item.seller_id`, a variation combination, an unrecognised path) **plus**
 *    every cause naming more than one. A multi-field rejection whose only trace
 *    is two red inputs is a rejection the operator has to reconstruct.
 *  - **`avisos`** — `type: 'warning'`. ML's docs are explicit that it already
 *    applied these itself, so painting a field red for one would report a
 *    problem that does not exist.
 */
import type { MlCausa, ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { ML_CAUSA_TIPO } from '@delfrance/schemas';

export interface CausasSplit {
  /** Control key → the messages to show on it. */
  porCampo: Record<string, string[]>;
  /** Blocking causes that belong above the form. */
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
    const campos = (causa.campos ?? []).filter((c) => c.length > 0);
    if (campos.length === 0 || campos.length > 1) gerais.push(causa);
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
 * Merge two control→messages maps. Used to put Mercado Livre's own rejection and
 * our pre-flight 422 refusal on the same controls: they answer different
 * questions ("ML refused this" vs "we would not even send it") and a listing can
 * legitimately carry both at once.
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
