/**
 * **The pure taxonomy core** of the Shopee listing import (#1517, step 9): a
 * listing's tier tree → the `grupoDeVariacoes` documents to create, the patches
 * to apply to the ones that already exist, and each model's
 * `grupoDeVariacoesUid` / `variacoesUid` combination.
 *
 * Pure: no Firestore, no wire call, no clock. The candidate grupos arrive as the
 * per-dispatch memo (`GrupoMemo`), and every write is returned as DATA for the
 * IO layer to apply.
 *
 * ## ⚠️ The grupo write is TIER 1, and this module does not name the other tier
 *
 * The patches below name ONLY `variacoes`, `variacoesIds` and
 * `linksVariacoesShopee`. The IO layer applies them with a guarded
 * `update(patch, { lastUpdateTime })` plus `ultimaModificacao`, re-reading and
 * **RE-PLANNING** once on `FAILED_PRECONDITION` — never re-applying the same
 * patch, which would defeat the guard. A second loss refuses the ITEM
 * (`taxonomia-em-conflito`) rather than proceeding with a partial taxonomy,
 * because a partial combination makes the NEXT import mint duplicate children:
 * a permanent duplicate bought for a transient conflict.
 *
 * An `update` masking at the top-level KEY is why this is safer than a
 * whole-document rewrite: every key we do not name — including the ones the
 * Flutter app still authors and `grupoDeVariacoesSchema` does not model —
 * survives untouched, with no raw spread at all. This module opens no
 * multi-document atomic write and files no entry in the transaction inventory.
 *
 * ## ⚠️ Where the tier names and ids come from, and why NAMES are the floor
 *
 * Names come from `tier_variation[]` (deprecated on the WRITE side only; still a
 * live documented response field). Ids come from `standardise_tier_variation[]`
 * **when present and non-zero** — and `faq 288` bounds the whole thing: *only
 * ID's and BR's Fashion-related categories have standard variations*. The wave-0
 * sandbox probe measured exactly that: both trees present, `variation_id: 0` and
 * every `variation_option_id: 0`. **So for a BR shop outside Fashion the only
 * usable identity is the NAME, and this module must work fully in that world.**
 * Ids are a bonus.
 *
 * ⚠️ `0` is the documented CUSTOM sentinel, a VALUE and never a wildcard. A
 * matcher that treated it as "present" would bind every custom tier in the
 * catalogue to whichever grupo happened to be linked first.
 *
 * ⚠️ The two trees are paired by INDEX and **only when their lengths are equal**.
 * Different lengths ⇒ the ids are ignored entirely and the names carry the
 * match; pairing a mismatched pair by index would attach one tier's id to
 * another tier's name.
 */
import type {
  ShopeeModel,
  ShopeeStandardiseTierVariation,
  ShopeeTierVariation,
} from '@delfrance/integrations-shopee';
import {
  INTEGRACAO_TIPO,
  TIPO_VARIACAO,
  linkVariacoesShopeeSchema,
  varianteFakePath,
  type ExternalVariacaoLink,
  type LinkVariacaoOpcaoShopee,
  type LinkVariacoesShopee,
  type TipoVariacao,
} from '@delfrance/schemas';

import type { GrupoMemo } from './itemLido';

/* -------------------------------------------------------------------------- */
/*  The `tipo` fold — ONE function, two consumers                              */
/* -------------------------------------------------------------------------- */

/**
 * Shopee gives no `SIZE`/`COLOR` attribute id the way Mercado Livre does, so the
 * tier NAME is the only signal — and this fold decides BOTH the `tipo` of a
 * grupo we create and whether the `tipo` rung of the matching cascade runs at
 * all. ONE function, because a matching rule and a creation rule that disagree
 * mint a duplicate grupo on every single import.
 */
const NOMES_TAMANHO: ReadonlySet<string> = new Set(['tamanho', 'tamanhos', 'size', 'sizes']);
const NOMES_COR: ReadonlySet<string> = new Set([
  'cor',
  'cores',
  'color',
  'colour',
  'colors',
  'colours',
]);

