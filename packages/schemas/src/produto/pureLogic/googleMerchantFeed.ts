import type { ComponentesKit } from '../collection/embedded/kit';
import type { GoogleMerchantData } from '../collection/extraData';
import { TIPO_VARIACAO } from '../../grupoDeVariacoes';
import { componentesKitEntries } from './kitEstoque';
import type { PrecosMap } from './precoCalculo';
import { type GrupoComId, parseFakePath } from './variacoes';

/**
 * Google Merchant Center **complementary** feed generation — port of the
 * Flutter `gerarFeedComplementarGoogleMerchantXml`
 * (`packages/google_merchant/lib/src/feed.dart`, issue #553). A complementary
 * feed only carries the handful of attributes this app tracks that Google's
 * own crawl of the primary feed cannot see — it is matched onto an existing
 * listing by `g:id`, never a full product feed.
 *
 * Pure and total: every Firestore read (the produto set, the chosen
 * `listaDePrecos`, `grupoDeVariacoes`, the kit components' own
 * `produtoExtraData`) is batched by the caller into the plain shapes below.
 *
 * ⚠️ Field-level inheritance, not all-or-nothing: the issue says a kit
 * "inherit[s]... from the most-expensive component... when the kit has none
 * of its own". That is read literally PER FIELD — a kit whose own
 * `googleMerchantData` sets `pattern` but leaves `material` empty keeps its
 * own `pattern` and still inherits `material` from the priciest component,
 * rather than an all-or-nothing swap once ANY field is missing.
 */

/** The four `GoogleMerchantData` fields a kit can inherit from a component. */
const CAMPOS_HERDAVEIS = ['age_group', 'gender', 'material', 'pattern'] as const;
type CampoHerdavel = (typeof CAMPOS_HERDAVEIS)[number];

/** Slim projection of a produto (parent, variation child, or kit component)
 * — everything the feed needs, batched up front by the caller. */
export interface FeedProdutoInput {
  id: string;
  /** `null` on a parent; the parent's doc id on a variation child. */
  paiId: string | null;
  sku: string | null;
  precos: PrecosMap;
  ehKit: boolean;
  componentesKit: ComponentesKit | null | undefined;
  /** Fake-path uids (`documents/grupoDeVariacoes/<g>/variacoes/<v>`) — the
   * stored wire shape, never bare variante ids (see `variacoes.ts`). */
  variacoesUid: readonly string[] | null | undefined;
  googleMerchantData: GoogleMerchantData | null | undefined;
}

/** The slim shape a kit's OWN components need — resolved price at the chosen
 * `listaDePrecos` plus their own `produtoExtraData.googleMerchantData`, keyed
 * by component produto id. A component absent from this map (a dangling
 * `componentesKit` reference, or one the caller could not price) simply loses
 * on "most expensive" — it never throws. */
export interface FeedComponenteInfo {
  precoResolvido: number | null;
  googleMerchantData: GoogleMerchantData | null | undefined;
}

/** One resolved feed entry — the exact eight `g:` fields #553 lists. A `null`
 * field means "omit the tag", never "emit it empty" (Google flags an empty
 * `<g:color/>` as invalid rather than absent). */
export interface FeedItem {
  id: string;
  itemGroupId: string;
  ageGroup: string | null;
  gender: string | null;
  material: string | null;
  pattern: string | null;
  color: string | null;
  size: string | null;
}

/** The most expensive kit component, by `precoResolvido` at the chosen lista —
 * `null` when the kit has no components, or none of them could be priced.
 * Ties keep the first component encountered (stable `componentesKit`
 * iteration order), so the pick is deterministic given the same input. */
function componenteMaisCaro(
  componentesKit: ComponentesKit | null | undefined,
  componenteInfoById: Readonly<Record<string, FeedComponenteInfo>>,
): FeedComponenteInfo | null {
  let melhor: FeedComponenteInfo | null = null;
  let melhorPreco = -Infinity;
  for (const [produtoId] of componentesKitEntries(componentesKit)) {
    const info = componenteInfoById[produtoId];
    if (!info || info.precoResolvido === null) continue;
    if (info.precoResolvido > melhorPreco) {
      melhorPreco = info.precoResolvido;
      melhor = info;
    }
  }
  return melhor;
}

/** Resolve one inheritable field: the produto's own value when it has one,
 * else — for a kit only — the most-expensive component's value. A non-kit
 * produto with an empty field simply omits it; there is no component to fall
 * back to. */
function campoComHeranca(
  produto: FeedProdutoInput,
  campo: CampoHerdavel,
  melhorComponente: FeedComponenteInfo | null,
): string | null {
  const proprio = produto.googleMerchantData?.[campo] ?? null;
  if (proprio !== null) return proprio;
  if (!produto.ehKit) return null;
  return melhorComponente?.googleMerchantData?.[campo] ?? null;
}

