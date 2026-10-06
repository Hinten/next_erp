/**
 * **`size_chart_info` — which chart a listing carries, decided ONCE** (step 18,
 * #1526).
 *
 * `add_item` / `update_item` take an optional `size_chart_info` with EXACTLY one
 * key: a TEMPLATE id (`size_chart_id`) or an IMAGE id (`size_chart`). This module
 * turns what `lerTabelaMedidasDoProduto.ts` read — the produto's tabela, THIS
 * conta's entries and the tabela's first photo — plus the listing's resolved
 * category and the category's `size_chart_limit` into ONE answer, the
 * {@link FonteTabelaDeMedidasShopee}. It touches nothing: the read is the other
 * half, the photo upload is `publicarAnuncio.ts`'s, the body is
 * `montagemAnuncio.ts`'s — the `lerImpostoDoProduto` / `taxInfoPublicacao` split.
 *
 * ## The precedence (Lucas, 2026-10-05: "template first, else the photo")
 *
 * 1. the produto names no tabela ⇒ `nenhuma`, motivo `produto-sem-tabela`;
 * 2. it names one that cannot be read ⇒ `nenhuma`, motivo `tabela-inexistente`;
 * 3. THE selection rule — `resolverEntradaShopee` in `@delfrance/schemas`, the
 *    same function the `/medidas` panel calls (#1369: never a second copy) —
 *    finds this conta's FIRST readable entry for the listing's category ⇒
 *    `modelo`. ⚠️ The template WINS: the photo is then never uploaded at all;
 * 4. no entry matched ⇒ the tabela's FIRST photo ⇒ `foto` (the legacy
 *    `fotos.first` fallback), with `motivo` still saying why no template did;
 * 5. no usable first photo ⇒ `nenhuma`, `fotoOmitida: 'sem-fotos'`.
 *
 * ⚠️ `nenhuma` means the KEY IS ABSENT from the body — never `size_chart_id: 0`
 * and never `size_chart: ''`, which are Shopee's DETACH sentinels. So a chart a
 * seller set in Seller Centre survives an update where nothing matched, and
 * removing an entry in `/medidas` does not detach a live chart either.
 *
 * ## `size_chart_limit` is ADVICE — with ONE exception, and it is vetoable
 *
 * - `suportaModelo === false` with a matching entry STILL sends the template:
 *   the operator picked it explicitly, and Shopee arbitrates — a refusal lands
 *   on `size_chart_info` as `tabela-de-medidas-recusada` (L7).
 * - ⚠️ `suportaFoto === false` EXPLICITLY ⇒ the photo is NOT sent
 *   (`fotoOmitida: 'categoria-sem-foto'`). A refused photo REFUSES the publish
 *   (Lucas's Q1c, a 422), so sending it to a category that declares it takes no
 *   image chart would self-inflict that refusal on every produto of the
 *   category, for a fallback nobody picked. `null` (unknown — the band is
 *   unverified for BR, register 253) sends it. This is the orchestrator's
 *   ruling, recorded for Lucas to veto; flipping it is this one comparison.
 * - `obrigatoria === true` with nothing to send ⇒ `avisoObrigatoria`, a
 *   NON-blocking warning for the summary. Nothing here ever refuses a publish:
 *   no BR mandate is documented (register 266), and Shopee is the arbiter.
 *
 * Pure: no Firestore, no Shopee call, no clock.
 */
import {
  type Foto,
  MOTIVO_SEM_TABELA_SHOPEE,
  type MotivoSemTabelaShopee,
  resolverEntradaShopee,
} from '@delfrance/schemas';

import type { LimitesDeItemDto } from '../taxonomia/limites';
import type { LeituraTabelaDeMedidasShopee } from './lerTabelaMedidasDoProduto';

/**
 * Why no TEMPLATE was attached — the reader's two outcomes plus the schemas'
 * three. Non-null on `foto` too: the photo is a fallback, and the summary says
 * what it fell back FROM.
 */
export type MotivoTabelaMedidasOmitida =
  | 'produto-sem-tabela'
  | 'tabela-inexistente'
  | MotivoSemTabelaShopee;