/**
 * A tier name → `grupoDeVariacoes.tipo`.
 *
 * The fold is `trim()` + `toLowerCase()` and then **EXACT membership**. No
 * diacritic stripping, no prefix matching, no `includes`.
 *
 * Equal: `'Tamanho'` ≡ `'tamanho'` ≡ `'TAMANHO'` ≡ `' Tamanho '`. The English
 * members earn their place: the sandbox shop's own tiers are `color` and `Size`.
 *
 * ⛔ Distinct, and every one of them deliberately: `'Tamanho do Pé'`, `'Corte'`,
 * `'Colorido'`, `'Cor da Alça'` — and `'Côr'`, whose accented spelling is NOT
 * folded. That narrowness is a known limitation pinned by a test rather than
 * papered over with an NFD normalisation, because widening the fold widens what
 * `tipo` MATCHES, and a wrong match binds a listing's sizes to the operator's
 * colour grupo.
 */
export function tipoDeVariacaoShopee(nome: string | null | undefined): TipoVariacao {
  const chave = nome?.trim().toLowerCase() ?? '';
  if (NOMES_TAMANHO.has(chave)) return TIPO_VARIACAO.tamanho;
  if (NOMES_COR.has(chave)) return TIPO_VARIACAO.cor;
  return TIPO_VARIACAO.outros;
}

/**
 * Deterministic id for a name with no usable external id: lowercase, trimmed,
 * whitespace runs → a single `-`, then everything outside `[a-z0-9-]` stripped.
 * Callers prefix the result with `n-`, which never collides with a
 * `shopee-<id>`. The SHAPE is Mercado Livre's `normalizeForSlug`, re-implemented
 * here because `apps/shopee` has no dependency edge to `apps/mercado-livre` and
 * none is possible.
 */
export function normalizarParaSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Trailing gender-vowel swap (`'Vermelha'` ⇄ `'Vermelho'`). `null` when the
 * string does not end in a swappable vowel — there is nothing to retry.
 */
export function trocarVogalDeGenero(s: string): string | null {
  if (s.length === 0) return null;
  const ultima = s[s.length - 1];
  if (ultima === 'a') return `${s.slice(0, -1)}o`;
  if (ultima === 'o') return `${s.slice(0, -1)}a`;
  if (ultima === 'A') return `${s.slice(0, -1)}O`;
  if (ultima === 'O') return `${s.slice(0, -1)}A`;
  return null;
}

/** Space ⇄ hyphen swap — whichever the string contains; unchanged if neither. */
export function trocarEspacoHifen(s: string): string {
  if (s.includes(' ')) return s.replace(/ /g, '-');
  if (s.includes('-')) return s.replace(/-/g, ' ');
  return s;
}

/* -------------------------------------------------------------------------- */
/*  The tier list                                                              */
/* -------------------------------------------------------------------------- */

/** One tier option, with whatever identity Shopee gave it. */
export interface OpcaoDeTierShopee {
  readonly nome: string;
  /** `0` = CUSTOM. Never treated as a wildcard, never treated as an absence. */
  readonly optionId: number;
}

/** One tier of a listing: its name, its (possibly zero) id, and its options. */
export interface TierShopee {
  readonly nome: string;
  /** `0` = CUSTOM. */
  readonly variationId: number;
  readonly opcoes: readonly OpcaoDeTierShopee[];
}