/**
 * Resolve `color`/`size` by matching the produto's `variacoesUid` against the
 * `grupoDeVariacoes` docs — a uid whose GROUP is `tipo: cor` names the color,
 * `tipo: tamanho` names the size. A uid that fails to parse, or whose group or
 * variante cannot be found, is skipped rather than failing the whole produto
 * (mirrors the tolerant reads elsewhere in this module, e.g.
 * `fotosForVariacao`). When more than one uid resolves to the same tipo — not
 * expected in a well-formed catalogue — the LAST one wins.
 */
export function resolveCorTamanho(
  variacoesUid: readonly string[] | null | undefined,
  grupos: readonly GrupoComId[],
): { color: string | null; size: string | null } {
  let color: string | null = null;
  let size: string | null = null;
  for (const uid of variacoesUid ?? []) {
    const parsed = parseFakePath(uid);
    if (!parsed) continue;
    const grupo = grupos.find((g) => g.id === parsed.grupoId);
    const variante = grupo?.data.variacoes?.find((v) => v.id === parsed.varianteId);
    if (!grupo || !variante) continue;
    if (grupo.data.tipo === TIPO_VARIACAO.cor) color = variante.nome;
    else if (grupo.data.tipo === TIPO_VARIACAO.tamanho) size = variante.nome;
  }
  return { color, size };
}

/** Options shared by every produto in one feed build. */
export interface BuildFeedItemsOptions {
  /** The chosen `listaDePrecos` doc id — `precos[listaId].valor` is the price
   * every skip/inherit decision is keyed on. */
  listaId: string;
  grupos: readonly GrupoComId[];
  /** Kit components' own price + `googleMerchantData`, by produto id. */
  componenteInfoById: Readonly<Record<string, FeedComponenteInfo>>;
}

/**
 * Build the resolved feed entries for a produto set — the pure core of
 * `gerarFeedComplementarGoogleMerchantXml`, kept separate from the XML
 * rendering so the field-mapping/skip/inheritance logic is unit-testable
 * without parsing XML back out.
 *
 * A produto with an empty `sku`, or whose resolved price at `listaId` is
 * absent or `<= 0`, is skipped entirely (#553's own acceptance criteria) —
 * never emitted with fabricated defaults.
 */
export function buildGoogleMerchantFeedItems(
  produtos: readonly FeedProdutoInput[],
  options: BuildFeedItemsOptions,
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const produto of produtos) {
    if (!produto.sku) continue;
    const preco = produto.precos?.[options.listaId]?.valor ?? null;
    if (preco === null || preco <= 0) continue;

    const melhorComponente = produto.ehKit
      ? componenteMaisCaro(produto.componentesKit, options.componenteInfoById)
      : null;
    const { color, size } = resolveCorTamanho(produto.variacoesUid, options.grupos);

    items.push({
      id: produto.googleMerchantData?.id ?? produto.sku,
      itemGroupId: produto.paiId ?? produto.id,
      ageGroup: campoComHeranca(produto, 'age_group', melhorComponente),
      gender: campoComHeranca(produto, 'gender', melhorComponente),
      material: campoComHeranca(produto, 'material', melhorComponente),
      pattern: campoComHeranca(produto, 'pattern', melhorComponente),
      color,
      size,
    });
  }
  return items;
}

/** Minimal XML 1.0 text-content escaping — the five predefined entities.
 * Every value flowing through here is plain catalog text (a variante's
 * `nome`, a free-text `material`/`pattern`), never markup, so no other
 * escaping is needed. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name: string, value: string | null): string {
  if (value === null) return '';
  return `    <g:${name}>${escapeXml(value)}</g:${name}>\n`;
}

/** Render resolved {@link FeedItem}s as the Google Merchant complementary feed
 * — RSS 2.0 with the `g:` (`http://base.google.com/ns/1.0`) namespace, one
 * `<item>` per entry, the field's tag omitted (never emitted empty) when the
 * value is `null`. */
export function renderGoogleMerchantFeedXml(items: readonly FeedItem[]): string {
  const body = items
    .map((item) =>
      [
        '  <item>',
        tag('id', item.id),
        tag('item_group_id', item.itemGroupId),
        tag('age_group', item.ageGroup),
        tag('gender', item.gender),
        tag('material', item.material),
        tag('pattern', item.pattern),
        tag('color', item.color),
        tag('size', item.size),
        '  </item>',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '<channel>',
    '  <title>Feed complementar Google Merchant</title>',
    body,
    '</channel>',
    '</rss>',
    '',
  ].join('\n');
}

/** Build the resolved items and render the feed in one call — the direct
 * port of the legacy `gerarFeedComplementarGoogleMerchantXml` entry point.
 * Split into {@link buildGoogleMerchantFeedItems} + {@link renderGoogleMerchantFeedXml}
 * for callers (and tests) that only need one half. */
export function gerarFeedComplementarGoogleMerchantXml(
  produtos: readonly FeedProdutoInput[],
  options: BuildFeedItemsOptions,
): string {
  return renderGoogleMerchantFeedXml(buildGoogleMerchantFeedItems(produtos, options));
}
