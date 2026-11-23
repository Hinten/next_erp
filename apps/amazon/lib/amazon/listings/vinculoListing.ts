/**
 * The link verdict of the Amazon listings flows (step 13, PR 13-b), pure:
 * whether a SKU's link docs may be trusted to send anything to its listing at
 * all, and if so, for which unit. ONE rule for every flow
 * ({@link FluxoListingAmazon}); a flow binds it with its own
 * {@link RegraVinculoListingAmazon} (the stock flow in
 * `estoque/vinculoEstoque.ts`). Its readers are `resolverVinculo.ts` (one SKU)
 * and `avaliacaoLoteVinculos.ts` (a batch).
 *
 * ## The binding is the order import's, never a second one
 *
 * A SKU sends the value of the unit an order line of that SKU consumes. So the
 * verdict takes the order import's own resolution of the SKU
 * (`ResolucaoVinculoAmazon`, `pedidos/vinculoProdutoAmazon.ts`) as given and
 * re-derives nothing of it: its ambiguous answer is `vinculo-ambiguo`, its
 * unresolved one `produto-ausente`. Every link doc under the produto the
 * resolution came from (the `dono`) is the SKU's link
 * ({@link VinculoAptoListingAmazon.linkIds}); a link doc under any other
 * produto is not, and is ignored.
 *
 * ## The closed refusal list, in the order it is checked
 *
 * 1. `vinculo-ambiguo`, `produto-ausente` — the resolution (above), or a
 *    `dono` the resolution names and the input does not carry;
 * 2. `pai-do-vinculo-ilegivel` — a link's parent pointer
 *    (`produtoAmazonPaiOuterRef`) is present but is not a
 *    `produtos/<id>/prodAmazon/<id>` path in either stored form, or names a
 *    document that does not exist, or one the caller did not read: a pointer
 *    that cannot be checked is not trusted. An explicit `null` or no field at
 *    all is NO pointer, and passes;
 * 3. `filho-com-sku-do-pai` — the document a pointer names carries THIS SKU,
 *    or the same non-null ASIN as the link: a child link carrying its
 *    parent's identity;
 * 4. `unidade-com-variacoes` — the unit has a child that is not its own sole
 *    member as a KIT: a family's parent sells nothing of its own. A kit root is
 *    the exception for exactly one child, the one its `filhoUnicoId` names (the
 *    web gives every new produto a sole member, and a kit's is a mirror): the
 *    order import binds the kit root itself, never that member. A non-kit unit
 *    with any child, a kit with two, or one whose single child is not the one
 *    it names, is refused. {@link unidadeComVariacoesListingAmazon} is the
 *    rule; a reader seeks the unit's children with `paiId == <unit>` and
 *    `limit(LIMITE_FILHOS_UNIDADE_LISTING_AMAZON)`, which is all it needs to
 *    tell none, one and more apart;
 * 5. `envio-desligado` — the STOCK flow only: the `dono`'s
 *    `statusProdutosMarketplace['<contaId>_<asin>'].enviarEstoque` is exactly
 *    `false`, under THIS conta's key and a link ASIN. `undefined`, `true`, the
 *    string `'false'` or another conta's key leave it on. The switch names
 *    stock alone, so no other flow reads it (nor the `dono`'s map at all).
 *
 * Refusals 1–4 hold for every flow. A link with no ASIN is apt and counted
 * (`semAsinNoVinculo`): Amazon's live read is the authority for what Amazon
 * knows, and the listing gate compares the two ASINs when both exist.
 *
 * ## The flow's own outcome
 *
 * Each flow stores its last send on the link doc under its OWN field
 * ({@link CAMPO_ENVIO_LISTING_AMAZON}), so the flows never read or overwrite
 * each other's. The verdict hands back, as `envioRecente`, the entry of the
 * flow's field with the latest `emMs` among the `dono`'s link docs (a tie
 * keeps the smallest link id's); an entry the flow's reader refuses is
 * skipped, never read as a send.
 *
 * ## Exact comparisons
 *
 * The SKU and the ASIN are compared as EXACT strings (no trim, no case fold):
 * a seller SKU is the seller's own identifier. An empty ASIN is no ASIN. The
 * conta key is built from the conta id exactly as stored.
 *
 * ## The fields
 *
 * {@link CAMPOS_VINCULO_LISTING_AMAZON}, {@link CAMPOS_DONO_LISTING_AMAZON},
 * {@link CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON} and
 * {@link CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON} are everything the verdict
 * reads off a link doc, its `dono`, a pointed-at link doc and the unit, per
 * flow: a reader may project them to those fields.
 *
 * PURE: no Firestore, no clock.
 */