function inteiroOuZero(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * The tier list of one listing — names from `tier_variation`, ids from
 * `standardise_tier_variation`.
 *
 * ⚠️ The two arrays are paired by index **only when their lengths are equal**;
 * otherwise every id reads as `0` (custom) and the names carry the whole match.
 * ⚠️ A tier with no usable name and no non-zero id contributes nothing: there
 * would be no identity to match it by and no name to create it with.
 */
export function tiersDoItem(entrada: {
  readonly tiers: readonly ShopeeTierVariation[];
  readonly padronizados: readonly ShopeeStandardiseTierVariation[];
}): readonly TierShopee[] {
  const { tiers, padronizados } = entrada;
  const pareia = padronizados.length === tiers.length;
  const saida: TierShopee[] = [];

  for (const [i, tier] of tiers.entries()) {
    const padrao = pareia ? padronizados[i] : undefined;
    const nome = (tier.name ?? padrao?.variation_name ?? '').trim();
    const variationId = inteiroOuZero(padrao?.variation_id);
    if (nome.length === 0 && variationId === 0) continue;

    const opcoesPadrao = padrao?.variation_option_list ?? [];
    const pareiaOpcoes = pareia && opcoesPadrao.length === tier.option_list.length;
    const opcoes: OpcaoDeTierShopee[] = [];
    for (const [j, opcao] of tier.option_list.entries()) {
      const padraoOpcao = pareiaOpcoes ? opcoesPadrao[j] : undefined;
      const nomeOpcao = (opcao.option ?? padraoOpcao?.variation_option_name ?? '').trim();
      const optionId = inteiroOuZero(padraoOpcao?.variation_option_id);
      if (nomeOpcao.length === 0 && optionId === 0) continue;
      opcoes.push({ nome: nomeOpcao, optionId });
    }
    saida.push({ nome, variationId, opcoes });
  }
  return saida;
}

/* -------------------------------------------------------------------------- */
/*  `linksVariacoesShopee` — the merge that never drops                        */
/* -------------------------------------------------------------------------- */

function objetoOuNulo(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function inteiro(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** `(integracaoShopeeId, category_id)` — the entry identity. */
function chaveDaEntrada(integracaoShopeeId: string, categoryId: number): string {
  return `${integracaoShopeeId} ${String(categoryId)}`;
}

/**
 * Union two `arakene_variation_id` lists, preserving the STORED order and
 * appending only what is new.
 */
function unirVariantes(
  armazenados: readonly string[],
  nossos: readonly string[],
): { readonly lista: string[]; readonly mudou: boolean } {
  const vistos = new Set(armazenados);
  const lista = [...armazenados];
  let mudou = false;
  for (const id of nossos) {
    if (id.length > 0 && !vistos.has(id)) {
      vistos.add(id);
      lista.push(id);
      mudou = true;
    }
  }
  return { lista, mudou };
}

/**
 * The option identity, for the merge.
 *
 * Equal: the same NON-ZERO `shopee_option_id`, whatever the names say — the
 * operator bound that id deliberately and the export reads it back.
 * Equal: both ids `0` and byte-identical names.
 * ⛔ Distinct: both ids `0` with names `'Azul'` and `'azul'` — TWO options, not
 * one. The name is sent back to Shopee verbatim on export, so a case fold here
 * would merge two real options into one and silently drop the other's mapping.
 * ⛔ Distinct: two different custom options never both match "the id-0 entry".
 */
function mesmaOpcao(a: LinkVariacaoOpcaoShopee, b: LinkVariacaoOpcaoShopee): boolean {
  if (a.shopee_option_id !== 0 && b.shopee_option_id !== 0) {
    return a.shopee_option_id === b.shopee_option_id;
  }
  if (a.shopee_option_id === 0 && b.shopee_option_id === 0) {
    return a.shopee_option_name === b.shopee_option_name;
  }
  return false;
}

/**
 * Merge OUR `(integração, category)` mapping into the stored
 * `linksVariacoesShopee` array.
 *
 * ⚠️ **Nothing is ever removed** — not an entry, not an option, not an
 * `arakene_variation_id`. The Flutter form authored this array, it is what step
 * 11's export reads, and an element our schema does not understand is still the
 * operator's work: a stored element that fails `safeParse` is kept **VERBATIM**
 * and skipped, never dropped.
 *
 * Field-by-field, on a matching entry:
 *  - `variation_id` / `variation_group_list`: take OURS **only** when theirs is
 *    `0` and ours is non-zero. A non-zero operator value is never overwritten.
 *  - `name`: fill-blank only.
 *  - `variationOptions`: matched by {@link mesmaOpcao}; a match unions
 *    `arakene_variation_id` and fill-blanks the name; a new option is appended.
 *
 * `mudou: false` when nothing changed, so a byte-identical re-import writes
 * nothing at all.
 */
export function fundirLinksVariacoesShopee(
  armazenado: readonly unknown[] | null | undefined,
  nosso: LinkVariacoesShopee,
): { readonly array: unknown[]; readonly mudou: boolean } {
  const entrada = armazenado ?? [];
  const chaveNossa = chaveDaEntrada(nosso.integracaoShopeeId, nosso.category_id);
  const saida: unknown[] = [];
  let mudou = false;
  let encontrou = false;

  for (const elemento of entrada) {
    const analisado = linkVariacoesShopeeSchema.safeParse(elemento);
    if (!analisado.success) {
      // ⚠️ VERBATIM. An element we cannot read is not an element we may delete.
      saida.push(elemento);
      continue;
    }
    const atual = analisado.data;
    if (chaveDaEntrada(atual.integracaoShopeeId, atual.category_id) !== chaveNossa) {
      saida.push(elemento);
      continue;
    }
    encontrou = true;

    const bruto = objetoOuNulo(elemento) ?? {};
    const fundido: Record<string, unknown> = { ...bruto };
    let mudouEsta = false;

    if (atual.variation_id === 0 && nosso.variation_id !== 0) {
      fundido.variation_id = nosso.variation_id;
      mudouEsta = true;
    }
    if (atual.variation_group_list === 0 && nosso.variation_group_list !== 0) {
      fundido.variation_group_list = nosso.variation_group_list;
      mudouEsta = true;
    }
    if (atual.name.trim().length === 0 && nosso.name.trim().length > 0) {
      fundido.name = nosso.name;
      mudouEsta = true;
    }

    const opcoes: LinkVariacaoOpcaoShopee[] = atual.variationOptions.map((o) => ({ ...o }));
    for (const nossaOpcao of nosso.variationOptions) {
      const existente = opcoes.find((o) => mesmaOpcao(o, nossaOpcao));
      if (existente === undefined) {
        opcoes.push({ ...nossaOpcao });
        mudouEsta = true;
        continue;
      }
      const uniao = unirVariantes(existente.arakene_variation_id, nossaOpcao.arakene_variation_id);
      if (uniao.mudou) {
        existente.arakene_variation_id = uniao.lista;
        mudouEsta = true;
      }
      if (
        existente.shopee_option_name.trim().length === 0 &&
        nossaOpcao.shopee_option_name.trim().length > 0
      ) {
        existente.shopee_option_name = nossaOpcao.shopee_option_name;
        mudouEsta = true;
      }
    }
    if (mudouEsta) fundido.variationOptions = opcoes;

    saida.push(mudouEsta ? fundido : elemento);
    if (mudouEsta) mudou = true;
  }

  if (!encontrou) {
    saida.push({ ...nosso });
    mudou = true;
  }
  return { array: saida, mudou };
}

/* -------------------------------------------------------------------------- */
/*  The grupo + variante cascades                                              */
/* -------------------------------------------------------------------------- */

/** A stored grupo, read DEFENSIVELY — never through a schema that would strip. */
interface GrupoLido {
  readonly id: string;
  readonly raw: Record<string, unknown>;
  readonly nome: string;
  readonly tipo: number | null;
  /** The embedded `variacoes` array, element by element, UNPARSED. */
  readonly variacoes: readonly unknown[];
  readonly variacoesIds: readonly string[];
  readonly linksVariacoesShopee: readonly unknown[] | null;
}

function lerGrupo(doc: { readonly id: string; readonly raw: Record<string, unknown> }): GrupoLido {
  const raw = doc.raw;
  const variacoes = Array.isArray(raw.variacoes) ? (raw.variacoes as unknown[]) : [];
  const ids = Array.isArray(raw.variacoesIds) ? (raw.variacoesIds as unknown[]) : [];
  return {
    id: doc.id,
    raw,
    nome: texto(raw.nome),
    tipo: typeof raw.tipo === 'number' ? raw.tipo : null,
    variacoes,
    variacoesIds: ids.filter((v): v is string => typeof v === 'string'),
    linksVariacoesShopee: Array.isArray(raw.linksVariacoesShopee)
      ? (raw.linksVariacoesShopee as unknown[])
      : null,
  };
}

/** One embedded `Variante`, as the matcher reads it. */
interface VarianteLida {
  readonly id: string;
  readonly nome: string;
}

function lerVariante(elemento: unknown): VarianteLida | null {
  const o = objetoOuNulo(elemento);
  if (o === null) return null;
  const id = texto(o.id);
  return id.length > 0 ? { id, nome: texto(o.nome) } : null;
}

/**
 * Does this grupo already carry OUR `(integração, variation_id)` link?
 *
 * ⚠️ `variation_id: 0` matches NOTHING. `0` is "custom", not a wildcard, and
 * treating it as one would bind every custom tier in the catalogue to whichever
 * grupo happened to be linked first.
 *
 * This is rung 1(b) of the grupo cascade and it exists because Firestore cannot
 * query INSIDE an array of objects (`array-contains` needs exact element
 * equality), so the operator-authored mapping — the very thing step 11's export
 * reads — is only findable by scanning the per-dispatch memo in memory.
 */
function linkDoGrupoCasa(grupo: GrupoLido, integracaoId: string, variationId: number): boolean {
  if (variationId === 0) return false;
  for (const elemento of grupo.linksVariacoesShopee ?? []) {
    const o = objetoOuNulo(elemento);
    if (o === null) continue;
    if (texto(o.integracaoShopeeId) === integracaoId && inteiro(o.variation_id) === variationId) {
      return true;
    }
  }
  return false;
}

/** The stored `(integração, category)` entry of this grupo, if there is one. */
function entradaDoGrupo(
  grupo: GrupoLido,
  integracaoId: string,
  categoryId: number,
): LinkVariacoesShopee | null {
  for (const elemento of grupo.linksVariacoesShopee ?? []) {
    const analisado = linkVariacoesShopeeSchema.safeParse(elemento);
    if (!analisado.success) continue;
    const e = analisado.data;
    if (e.integracaoShopeeId === integracaoId && e.category_id === categoryId) return e;
  }
  return null;
}

/** The grupo one tier resolved to, and how. */
export interface GrupoPlanejado {
  readonly grupoId: string;
  readonly criar: boolean;
  /** The FULL document, on create. `null` on a match. */
  readonly docNovo: Record<string, unknown> | null;
  /**
   * The guarded patch, on a match that changed something. `null` when the grupo
   * already said everything this import has to say — a byte-identical re-import
   * writes nothing.
   *
   * ⚠️ Names ONLY `variacoes`, `variacoesIds` and `linksVariacoesShopee`. The IO
   * layer adds `ultimaModificacao` and the `lastUpdateTime` precondition.
   */
  readonly patch: Record<string, unknown> | null;
  /** The Variante id each option of this tier resolved to, by option index. */
  readonly varianteIds: readonly string[];
}

/** What the whole taxonomy resolution produced. */
export interface PlanoDeTaxonomiaShopee {
  readonly grupos: readonly GrupoPlanejado[];
  /**
   * Each model's combination.
   *
   * ⚠️ Keyed by `model_id`, which is Shopee's identity for a model — and
   * `combos` beside it is index-aligned with the `modelos` array, so a caller
   * iterating models never has to rely on the id being unique.
   */
  readonly combosPorModelo: ReadonlyMap<number, ComboResolvido>;
  readonly combos: readonly ComboResolvido[];
}

/** One model's resolved combination, in the two produto wire shapes. */
export interface ComboResolvido {
  readonly grupoDeVariacoesUid: readonly string[] | null;
  readonly variacoesUid: readonly string[] | null;
}

export interface ArgsPlanejarTaxonomia {
  readonly tiers: readonly TierShopee[];
  readonly modelos: readonly ShopeeModel[];
  /** The per-dispatch memo: every `grupoDeVariacoes` document, unparsed. */
  readonly candidatos: GrupoMemo['docs'];
  readonly integracaoId: string;
  /** The listing's LEAF Shopee category — half the `linksVariacoesShopee` key. */
  readonly categoryId: number;
  /** The leaf category's display name, for the entry's `name`. Blank is legal. */
  readonly nomeCategoria: string;
  readonly nowMs: number;
}

/**
 * The whole taxonomy resolution for one listing.
 *
 * **Grupo cascade**, in order, over the memo:
 *  1. the document id `shopee-<variation_id>` (non-zero ids only), **or** a grupo
 *     whose `linksVariacoesShopee` already names this integração with the same
 *     non-zero `variation_id`;
 *  2. exact `nome` — BYTE equality, no trim, no case fold (`'Cor'` ≠ `'cor'`,
 *     `'Cor'` ≠ `'Cor '`);
 *  3. any grupo whose `tipo` equals {@link tipoDeVariacaoShopee}, when that is
 *     non-zero — so a grupo named `'Cores'` matches a tier named `'Color'`,
 *     while a tier named `'Corte'` folds to `outros` and rung 3 never runs;
 *  4. create, at `shopee-<variation_id>` (non-zero) or `n-<slug(nome)>`.
 *
 * **Variante cascade**, in order, over the grupo's embedded `variacoes`:
 *  1. the grupo's stored `(integração, category)` entry, its `variationOptions`
 *     row whose **non-zero** `shopee_option_id` equals ours ⇒
 *     `arakene_variation_id[0]` (the FIRST, matching the legacy export's own
 *     `.first`) — accepted only if that variante still exists;
 *  2. exact `nome`;
 *  3. the two single-class literal swaps, gender vowel then space⇄hyphen,
 *     **never combined**;
 *  4. create, at `shopee-<option_id>` (non-zero) or `n-<slug(nome)>`.
 *
 * ⚠️ The two swaps are tried SEPARATELY and never composed. Combining them would
 * let `'Vermelha Clara'` reach `'Vermelho-Claro'` — two edits away, which is no
 * longer a spelling variant of one word but a different value, and binding it
 * would move a listing's stock onto the wrong variante.
 *
 * ⚠️ `ordem: i + 1` (the tier's own position) is set on CREATE only. An existing
 * grupo's `ordem` belongs to the operator and is never touched — it is what
 * `reconstructFromVariacoesUid` joins names in.
 *
 * ⚠️ A tier or option that resolves to nothing contributes NOTHING to the
 * combination — never a placeholder, never a dangling fake path.
 */
export function planejarTaxonomia(args: ArgsPlanejarTaxonomia): PlanoDeTaxonomiaShopee {
  const { tiers, modelos, integracaoId, categoryId, nowMs } = args;
  const lidos = args.candidatos.map(lerGrupo);
  const usados = new Set<string>();
  const grupos: GrupoPlanejado[] = [];

  for (const [i, tier] of tiers.entries()) {
    // ---- the grupo ---------------------------------------------------------
    const tipo = tipoDeVariacaoShopee(tier.nome);
    const idPorVariacao = tier.variationId !== 0 ? `shopee-${String(tier.variationId)}` : null;
    const disponiveis = lidos.filter((g) => !usados.has(g.id));

    const casado =
      (idPorVariacao !== null ? disponiveis.find((g) => g.id === idPorVariacao) : undefined) ??
      disponiveis.find((g) => linkDoGrupoCasa(g, integracaoId, tier.variationId)) ??
      (tier.nome.length > 0 ? disponiveis.find((g) => g.nome === tier.nome) : undefined) ??
      (tipo !== TIPO_VARIACAO.outros ? disponiveis.find((g) => g.tipo === tipo) : undefined) ??
      null;

    const grupoId =
      casado?.id ?? idPorVariacao ?? `n-${normalizarParaSlug(tier.nome || String(i + 1))}`;
    usados.add(grupoId);

    // ---- the variantes -----------------------------------------------------
    const variacoes: unknown[] = casado ? [...casado.variacoes] : [];
    const entradaArmazenada =
      casado !== null ? entradaDoGrupo(casado, integracaoId, categoryId) : null;
    const varianteIds: string[] = [];
    const opcoesDoLink: LinkVariacaoOpcaoShopee[] = [];
    let variacoesMudaram = false;

    for (const opcao of tier.opcoes) {
      const lidas = variacoes.map(lerVariante).filter((v): v is VarianteLida => v !== null);

      // Rung 1 — the operator's own option mapping.
      let alvo: VarianteLida | null = null;
      if (opcao.optionId !== 0 && entradaArmazenada !== null) {
        const linha = entradaArmazenada.variationOptions.find(
          (o) => o.shopee_option_id === opcao.optionId,
        );
        const primeiro = linha?.arakene_variation_id[0];
        alvo = primeiro !== undefined ? (lidas.find((v) => v.id === primeiro) ?? null) : null;
      }
      // Rung 2 — exact name.
      if (alvo === null && opcao.nome.length > 0) {
        alvo = lidas.find((v) => v.nome === opcao.nome) ?? null;
      }
      // Rung 3a — trailing gender vowel. Rung 3b — space ⇄ hyphen. NEVER both.
      if (alvo === null && opcao.nome.length > 0) {
        const genero = trocarVogalDeGenero(opcao.nome);
        if (genero !== null) alvo = lidas.find((v) => v.nome === genero) ?? null;
      }
      if (alvo === null && opcao.nome.length > 0) {
        const hifen = trocarEspacoHifen(opcao.nome);
        if (hifen !== opcao.nome) alvo = lidas.find((v) => v.nome === hifen) ?? null;
      }

      if (alvo === null) {
        // Rung 4 — create.
        const idNovo =
          opcao.optionId !== 0
            ? `shopee-${String(opcao.optionId)}`
            : `n-${normalizarParaSlug(opcao.nome)}`;
        if (idNovo === 'n-') continue; // no id and no sluggable name: nothing to bind.
        const link = montarLinkExterno(integracaoId, opcao, nowMs);
        variacoes.push({
          id: idNovo,
          nome: opcao.nome.length > 0 ? opcao.nome : idNovo,
          // ⚠️ `codigo: null` on every created variante. `skuPaiPorSufixo` must
          // refuse rather than guess, and inventing a código yields a parent sku
          // that matches no child.
          codigo: null,
          variantesVinculadasIds: null,
          externalVariacaoLinks: [link],
          timestamp: nowMs,
        });
        variacoesMudaram = true;
        varianteIds.push(idNovo);
        opcoesDoLink.push(montarOpcaoDoLink(opcao, idNovo));
        continue;
      }

      // A match: stamp `externalVariacaoLinks` only when this (integração,
      // externalId) pair is not already there.
      const casada = alvo;
      const indice = variacoes.findIndex((e) => lerVariante(e)?.id === casada.id);
      const bruto = objetoOuNulo(variacoes[indice]);
      if (bruto !== null && !jaTemLink(bruto, integracaoId, externalIdDaOpcao(opcao))) {
        const links = Array.isArray(bruto.externalVariacaoLinks)
          ? [...(bruto.externalVariacaoLinks as unknown[])]
          : [];
        links.push(montarLinkExterno(integracaoId, opcao, nowMs));
        variacoes[indice] = { ...bruto, externalVariacaoLinks: links };
        variacoesMudaram = true;
      }
      varianteIds.push(casada.id);
      opcoesDoLink.push(montarOpcaoDoLink(opcao, casada.id));
    }

    // ---- the `linksVariacoesShopee` entry ----------------------------------
    const nossaEntrada: LinkVariacoesShopee = {
      name: args.nomeCategoria,
      category_id: categoryId,
      variation_id: tier.variationId,
      // ⚠️ A SCALAR int despite the plural name — the group id. `0` when Shopee
      // gave none, which is the normal answer outside Fashion.
      variation_group_list: 0,
      // ⚠️ A BARE doc id, NOT a `documents/integracao/<id>` outer-ref — unlike
      // every other conta reference in the Shopee models. Normalising it would
      // orphan every operator-authored entry.
      integracaoShopeeId: integracaoId,
      variationOptions: opcoesDoLink,
    };
    const fusao = fundirLinksVariacoesShopee(casado?.linksVariacoesShopee ?? null, nossaEntrada);
    const variacoesIds = [
      ...new Set([
        ...(casado?.variacoesIds ?? []),
        ...variacoes.map((e) => lerVariante(e)?.id).filter((id): id is string => id !== undefined),
      ]),
    ];

    if (casado === null) {
      grupos.push({
        grupoId,
        criar: true,
        docNovo: {
          nome: tier.nome.length > 0 ? tier.nome : grupoId,
          codigo: null,
          // The tier's own position — an improvement on ML's flat `ordem: 1`,
          // because Shopee's `tier_index[i]` gives a real order. CREATE only.
          ordem: i + 1,
          tipo,
          permiteFotos: tipo === TIPO_VARIACAO.cor,
          ultimaModificacao: null,
          timestamp: nowMs,
          variacoesIds,
          variacoes,
          linksVariacoesShopee: fusao.array,
          linksVariacoesli: null,
          linksVariacoesAmazon: null,
        },
        patch: null,
        varianteIds,
      });
    } else {
      const mudou = variacoesMudaram || fusao.mudou;
      grupos.push({
        grupoId,
        criar: false,
        docNovo: null,
        patch: mudou ? { variacoes, variacoesIds, linksVariacoesShopee: fusao.array } : null,
        varianteIds,
      });
    }
  }

  // ---- each model's combination -------------------------------------------
  const combos: ComboResolvido[] = [];
  const combosPorModelo = new Map<number, ComboResolvido>();
  for (const modelo of modelos) {
    const grupoUids: string[] = [];
    const fakes: string[] = [];
    for (const [i, idx] of (modelo.tier_index ?? []).entries()) {
      const grupo = grupos[i];
      const varianteId = grupo?.varianteIds[idx];
      if (grupo === undefined || varianteId === undefined) continue;
      if (!grupoUids.includes(grupo.grupoId)) grupoUids.push(grupo.grupoId);
      const fake = varianteFakePath(grupo.grupoId, varianteId);
      if (!fakes.includes(fake)) fakes.push(fake);
    }
    const combo: ComboResolvido = {
      grupoDeVariacoesUid: grupoUids.length > 0 ? grupoUids : null,
      variacoesUid: fakes.length > 0 ? fakes : null,
    };
    combos.push(combo);
    combosPorModelo.set(modelo.model_id, combo);
  }

  return { grupos, combosPorModelo, combos };
}

/** `shopee_option_id` when non-zero, else the option NAME — the only identity left. */
function externalIdDaOpcao(opcao: OpcaoDeTierShopee): string {
  return opcao.optionId !== 0 ? String(opcao.optionId) : opcao.nome;
}

function montarLinkExterno(
  integracaoId: string,
  opcao: OpcaoDeTierShopee,
  nowMs: number,
): ExternalVariacaoLink {
  return {
    tipo: INTEGRACAO_TIPO.shopee,
    integracaoId,
    externalId: externalIdDaOpcao(opcao),
    externalName: opcao.nome,
    timestamp: nowMs,
  };
}

function montarOpcaoDoLink(opcao: OpcaoDeTierShopee, varianteId: string): LinkVariacaoOpcaoShopee {
  return {
    shopee_option_id: opcao.optionId,
    shopee_option_name: opcao.nome,
    // ⚠️ A LIST: one Shopee option may map to several ERP variantes, and the
    // export takes `.first` of the matching options. We contribute exactly one
    // and the merge unions it with whatever the operator already bound.
    arakene_variation_id: [varianteId],
  };
}

function jaTemLink(
  bruto: Record<string, unknown>,
  integracaoId: string,
  externalId: string,
): boolean {
  const links = Array.isArray(bruto.externalVariacaoLinks)
    ? (bruto.externalVariacaoLinks as unknown[])
    : [];
  return links.some((l) => {
    const o = objetoOuNulo(l);
    return (
      o !== null && texto(o.integracaoId) === integracaoId && texto(o.externalId) === externalId
    );
  });
}