/** The closed set — spelled once; the schemas' three are SPREAD, never re-typed. */
export const MOTIVO_TABELA_MEDIDAS_OMITIDA = {
  produtoSemTabela: 'produto-sem-tabela',
  tabelaInexistente: 'tabela-inexistente',
  ...MOTIVO_SEM_TABELA_SHOPEE,
} as const satisfies Record<string, MotivoTabelaMedidasOmitida>;

/** Which of the two keys the body carries, or neither. */
export type TipoFonteTabelaDeMedidas = 'modelo' | 'foto' | 'nenhuma';

export const FONTE_TABELA_MEDIDAS = {
  modelo: 'modelo',
  foto: 'foto',
  nenhuma: 'nenhuma',
} as const satisfies Record<string, TipoFonteTabelaDeMedidas>;

/**
 * The decision.
 *
 * - `modelo` ⇒ `size_chart_info: { size_chart_id }` — the entry's id, verbatim.
 * - `foto` ⇒ the I/O half uploads THIS photo (`resolver([foto], { cap: 1 })`)
 *   and the body carries `size_chart_info: { size_chart: <image_id> }`.
 * - `nenhuma` ⇒ the key is absent.
 */
export type FonteTabelaDeMedidasShopee =
  | { readonly tipo: 'modelo'; readonly sizeChartId: number }
  | { readonly tipo: 'foto'; readonly foto: Foto }
  | { readonly tipo: 'nenhuma' };

/** Why the photo fallback did not happen, when it was the next step. */
export type FotoTabelaMedidasOmitida = 'sem-fotos' | 'categoria-sem-foto';

export const FOTO_TABELA_MEDIDAS_OMITIDA = {
  /** No usable FIRST photo — none stored, or the first stored one is unreadable. */
  semFotos: 'sem-fotos',
  /** A first photo exists and the category declares `support_image_size_chart: false`. */
  categoriaSemFoto: 'categoria-sem-foto',
} as const satisfies Record<string, FotoTabelaMedidasOmitida>;

/** Everything the body, the summary, the log and the CLI read — one object. */
export interface ResultadoTabelaDeMedidasShopee {
  readonly fonte: FonteTabelaDeMedidasShopee;
  /** The TEMPLATE id — non-null ⇔ `fonte.tipo === 'modelo'` ⇔ `motivo === null`. */
  readonly sizeChartId: number | null;
  /** Why no template — `null` only when one was attached. */
  readonly motivo: MotivoTabelaMedidasOmitida | null;
  /** The tabela read (`null` when there was none, or its ref was unusable). */
  readonly tabMediId: string | null;
  /** READABLE entries this conta has on the tabela (any category). */
  readonly entradasNestaConta: number;
  /** UNREADABLE entries this conta has on the tabela — kept by `/medidas`, never sent. */
  readonly ilegiveis: number;
  /** `size_chart_limit.size_chart_mandatory` — `null` when unknown. */
  readonly obrigatoria: boolean | null;
  /** `size_chart_limit.support_template_size_chart` — ADVICE only. */
  readonly suportaModelo: boolean | null;
  /** `size_chart_limit.support_image_size_chart` — only an explicit `false` withholds the photo. */
  readonly suportaFoto: boolean | null;
  /** Non-null only when the photo was the next step and was not taken. */
  readonly fotoOmitida: FotoTabelaMedidasOmitida | null;
  /** `obrigatoria === true` and nothing is sent — a summary warning, never a refusal. */
  readonly avisoObrigatoria: boolean;
}

interface Bandas {
  readonly obrigatoria: boolean | null;
  readonly suportaModelo: boolean | null;
  readonly suportaFoto: boolean | null;
}

interface Decisao {
  readonly fonte: FonteTabelaDeMedidasShopee;
  readonly motivo: MotivoTabelaMedidasOmitida | null;
  readonly tabMediId: string | null;
  readonly entradasNestaConta: number;
  readonly ilegiveis: number;
  readonly fotoOmitida: FotoTabelaMedidasOmitida | null;
}