import { ehFamiliaDeUm, naoDocId } from '@delfrance/schemas';

import type { ResolucaoVinculoAmazon } from '../pedidos/vinculoProdutoAmazon';
import { FLUXO_LISTING_AMAZON, type FluxoListingAmazon } from './fluxoListing';

/* ------------------------------ the vocabulary ------------------------------ */

/** A refusal of the link verdict (module header), in the order it is checked. */
export type RecusaVinculoListingAmazon =
  | 'vinculo-ambiguo'
  | 'produto-ausente'
  | 'pai-do-vinculo-ilegivel'
  | 'filho-com-sku-do-pai'
  | 'unidade-com-variacoes'
  | 'envio-desligado';

/** The closed refusal set, so code names a member instead of spelling a slug. */
export const MOTIVO_VINCULO_LISTING_AMAZON = {
  vinculoAmbiguo: 'vinculo-ambiguo',
  produtoAusente: 'produto-ausente',
  paiDoVinculoIlegivel: 'pai-do-vinculo-ilegivel',
  filhoComSkuDoPai: 'filho-com-sku-do-pai',
  unidadeComVariacoes: 'unidade-com-variacoes',
  envioDesligado: 'envio-desligado',
} as const satisfies Record<string, RecusaVinculoListingAmazon>;

/** What an apt verdict counts, never refuses. */
export type ContadorVinculoListingAmazon = 'semAsinNoVinculo';

/** The closed counter set; each key is its own token. */
export const CONTADOR_VINCULO_LISTING_AMAZON = {
  semAsinNoVinculo: 'semAsinNoVinculo',
} as const satisfies Record<string, ContadorVinculoListingAmazon>;

/* -------------------------------- the fields -------------------------------- */

/** Where each flow stores its last send on a link doc (module header, "The flow's own outcome"). */
export const CAMPO_ENVIO_LISTING_AMAZON = {
  [FLUXO_LISTING_AMAZON.estoque]: 'envioEstoqueAmazon',
  [FLUXO_LISTING_AMAZON.preco]: 'envioPrecoAmazon',
} as const satisfies Record<FluxoListingAmazon, string>;

/** Everything the verdict reads off one of the SKU's link docs, per flow. */
export const CAMPOS_VINCULO_LISTING_AMAZON = {
  [FLUXO_LISTING_AMAZON.estoque]: [
    'asin',
    'produtoAmazonPaiOuterRef',
    CAMPO_ENVIO_LISTING_AMAZON.estoque,
  ],
  [FLUXO_LISTING_AMAZON.preco]: [
    'asin',
    'produtoAmazonPaiOuterRef',
    CAMPO_ENVIO_LISTING_AMAZON.preco,
  ],
} as const satisfies Record<FluxoListingAmazon, readonly string[]>;

/** Everything the verdict reads off the links' `dono`, per flow: refusal 5's map, stock only. */
export const CAMPOS_DONO_LISTING_AMAZON = {
  [FLUXO_LISTING_AMAZON.estoque]: ['statusProdutosMarketplace'],
  [FLUXO_LISTING_AMAZON.preco]: [],
} as const satisfies Record<FluxoListingAmazon, readonly string[]>;

/** Everything the verdict reads off the document a parent pointer names. */
export const CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON = ['sku', 'asin'] as const;

/** Everything the verdict reads off the UNIT's produto document (refusal 4). */
export const CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON = ['ehKit', 'paiId', 'filhoUnicoId'] as const;

