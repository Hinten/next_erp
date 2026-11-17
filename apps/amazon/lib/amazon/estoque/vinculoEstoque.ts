/**
 * The link verdict of the Amazon stock sync (step 12, PR 12-d), pure: whether
 * a SKU's link docs may be trusted to publish stock at all, and if so, for
 * which unit. Its reader is `resolverEstoque.ts` (PR 12-e1).
 *
 * ## The binding is the order import's, never a second one
 *
 * A SKU publishes the stock of the unit an order line of that SKU consumes.
 * So the verdict takes the order import's own resolution of the SKU
 * (`ResolucaoVinculoAmazon`, `pedidos/vinculoProdutoAmazon.ts`) as given and
 * re-derives nothing of it: its ambiguous answer is `vinculo-ambiguo`, its
 * unresolved one `produto-ausente` (`vinculoEstoque.test.ts` proves both through
 * that resolver itself). Every link doc under the produto the resolution came
 * from (the `dono`) is the SKU's link ({@link VinculoAptoEstoqueAmazon.linkIds});
 * a link doc under any other produto is not, and is ignored.
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
 *    member as a KIT: a family's parent publishes no stock of its own. A kit
 *    root is the exception for exactly one child, the one its `filhoUnicoId`
 *    names (the web gives every new produto a sole member, and a kit's is a
 *    mirror): the order import binds the kit root itself, never that member,
 *    so the kit's component-min is what an order of the SKU consumes. A
 *    non-kit unit with any child, a kit with two, or one whose single child
 *    is not the one it names, is refused. {@link unidadeComVariacoesEstoqueAmazon}
 *    is the rule; a reader seeks the unit's children with `paiId == <unit>`
 *    and `limit(LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON)`, which is all it needs
 *    to tell none, one and more apart;
 * 5. `envio-desligado` — the `dono`'s
 *    `statusProdutosMarketplace['<contaId>_<asin>'].enviarEstoque` is exactly
 *    `false`, under THIS conta's key and a link ASIN. `undefined`, `true`, the
 *    string `'false'` or another conta's key leave it on.
 *
 * A link with no ASIN is apt and counted (`semAsinNoVinculo`): Amazon's live
 * read is the authority for what Amazon knows, and the listing gate compares
 * the two ASINs when both exist.
 *
 * ## Exact comparisons
 *
 * The SKU and the ASIN are compared as EXACT strings (no trim, no case fold):
 * a seller SKU is the seller's own identifier. An empty ASIN is no ASIN. The
 * conta key is built from the conta id exactly as stored.
 *
 * ## The fields
 *
 * {@link CAMPOS_VINCULO_ESTOQUE_AMAZON}, {@link CAMPOS_DONO_ESTOQUE_AMAZON},
 * {@link CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON} and
 * {@link CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON} are everything the verdict reads
 * off a link doc, its `dono`, a pointed-at link doc and the unit: a reader may
 * project them to those fields (a test proves the projection changes no verdict).
 * `publicado` is not among them: it is never a gate.
 *
 * PURE: no Firestore, no clock.
 */
import {
  type EnvioEstoqueAmazon,
  ehFamiliaDeUm,
  envioEstoqueAmazonSchema,
  naoDocId,
} from '@delfrance/schemas';

import type { ResolucaoVinculoAmazon } from '../pedidos/vinculoProdutoAmazon';
import {
  CONTADOR_ESTOQUE_AMAZON,
  type ContadorEstoqueAmazon,
  MOTIVO_ESTOQUE_AMAZON,
  type RecusaVinculoEstoqueAmazon,
} from './motivosEstoque';

/** Everything the verdict reads off one of the SKU's link docs. */
export const CAMPOS_VINCULO_ESTOQUE_AMAZON = [
  'asin',
  'produtoAmazonPaiOuterRef',
  'envioEstoqueAmazon',
] as const;

/** Everything the verdict reads off the links' `dono`. */
export const CAMPOS_DONO_ESTOQUE_AMAZON = ['statusProdutosMarketplace'] as const;

/** Everything the verdict reads off the document a parent pointer names. */
export const CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON = ['sku', 'asin'] as const;

/** Everything the verdict reads off the UNIT's produto document (refusal 4). */
export const CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON = ['ehKit', 'paiId', 'filhoUnicoId'] as const;

/**
 * The most children of the unit a reader seeks (`paiId == <unit>`): two tell
 * none, one and more apart, which is all refusal 4 asks.
 */
export const LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON = 2;