const NENHUMA: FonteTabelaDeMedidasShopee = { tipo: FONTE_TABELA_MEDIDAS.nenhuma };

/** The two DERIVED fields, computed in ONE place from the decision. */
function fechar(d: Decisao, bandas: Bandas): ResultadoTabelaDeMedidasShopee {
  return {
    ...d,
    ...bandas,
    sizeChartId: d.fonte.tipo === FONTE_TABELA_MEDIDAS.modelo ? d.fonte.sizeChartId : null,
    avisoObrigatoria: bandas.obrigatoria === true && d.fonte.tipo === FONTE_TABELA_MEDIDAS.nenhuma,
  };
}

/**
 * Decide `size_chart_info` for ONE listing.
 *
 * @param categoryId the listing's RESOLVED category — the stored link's
 *   `category_id` first, the request's otherwise: the ONE resolution
 *   `montarAnuncio` makes for `category_id` and the leaf gate. A template of
 *   another category would be a chart for the wrong garment.
 * @param sizeChartLimit the category's band, already in hand from step 10's
 *   `get_item_limit` (`null` when the block is absent).
 */
export function resolverTabelaDeMedidasDoAnuncio(
  leitura: LeituraTabelaDeMedidasShopee,
  categoryId: number | null,
  sizeChartLimit: LimitesDeItemDto['sizeChartLimit'],
): ResultadoTabelaDeMedidasShopee {
  const bandas: Bandas = {
    obrigatoria: sizeChartLimit?.sizeChartMandatory ?? null,
    suportaModelo: sizeChartLimit?.supportTemplateSizeChart ?? null,
    suportaFoto: sizeChartLimit?.supportImageSizeChart ?? null,
  };

  if (leitura.tipo === 'produto-sem-tabela') {
    return fechar(
      {
        fonte: NENHUMA,
        motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.produtoSemTabela,
        tabMediId: null,
        entradasNestaConta: 0,
        ilegiveis: 0,
        fotoOmitida: null,
      },
      bandas,
    );
  }
  if (leitura.tipo === 'tabela-inexistente') {
    return fechar(
      {
        fonte: NENHUMA,
        motivo: MOTIVO_TABELA_MEDIDAS_OMITIDA.tabelaInexistente,
        tabMediId: leitura.tabMediId,
        entradasNestaConta: 0,
        ilegiveis: 0,
        fotoOmitida: null,
      },
      bandas,
    );
  }

  const linhas = leitura.leitura.linhas;
  const entradasNestaConta = linhas.filter((linha) => linha.motivo === null).length;
  const contagem = {
    tabMediId: leitura.tabMediId,
    entradasNestaConta,
    ilegiveis: linhas.length - entradasNestaConta,
  };

  // THE rule — called, never re-typed (#1369).
  const resolucao = resolverEntradaShopee(leitura.leitura, categoryId);
  if (resolucao.motivo === null) {
    return fechar(
      {
        ...contagem,
        fonte: { tipo: FONTE_TABELA_MEDIDAS.modelo, sizeChartId: resolucao.entrada.size_chart_id },
        motivo: null,
        fotoOmitida: null,
      },
      bandas,
    );
  }

  const foto = leitura.primeiraFoto;
  if (foto === null) {
    return fechar(
      {
        ...contagem,
        fonte: NENHUMA,
        motivo: resolucao.motivo,
        fotoOmitida: FOTO_TABELA_MEDIDAS_OMITIDA.semFotos,
      },
      bandas,
    );
  }
  // ⚠️ EXPLICIT `false` only — `null` is "unknown" and sends (module docblock).
  if (bandas.suportaFoto === false) {
    return fechar(
      {
        ...contagem,
        fonte: NENHUMA,
        motivo: resolucao.motivo,
        fotoOmitida: FOTO_TABELA_MEDIDAS_OMITIDA.categoriaSemFoto,
      },
      bandas,
    );
  }
  return fechar(
    {
      ...contagem,
      fonte: { tipo: FONTE_TABELA_MEDIDAS.foto, foto },
      motivo: resolucao.motivo,
      fotoOmitida: null,
    },
    bandas,
  );
}