/**
 * The most children of the unit a reader seeks (`paiId == <unit>`): two tell
 * none, one and more apart, which is all refusal 4 asks.
 */
export const LIMITE_FILHOS_UNIDADE_LISTING_AMAZON = 2;

/* -------------------------------- the shapes -------------------------------- */

/** The unit as refusal 4 reads it: its own document and the children a seek found. */
export interface UnidadeDoVinculoListingAmazon {
  /** The unit's produto document (at least {@link CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON}). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** The ids of the unit's children the seek returned, in any order (empty = none). */
  readonly filhosIds: readonly string[];
}

/** One link doc of the SKU, as a reader read it. */
export interface LinkDoSkuListingAmazon {
  readonly linkId: string;
  /** The produto the link doc sits under, taken from its PATH. */
  readonly donoId: string;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** The `dono` the resolution names (its links' produto): its id and its raw document. */
export interface DonoDoVinculoListingAmazon {
  readonly id: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A link's parent pointer, read. */
export type PonteiroPaiListingAmazon =
  | { readonly tipo: 'ausente' }
  | { readonly tipo: 'ilegivel' }
  | {
      readonly tipo: 'caminho';
      /** The bare path, `produtos/<produtoId>/prodAmazon/<linkId>`: the key of {@link EntradaVinculoListingAmazon.paisDosLinks}. */
      readonly caminho: string;
      readonly produtoId: string;
      readonly linkId: string;
    };

/** What a reader found at a pointer's path: the document's two fields, or nothing. */
export type AlvoDoPaiListingAmazon = 'sumido' | { readonly sku: unknown; readonly asin: unknown };

/** What the verdict is handed: the same for every flow. */
export interface EntradaVinculoListingAmazon {
  readonly contaId: string;
  readonly sku: string;
  /** The order import's resolution of the SKU, unchanged. */
  readonly resolucao: ResolucaoVinculoAmazon;
  /** The `dono` whose unit the resolution names; `null` when none was read. */
  readonly dono: DonoDoVinculoListingAmazon | null;
  /** Every link doc of the SKU for this conta, each with its `donoId` from its path. */
  readonly linksDoSku: readonly LinkDoSkuListingAmazon[];
  /** Each readable pointer's target, keyed by its bare path ({@link ponteiroPaiDoVinculoListingAmazon}). */
  readonly paisDosLinks: ReadonlyMap<string, AlvoDoPaiListingAmazon>;
  /** The unit the resolution names: its document and its children (refusal 4). */
  readonly unidade: UnidadeDoVinculoListingAmazon;
}

/** A flow's stored outcome, as far as the verdict reads it: its clock, in ms. */
export interface EnvioDoVinculoListingAmazon {
  readonly emMs: number;
}

/** How a flow binds the verdict. */
export interface RegraVinculoListingAmazon<E extends EnvioDoVinculoListingAmazon> {
  readonly fluxo: FluxoListingAmazon;
  /**
   * The flow's stored outcome, from the raw value of its field on one link doc
   * ({@link CAMPO_ENVIO_LISTING_AMAZON}): the parsed entry, or `null` when the
   * field is absent or the flow's schema refuses it.
   */
  readonly lerEnvio: (valor: unknown) => E | null;
}

/** An apt link: the unit it sends for, and what the plan and the gate read. */
export interface VinculoAptoListingAmazon<E extends EnvioDoVinculoListingAmazon> {
  readonly apto: true;
  readonly unidadeId: string;
  readonly donoId: string;
  /** The live `dono`'s link docs of the SKU, sorted: where an outcome is written back. */
  readonly linkIds: readonly string[];
  /** The distinct non-empty ASINs those docs carry, sorted (empty = the link knows none). */
  readonly asinsDoVinculo: readonly string[];
  /** The flow's stored outcome with the latest `emMs` among those docs, or `null`. */
  readonly envioRecente: E | null;
  readonly contagens: readonly ContadorVinculoListingAmazon[];
}

export type VeredictoVinculoListingAmazon<E extends EnvioDoVinculoListingAmazon> =
  | VinculoAptoListingAmazon<E>
  | { readonly apto: false; readonly motivo: RecusaVinculoListingAmazon };

/* -------------------------------- the rule --------------------------------- */

/** A pointer's path, in either stored form (module header, refusal 2). */
const CAMINHO_PAI = /^(?:documents\/)?produtos\/([^/]+)\/prodAmazon\/([^/]+)$/;

const AUSENTE: PonteiroPaiListingAmazon = { tipo: 'ausente' };
const ILEGIVEL: PonteiroPaiListingAmazon = { tipo: 'ilegivel' };

/**
 * A link's `produtoAmazonPaiOuterRef`, read: `null` or no value is NO pointer;
 * a string in either stored form (`documents/produtos/<id>/prodAmazon/<id>` or
 * `produtos/<id>/prodAmazon/<id>`, exact: no trim, no case fold) is its bare
 * path; anything else is unreadable.
 */
export function ponteiroPaiDoVinculoListingAmazon(valor: unknown): PonteiroPaiListingAmazon {
  if (valor === null || valor === undefined) return AUSENTE;
  if (typeof valor !== 'string') return ILEGIVEL;
  const m = CAMINHO_PAI.exec(valor);
  const produtoId = m?.[1];
  const linkId = m?.[2];
  if (produtoId === undefined || linkId === undefined) return ILEGIVEL;
  if (naoDocId(produtoId) || naoDocId(linkId)) return ILEGIVEL;
  return {
    tipo: 'caminho',
    caminho: `produtos/${produtoId}/prodAmazon/${linkId}`,
    produtoId,
    linkId,
  };
}

/** A non-empty string, or `null` (an empty ASIN is no ASIN). */
function textoNaoVazio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

function ehObjeto(valor: unknown): valor is Readonly<Record<string, unknown>> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** The `dono`'s stock opt-out for this conta and ASIN: `enviarEstoque` exactly `false`. */
function envioDesligado(
  dono: Readonly<Record<string, unknown>>,
  contaId: string,
  asin: string,
): boolean {
  const mapa = dono.statusProdutosMarketplace;
  if (!ehObjeto(mapa)) return false;
  const chave = `${contaId}_${asin}`;
  if (!Object.hasOwn(mapa, chave)) return false;
  const entrada = mapa[chave];
  return ehObjeto(entrada) && entrada.enviarEstoque === false;
}

/** The flow's stored outcome with the latest `emMs`; a tie keeps the smallest link id. Refused entries are skipped. */
function envioMaisRecente<E extends EnvioDoVinculoListingAmazon>(
  links: readonly LinkDoSkuListingAmazon[],
  regra: RegraVinculoListingAmazon<E>,
): E | null {
  const campo = CAMPO_ENVIO_LISTING_AMAZON[regra.fluxo];
  let recente: E | null = null;
  for (const link of links) {
    const lido = regra.lerEnvio(link.dados[campo]);
    if (lido === null) continue;
    if (recente === null || lido.emMs > recente.emMs) recente = lido;
  }
  return recente;
}

/**
 * Refusal 4 (module header): whether the unit `unidadeId` has a child other
 * than its own sole member as a kit root — `ehKit` exactly `true`, no `paiId`,
 * and a `filhoUnicoId` naming EXACTLY the one child the seek found. Any other
 * child, two of them, or a field that cannot be read, refuses (fail closed).
 */
export function unidadeComVariacoesListingAmazon(
  unidadeId: string,
  unidade: UnidadeDoVinculoListingAmazon,
): boolean {
  const [unico, ...outros] = unidade.filhosIds;
  if (unico === undefined) return false;
  if (outros.length > 0) return true;
  const { ehKit, paiId, filhoUnicoId } = unidade.raw;
  if (ehKit !== true || typeof filhoUnicoId !== 'string') return true;
  if (paiId !== null && paiId !== undefined) return true;
  return !(ehFamiliaDeUm({ id: unidadeId, paiId: null, filhoUnicoId }) && unico === filhoUnicoId);
}

function recusa<E extends EnvioDoVinculoListingAmazon>(
  motivo: RecusaVinculoListingAmazon,
): VeredictoVinculoListingAmazon<E> {
  return { apto: false, motivo };
}

/** The link verdict (module header), bound by a flow's {@link RegraVinculoListingAmazon}. */
export function avaliarVinculoListingAmazon<E extends EnvioDoVinculoListingAmazon>(
  entrada: EntradaVinculoListingAmazon,
  regra: RegraVinculoListingAmazon<E>,
): VeredictoVinculoListingAmazon<E> {
  const { resolucao, dono, sku, contaId } = entrada;

  // 1. The order import's resolution, as given.
  if (resolucao.produtoId === null) {
    return recusa(
      resolucao.via === 'unresolved'
        ? MOTIVO_VINCULO_LISTING_AMAZON.produtoAusente
        : MOTIVO_VINCULO_LISTING_AMAZON.vinculoAmbiguo,
    );
  }
  if (dono === null) return recusa(MOTIVO_VINCULO_LISTING_AMAZON.produtoAusente);
  const links = entrada.linksDoSku
    .filter((l) => l.donoId === dono.id)
    .sort((a, b) => (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
  if (links.length === 0) return recusa(MOTIVO_VINCULO_LISTING_AMAZON.produtoAusente);

  // 2. Every pointer must be checkable.
  const alvos: { link: LinkDoSkuListingAmazon; alvo: { sku: unknown; asin: unknown } }[] = [];
  for (const link of links) {
    const ponteiro = ponteiroPaiDoVinculoListingAmazon(link.dados.produtoAmazonPaiOuterRef);
    if (ponteiro.tipo === 'ausente') continue;
    if (ponteiro.tipo === 'ilegivel') {
      return recusa(MOTIVO_VINCULO_LISTING_AMAZON.paiDoVinculoIlegivel);
    }
    const alvo = entrada.paisDosLinks.get(ponteiro.caminho);
    if (alvo === undefined || alvo === 'sumido') {
      return recusa(MOTIVO_VINCULO_LISTING_AMAZON.paiDoVinculoIlegivel);
    }
    alvos.push({ link, alvo });
  }

  // 3. No link carries its parent's SKU or ASIN.
  for (const { link, alvo } of alvos) {
    if (typeof alvo.sku === 'string' && alvo.sku === sku) {
      return recusa(MOTIVO_VINCULO_LISTING_AMAZON.filhoComSkuDoPai);
    }
    const asinDoLink = textoNaoVazio(link.dados.asin);
    if (asinDoLink !== null && textoNaoVazio(alvo.asin) === asinDoLink) {
      return recusa(MOTIVO_VINCULO_LISTING_AMAZON.filhoComSkuDoPai);
    }
  }

  // 4. A family's parent sells nothing (a kit root's own sole member is no variation).
  if (unidadeComVariacoesListingAmazon(resolucao.produtoId, entrada.unidade)) {
    return recusa(MOTIVO_VINCULO_LISTING_AMAZON.unidadeComVariacoes);
  }

  // 5. The `dono`'s stock opt-out, under this conta's key only: the stock flow alone.
  const asins = [
    ...new Set(
      links.map((l) => textoNaoVazio(l.dados.asin)).filter((a): a is string => a !== null),
    ),
  ].sort();
  if (
    regra.fluxo === FLUXO_LISTING_AMAZON.estoque &&
    asins.some((asin) => envioDesligado(dono.raw, contaId, asin))
  ) {
    return recusa(MOTIVO_VINCULO_LISTING_AMAZON.envioDesligado);
  }

  return {
    apto: true,
    unidadeId: resolucao.produtoId,
    donoId: dono.id,
    linkIds: links.map((l) => l.linkId),
    asinsDoVinculo: asins,
    envioRecente: envioMaisRecente(links, regra),
    contagens: asins.length === 0 ? [CONTADOR_VINCULO_LISTING_AMAZON.semAsinNoVinculo] : [],
  };
}