/** The unit as refusal 4 reads it: its own document and the children a seek found. */
export interface UnidadeDoVinculoEstoqueAmazon {
  /** The unit's produto document (at least {@link CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON}). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** The ids of the unit's children the seek returned, in any order (empty = none). */
  readonly filhosIds: readonly string[];
}

/** One link doc of the SKU, as the resolver read it. */
export interface LinkDoSkuEstoqueAmazon {
  readonly linkId: string;
  /** The produto the link doc sits under, taken from its PATH. */
  readonly donoId: string;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** The `dono` the resolution names (its links' produto): its id and its raw document. */
export interface DonoDoVinculoEstoqueAmazon {
  readonly id: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** A link's parent pointer, read. */
export type PonteiroPaiEstoqueAmazon =
  | { readonly tipo: 'ausente' }
  | { readonly tipo: 'ilegivel' }
  | {
      readonly tipo: 'caminho';
      /** The bare path, `produtos/<produtoId>/prodAmazon/<linkId>`: the key of {@link EntradaVinculoEstoqueAmazon.paisDosLinks}. */
      readonly caminho: string;
      readonly produtoId: string;
      readonly linkId: string;
    };

/** What a reader found at a pointer's path: the document's two fields, or nothing. */
export type AlvoDoPaiEstoqueAmazon = 'sumido' | { readonly sku: unknown; readonly asin: unknown };

/** What the verdict is handed. */
export interface EntradaVinculoEstoqueAmazon {
  readonly contaId: string;
  readonly sku: string;
  /** The order import's resolution of the SKU, unchanged. */
  readonly resolucao: ResolucaoVinculoAmazon;
  /** The `dono` whose unit the resolution names; `null` when none was read. */
  readonly dono: DonoDoVinculoEstoqueAmazon | null;
  /** Every link doc of the SKU for this conta, each with its `donoId` from its path. */
  readonly linksDoSku: readonly LinkDoSkuEstoqueAmazon[];
  /** Each readable pointer's target, keyed by its bare path ({@link ponteiroPaiDoVinculoEstoqueAmazon}). */
  readonly paisDosLinks: ReadonlyMap<string, AlvoDoPaiEstoqueAmazon>;
  /** The unit the resolution names: its document and its children (refusal 4). */
  readonly unidade: UnidadeDoVinculoEstoqueAmazon;
}

/** An apt link: the unit it publishes for, and what the plan and the gate read. */
export interface VinculoAptoEstoqueAmazon {
  readonly apto: true;
  readonly unidadeId: string;
  readonly donoId: string;
  /** The live `dono`'s link docs of the SKU, sorted: where an outcome is written back. */
  readonly linkIds: readonly string[];
  /** The distinct non-empty ASINs those docs carry, sorted (empty = the link knows none). */
  readonly asinsDoVinculo: readonly string[];
  /** The stored stock outcome with the latest `emMs` among those docs, or `null`. */
  readonly envioRecente: EnvioEstoqueAmazon | null;
  readonly contagens: readonly ContadorEstoqueAmazon[];
}

export type VeredictoVinculoEstoqueAmazon =
  | VinculoAptoEstoqueAmazon
  | { readonly apto: false; readonly motivo: RecusaVinculoEstoqueAmazon };

/** A pointer's path, in either stored form (module header, refusal 2). */
const CAMINHO_PAI = /^(?:documents\/)?produtos\/([^/]+)\/prodAmazon\/([^/]+)$/;

const AUSENTE: PonteiroPaiEstoqueAmazon = { tipo: 'ausente' };
const ILEGIVEL: PonteiroPaiEstoqueAmazon = { tipo: 'ilegivel' };

/**
 * A link's `produtoAmazonPaiOuterRef`, read: `null` or no value is NO pointer;
 * a string in either stored form (`documents/produtos/<id>/prodAmazon/<id>` or
 * `produtos/<id>/prodAmazon/<id>`, exact: no trim, no case fold) is its bare
 * path; anything else is unreadable.
 */
export function ponteiroPaiDoVinculoEstoqueAmazon(valor: unknown): PonteiroPaiEstoqueAmazon {
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

/** The `dono`'s opt-out for this conta and ASIN: `enviarEstoque` exactly `false`. */
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

/** The stored outcome with the latest `emMs`; a tie keeps the smallest link id. Invalid entries are skipped. */
function envioMaisRecente(links: readonly LinkDoSkuEstoqueAmazon[]): EnvioEstoqueAmazon | null {
  let recente: EnvioEstoqueAmazon | null = null;
  for (const link of links) {
    const lido = envioEstoqueAmazonSchema.safeParse(link.dados.envioEstoqueAmazon);
    if (!lido.success) continue;
    if (recente === null || lido.data.emMs > recente.emMs) recente = lido.data;
  }
  return recente;
}

/**
 * Refusal 4 (module header): whether the unit `unidadeId` has a child other
 * than its own sole member as a kit root — `ehKit` exactly `true`, no `paiId`,
 * and a `filhoUnicoId` naming EXACTLY the one child the seek found. Any other
 * child, two of them, or a field that cannot be read, refuses (fail closed).
 */
export function unidadeComVariacoesEstoqueAmazon(
  unidadeId: string,
  unidade: UnidadeDoVinculoEstoqueAmazon,
): boolean {
  const [unico, ...outros] = unidade.filhosIds;
  if (unico === undefined) return false;
  if (outros.length > 0) return true;
  const { ehKit, paiId, filhoUnicoId } = unidade.raw;
  if (ehKit !== true || typeof filhoUnicoId !== 'string') return true;
  if (paiId !== null && paiId !== undefined) return true;
  return !(ehFamiliaDeUm({ id: unidadeId, paiId: null, filhoUnicoId }) && unico === filhoUnicoId);
}

function recusa(motivo: RecusaVinculoEstoqueAmazon): VeredictoVinculoEstoqueAmazon {
  return { apto: false, motivo };
}

/** The link verdict (module header). */
export function avaliarVinculoEstoqueAmazon(
  entrada: EntradaVinculoEstoqueAmazon,
): VeredictoVinculoEstoqueAmazon {
  const { resolucao, dono, sku, contaId } = entrada;

  // 1. The order import's resolution, as given.
  if (resolucao.produtoId === null) {
    return recusa(
      resolucao.via === 'unresolved'
        ? MOTIVO_ESTOQUE_AMAZON.produtoAusente
        : MOTIVO_ESTOQUE_AMAZON.vinculoAmbiguo,
    );
  }
  if (dono === null) return recusa(MOTIVO_ESTOQUE_AMAZON.produtoAusente);
  const links = entrada.linksDoSku
    .filter((l) => l.donoId === dono.id)
    .sort((a, b) => (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
  if (links.length === 0) return recusa(MOTIVO_ESTOQUE_AMAZON.produtoAusente);

  // 2. Every pointer must be checkable.
  const alvos: { link: LinkDoSkuEstoqueAmazon; alvo: { sku: unknown; asin: unknown } }[] = [];
  for (const link of links) {
    const ponteiro = ponteiroPaiDoVinculoEstoqueAmazon(link.dados.produtoAmazonPaiOuterRef);
    if (ponteiro.tipo === 'ausente') continue;
    if (ponteiro.tipo === 'ilegivel') return recusa(MOTIVO_ESTOQUE_AMAZON.paiDoVinculoIlegivel);
    const alvo = entrada.paisDosLinks.get(ponteiro.caminho);
    if (alvo === undefined || alvo === 'sumido') {
      return recusa(MOTIVO_ESTOQUE_AMAZON.paiDoVinculoIlegivel);
    }
    alvos.push({ link, alvo });
  }

  // 3. No link carries its parent's SKU or ASIN.
  for (const { link, alvo } of alvos) {
    if (typeof alvo.sku === 'string' && alvo.sku === sku) {
      return recusa(MOTIVO_ESTOQUE_AMAZON.filhoComSkuDoPai);
    }
    const asinDoLink = textoNaoVazio(link.dados.asin);
    if (asinDoLink !== null && textoNaoVazio(alvo.asin) === asinDoLink) {
      return recusa(MOTIVO_ESTOQUE_AMAZON.filhoComSkuDoPai);
    }
  }

  // 4. A family's parent publishes nothing (a kit root's own sole member is no variation).
  if (unidadeComVariacoesEstoqueAmazon(resolucao.produtoId, entrada.unidade)) {
    return recusa(MOTIVO_ESTOQUE_AMAZON.unidadeComVariacoes);
  }

  // 5. The `dono`'s opt-out, under this conta's key only.
  const asins = [
    ...new Set(
      links.map((l) => textoNaoVazio(l.dados.asin)).filter((a): a is string => a !== null),
    ),
  ].sort();
  if (asins.some((asin) => envioDesligado(dono.raw, contaId, asin))) {
    return recusa(MOTIVO_ESTOQUE_AMAZON.envioDesligado);
  }

  return {
    apto: true,
    unidadeId: resolucao.produtoId,
    donoId: dono.id,
    linkIds: links.map((l) => l.linkId),
    asinsDoVinculo: asins,
    envioRecente: envioMaisRecente(links),
    contagens: asins.length === 0 ? [CONTADOR_ESTOQUE_AMAZON.semAsinNoVinculo] : [],
  };
}
