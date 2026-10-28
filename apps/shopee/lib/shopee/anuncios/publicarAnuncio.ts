/**
 * **Publish ONE produto to Shopee** (#1519, step 11 — S2/S3/S7): the IO half.
 *
 * Three functions, in one order: {@link prepararPublicacao} READS the whole
 * graph (structurally write-free), `planejarPublicacao` (`planoPublicacao.ts`)
 * DECIDES, and {@link aplicarPublicacao} EXECUTES the eleven steps of the
 * reconciler's §2.4 order. {@link publicarAnuncioShopee} is that sequence; the
 * first two are exported separately so the CLI's dry run can print the PLAN
 * without applying it.
 *
 * It owns exactly four Shopee calls — `add_item`, `update_item`, `unlist_item`
 * and `get_item_base_info` (the read-back, through `produtos/lerAnuncio.ts`) —
 * plus `get_channel_list` in `preparar` and the bounded `get_brand_list` paging
 * of the brand cascade. The five tier/model calls are
 * `modelosPublicacao.ts`'s and `upload_image` is `fotosPublicacao.ts`'s; and
 * since #1911 P5 the publish of an `incerta` draft also reaches ENSURE's reads —
 * `get_item_list` and one `get_item_base_info` batch — which are
 * `criacaoIncerta.ts`'s (`localizarAnuncioIncerto`), reached from
 * `reservaRascunho.ts` before `preparar`; since #1911 P5b a `livre` draft's
 * FIRST create pays the same two kinds of read (`get_item_list` pages, the
 * base-info batch) for its same-SKU look-up — `criacaoIncerta.ts`'s
 * `verificarAnuncioExistenteShopee` over `../kits/localizarKitPorSku.ts`'s
 * walk, reached from {@link aplicarPublicacao} just before the send. On the
 * PUBLISH path no other module
 * under `anuncios/` calls Shopee, which is what makes "which module owns which
 * call" answerable by FILE (the lifecycle and push modules —
 * `pausarAnuncio.ts`, `reverificarAnuncio.ts`, `pushAnuncio.ts` — own their own).
 *
 * ## ⚠️ The read-back is the ONLY source of listing STATE (O5)
 *
 * `add_item` / `update_item` answer an echo, and the sandbox probe measured that
 * echo carrying a **stale `item_status`** while `get_item_base_info` answered the
 * right one on the same item in the same second (`announcement 1395` is removing
 * the response's logistics block for the same reason, and `announcement 1394`
 * says to call `get_item_base_info` instead). So the only thing this module ever
 * reads out of a write response is the `item_id` of a create — an IDENTIFIER,
 * not state — and `item_status`, `estadoAnuncio`, `deboost`,
 * `original_brand_name` and `logistic_info` all come from step 10's read-back.
 *
 * ## ⚠️ Write-back #1 lands the instant Shopee confirms, for RESUMABILITY
 *
 * A publish is a sequence of provider calls that can fail anywhere in the
 * middle, and Shopee keeps whatever already landed. Persisting the `item_id` the
 * moment `add_item` answers is what makes a half-failed publish RESUMABLE
 * instead of orphaned: a link document holding an `item_id` and no models makes
 * the next publish an UPDATE that runs the tier leg. The alternative — one write
 * at the end — loses the id of a listing that exists, and the next attempt
 * creates a SECOND one.
 *
 * ## ⚠️ A DRAFT's first create runs under a LOCK (#1911, D4/D15)
 *
 * When the named link is a draft (`ehRascunhoShopee`), {@link
 * publicarAnuncioShopee} takes the draft's publish lock BEFORE `preparar` reads
 * the content it will send, re-reads it immediately before `add_item`, gates
 * EACH `add_item` leg on the live clock, turns write-back #1 into a tier-1
 * CLAIM, and hands the lock back on every way out — or KEEPS it when the create
 * may have happened. The mechanism is `reservaRascunho.ts`; this module decides
 * which way out a failure is, through {@link ReservaDeRascunhoShopee.fase} and
 * the `add_item` classifier (`criacaoIncerta.ts`). A republish of a listing
 * takes no lock and is byte-for-byte step 11's.
 *
 * ## ⚠️ A FIRST create never duplicates a listing the conta holds (#1911 P5b)
 *
 * Lucas, 2026-10-26: before a `livre` draft's first `add_item`, still under
 * its lock and after D15, {@link aplicarPublicacao} looks for a listing of the
 * conta with the SKU the planned body SENDS (`verificarAnuncioExistenteShopee`,
 * the kit arm's same-SKU scan mirrored): an unlinked hit refuses
 * `anuncio-existente-sem-vinculo` ("importe-o"), another produto's
 * `anuncio-existente-de-outro-produto`, an incomplete scan
 * `busca-de-anuncio-existente-incompleta` — nothing sent, the lock handed
 * back. This produto's own listing is D15's (excluded); a body with no SKU
 * scans nothing; an `incerta` draft ran ENSURE instead — for the fold ENSURE
 * searched only: a SKU renamed between the reservation and `preparar` is
 * looked up here on the body (batch-A review). The dry run never
 * reaches it (it takes no lock and applies nothing).
 *
 * ## ⚠️ An UNCERTAIN first create is remembered, then LOOKED FOR (#1911, D5)
 *
 * - **No link at all ⇒ a draft is MINTED first** (K1-5): a live create of a
 *   produto the conta holds NO link of goes through the draft route's own
 *   create (`rascunho.ts`, tier 0 at a fresh `newDocId`) carrying the brand
 *   `{brand_id: 0, original_brand_name: null}` — the `?? 0` this path always
 *   sent — and the operator's category, then continues NAMED: lock, memory,
 *   D15. A refusal before the send leaves the draft, and the next no-link run
 *   hears `rascunho-nao-nomeado` (`kits/armaDePublicacao.ts`). The dry run
 *   (`prepararPublicacao` alone) mints nothing. A link that appears between
 *   the dispatcher's read and the mint's is a 409 `CONTENCAO`, never a
 *   fall-back to step 11's lexical resolver; and `aplicarPublicacao` refuses
 *   any create onto a draft it holds no lock of (batch-A review, the mint
 *   race).
 * - **`incerto` ⇒ 202, never "falhou"**: the lock is kept live for the wait
 *   and the attempt recorded (`registrarCriacaoIncerta`), then
 *   `CriacaoDeAnuncioIncertaError` carries the 202's facts to `publicarShopee`.
 * - **The next publish looks first** (ENSURE, inside the reservation): a
 *   listing it ADOPTS turns this run into an UPDATE of it
 *   ({@link EntradaDePublicacao.retomandoCriacao}, so a has-model listing the
 *   lost attempt created UNLIST is re-listed — by THIS run only: a run that
 *   fails after the adoption, or the import's adoption, leaves it pausado).
 *
 * Clock-free and timer-free: `deps.nowMs` is the ONE instant every write
 * stamps and `deps.esperar` the ONE wait, both parameters; the draft lock's
 * live clock is `deps.aoVivo.agora`, also a parameter (the route's clock).
 * Every Firestore access goes through a `@delfrance/data/admin/collections`
 * handle and nothing here opens a multi-document atomic write.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_BRAND_MAX_PAGE_SIZE,
  SHOPEE_BRAND_STATUS,
  SHOPEE_ITEM_STATUS_WRITABLE,
  ShopeeApiError,
  ShopeeError,
  ShopeeRateLimitError,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeAddItemRequest,
  type ShopeeClient,
  type ShopeeItemStatusWritable,
  type ShopeeItemWriteResponse,
  type ShopeeLogisticsChannel,
  type ShopeePartnerClient,
  type ShopeeTaxInfoRequest,
  type ShopeeUpdateItemRequest,
} from '@delfrance/integrations-shopee';
import {
  CODIGO_RASCUNHO_SHOPEE,
  SHOPEE_ITEM_STATUS,
  componentesKitSchema,
  ehRascunhoShopee,
  estoqueDisponivel,
  fotoSchema,
  kitEstoqueDisponivel,
  parseFakePath,
  parseRef,
  precoDoFilhoNaTabela,
  propagaPrecoAosFilhos,
  rascunhoSemMarcaShopee,
  textoUtilizavelShopee,
  toOuterRef,
  varianteFakePath,
  type ComponentesKit,
  type EstadoAnuncioShopee,
  type Foto,
} from '@delfrance/schemas';
import {
  grupoDeVariacoesCollection,
  integracaoCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { ShopeeImportBlockedError } from '../produtos/errosImportacao';
import { lerLinhaDeEstoque } from '../produtos/estoquePrecos';
import {
  ehKitDe,
  itemStatusDe,
  temModelosDe,
  type ItemLido,
  type MemoDeCategorias,
} from '../produtos/itemLido';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { aplicarLinkDaListagem } from '../produtos/links';
import { itemStatusDeLink } from '../produtos/mapeamento';
import { avisoDeShopee, lerAtributos } from '../taxonomia/atributos';
import { lerMarcasCached, type ShopeeTaxonomiaCtx } from '../taxonomia/cache';
import { ehFolha } from '../taxonomia/categorias';
import { projetarAtributos, type AtributosProjetados } from '../taxonomia/dto';
import { lerLimitesDeItem, type LimitesDeItemLidos } from '../taxonomia/limites';
import { MOTIVO_RESOLUCAO_ANUNCIO, resolverAvisoDeAnuncio } from './avisoAnuncio';
import {
  ESPERA_APOS_ADD_ITEM_MS,
  FRASE_TAX_INFO_INCOMPLETO,
  MAX_PAGINAS_MARCAS,
} from './constantesAnuncio';
import {
  CriacaoDeAnuncioIncertaError,
  desfechoDeCriacaoDeItem,
  mensagemDoAnuncioIncerto,
  recusaDoAnuncioIncerto,
  skuDaBuscaShopee,
  verificarAnuncioExistenteShopee,
} from './criacaoIncerta';
import {
  ETAPA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
  limitarMensagemProblema,
  temProblemaDeBloqueio,
  type EtapaPublicacao,
  type ProblemaDeBloqueio,
  type ProblemaPublicacao,
} from './errosPublicacao';
import {
  criarResolvedorDeImagens,
  type FalhaDeFotoPublicacao,
  type ResolvedorDeImagensShopee,
  type ResumoFotosPublicacao,
} from './fotosPublicacao';
import { criarLeitorDeImpostoShopee } from './lerImpostoDoProduto';
import { lerTabelaMedidasDoProduto } from './lerTabelaMedidasDoProduto';
import {
  lerLinksDeVariacao,
  lerVinculosDaConta,
  resolverLinkPorProduto,
  type LinkDeVariacao,
} from './linkAnuncio';
import { aplicarModelos, type ResultadoModelos } from './modelosPublicacao';
import {
  categoriaDoAnuncio,
  kitNativoDoAnuncio,
  vinculoDecideKitNativo,
  type LinkListagemLido,
  type ProdutoParaPublicar,
} from './montagemAnuncio';
import {
  fotoDaTabelaRecusadaPelaShopee,
  planejarPublicacao,
  type ContextoPublicacao,
  type FotoDaTabelaDeMedidas,
  type FotosResolvidas,
  type OrdemDeRelistagem,
  type PlanoPublicacao,
} from './planoPublicacao';
import { problemaDeErroShopee, problemasDeErroShopee } from './problemasPublicacao';
import { criarRascunhoShopee } from './rascunho';
import {
  buscaNoPrazoDoEnvio,
  ConflitoDeRascunhoShopeeError,
  conferirTravaAntesDoEnvio,
  liberarTravaShopee,
  liberarTravaShopeeSemSubstituirErro,
  portaoDeEnvio,
  registrarCriacaoIncerta,
  reivindicarRascunhoShopee,
  reservarRascunhoShopee,
  type ControlesDaPublicacaoAoVivo,
  type ReservaDeRascunhoShopee,
} from './reservaRascunho';
import { agendadoParaMsDe, estadoDoAnuncio } from './statusAnuncio';
import {
  FONTE_TABELA_MEDIDAS,
  resolverTabelaDeMedidasDoAnuncio,
  type FotoTabelaMedidasOmitida,
  type MotivoTabelaMedidasOmitida,
  type ResultadoTabelaDeMedidasShopee,
  type TipoFonteTabelaDeMedidas,
} from './tabelaMedidasPublicacao';
import { MOTIVO_TAX_INFO_OMITIDO, type MotivoTaxInfoOmitido } from './taxInfoPublicacao';
import {
  fotoDaOpcaoDeTier,
  ordenarTiers,
  type FilhoParaPublicar,
  type GrupoParaTier,
  type VarianteDoTier,
} from './tiersPublicacao';

/* -------------------------------------------------------------------------- */
/*                                    Deps                                    */
/* -------------------------------------------------------------------------- */

export interface PublicarAnuncioDeps {
  readonly db: Firestore;
  readonly client: ShopeeClient;
  /**
   * The PARTNER client, as a factory (C8). `upload_image` is Public-signed, so
   * it is the client that never asks for an access token; the factory is the
   * composition root's seam and the photo unit receives a bound FUNCTION rather
   * than a client.
   */
  readonly partnerClient: () => ShopeePartnerClient;
  /** The conta's BARE doc id. */
  readonly integracaoId: string;
  readonly tabelaNormalOuterRef: string | null;
  readonly depositoOuterRef: string | null;
  readonly operacaoOuterRef: string | null;
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Read at the COMPOSITION ROOT — never from the environment here. */
  readonly hostEmulador?: string | null;
  /** MILLISECONDS. ONE clock read per request, handed down. */
  readonly nowMs: number;
  /** The ONE wait of this folder — there is no timer under `anuncios/`. */
  readonly esperar: (ms: number) => Promise<void>;
  readonly taxonomia: ShopeeTaxonomiaCtx;
  readonly categorias: MemoDeCategorias;
  /**
   * The picture-resolver seam. Absent ⇒ {@link criarResolvedorDePublicacao},
   * which is what production always takes; the `ReverificarAnuncioDeps.clientFor`
   * idiom. It is the ONE resolver of the publish either way (C7).
   */
  readonly resolvedorDeImagens?: ResolvedorDeImagensShopee;
  /**
   * What a LIVE run supplies to publish a DRAFT (#1911, D4/D15): the route's
   * clock `agora`, the request's deadline and the second-listing confirmation
   * (`reservaRascunho.ts`). The route and `publicar:anuncio --live` always set
   * it; a dry run never reaches the lock at all.
   *
   * ⚠️ OPTIONAL on THIS type only because every `KitDeps` builder shares it
   * and the kit arms never read it — never because it may be skipped: a DRAFT
   * reached without it is refused before any write, and there is no fallback to
   * {@link PublicarAnuncioDeps.nowMs} anywhere (a constant clock makes the send
   * gate vacuous). Inside the object, `agora` is REQUIRED.
   */
  readonly aoVivo?: ControlesDaPublicacaoAoVivo;
}

/**
 * The deps of the READ-ONLY half, and the proof is STRUCTURAL: no writer is
 * reachable from this type.
 *
 * `partnerClient` and `fetchImpl` are what the photo resolver needs to UPLOAD,
 * `esperar` only matters between two writes, and `hostEmulador` only widens the
 * download allow-list. Omitting all four is the `PrepararImportacaoShopeeDeps`
 * discipline: the property is proved by the call graph rather than asserted in a
 * comment — and it is also why the resolver arrives as a PARAMETER of
 * {@link prepararPublicacao} instead of being built there. `aoVivo` (#1911) is
 * omitted for the same reason: the draft lock is a WRITE, and the dry run that
 * runs this half alone must not be able to reach it.
 */
export type PrepararPublicacaoDeps = Omit<
  PublicarAnuncioDeps,
  'partnerClient' | 'fetchImpl' | 'esperar' | 'hostEmulador' | 'resolvedorDeImagens' | 'aoVivo'
>;

/** What the route's body (and the CLI's flags) resolve to. */
export interface EntradaDePublicacao {
  readonly produtoId: string;
  /**
   * Narrows to ONE `prodshopee` document. A `linkDocId` belonging to ANOTHER
   * conta resolves to nothing at all, so the route answers 404 instead of
   * publishing onto a listing this conta does not own.
   */
  readonly linkDocId?: string | null;
  /**
   * The operator's category choice (C36). Used ONLY when the resolved link
   * carries no `category_id`; a stored value always wins.
   */
  readonly categoryId?: number | null;
  /** What the operator asked for. A create WITH children still sends `UNLIST` first. */
  readonly statusPedido: ShopeeItemStatusWritable;
  /**
   * #1911 (D5): this run ADOPTED the listing an earlier, uncertain create of
   * the draft made (ENSURE, `reservaRascunho.ts`), and goes on as an UPDATE of
   * it. Set by {@link publicarAnuncioShopee} alone, never by a body: the plan
   * then re-lists a has-model listing the lost attempt left `UNLIST`
   * (`planoPublicacao.ts`). Absent ⇒ `false`.
   *
   * ⚠️ It lives in this run's memory ONLY (batch-A review, accepted for now):
   * the adoption is written BEFORE the plan runs, so an adopting run that then
   * fails — or an adoption by the product IMPORT, which never publishes — leaves
   * the listing `UNLIST` (pausado) until the operator re-activates it; the next
   * publish is a plain update, which never lists. `anuncios/README.md` records
   * the residual and the durable-marker fix it waits on.
   */
  readonly retomandoCriacao?: boolean;
  /**
   * #1911 batch-A review: the DISPATCHER read the conta and found NO link of
   * this produto (`publicarShopee.ts`, the `linkDocId: null` arm). Set by that
   * entry alone. The mint's own re-read then finding ANY link means another run
   * (or the import) wrote one in between, and the run refuses — it never falls
   * back to step 11's lexical resolver ({@link nomearCriacaoSemVinculo}).
   * Absent ⇒ a direct caller, which keeps the step-11 unnamed pick (a draft
   * among the links still refuses).
   */
  readonly despachoSemVinculo?: boolean;
}

/**
 * What one publish did about the size chart (step 18) — the decision it SENT,
 * plus the read-back's echo as a DIAGNOSTIC.
 *
 * ⚠️ `lidaDeVolta` is `get_item_base_info.size_chart_id` RAW (no fold — Shopee
 * zero-fills absent numerics, so a `0` there is data), and it is what settles
 * whether a JSON-number `size_chart_id` was accepted (register 262).
 * `fotoLidaDeVolta` is the read-back `size_chart` URL's PRESENCE, never the URL
 * — an `http(s)` URL; Shopee's `"-"` placeholder and a blank are absence.
 * Both are `null` when the read-back degraded. Nothing reads either to decide
 * anything: the pick lives on `tabMedi`, never derived from the read-back.
 */
export interface TabelaDeMedidasDaPublicacao {
  /** The TEMPLATE sent — non-null ⇔ `fonte === 'modelo'`. */
  readonly sizeChartId: number | null;
  readonly fonte: TipoFonteTabelaDeMedidas;
  /** Why no template — `null` only when one was sent. */
  readonly motivo: MotivoTabelaMedidasOmitida | null;
  readonly fotoOmitida: FotoTabelaMedidasOmitida | null;
  /** The category declares a MANDATORY chart and nothing went out — a warning. */
  readonly avisoObrigatoria: boolean;
  readonly lidaDeVolta: number | null;
  readonly fotoLidaDeVolta: boolean | null;
}

/** One publish, done. */
export interface ResultadoPublicacao {
  readonly plano: PlanoPublicacao;
  readonly produtoId: string;
  /** The listing id — the echo's on a create, the stored one on an update. */
  readonly itemId: number;
  readonly linkDocId: string;
  readonly ehAtualizacao: boolean;
  /**
   * The fold over the READ-BACK (O5). `null` when the read-back degraded, which
   * is the one case where nothing authoritative was read.
   */
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
  /** The RAW `item_status` of the read-back; `null` when it degraded. */
  readonly itemStatus: string | null;
  readonly deboost: boolean;
  /** The FIRST non-noise envelope `warning` of this publish, in call order. */
  readonly avisoShopee: string | null;
  readonly modelos: ResultadoModelos;
  readonly fotos: ResumoFotosPublicacao;
  /** Pictures this publish could not resolve. Counted, never fatal. */
  readonly falhasDeFoto: readonly FalhaDeFotoPublicacao[];
  readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  /** Which re-list door worked; `null` when the dance was not planned. */
  readonly relistagem: OrdemDeRelistagem | null;
  /** `true` only when a violation aviso was OPEN and this publish closed it. */
  readonly avisoResolvido: boolean;
  /** `false` when the read-back could not find the listing (eventual consistency). */
  readonly leituraDeVolta: boolean;
  /** The size chart this publish sent, and what the read-back echoed (step 18). */
  readonly tabelaDeMedidas: TabelaDeMedidasDaPublicacao;
  /**
   * Shopee calls spent by **`aplicar` only** — the budget signal, like
   * `reverificarAnuncio.ts`'s field of the same name.
   *
   * ⚠️ It does NOT include what `preparar` paid for (`get_item_limit`,
   * `get_attribute_tree`, `get_channel_list` and the brand paging): the figure
   * lives on the APPLIER's result, and `preparar` is write-free and reusable.
   * Inside `aplicar` every step is counted per CALL — the read-back included,
   * which is two for a kit or an item with models.
   */
  readonly chamadasShopee: number;
}

/* -------------------------------------------------------------------------- */
/*                          small tolerant projections                         */
/* -------------------------------------------------------------------------- */

function textoOuNull(bruto: unknown): string | null {
  return typeof bruto === 'string' ? bruto : null;
}

function textoUtilizavel(bruto: unknown): string | null {
  const texto = textoOuNull(bruto);
  if (texto === null) return null;
  const limpo = texto.trim();
  return limpo.length > 0 ? texto : null;
}

function numeroOuNull(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : null;
}

function booleano(bruto: unknown): boolean {
  return bruto === true;
}

/**
 * A stored three-valued boolean, kept three-valued.
 *
 * ⚠️ Not {@link booleano}: that one folds every non-`true` reading to `false`,
 * which is right for an ERP flag with a schema default and WRONG for a field
 * whose `null` means "this listing was never read back" — the reading and the
 * absence of a reading are different facts, and only this projection preserves
 * them. The refusal that consumes it compares `=== true` either way; what the
 * fold would destroy is every later reader's ability to tell the two apart.
 */
function booleanoOuNull(bruto: unknown): boolean | null {
  return typeof bruto === 'boolean' ? bruto : null;
}

function listaDeTextos(bruto: unknown): readonly string[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** A stored `item_id` that is not a positive number is "no listing yet". */
function itemIdUtilizavel(bruto: unknown): number | null {
  const n = numeroOuNull(bruto);
  return n !== null && n > 0 ? n : null;
}

/**
 * `produto.precos`, projected to what the mappers read.
 *
 * ⚠️ An entry whose `valor` is not a finite number is DROPPED rather than
 * coerced: a price is the one field where a guessed number reaches a buyer.
 */
function precosDeProduto(bruto: unknown): Record<string, { readonly valor: number }> | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const saida: Record<string, { readonly valor: number }> = {};
  for (const [tabela, valor] of Object.entries(bruto as Record<string, unknown>)) {
    const n = numeroOuNull((valor as { valor?: unknown } | null)?.valor);
    if (n !== null) saida[tabela] = { valor: n };
  }
  return Object.keys(saida).length > 0 ? saida : null;
}

/**
 * `produto.fotos`, row by row, through the schema.
 *
 * A row that does not parse is DROPPED with the others kept: `arquivoOuterRef`
 * is what the resolver needs and a row without one cannot be fetched at all, so
 * refusing the whole produto for one malformed picture would make a publish
 * impossible for a defect the operator can fix on one row. The count reaches the
 * one log line.
 */
function fotosDeProduto(bruto: unknown): {
  readonly fotos: readonly Foto[];
  readonly ilegiveis: number;
} {
  if (!Array.isArray(bruto)) return { fotos: [], ilegiveis: 0 };
  const fotos: Foto[] = [];
  let ilegiveis = 0;
  for (const linha of bruto) {
    const lido = fotoSchema.safeParse(linha);
    if (lido.success) fotos.push(lido.data);
    else ilegiveis += 1;
  }
  return { fotos, ilegiveis };
}

function componentesDeProduto(bruto: unknown): ComponentesKit | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const lido = componentesKitSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

/**
 * ⚠️ An absent `ordem` sorts LAST, never first.
 *
 * `produto.ordem` is `.nullable()`, and the legacy sorts an absent one at the
 * end (`sortGruposByOrdem`'s `?? Infinity`). A `0` fallback would make an
 * unordered child win the item-level price of a create over a child the operator
 * explicitly put first. `MAX_SAFE_INTEGER` rather than `Infinity` so the value
 * stays a safe integer in every comparison.
 */
const ORDEM_AUSENTE = Number.MAX_SAFE_INTEGER;

function ordemDeProduto(bruto: unknown): number {
  return numeroOuNull(bruto) ?? ORDEM_AUSENTE;
}

/** One produto document, projected for the mappers. */
function produtoParaPublicar(id: string, raw: Record<string, unknown>): ProdutoParaPublicar {
  return {
    id,
    nome: textoOuNull(raw.nome) ?? '',
    sku: textoOuNull(raw.sku),
    gtin: textoOuNull(raw.gtin),
    paiId: textoUtilizavel(raw.paiId),
    ehKit: booleano(raw.ehKit),
    ehKitVirtual: booleano(raw.ehKitVirtual),
    ehUsado: booleano(raw.ehUsado),
    ofereceFreteGratis: booleano(raw.ofereceFreteGratis),
    crossdocking: numeroOuNull(raw.crossdocking),
    pesoBrutoKg: numeroOuNull(raw.pesoBrutoKg),
    pesoLiquidoKg: numeroOuNull(raw.pesoLiquidoKg),
    alturaCm: numeroOuNull(raw.alturaCm),
    larguraCm: numeroOuNull(raw.larguraCm),
    profundidadeCm: numeroOuNull(raw.profundidadeCm),
    precos: precosDeProduto(raw.precos),
    variacoesUid: listaDeTextos(raw.variacoesUid),
    componentesKit: componentesDeProduto(raw.componentesKit),
    fotos: fotosDeProduto(raw.fotos).fotos,
  };
}

/**
 * The stored `prodshopee` fields the ITEM mapper reads.
 *
 * ⚠️ `estadoAnuncio` arrives ALREADY folded by `linkAnuncio.ts` (an unrecognised
 * stored value reads as `null`), which is what lets `montarAnuncio` refuse a
 * `removido` listing without a second copy of that fold.
 *
 * ⚠️ `kitNativo` is read THREE-valued and never coerced — it is what Shopee
 * reported about the live listing, and it is the authority behind
 * `produto-e-kit` on every republish.
 *
 * ⚠️ `ehRascunho` (#1911, D3) is the shared `ehRascunhoShopee` over the RAW
 * document, never over the projection built here: `item_id` below is already
 * folded (`0` and `'123'` read `null`), and a corrupt link must not pass for a
 * draft. It moves the kit question of a draft to the produto
 * (`vinculoDecideKitNativo`, `montagemAnuncio.ts`).
 *
 * ⚠️ `marcaNaoEscolhida` (#1911, D10) is the shared `rascunhoSemMarcaShopee`
 * over the RAW document too, for the same reason and one more: `brand_id`
 * below is already folded by `numeroOuNull`, so an ABSENT key and a stored
 * `null` both read `null` there — the predicate must see the stored document
 * to tell a draft nobody gave a brand from an imported listing whose
 * `brand_id` is `null`. The listing assembly refuses the first
 * (`marca-nao-escolhida`) and never the second.
 */
function linkListagemLido(
  raw: Record<string, unknown>,
  estadoAnuncio: EstadoAnuncioShopee | null,
): LinkListagemLido {
  return {
    item_id: itemIdUtilizavel(raw.item_id),
    item_name: textoOuNull(raw.item_name),
    description: textoOuNull(raw.description),
    category_id: numeroOuNull(raw.category_id),
    brand_id: numeroOuNull(raw.brand_id),
    attributes: Array.isArray(raw.attributes) ? (raw.attributes as readonly unknown[]) : null,
    logistic_info: Array.isArray(raw.logistic_info)
      ? (raw.logistic_info as readonly unknown[])
      : null,
    estadoAnuncio,
    kitNativo: booleanoOuNull(raw.kitNativo),
    ehRascunho: ehRascunhoShopee(raw),
    marcaNaoEscolhida: rascunhoSemMarcaShopee(raw),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   preparar                                  */
/* -------------------------------------------------------------------------- */

/**
 * The photo resolver of ONE publish, with the upload bound to the partner client
 * (C8) — the ONE place in this app that binds it.
 *
 * ONE resolver per publish, deliberately: its `arquivos.externalIds` memo has to
 * span the item pass AND every tier-1 option pass (C7), and a resolver per pass
 * would read its own writes.
 */
export function criarResolvedorDePublicacao(
  deps: PublicarAnuncioDeps,
  produtoId: string,
): ResolvedorDeImagensShopee {
  return criarResolvedorDeImagens({
    db: deps.db,
    integracaoId: deps.integracaoId,
    produtoId,
    // ⚠️ A FUNCTION, not a client: the photo unit stays testable with no client
    // double, and `upload_image` is Public-signed so nothing shop-scoped is
    // passed (the probe settled it; `signing` is the probe's seam alone).
    enviarImagem: (p) => deps.partnerClient().uploadImage(p),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.hostEmulador === undefined ? {} : { hostEmulador: deps.hostEmulador }),
  });
}

/**
 * Read the whole graph ONE publish needs.
 *
 * ⚠️ **It writes nothing**, and the proof is structural: {@link
 * PrepararPublicacaoDeps} reaches no writer, and the resolver it is handed is
 * never CALLED here (a test drives it with a resolver that throws). That holds
 * for step 18's tabela too: `lerTabelaMedidasDoProduto` READS the produto's
 * `tabMedi` document (one get, none without a ref) and the size-chart photo is
 * uploaded by {@link resolverFotosDaPublicacao}, never here.
 *
 * ⚠️ **`get_model_list` is never read here.** The live tier tree is read FRESH
 * inside `aplicarModelos`, immediately before `update_tier_variation` is built:
 * that call is a full-list replace, so a stale tree in the plan is the
 * omission-deletes defect.
 *
 * Two refusals are raised as early as they can be DECIDED — a variation child
 * (`paiId`) and a NATIVE Shopee kit ({@link kitNativoDoAnuncio}, step 19's
 * `add_kit_item`). ⚠️ That is after the link read rather than before it, because
 * the kit arm's authority on a republish is the link's `kitNativo` (what Shopee
 * itself reported), so deciding earlier would mean deciding on the produto's
 * `ehKit` — the step-11 defect that made the whole legacy kit catalogue
 * unpublishable. The cost is ONE document read on a refused publish; the photo
 * resolver, the channel list and the taxonomy are all still untouched.
 * `montarAnuncio` produces both refusals again from the same fields, so the plan
 * is consistent either way; raising here is what stops a refused publish paying
 * for a channel list and a picture upload.
 *
 * @returns `null` when this conta has nothing to publish onto — the produto does
 *   not exist, or a `linkDocId` was named and does not belong to this conta.
 *   Both are the route's **404**.
 */
export async function prepararPublicacao(
  deps: PrepararPublicacaoDeps,
  entrada: EntradaDePublicacao,
  resolvedorDeImagens: ResolvedorDeImagensShopee,
): Promise<ContextoPublicacao | null> {
  const db = deps.db;
  const produtoSnap = await produtoCollection.docRef(db, {}, entrada.produtoId).get();
  if (!produtoSnap.exists) return null;
  const raw = (produtoSnap.data() ?? {}) as Record<string, unknown>;
  const produto = produtoParaPublicar(entrada.produtoId, raw);

  const linkResolvido = await resolverLinkPorProduto(
    db,
    deps.integracaoId,
    entrada.produtoId,
    entrada.linkDocId ?? null,
  );
  const link =
    linkResolvido === null
      ? null
      : linkListagemLido(linkResolvido.raw, linkResolvido.estadoAnuncio);

  // The kit arm reads the LINK, so this cannot run before the resolver — see the
  // function's docblock. It still runs before every other read and before the
  // first Shopee call, and it keeps its precedence over the 404 below: a produto
  // that may never be published this way is told so, whichever linkDocId the
  // caller named.
  recusarProdutoNaoPublicavel(produto, link);

  // A named link that resolves to nothing is a 404, not a first publish: the
  // conta filter runs FIRST inside the resolver, so an id can only ever narrow
  // within what this conta already owns.
  if (linkResolvido === null && textoUtilizavel(entrada.linkDocId) !== null) return null;

  const ehAtualizacao = link !== null && link.item_id !== null;

  const descricao = await lerDescricao(db, entrada.produtoId);
  const filhosCrus = await lerFilhos(db, entrada.produtoId);
  // ⚠️ PER LISTING (step 19, L8): only the rows that point at the RESOLVED link.
  // A child may also carry another listing's rows — the native kit a converted
  // ordinary listing now sits beside — and binding a child to that listing's
  // model would plan this listing's update against the wrong `model_id`. `null`
  // (no link yet) is the step-11 first publish, which has nothing to filter by.
  const linksDeVariacao = await lerLinksDeVariacao(
    db,
    deps.integracaoId,
    entrada.produtoId,
    linkResolvido?.linkDocId ?? null,
  );
  const grupos = await lerGrupos(db, filhosCrus);

  /* ---- estoque: the produto, every child, and every kit COMPONENT of both. -- */
  const disponivelByProdutoId: Record<string, number | null | undefined> = {};
  for (const componenteId of idsDeComponentes(produto, filhosCrus)) {
    const linha = await lerLinhaDeEstoque(db, componenteId, deps.depositoOuterRef);
    disponivelByProdutoId[componenteId] = linha === null ? 0 : chao(estoqueDisponivel(linha));
  }
  const linhaDoPai = await lerLinhaDeEstoque(db, entrada.produtoId, deps.depositoOuterRef);
  // ⚠️ The produto's OWN availability, NOT the kit fold: `montarAnuncio` applies
  // `quantidadeParaPublicarShopee`, which folds the components itself. Folding
  // here too would be two copies of that rule.
  const ownDisponivel = linhaDoPai === null ? 0 : chao(estoqueDisponivel(linhaDoPai));

  const tabelaNormalId = idDeRef(deps.tabelaNormalOuterRef);
  // ⚠️ The PARENT's two raw values, off the document already in hand — no second
  // read. It is always the parent: a variation child is refused above.
  const precoDoPai: PrecoDoPai = {
    precos: raw.precos,
    propagaPreco: propagaPrecoAosFilhos(raw.propagatePriceToChildren),
  };
  const filhos = await Promise.all(
    filhosCrus.map((filho) =>
      filhoParaPublicar(
        db,
        deps,
        filho,
        precoDoPai,
        tabelaNormalId,
        linksDeVariacao,
        disponivelByProdutoId,
      ),
    ),
  );

  /* ---- taxonomy: the leaf gate, the bands, the attributes. ----------------- */
  // ⚠️ The ONE resolution `montarAnuncio` and the size-chart photo pass call.
  const categoryId = categoriaDoAnuncio(link, entrada.categoryId ?? null);
  const indice = await deps.categorias.carregar();
  const veredictoFolha = categoryId === null ? 'desconhecida' : ehFolha(indice, categoryId);
  const limites: LimitesDeItemLidos = await lerLimitesDeItem(deps.taxonomia, categoryId);
  // ⚠️ The attribute tree is gated on the LEAF verdict: `get_attribute_tree`
  // answers nothing usable for a non-leaf, and `montarAnuncio` refuses such a
  // category with `categoria-invalida` anyway — so the call is skipped rather
  // than spent.
  const atributos: AtributosProjetados =
    categoryId !== null && veredictoFolha === 'folha'
      ? projetarAtributos((await lerAtributos(deps.taxonomia, categoryId)).atributos)
      : { atributos: [], truncated: false };

  const marca = await resolverMarcaDoAnuncio(deps, link, linkResolvido?.raw ?? null, categoryId);

  /* ---- the shop's channels, UNCACHED: a stale list enables a dead channel. - */
  const canais = await lerCanaisDaLoja(deps.client);

  const imposto = await criarLeitorDeImpostoShopee({
    db,
    operacaoOuterRef: deps.operacaoOuterRef,
  }).ler(entrada.produtoId);

  // Step 18: the produto's tabela de medidas, for THIS conta. At most ONE read,
  // and none at all when the produto names no tabela; it writes nothing.
  const tabelaDeMedidas = await lerTabelaMedidasDoProduto(
    db,
    raw.tabelaDeMedidasModaUid,
    deps.integracaoId,
  );

  return {
    integracaoId: deps.integracaoId,
    produto,
    descricao,
    filhos,
    grupos,
    link,
    linkDocId: linkResolvido?.linkDocId ?? null,
    linksDeVariacao,
    limites,
    atributos,
    veredictoFolha,
    categoryId: entrada.categoryId ?? null,
    marca,
    canais,
    imposto,
    tabelaDeMedidas,
    resolvedorDeImagens,
    ehAtualizacao,
    // Only an UPDATE resumes a create: an adoption that found no item_id on
    // the re-read is an ordinary first publish.
    retomandoCriacao: ehAtualizacao && entrada.retomandoCriacao === true,
    statusPedido: entrada.statusPedido,
    tabelaNormalId,
    ownDisponivel,
    disponivelByProdutoId,
    nowMs: deps.nowMs,
  };
}

/**
 * `produto-e-filho` — a variation child is never published on its own: its
 * listing is its PARENT's. Exported for step 19's publish dispatcher
 * (`kits/armaDePublicacao.ts`, rule (−1)), which refuses a child BEFORE any arm
 * is chosen — one sentence for both refusals, never two copies of it.
 */
export function problemaProdutoEFilho(produtoId: string, paiId: string): ProblemaDeBloqueio {
  return {
    campo: 'paiId',
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
    mensagem: limitarMensagemProblema(
      `o produto ${produtoId} é uma variação de ${paiId} — publique o produto PAI, ` +
        'que leva as variações como modelos',
    ),
  };
}

/**
 * The two refusals that are about the PRODUTO (and, for the kit one, about the
 * listing it already has) rather than about a field of the payload.
 *
 * ⚠️ **`ehKit` does not appear here** — corrected in step 12 (#1520). The ERP's
 * `ehKit` produtos publish as ordinary Shopee listings and there are thousands
 * of them; only a NATIVE Shopee kit is refused, and {@link kitNativoDoAnuncio}
 * is the ONE predicate that decides it, shared with `montarAnuncio` so the two
 * producers of `produto-e-kit` cannot drift apart.
 *
 * ⚠️ Since step 19 (#1527, PR 7) the kit refusal is a DEFENSIVE assertion: the
 * publish dispatcher (`kits/armaDePublicacao.ts`) routes every native kit to the
 * kit arms before this module is reached, so a native kit arriving here is a
 * routing bug — and the sentence says that rather than giving the operator an
 * instruction to follow.
 *
 * `campo` names the field the operator must look at, and it therefore follows
 * the arm the predicate took: the link's `kitNativo` on a republish, the
 * produto's `ehKitVirtual` on a first publish — a DRAFT link's included
 * (#1911). The arm is {@link vinculoDecideKitNativo}'s answer, the same call the
 * predicate makes, so the label cannot drift from the branch; both spellings
 * are pinned by tests, because nothing in the type system ties a label to a
 * branch.
 */
function recusarProdutoNaoPublicavel(
  produto: ProdutoParaPublicar,
  link: LinkListagemLido | null,
): void {
  const problemas: ProblemaDeBloqueio[] = [];
  if (produto.paiId !== null) {
    problemas.push(problemaProdutoEFilho(produto.id, produto.paiId));
  }
  if (kitNativoDoAnuncio(link, produto)) {
    problemas.push({
      campo: vinculoDecideKitNativo(link) ? 'kitNativo' : 'ehKitVirtual',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit,
      mensagem:
        `o anúncio do produto ${produto.id} é um kit NATIVO da Shopee e chegou ao publicador de ` +
        'anúncio comum — kit nativo é publicado pelo caminho de kit (add_kit_item / ' +
        'update_kit_item), para onde o ERP o encaminha antes; chegar aqui é defeito do ERP, nada ' +
        'foi enviado',
    });
  }
  if (temProblemaDeBloqueio(problemas)) {
    throw new ShopeePublishBlockedError({ produtoId: produto.id, itemId: null, problemas });
  }
}

/**
 * The produto's description (`extraData/singleton.descricao`), or `null`.
 *
 * Exported for step 19's kit arm (`kits/prepararKit.ts`), which reads the SAME
 * graph for an `add_kit_item` body: a second copy of any of the six readers
 * exported here would be the #1369 drift.
 */
export async function lerDescricao(db: Firestore, produtoId: string): Promise<string | null> {
  const snap = await produtoExtraDataCollection.docRef(db, { produtoId }, 'singleton').get();
  if (!snap.exists) return null;
  return textoOuNull((snap.data() ?? {}).descricao);
}

interface FilhoCru {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

/**
 * The variation children.
 *
 * The same `produtos (paiId == …)` query `resolveProduto.ts`'s `jaTemFilhos`
 * already runs, so its index cost is paid and no new composite is needed.
 * Exported for step 19's kit arm (a kit FAMILY's children are its kit models).
 */
export async function lerFilhos(db: Firestore, produtoPaiId: string): Promise<readonly FilhoCru[]> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', produtoPaiId).get();
  return snap.docs.map((d) => ({
    id: d.id,
    raw: (d.data() ?? {}) as Record<string, unknown>,
  }));
}

/** Every kit component id whose availability a quantity decision reads. */
function idsDeComponentes(
  produto: ProdutoParaPublicar,
  filhos: readonly FilhoCru[],
): readonly string[] {
  const ids = new Set<string>();
  const junte = (componentes: ComponentesKit | null): void => {
    for (const id of Object.keys(componentes ?? {})) ids.add(id);
  };
  if (produto.ehKit || produto.ehKitVirtual) junte(produto.componentesKit);
  for (const filho of filhos) {
    if (!booleano(filho.raw.ehKit) && !booleano(filho.raw.ehKitVirtual)) continue;
    junte(componentesDeProduto(filho.raw.componentesKit));
  }
  return [...ids];
}

/** Floor at zero: a negative availability is a real defect and an unsendable quantity. */
function chao(valor: number): number {
  return Math.max(Math.floor(valor), 0);
}

/**
 * The PARENT's price inputs for its children, RAW: `precos` as stored and
 * `propagatePriceToChildren` already folded by `propagaPrecoAosFilhos` (only a
 * stored literal `false` turns propagation off).
 */
interface PrecoDoPai {
  readonly precos: unknown;
  readonly propagaPreco: boolean;
}

/**
 * One child, projected for the tier mapper.
 *
 * ⚠️ `estoque` is the child's AVAILABLE quantity and is NOT clamped to the
 * shop's band here: `montarTiers` refuses a child below `stockLimit.min` and
 * clamps one above `stockLimit.max`, and a second clamp here would hide the
 * refusal. It IS floored at zero, because a negative `seller_stock` is not a
 * body Shopee accepts and `0 < min` still refuses.
 *
 * Exported for step 19's kit arm: a kit model's price is this function's
 * `preco` (the shared child-price rule), never a second derivation.
 */
export async function filhoParaPublicar(
  db: Firestore,
  deps: PrepararPublicacaoDeps,
  filho: FilhoCru,
  precoDoPai: PrecoDoPai,
  tabelaNormalId: string | null,
  links: readonly LinkDeVariacao[],
  disponivelByProdutoId: Record<string, number | null | undefined>,
): Promise<FilhoParaPublicar> {
  const linha = await lerLinhaDeEstoque(db, filho.id, deps.depositoOuterRef);
  const proprio = linha === null ? 0 : estoqueDisponivel(linha);
  const componentes = componentesDeProduto(filho.raw.componentesKit);
  const ehKit = booleano(filho.raw.ehKit) || booleano(filho.raw.ehKitVirtual);
  // The SAME fold `quantidadeParaPublicarShopee` applies at item level —
  // `kitEstoqueDisponivel(...) ?? own`, never the additive reading — so the item
  // and its models cannot disagree about what a kit has.
  const derivado = ehKit ? kitEstoqueDisponivel(componentes, disponivelByProdutoId) : null;
  const link = links.find((l) => l.produtoId === filho.id) ?? null;

  return {
    produtoId: filho.id,
    sku: textoOuNull(filho.raw.sku),
    gtin: textoOuNull(filho.raw.gtin),
    ordem: ordemDeProduto(filho.raw.ordem),
    variacoesUid: listaDeTextos(filho.raw.variacoesUid),
    // ⚠️ The shared child-price rule (`@delfrance/schemas`, Mercado Livre's, the
    // ONE copy step 13's price sync calls too — D-9, #1521): a PROPAGATING parent's
    // price in the tabela, the child's own map never read, not even as a fallback;
    // a non-propagating parent ⇒ the child's own price, the parent never read.
    // Both arms go through `precoDaTabela`: rounded to the centavo and positive
    // AFTER rounding, so a `0` (or `0.004`) is `null` here and `montarTiers`
    // refuses it as `filho-sem-preco` — on an UPDATE too — instead of putting
    // `original_price: 0` on an `init_tier_variation` / `add_model` body.
    // ⚠️ Why the parent under propagation: the produto trigger copies the
    // parent's `precos` into each child only when the PARENT's prices change, so
    // a child created after that edit, a step-9 import or a legacy row can hold
    // no price (or a stale one) while the family is priced.
    preco: precoDoFilhoNaTabela(
      {
        precosDoPai: precoDoPai.precos,
        propagaPreco: precoDoPai.propagaPreco,
        precosDoFilho: filho.raw.precos,
      },
      tabelaNormalId,
    ),
    // The price SOURCE, from the very flag that chose the arm above — so a
    // `filho-sem-preco` names the parent exactly when the parent priced it.
    precoDoPai: precoDoPai.propagaPreco,
    estoque: chao(derivado ?? proprio),
    fotos: fotosDeProduto(filho.raw.fotos).fotos,
    linkModelId: link?.modelId ?? null,
    linkDocId: link?.linkDocId ?? null,
    tierIndexArmazenado: link === null ? null : link.tierIndex,
  };
}

/**
 * Every `grupoDeVariacoes` the children reference, read once.
 *
 * ⚠️ A variante's `ordem` is its INDEX inside `grupo.variacoes` — the legacy
 * wire rule (`models.dart:2034-2057`: groups by `ordem`, variants by their
 * position in the array). The array order IS the operator's order; a stored
 * per-variante `ordem` field does not exist.
 *
 * Exported for step 19's kit arm, whose ONE tier is the family's grupo.
 */
export async function lerGrupos(
  db: Firestore,
  filhos: readonly FilhoCru[],
): Promise<readonly GrupoParaTier[]> {
  const ids: string[] = [];
  for (const filho of filhos) {
    for (const caminho of listaDeTextos(filho.raw.variacoesUid)) {
      const parsed = parseFakePath(caminho);
      if (parsed !== null && !ids.includes(parsed.grupoId)) ids.push(parsed.grupoId);
    }
  }

  const grupos: GrupoParaTier[] = [];
  for (const grupoId of ids) {
    const snap = await grupoDeVariacoesCollection.docRef(db, {}, grupoId).get();
    if (!snap.exists) {
      console.warn('[shopee/anuncios] grupo de variações ausente ao preparar a publicação', {
        grupoId,
      });
      continue;
    }
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    const variacoes: VarianteDoTier[] = [];
    const brutas = Array.isArray(raw.variacoes) ? (raw.variacoes as readonly unknown[]) : [];
    brutas.forEach((bruta, indice) => {
      const linha = (bruta ?? {}) as Record<string, unknown>;
      const varianteId = textoUtilizavel(linha.id);
      const nome = textoUtilizavel(linha.nome);
      if (varianteId === null || nome === null) return;
      variacoes.push({ varianteId, nome, ordem: indice });
    });
    grupos.push({
      grupoId,
      // A grupo with no string `nome` is NAMELESS: `''` lets the custom-tier
      // blank-name refusal stop it before `add_item`. Falling back to the doc
      // id would publish the id as the tier name Shopee buyers see.
      nome: textoOuNull(raw.nome) ?? '',
      ordem: numeroOuNull(raw.ordem) ?? ORDEM_AUSENTE,
      permiteFotos: booleano(raw.permiteFotos),
      variacoes,
      linksVariacoesShopee: Array.isArray(raw.linksVariacoesShopee)
        ? (raw.linksVariacoesShopee as readonly unknown[])
        : null,
    });
  }
  return grupos;
}

/**
 * The shop's logistics channels, read UNCACHED once per publish.
 *
 * ⚠️ Deliberately not behind a TTL cache: a stale list would enable a channel
 * the shop turned off minutes ago, and the failure is a listing the seller
 * cannot ship. The per-element `null` sentinel is filtered here — one unreadable
 * channel must not cost the whole build.
 *
 * Exported for step 19's kit arm, which reads the channels UNCACHED for the same
 * reason.
 */
export async function lerCanaisDaLoja(
  client: ShopeeClient,
): Promise<readonly ShopeeLogisticsChannel[]> {
  const lista = await client.getChannelList();
  return lista.logistics_channel_list.filter((c): c is ShopeeLogisticsChannel => c !== null);
}

/** The last path segment of an outerRef, through the SHARED fold. */
function idDeRef(ref: string | null): string | null {
  if (ref === null) return null;
  const { id } = parseRef(ref);
  return id.length > 0 ? id : null;
}

/**
 * C17's brand cascade, in rungs, with the cheap rungs first.
 *
 *  1. `brand_id === 0` ⇒ **no read at all**. Shopee's own "No Brand" is a
 *     CHOICE, and `montarAnuncio` supplies its wire name — so this module never
 *     spells that literal and never spends a call on it.
 *  2. the link's stored `original_brand_name` — written by every read-back
 *     (write-back #2), by the draft route with the operator's brand pick (the
 *     no-link mint's `null` included), and by the import (`shopeeLink.ts`'s
 *     writer list). Zero cost on a republish.
 *  3. a BOUNDED `get_brand_list` walk of the item's category
 *     (≤ {@link MAX_PAGINAS_MARCAS} pages), through step 10's TTL cache.
 *  4. `nome: null` — `montarAnuncio` then refuses a CREATE (`marca-sem-nome`)
 *     and OMITS the whole `brand` object on an update, which destroys nothing
 *     because `update_item` is field-wise.
 *
 * ⚠️ `integracao/{id}/brandshopee` is NEVER read: its schema is
 * `z.object({}).passthrough()`, so a name taken out of it is an undeclared key,
 * and it stays the curated registration shortlist with no reader.
 */
async function resolverMarcaDoAnuncio(
  deps: PrepararPublicacaoDeps,
  link: LinkListagemLido | null,
  raw: Record<string, unknown> | null,
  categoryId: number | null,
): Promise<{ readonly brandId: number; readonly nome: string | null }> {
  // ⚠️ The SAME `??` cascade `montarAnuncio` applies, so the id whose name is
  // resolved here is the id that goes out on the wire.
  const brandId = link?.brand_id ?? 0;
  if (brandId === 0) return { brandId: 0, nome: null };

  const armazenado = textoUtilizavel(raw?.original_brand_name);
  if (armazenado !== null) return { brandId, nome: armazenado };

  if (categoryId === null) return { brandId, nome: null };

  let offset = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS_MARCAS; pagina += 1) {
    const pag = await lerMarcasCached(deps.taxonomia, {
      categoryId,
      status: SHOPEE_BRAND_STATUS.normal,
      offset,
      pageSize: SHOPEE_BRAND_MAX_PAGE_SIZE,
    });
    const achada = pag.brand_list.find((m) => m.brand_id === brandId);
    if (achada !== undefined) return { brandId, nome: achada.original_brand_name };
    // ⚠️ Shopee's own cursor, VERBATIM — never `offset + pageSize`, which is
    // what makes a mutating list skip rows.
    if (!pag.has_next_page || pag.next_offset === null) break;
    offset = pag.next_offset;
  }
  console.warn('[shopee/anuncios] marca não resolvida no catálogo da categoria', {
    integracaoId: deps.integracaoId,
    categoryId,
    brandId,
    paginas: MAX_PAGINAS_MARCAS,
  });
  return { brandId, nome: null };
}

/* -------------------------------------------------------------------------- */
/*                                    fotos                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve every picture this publish sends, through the ONE resolver.
 *
 * The ITEM pass first (cap `SHOPEE_ITEM_IMAGE_MAX`, in render ORDER — Shopee
 * renders `image_id_list` positionally, so the list is never re-sorted), then
 * the tier-1 option passes at `cap: 1`.
 *
 * ⚠️ **Zero usable pictures is NOT an error here.** The resolver answers an
 * empty list, `montarAnuncio` turns that into the `sem-fotos` refusal, and the
 * applier throws `ShopeePublishBlockedError` before `add_item` — so the operator
 * gets a body naming every refusal instead of one that stops at "no pictures".
 *
 * Then, step 18, the size-chart PHOTO pass ({@link resolverFotoDaTabelaDeMedidas}).
 */
export async function resolverFotosDaPublicacao(
  contexto: ContextoPublicacao,
): Promise<FotosResolvidas> {
  const resolvedor = contexto.resolvedorDeImagens;
  const item = await resolvedor.resolver(contexto.produto.fotos);
  const imagensDeOpcao = await resolverImagensDeOpcao(contexto, resolvedor);
  const tabelaDeMedidas = await resolverFotoDaTabelaDeMedidas(contexto, resolvedor);
  return { item, imagensDeOpcao, tabelaDeMedidas, resumo: resolvedor.resumo() };
}

/**
 * The tabela's FIRST photo as an image chart — uploaded ONLY when the size-chart
 * decision says `foto` (step 18, A.1.4).
 *
 * ⚠️ **The decision is the item mapper's own**, made here BEFORE it runs because
 * the upload is I/O: the SAME `resolverTabelaDeMedidasDoAnuncio` over the SAME
 * resolved category ({@link categoriaDoAnuncio}) and the same band, so the photo
 * uploaded here is exactly the one `montarAnuncio` will put on the body. A
 * template that matched WINS and costs zero uploads; a category that explicitly
 * takes no image chart costs zero uploads too.
 *
 * Step 11's resolver, `cap: 1`: its SSRF allow-list, its `arquivos.externalIds`
 * cache (a re-publish reuses the cached `image_id` — the legacy behaviour) and
 * its failure split, unchanged. The dry run uploads it too, step 11's documented
 * exception. A skipped photo comes back as `imageId: null` with the resolver's
 * own `falha`, and the PLAN refuses the publish on `size_chart_info` — never on
 * `image`, and before any listing write (Lucas's Q1c). Anything the resolver
 * propagates (a rate limit, a Firestore error) fails the publish here, as for
 * the item pass.
 */
async function resolverFotoDaTabelaDeMedidas(
  contexto: ContextoPublicacao,
  resolvedor: ResolvedorDeImagensShopee,
): Promise<FotoDaTabelaDeMedidas | null> {
  const decisao = resolverTabelaDeMedidasDoAnuncio(
    contexto.tabelaDeMedidas,
    categoriaDoAnuncio(contexto.link, contexto.categoryId),
    contexto.limites.limites.sizeChartLimit,
  );
  if (decisao.fonte.tipo !== FONTE_TABELA_MEDIDAS.foto) return null;
  const resultado = await resolvedor.resolver([decisao.fonte.foto], { cap: 1 });
  const imageId = resultado.imageIds[0] ?? null;
  return { imageId, falha: imageId === null ? (resultado.falhas[0] ?? null) : null };
}

/**
 * Which variante of `grupoId` one child occupies, from its fake paths.
 * Exported for step 19's kit arm (each kit model's tier option).
 */
export function varianteDoFilhoNoGrupo(filho: FilhoParaPublicar, grupoId: string): string | null {
  for (const caminho of filho.variacoesUid) {
    const parsed = parseFakePath(caminho);
    if (parsed !== null && parsed.grupoId === grupoId) return parsed.varianteId;
  }
  return null;
}

/**
 * The tier-1 option images — ALL-OR-NONE, and keyed by variante IDENTITY.
 *
 * Every picture is located BEFORE the first upload, so a variante with no
 * picture costs zero calls. The map's key is `varianteFakePath(grupoId,
 * varianteId)`, not a position, so it survives the tier re-ordering a fresh
 * `get_model_list` may impose; `montarTiers` re-applies all-or-none defensively,
 * so a partial map yields no image on any option.
 *
 * ⚠️ The tier-1 grupo is chosen from the CREATE order (`ordenarTiers` with no
 * live tree), because `preparar` reads no `get_model_list`. On a republish whose
 * live tree puts a different grupo first, the uploaded ids simply go unused —
 * the cost is an upload, paid once, since every id lands in
 * `arquivos.externalIds`.
 */
async function resolverImagensDeOpcao(
  contexto: ContextoPublicacao,
  resolvedor: ResolvedorDeImagensShopee,
): Promise<ReadonlyMap<string, string> | null> {
  if (contexto.filhos.length === 0) return null;
  const [tier1] = ordenarTiers(contexto.grupos, null);
  if (tier1 === undefined || !tier1.permiteFotos) return null;

  const pares: { readonly chave: string; readonly foto: Foto }[] = [];
  for (const variante of tier1.variacoes) {
    const usada = contexto.filhos.some(
      (f) => varianteDoFilhoNoGrupo(f, tier1.grupoId) === variante.varianteId,
    );
    if (!usada) continue;
    const foto = fotoDaOpcaoDeTier(
      variante,
      tier1.grupoId,
      contexto.filhos,
      contexto.produto.fotos,
    );
    // ALL-OR-NONE, decided before anything is sent.
    if (foto === null) return null;
    pares.push({ chave: varianteFakePath(tier1.grupoId, variante.varianteId), foto });
  }
  if (pares.length === 0) return null;

  const mapa = new Map<string, string>();
  for (const par of pares) {
    const resultado = await resolvedor.resolver([par.foto], { cap: 1 });
    const imageId = resultado.imageIds[0] ?? null;
    if (imageId === null) return null;
    mapa.set(par.chave, imageId);
  }
  return mapa;
}

/* -------------------------------------------------------------------------- */
/*                         the item write + the C13 retry                      */
/* -------------------------------------------------------------------------- */

/** What one item write answered, plus what it cost and what it gave up. */
interface EnvioDeItem {
  readonly resposta: ShopeeItemWriteResponse;
  readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  readonly chamadas: number;
}

/** A body with the BR fiscal block removed — the retry's whole mechanism. */
function semBlocoFiscal<B extends { readonly tax_info?: ShopeeTaxInfoRequest }>(
  corpo: B,
): Omit<B, 'tax_info'> {
  const { tax_info: _descartado, ...resto } = corpo;
  return resto;
}

/**
 * Is this the BR all-or-nothing refusal, on a body that HAD the block?
 *
 * ⚠️ The four conditions are the whole bound (C13). The last one — the body
 * still carrying a `tax_info` key — is what makes the retry **bounded by
 * CONSTRUCTION**: the retried body has no such key, so the identical refusal
 * cannot be retried a second time. A counter would be a second mechanism able to
 * disagree with the first.
 */
function ehRecusaDoBlocoFiscal(
  err: unknown,
  corpo: { readonly tax_info?: ShopeeTaxInfoRequest },
): err is ShopeeApiError {
  if (!(err instanceof ShopeeApiError)) return false;
  // The ONE prefix stripper lives in the package; both spellings of the code are
  // real and Shopee prints them on the same page.
  const nu = shopeeCodeSemPrefixoDeModulo(err.code);
  if (err.code !== 'error_param' && nu !== 'error_param') return false;
  if (!err.message.includes(FRASE_TAX_INFO_INCOMPLETO)) return false;
  return corpo.tax_info !== undefined;
}

/**
 * Send the item body, retrying ONCE without `tax_info` on the BR
 * all-or-nothing refusal (C13, frozen).
 *
 * The retry omits the WHOLE key — never a modified block: Shopee's BR fiscal
 * block is all-or-nothing, so a partial one is a second refusal and a repaired
 * one is a guess about the seller's own fiscal configuration.
 */
async function enviarItemComRetentativaFiscal<
  B extends { readonly tax_info?: ShopeeTaxInfoRequest },
>(
  enviar: (corpo: B | Omit<B, 'tax_info'>) => Promise<ShopeeItemWriteResponse>,
  corpo: B,
  alvo: { readonly produtoId: string; readonly etapa: EtapaPublicacao },
): Promise<EnvioDeItem> {
  try {
    return { resposta: await enviar(corpo), taxInfoOmitido: null, chamadas: 1 };
  } catch (err) {
    if (!ehRecusaDoBlocoFiscal(err, corpo)) throw err;
    console.warn('[shopee/anuncios] tax_info recusado; reenviando sem o bloco', {
      produtoId: alvo.produtoId,
      etapa: alvo.etapa,
    });
    return {
      resposta: await enviar(semBlocoFiscal(corpo)),
      taxInfoOmitido: MOTIVO_TAX_INFO_OMITIDO.recusadoIncompleto,
      chamadas: 2,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                               the write-backs                               */
/* -------------------------------------------------------------------------- */

type CorpoDeItem = ShopeeAddItemRequest | ShopeeUpdateItemRequest;

/**
 * Write-back #1 — the §2.4 field set, AS SENT, the instant Shopee confirms.
 *
 * `merge`/`add` through `aplicarLinkDaListagem`, never `mergeIfExists`:
 * `ultimaPublicacao` is a NESTED object and `mergeIfExists` is `update()`, which
 * throws on one (C15) — and a first publish must CREATE the document anyway.
 *
 * ⚠️ `publicadoEm` is written on the FIRST success only. A republish leaves the
 * stored value alone, so the field keeps meaning "when this listing first went
 * out" rather than "when it was last touched" — `ultimaPublicacao.em` is that.
 *
 * ⚠️ On a DRAFT's create (#1911, `reserva` non-null) this is the tier-1 CLAIM
 * of `reservaRascunho.ts` instead of the plain merge, and the field set is
 * re-derived from the document each attempt reads — never the `armazenado`
 * read before the send. Every other target keeps the plain merge/add above,
 * byte for byte.
 */
async function escreverWriteBack1(
  deps: PublicarAnuncioDeps,
  args: {
    readonly produtoId: string;
    readonly linkDocId: string | null;
    readonly armazenado: Record<string, unknown>;
    readonly itemId: number;
    readonly corpo: CorpoDeItem;
    readonly etapa: EtapaPublicacao;
    readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  },
  reserva: ReservaDeRascunhoShopee | null,
): Promise<string> {
  const montar = (armazenado: Record<string, unknown>): Record<string, unknown> =>
    dadosDoWriteBack1(deps, args, armazenado);

  if (reserva !== null) {
    const linkDocId = await reivindicarRascunhoShopee(
      deps.db,
      { produtoId: args.produtoId, linkDocId: reserva.linkDocId, itemId: args.itemId },
      montar,
    );
    // Claimed (or forked onto a fresh link): the lock is no longer ours to touch.
    reserva.fase = 'encerrada';
    return linkDocId;
  }

  return await aplicarLinkDaListagem(deps.db, args.produtoId, {
    acao: args.linkDocId === null ? 'add' : 'merge',
    docId: args.linkDocId,
    dados: montar(args.armazenado),
  });
}

/** Write-back #1's field set — §2.4's, AS SENT — over one reading of the link. */
function dadosDoWriteBack1(
  deps: PublicarAnuncioDeps,
  args: {
    readonly itemId: number;
    readonly corpo: CorpoDeItem;
    readonly etapa: EtapaPublicacao;
    readonly taxInfoOmitido: MotivoTaxInfoOmitido | null;
  },
  armazenado: Record<string, unknown>,
): Record<string, unknown> {
  const { corpo } = args;
  return {
    // Always canonical, never the stored value — the conta filter every reader
    // applies is this field.
    contaProdutoShopeeOuterRef: toOuterRef(integracaoCollection.docPath({}, deps.integracaoId)),
    item_id: args.itemId,
    ...(corpo.item_name === undefined ? {} : { item_name: corpo.item_name }),
    ...(corpo.description === undefined ? {} : { description: corpo.description }),
    ...(corpo.category_id === undefined ? {} : { category_id: corpo.category_id }),
    ...(corpo.condition === undefined ? {} : { condition: corpo.condition }),
    ...(corpo.attribute_list === undefined ? {} : { attributes: corpo.attribute_list }),
    ...(corpo.logistic_info === undefined ? {} : { logistic_info: corpo.logistic_info }),
    ...(corpo.brand === undefined ? {} : { brand_id: corpo.brand.brand_id }),
    taxInfoOmitido: args.taxInfoOmitido,
    ultimaPublicacao: { em: deps.nowMs, etapa: args.etapa, itemId: args.itemId },
    ultimaModificacao: deps.nowMs,
    ...(numeroOuNull(armazenado.publicadoEm) === null ? { publicadoEm: deps.nowMs } : {}),
    ...(numeroOuNull(armazenado.dataCadastro) === null ? { dataCadastro: deps.nowMs } : {}),
  };
}

/**
 * Write-back #2 — everything that comes from the READ-BACK, and nothing else.
 *
 * ⚠️ Every value here was READ from `get_item_base_info` (O5). `item_status` in
 * particular is never the request's and never the echo's: the probe measured
 * `update_item` echoing a stale status while the read-back answered the live one.
 *
 * Step 19 (R-1): `kitNativo` is written here too, as `ehKitDe` of the very row
 * just read — the rule every `kitNativo` writer follows (step 9's import, this
 * write-back, the kit arm's read-back), so a step-11 link no longer stays
 * `null` for ever. An ordinary listing stores `false`, which is DATA: steps 12
 * and 13 read it as "not a native kit" exactly as they read an absent one.
 */
async function escreverWriteBack2(
  deps: PublicarAnuncioDeps,
  args: {
    readonly produtoId: string;
    readonly linkDocId: string;
    readonly item: ItemLido;
    readonly estado: EstadoAnuncioShopee;
    readonly deboost: boolean;
  },
): Promise<void> {
  const base = args.item.base;
  await aplicarLinkDaListagem(deps.db, args.produtoId, {
    acao: 'merge',
    docId: args.linkDocId,
    dados: {
      item_status: itemStatusDeLink(args.item),
      estadoAnuncio: args.estado,
      deboost: args.deboost,
      original_brand_name: base.brand?.original_brand_name ?? null,
      logistic_info: base.logistic_info,
      kitNativo: ehKitDe(base),
      // A publish that got this far SUCCEEDED; leaving the last failure standing
      // would make the operator's panel lie about the current state.
      falhaPublicacao: null,
      ultimaModificacao: deps.nowMs,
    },
  });
}

/**
 * The failure stamp — and it stamps only once WRITES HAVE BEGUN.
 *
 * Its `linkDocId === null` branch (nothing to stamp, nothing created: a link
 * that does not exist cannot be a ghost, and an invented one would record a
 * listing that was never made) is a DEFENSIVE guard for a plan with no link,
 * reached only by a direct `aplicarPublicacao` call. Since #1911 P5 no LIVE
 * entry reaches `add_item` without a link document: a create with no link
 * first mints its draft (`nomearCriacaoSemVinculo`), and a DRAFT's failed
 * create is never stamped here — `nao-criado` is stamped by the token-guarded
 * release (`liberarTravaShopee`), `incerto` is not stamped at all (the 202).
 *
 * ⚠️ A failure of the stamp itself is NOT caught. Swallowing it would need
 * exactly the generic catch root `CLAUDE.md` rule 6 bans, and the two things
 * that can fail it — a Firestore outage and a patch that does not validate — are
 * both worth surfacing on their own.
 */
/**
 * The problemas the stamp stores — the ERROR'S OWN list whenever it has one.
 *
 * ⚠️ `problemasDeErroShopee` answers `[]` for anything that is not a
 * `ShopeeApiError`, and the two classes that already CARRY a populated list are
 * exactly those two: the re-list refusal (`relistar`, both doors refusing) and a
 * block raised from the FRESH tree by the model leg. Reading only the classifier
 * made the stamp contradict its own `mensagem` — "1 problema" beside an empty
 * `problemas[]` — and dropped the only text that names WHICH field or which tier
 * position failed, which is all the operator has to act on.
 */
function problemasDaFalha(err: ShopeeError): readonly ProblemaPublicacao[] {
  if (err instanceof ShopeePublishRejectedError) return err.problemas;
  if (err instanceof ShopeePublishBlockedError) return err.problemas;
  return problemasDeErroShopee(err);
}

/**
 * What the stamp's `erro` field carries: Shopee's own code whenever there is
 * one, so the row can be looked up and grouped by it, and the class name only
 * when the failure is ours. ⚠️ A `ShopeePublishRejectedError` HAS the code — in
 * `shopeeCode` — and storing its class name instead left the code reachable only
 * by reading the `mensagem` prose.
 */
function codigoDaFalha(err: ShopeeError): string {
  if (err instanceof ShopeeApiError) return err.code;
  if (err instanceof ShopeePublishRejectedError) return err.shopeeCode;
  return err.name;
}

async function carimbarFalhaDePublicacao(
  deps: PublicarAnuncioDeps,
  args: DadosDaFalha & { readonly produtoId: string; readonly linkDocId: string | null },
): Promise<void> {
  if (args.linkDocId === null) {
    console.warn('[shopee/anuncios] falha antes de qualquer vínculo; nada a carimbar', {
      produtoId: args.produtoId,
      etapa: args.etapa,
      erro: args.erro,
    });
    return;
  }
  await aplicarLinkDaListagem(deps.db, args.produtoId, {
    acao: 'merge',
    docId: args.linkDocId,
    dados: carimboDaFalha(deps, args),
  });
}

/** What one failure stamp says. */
interface DadosDaFalha {
  readonly itemId: number | null;
  readonly etapa: EtapaPublicacao;
  readonly erro: string;
  readonly mensagem: string;
  readonly problemas: readonly ProblemaPublicacao[];
}

/**
 * The stamp's patch — ONE builder for both writers of it: the plain merge
 * above, and the token-guarded release of a draft's lock (#1911), which lands
 * this same patch together with `publicacaoEmCurso: null` or not at all.
 */
function carimboDaFalha(deps: PublicarAnuncioDeps, args: DadosDaFalha): Record<string, unknown> {
  return {
    falhaPublicacao: {
      em: deps.nowMs,
      etapa: args.etapa,
      erro: args.erro,
      mensagem: limitarMensagemProblema(args.mensagem),
      // ⚠️ `campo` is a REQUIRED non-nullable string on the link schema while a
      // problema's is `string | null`, so a field-less refusal stores `''`.
      // The information the operator acts on is `mensagem`, which is kept whole.
      problemas: args.problemas.map((p) => ({
        campo: p.campo ?? '',
        motivo: p.motivo,
        mensagem: p.mensagem,
      })),
    },
    ultimaModificacao: deps.nowMs,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 relistagem                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ONE refusal that earns the second door.
 *
 * ⚠️ `pausarAnuncio.ts` holds a private twin of this token for its own
 * `reativar` fallback. Neither module exports it, and de-duplicating them is one
 * import in a later pass — recorded rather than silently duplicated.
 */
const TOKEN_RELISTAGEM_RECUSADA = 'error_set_normal_unlisted_item';

/** A bare Shopee code at the START of a refusal sentence. */
const RE_CODIGO_ANCORADO = /^error_[a-z0-9_]*/;

/**
 * The code inside a `failure_list[].failed_reason`, which is a SENTENCE
 * embedding one.
 *
 * `''` when the sentence names none: `shopeeCode` is a CODE field and inventing
 * a plausible-looking one would be worse than saying Shopee gave us none. The
 * prose still reaches the operator through the problema's `mensagem`.
 */
function codigoDaRecusa(reason: string | null | undefined): string {
  const bruto = (reason ?? '').trim();
  if (bruto === '') return '';
  const semPrefixo = shopeeCodeSemPrefixoDeModulo(bruto) ?? bruto;
  return RE_CODIGO_ANCORADO.exec(semPrefixo)?.[0] ?? '';
}

/**
 * ⚠️ A **substring** test, because `failed_reason` is a SENTENCE embedding the
 * code token, and over the prefix-STRIPPED text, because Shopee prints
 * `error_param` and `product.error_param` on the same page.
 */
function ehRelistagemRecusada(texto: string | null | undefined): boolean {
  if (typeof texto !== 'string') return false;
  const semPrefixo = shopeeCodeSemPrefixoDeModulo(texto) ?? texto;
  return semPrefixo.includes(TOKEN_RELISTAGEM_RECUSADA);
}

/** One door's verdict. */
type VerdictoDaPorta =
  | { readonly kind: 'ok'; readonly aviso: string | null }
  | {
      readonly kind: 'recusada';
      readonly codigo: string;
      readonly mensagem: string;
      readonly outraPorta: boolean;
    };

/**
 * `unlist_item { unlist: false }` — the documented re-list (`guide 221 §6`), and
 * the probe confirmed it re-lists a seller-created `UNLIST`.
 *
 * ⚠️ Per-entry verdicts are DATA: a valid request answers 200 even when the
 * entry was refused, so `failure_list` is read rather than "no throw" being
 * taken for success. A whole-call failure propagates untouched — the applier
 * stamps it — EXCEPT an envelope error that classifies as the re-list refusal,
 * which is that refusal for every id of the call and therefore earns the second
 * door.
 */
async function portaUnlist(client: ShopeeClient, itemId: number): Promise<VerdictoDaPorta> {
  try {
    const res = await client.unlistItem({ item_list: [{ item_id: itemId, unlist: false }] });
    const aviso = avisoDeShopee(res.warning);
    if (res.response.success_list.some((l) => l.item_id === itemId)) return { kind: 'ok', aviso };
    const recusa = res.response.failure_list.find((l) => l.item_id === itemId);
    const reason = recusa?.failed_reason ?? null;
    return {
      kind: 'recusada',
      codigo: codigoDaRecusa(reason),
      mensagem:
        reason ?? 'unlist_item não reportou este item_id nem em success_list nem em failure_list.',
      outraPorta: ehRelistagemRecusada(reason),
    };
  } catch (err) {
    // ⚠️ `ShopeeRateLimitError` EXTENDS `ShopeeApiError`, so it is excluded
    // explicitly: a burst limit is a transient the caller must see, never a
    // per-entry refusal.
    if (err instanceof ShopeeApiError && !(err instanceof ShopeeRateLimitError)) {
      if (ehRelistagemRecusada(err.code)) {
        return { kind: 'recusada', codigo: err.code, mensagem: err.message, outraPorta: true };
      }
    }
    throw err;
  }
}

/**
 * `update_item { item_id, item_status: 'NORMAL' }` — the fallback door, and the
 * ONLY `item_status` this module ever sends.
 *
 * ⚠️ The body carries **nothing else**: a status bundled with other fields is
 * silently ignored on some listings.
 */
async function portaUpdateItem(client: ShopeeClient, itemId: number): Promise<VerdictoDaPorta> {
  try {
    const res = await client.updateItem({
      item_id: itemId,
      item_status: SHOPEE_ITEM_STATUS_WRITABLE.normal,
    });
    return { kind: 'ok', aviso: avisoDeShopee(res.warning) };
  } catch (err) {
    if (err instanceof ShopeeApiError && !(err instanceof ShopeeRateLimitError)) {
      if (ehRelistagemRecusada(err.code)) {
        return { kind: 'recusada', codigo: err.code, mensagem: err.message, outraPorta: true };
      }
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   aplicar                                   */
/* -------------------------------------------------------------------------- */

/** Every etapa that is ALSO the trailing segment of a Shopee API path. */
const ETAPAS_QUE_SAO_OPERACOES: ReadonlySet<string> = new Set<string>(
  Object.values(ETAPA_PUBLICACAO),
);

/**
 * Which call a Shopee failure happened at, from the error's OWN path.
 *
 * ⚠️ Consulted for the tier/model leg ALONE, and that is the point:
 * `aplicarModelos` owns FIVE calls and answers one result, so the applier cannot
 * know which of them refused — while `err.path` does, and it is a string this
 * repo builds. Every other step is one call, so the applier's own cursor is
 * already exact; refining those would MIS-attribute the re-list fallback (whose
 * path segment is `update_item`) to the item write.
 *
 * A segment that is not an etapa member (`unlist_item`, `get_item_base_info`)
 * keeps the fallback.
 */
function etapaDaFalha(err: unknown, fallback: EtapaPublicacao): EtapaPublicacao {
  if (!(err instanceof ShopeeApiError)) return fallback;
  const segmento =
    err.path
      .split('/')
      .filter((s) => s.length > 0)
      .at(-1) ?? '';
  return ETAPAS_QUE_SAO_OPERACOES.has(segmento) ? (segmento as EtapaPublicacao) : fallback;
}

/** Collects the first non-noise envelope `warning` of a publish, in call order. */
class ColetorDeAviso {
  private primeiro: { readonly aviso: string; readonly etapa: EtapaPublicacao } | null = null;

  juntar(
    aviso: string | null,
    etapa: EtapaPublicacao,
    alvo: { produtoId: string; itemId: number | null },
  ): void {
    if (aviso === null || this.primeiro !== null) return;
    this.primeiro = { aviso, etapa };
    // ⚠️ The ETAPA and the ids only. An envelope `warning` is provider prose and
    // a log line in this app carries ids, counts, enum tokens and booleans — the
    // string itself reaches the operator through the RESULT.
    console.warn('[shopee/anuncios] a Shopee respondeu um warning na publicação', {
      produtoId: alvo.produtoId,
      itemId: alvo.itemId,
      etapa,
    });
  }

  valor(): string | null {
    return this.primeiro?.aviso ?? null;
  }
}

/**
 * Execute one plan, in EXACTLY the reconciler's §2.4 order.
 *
 *  1. the pictures — already resolved into the plan (`planoPublicacao.ts`'s
 *     header says why the upload precedes the plan);
 *  2. `add_item` | `update_item`, with the C13 one-shot fiscal retry;
 *  3. **parent write-back #1**, the instant Shopee confirms;
 *  4. `esperar(ESPERA_APOS_ADD_ITEM_MS)` — a create WITH children only;
 *  5–8. `aplicarModelos` (the fresh `get_model_list`, the tier/model writes, the
 *     reconciliation read and the child links);
 *  9. the re-list dance;
 * 10. the read-back through `lerAnuncioShopee`;
 * 11. **parent write-back #2**, from the read-back alone.
 *
 * ⚠️ The order is not a style: the wait exists because `init_tier_variation`
 * right after `add_item` fails on a listing Shopee has not finished indexing,
 * and write-back #1 precedes the tier leg because that is what makes a failure
 * in the tier leg RESUMABLE.
 *
 * ⚠️ **The PLAN is the whole input**, and the `ContextoPublicacao` §2.4 sketches
 * as a third parameter is deliberately not taken: everything the applier needs
 * is already on the plan, and a second graph beside it is a second source of
 * truth for values the plan states — exactly what "the plan as DATA" exists to
 * prevent. The three write-time facts that are NOT on the plan
 * (`publicadoEm`/`dataCadastro` first-time and the stored violation count) are
 * read from the link document itself, which is fresher than any context.
 *
 * ⚠️ `rascunho` (#1911) is the held lock of a DRAFT's create and the live
 * controls it was taken with; `null` everywhere else, which is step 11's path
 * unchanged. With it, step 2 is preceded by the PRE-SEND re-read, every
 * `add_item` leg by the credential warm and then the synchronous send gate
 * (nothing sent yet ⇒ the error rethrown unstamped), step 3 is the CLAIM, and an
 * `add_item` failure is CLASSIFIED (`desfechoDeCriacaoDeItem`): `nao-criado` ⇒
 * the stamp and the release in ONE token-guarded write; `incerto` ⇒ no stamp,
 * the lock KEPT, the raw error rethrown — never a "Shopee refused" for a create
 * that may exist. And unless the reservation's ENSURE already searched the
 * very SKU fold the body sends
 * ({@link PublicacaoDeRascunho.skuJaBuscado}), the FIRST create's
 * same-SKU look-up runs before all of that, outside the step-2 `try` (#1911
 * P5b): its refusal is a `ShopeePublishBlockedError`, its Shopee failure
 * propagates unclassified and unstamped, and its calls count into
 * `chamadasShopee`.
 */
export async function aplicarPublicacao(
  deps: PublicarAnuncioDeps,
  plano: PlanoPublicacao,
  rascunho: PublicacaoDeRascunho | null = null,
): Promise<ResultadoPublicacao> {
  if (temProblemaDeBloqueio(plano.problemas)) {
    throw new ShopeePublishBlockedError({
      produtoId: plano.produtoId,
      itemId: plano.itemId,
      problemas: plano.problemas,
    });
  }
  // Step 18, Q1c: the tabela's photo did not upload ⇒ the publish is REFUSED
  // on `size_chart_info`, before the link read and before any listing write —
  // never published without the chart, and never retried without it. The
  // REJECTED class (etapa `fotos`), because its motivo is outside the blocked
  // vocabulary; `shopeeCode` is `''` — the resolver keeps the failure's closed
  // motivo, not a code. ⚠️ "recusada pela Shopee" only when Shopee refused the
  // upload: the same predicate the plan chose the problema's sentence with.
  if (plano.recusaTabelaDeMedidas !== null) {
    throw new ShopeePublishRejectedError({
      etapa: ETAPA_PUBLICACAO.fotos,
      shopeeCode: '',
      produtoId: plano.produtoId,
      itemId: plano.itemId,
      problemas: [plano.recusaTabelaDeMedidas],
      recusadaPelaShopee: fotoDaTabelaRecusadaPelaShopee(plano.fotos.tabelaDeMedidas),
    });
  }

  const produtoId = plano.produtoId;
  const avisos = new ColetorDeAviso();
  let etapa: EtapaPublicacao = plano.ehAtualizacao
    ? ETAPA_PUBLICACAO.updateItem
    : ETAPA_PUBLICACAO.addItem;
  let linkDocId = plano.linkDocId;
  let itemId = plano.itemId;
  let chamadasShopee = 0;

  // Read BEFORE the first write: the "first publish only" fields and the
  // violation count are decided from the document as it stands right now.
  const armazenado = await lerLinkArmazenado(deps.db, produtoId, linkDocId);

  // ⚠️ A DRAFT's `add_item` is sent ONLY under its lock (#1911 batch-A
  // review). A create planned onto a named link that reads as a draft (a gone
  // document reads so too) with no reservation in hand reached here unlocked —
  // step 11's lexical resolver picking a draft another run just minted — and
  // would send a second `add_item` beside that run's. Refused with NOTHING
  // written or sent; the ONE predicate on the raw document, never on
  // `linkDocId` alone (a corrupt `item_id: 0` link is no draft and goes on).
  if (!plano.ehAtualizacao && rascunho === null && linkDocId !== null) {
    if (ehRascunhoShopee(armazenado)) throw rascunhoSemTrava(linkDocId);
  }

  // ⚠️ #1911 P5b (Lucas, 2026-10-26): a `livre` draft's FIRST create looks
  // for a listing the conta already holds with the SKU this body SENDS —
  // unlinked ⇒ "importe-o", another produto's ⇒ one SKU per produto,
  // incomplete ⇒ nothing created — the kit arm's same-SKU scan mirrored.
  // Under the lock, after D15, BEFORE the `try`: a refusal is a blocked
  // refusal with nothing sent, and a scan's Shopee failure propagates
  // untouched — never classified as an `add_item` outcome nor stamped (the
  // caller hands the lock back, `fase` still `travada`). Skipped ONLY when
  // this run's ENSURE already searched the very fold the body sends: the
  // produto is read again after the reservation, and a SKU renamed in
  // between was never looked up (batch-A review, rule 7).
  if (
    !plano.ehAtualizacao &&
    rascunho !== null &&
    skuDaBuscaShopee(plano.item.criar.item_sku) !== rascunho.skuJaBuscado
  ) {
    // ⚠️ Under the send gate's deadline (batch-A review): on a shop of
    // thousands of listings the walk can outlive the request, and a run the
    // platform cuts there leaves its lock UNSTAMPED. It stops before its next
    // Shopee read instead — 409 `PUBLICACAO_EXPIRADA`, nothing decided, the
    // lock handed back by `publicarAnuncioShopee`'s catch (`fase` `travada`).
    const verificacao = await buscaNoPrazoDoEnvio(
      rascunho.reserva.linkDocId,
      rascunho.reserva,
      rascunho.controles,
      (podeContinuar) =>
        verificarAnuncioExistenteShopee(deps.client, deps.db, {
          integracaoId: deps.integracaoId,
          produtoId,
          itemSku: plano.item.criar.item_sku,
          podeContinuar,
        }),
    );
    chamadasShopee += verificacao.chamadas;
    if (temProblemaDeBloqueio(verificacao.problemas)) {
      throw new ShopeePublishBlockedError({
        produtoId,
        itemId: null,
        problemas: verificacao.problemas,
      });
    }
  }

  try {
    /* ---- (2) the item write. -------------------------------------------- */
    // A DRAFT's create: the lock must still be OURS immediately before the
    // send — and the SKU the body sends is STAMPED on it there, so a look-up
    // of an uncertain create compares against what was SENT (batch-A review);
    // its `expiraEm` is what every leg's gate measures against.
    const envio = await enviarItem(
      deps,
      plano,
      rascunho === null
        ? null
        : {
            ...rascunho,
            trava: await conferirTravaAntesDoEnvio(
              deps.db,
              rascunho.reserva,
              skuDaBuscaShopee(plano.item.criar.item_sku),
            ),
          },
    );
    chamadasShopee += envio.chamadas;
    const corpo = envio.corpo;
    // ⚠️ The echo's `item_id` is an IDENTIFIER, not state — the one thing this
    // module ever takes from a write response (O5).
    itemId = plano.ehAtualizacao ? plano.itemId : envio.resposta.response.item_id;
    if (itemId === null || !Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new Error(
        `publicarAnuncioShopee: a Shopee confirmou a escrita do produto ${produtoId} sem um ` +
          `item_id utilizável (${JSON.stringify(envio.resposta.response.item_id)}).`,
      );
    }
    const taxInfoOmitido = envio.taxInfoOmitido ?? plano.taxInfoOmitido;
    avisos.juntar(avisoDeShopee(envio.resposta.warning), etapa, { produtoId, itemId });

    /* ---- (3) write-back #1 — a CLAIM on a draft. ------------------------ */
    linkDocId = await escreverWriteBack1(
      deps,
      { produtoId, linkDocId, armazenado, itemId, corpo, etapa, taxInfoOmitido },
      rascunho?.reserva ?? null,
    );

    /* ---- (4) the wait — exactly when the plan says so. ------------------ */
    if (plano.passos.some((p) => p.tipo === 'esperar')) {
      await deps.esperar(ESPERA_APOS_ADD_ITEM_MS);
    }

    /* ---- (5-8) the tier/model leg, in ONE call. ------------------------- */
    etapa = ETAPA_PUBLICACAO.getModelList;
    const modelos = await aplicarModelos(deps, plano, itemId, linkDocId);
    // Every step of that leg IS one Shopee call — the derivation is the leg's
    // own `passos`, never a second count here.
    chamadasShopee += modelos.passos.length;
    for (const aviso of modelos.avisos) {
      avisos.juntar(aviso, ETAPA_PUBLICACAO.initTierVariation, { produtoId, itemId });
    }

    /* ---- (9) the re-list dance. ---------------------------------------- */
    etapa = ETAPA_PUBLICACAO.relistagem;
    const relistagem =
      plano.relistagem === null
        ? null
        : await relistar(deps, plano.relistagem, { produtoId, itemId }, avisos);
    if (relistagem !== null) chamadasShopee += relistagem.chamadas;

    /* ---- (10) the read-back — the ONLY state source. -------------------- */
    etapa = ETAPA_PUBLICACAO.leituraDeVolta;
    const leitura = await lerDeVolta(deps, itemId);
    chamadasShopee += leitura.chamadas;

    /* ---- (11) write-back #2 + the aviso resolver. ----------------------- */
    let estadoAnuncio: EstadoAnuncioShopee | null = null;
    let itemStatus: string | null = null;
    let deboost = false;
    let avisoResolvido = false;
    if (leitura.item !== null) {
      itemStatus = itemStatusDe(leitura.item);
      const fold = estadoDoAnuncio(
        {
          kind: 'lido',
          itemStatus,
          deboost: leitura.item.base.deboost,
          agendadoParaMs: agendadoParaMsDe(leitura.item.base.scheduled_publish_time),
        },
        deps.nowMs,
      );
      estadoAnuncio = fold.estado;
      deboost = fold.deboost;
      await escreverWriteBack2(deps, {
        produtoId,
        linkDocId,
        item: leitura.item,
        estado: fold.estado,
        deboost: fold.deboost,
      });

      // ⚠️ The publisher makes no `get_item_violation_info` call, so "no
      // violations" is the STORED reading — the strongest signal it holds. The
      // resolver answers a TRANSITION, so a produto with no open aviso simply
      // answers `false`.
      const normalizado =
        itemStatus === SHOPEE_ITEM_STATUS.normal &&
        !fold.deboost &&
        violacoesArmazenadas(armazenado) === 0;
      avisoResolvido = normalizado
        ? await resolverAvisoDeAnuncio(
            deps.db,
            { integracaoId: deps.integracaoId, produtoId },
            MOTIVO_RESOLUCAO_ANUNCIO.normalizado,
            { nowMs: deps.nowMs },
          )
        : false;
    }

    const resultado: ResultadoPublicacao = {
      plano,
      produtoId,
      itemId,
      linkDocId,
      ehAtualizacao: plano.ehAtualizacao,
      estadoAnuncio,
      itemStatus,
      deboost,
      avisoShopee: avisos.valor(),
      modelos,
      fotos: plano.fotos.resumo,
      falhasDeFoto: plano.falhasDeFoto,
      taxInfoOmitido,
      relistagem: relistagem?.porta ?? null,
      avisoResolvido,
      leituraDeVolta: leitura.item !== null,
      tabelaDeMedidas: tabelaDeMedidasDaPublicacao(plano.item.tabelaDeMedidas, leitura.item),
      chamadasShopee,
    };
    registrarPublicacao(deps, resultado);
    return resultado;
  } catch (err) {
    // A DRAFT whose lock is still `travada` sent NOTHING (#1911): the pre-send
    // re-read, the credential warm or a gate stopped it before `add_item`. The
    // caller's catch hands the lock back, unstamped — and a Shopee error here
    // (the warm's token refresh) is about the TOKEN, never about the listing,
    // so it must not reach the plain stamp below, which is not token-guarded.
    if (rascunho !== null && rascunho.reserva.fase === 'travada') throw err;
    // A DRAFT's `add_item` failed with something that is not a Shopee answer
    // (#1911): the classifier owns it. The app's token step never left this
    // process — nothing is outstanding, so the caller's catch hands the lock
    // back, unstamped. Any other such error is OURS: the classifier rethrows it
    // and the lock is KEPT (it expires into `incerta`).
    if (
      rascunho !== null &&
      rascunho.reserva.fase === 'enviando' &&
      !(err instanceof ShopeeError) &&
      desfechoDeCriacaoDeItem(err) === 'nao-criado'
    ) {
      rascunho.reserva.fase = 'travada';
      throw err;
    }
    // ⚠️ The BASE class, and it is safe here for one reason: nothing is
    // swallowed. Every error rethrows; the narrow decides only whether a
    // `falhaPublicacao` stamp is worth writing, and a failure Shopee reported is
    // exactly the class an operator's panel has to show. A Firestore error is
    // NOT one — it would most likely fail the stamp too.
    if (err instanceof ShopeeError) {
      const problemas = problemasDaFalha(err);
      // The model leg is the ONE step whose exact call the applier cannot know;
      // everywhere else the cursor already is the call.
      const etapaReal = etapa === ETAPA_PUBLICACAO.getModelList ? etapaDaFalha(err, etapa) : etapa;
      const falha: DadosDaFalha = {
        itemId,
        etapa: etapaReal,
        erro: codigoDaFalha(err),
        mensagem: err.message,
        problemas,
      };
      if (rascunho !== null && rascunho.reserva.fase === 'enviando') {
        const { reserva } = rascunho;
        // A DRAFT's `add_item` failed (#1911): only the classifier may say
        // nothing was created. `incerto` ⇒ NO stamp (never "falhou" for a
        // listing that may exist): the lock KEPT live for the wait and the
        // attempt RECORDED in one token-guarded write, then the 202 — the next
        // publish waits, then looks for the listing before any new `add_item`.
        if (desfechoDeCriacaoDeItem(err) === 'incerto') {
          const aguardarMs = await registrarCriacaoIncerta(deps.db, reserva, rascunho.controles);
          // The same fold the re-send's look-up will run on the produto's SKU —
          // the body sent it iff it was usable.
          const reenvioVerificaSku = skuDaBuscaShopee(plano.item.criar.item_sku) !== '';
          console.warn(
            '[shopee/anuncios] add_item do rascunho com desfecho INCERTO; trava mantida',
            {
              produtoId,
              linkDocId: reserva.linkDocId,
              erro: falha.erro,
              aguardarMs,
              reenvioVerificaSku,
            },
          );
          throw new CriacaoDeAnuncioIncertaError(
            {
              produtoId,
              linkDocId: reserva.linkDocId,
              aguardarMs,
              reenvioVerificaSku,
              recusa: recusaDoAnuncioIncerto(err),
              mensagem: mensagemDoAnuncioIncerto(reenvioVerificaSku),
            },
            err,
          );
        }
        // `nao-criado`: the stamp and the release in ONE token-guarded write —
        // a lock another run holds now is never cleared nor stamped over. A
        // Firestore failure of that write never replaces Shopee's refusal
        // below (the stamp is lost with the release; the lock expires).
        await liberarTravaShopeeSemSubstituirErro(deps.db, reserva, carimboDaFalha(deps, falha));
      } else {
        await carimbarFalhaDePublicacao(deps, { ...falha, produtoId, linkDocId });
      }
      // A rate limit is excluded: it is a transient with its own HTTP mapping,
      // not a refusal of this publish.
      if (err instanceof ShopeeApiError && !(err instanceof ShopeeRateLimitError)) {
        throw new ShopeePublishRejectedError({
          etapa: etapaReal,
          // VERBATIM, module prefix and all — the prefix says which page's error
          // list to read.
          shopeeCode: err.code,
          produtoId,
          itemId,
          problemas,
        });
      }
    }
    throw err;
  }
}

/**
 * The stored parent link document, read at APPLY time.
 *
 * ⚠️ One `get`, and it is not the one `preparar` paid for: `ContextoPublicacao`
 * carries the link PROJECTION (§2.8's frozen shape), which deliberately holds
 * only the fields the ITEM mapper reads. Three write-time decisions need the
 * document itself and none of them can be derived from that projection:
 * `publicadoEm` and `dataCadastro` are "first time only" (and `publicadoEm` may
 * legitimately be absent on a link step 9 IMPORTED, which is an update with no
 * first publish of ours), and the violation count decides whether the aviso
 * resolver runs. Reading it here rather than in `preparar` also makes those
 * decisions from the freshest reading there is.
 *
 * `{}` when there is no link yet — every "first time" test then answers true.
 */
async function lerLinkArmazenado(
  db: Firestore,
  produtoId: string,
  linkDocId: string | null,
): Promise<Record<string, unknown>> {
  if (linkDocId === null) return {};
  const snap = await produtoShopeeLinkCollection.docRef(db, { produtoId }, linkDocId).get();
  return snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : {};
}

/**
 * How many violation rows the STORED link carries.
 *
 * ⚠️ The publisher makes no `get_item_violation_info` call (it is not in its
 * ownership row), so the stored list is the strongest evidence it holds. An
 * unreadable value counts as ZERO rows rather than blocking the resolver: the
 * resolver answers a TRANSITION, so at worst it closes a row a re-verify would
 * have closed anyway.
 */
function violacoesArmazenadas(raw: Record<string, unknown>): number {
  return Array.isArray(raw.violations) ? raw.violations.length : 0;
}

/**
 * A DRAFT's publish in progress (#1911): the lock this run holds and the live
 * controls it was taken with — `aplicarPublicacao`'s third parameter.
 */
export interface PublicacaoDeRascunho {
  readonly reserva: ReservaDeRascunhoShopee;
  readonly controles: ControlesDaPublicacaoAoVivo;
  /**
   * #1911 P5b: the SKU fold this run's ENSURE already searched under this
   * lock (the reservation's `skuBuscadoNaReserva`), or `null` when none was —
   * a `livre` draft, or the attested SKU-less proceed. The FIRST create's
   * same-SKU look-up (`verificarAnuncioExistenteShopee`) is skipped ONLY when
   * the planned body sends exactly this fold (Lucas, 2026-10-26: that path is
   * not scanned twice); any other body — a SKU renamed between the
   * reservation and `preparar` included (batch-A review) — is looked up.
   */
  readonly skuJaBuscado: string | null;
}

/**
 * `add_item` or `update_item`, with the body that was actually sent.
 *
 * ⚠️ On a DRAFT's create (`rascunho` non-null) EVERY `add_item` leg — the
 * fiscal retry's second one included — warms the credential, then runs the
 * synchronous send gate right before the call, and records on the reservation
 * whether a send may be
 * outstanding: each leg starts with nothing outstanding (a second leg exists
 * only after the first was refused for good, `ehRecusaDoBlocoFiscal`), is
 * `enviando` from the instant the gate passes, and `criada` once Shopee
 * answers with success.
 */
async function enviarItem(
  deps: PublicarAnuncioDeps,
  plano: PlanoPublicacao,
  rascunho: (PublicacaoDeRascunho & { readonly trava: { readonly expiraEm: number } }) | null,
): Promise<EnvioDeItem & { readonly corpo: CorpoDeItem }> {
  if (!plano.ehAtualizacao) {
    const corpo = plano.item.criar;
    const envio = await enviarItemComRetentativaFiscal(
      (c) => (rascunho === null ? deps.client.addItem(c) : enviarSobATrava(deps, rascunho, c)),
      corpo,
      { produtoId: plano.produtoId, etapa: ETAPA_PUBLICACAO.addItem },
    );
    return { ...envio, corpo: envio.taxInfoOmitido === null ? corpo : semBlocoFiscal(corpo) };
  }

  const corpo = plano.item.atualizar;
  if (corpo === null) {
    // Unreachable through `prepararPublicacao`, which only sets `ehAtualizacao`
    // when the stored `item_id` is a positive number — and that is exactly when
    // `montarAnuncio` builds the update body.
    throw new Error(
      `publicarAnuncioShopee: o plano do produto ${plano.produtoId} pede um update_item sem item_id.`,
    );
  }
  const envio = await enviarItemComRetentativaFiscal((c) => deps.client.updateItem(c), corpo, {
    produtoId: plano.produtoId,
    etapa: ETAPA_PUBLICACAO.updateItem,
  });
  return { ...envio, corpo: envio.taxInfoOmitido === null ? corpo : semBlocoFiscal(corpo) };
}

/**
 * ONE `add_item` leg of a DRAFT's create, under its lock: nothing outstanding
 * → the credential warm (`controles.aquecerCredencial`) → the synchronous gate
 * (it throws `PUBLICACAO_EXPIRADA` with nothing sent) → `enviando` → the call
 * → `criada`.
 *
 * ⚠️ The warm comes FIRST, and that order is the point (batch-A review): the
 * only await between the gate and the request is the client's own token ask
 * inside `addItem`, and a token near expiry turns that ask into a provider
 * REFRESH with no deadline. Warmed before the gate, any refresh is paid while
 * nothing is outstanding, the gate reads the clock AFTER it, and the client's
 * ask is one credential read inside `MARGEM_ENVIO_SHOPEE_MS`. A warm that
 * throws leaves `fase` at `travada`: nothing was sent, and the caller hands the
 * lock back unstamped.
 */
async function enviarSobATrava(
  deps: PublicarAnuncioDeps,
  rascunho: PublicacaoDeRascunho & { readonly trava: { readonly expiraEm: number } },
  corpo: ShopeeAddItemRequest,
): Promise<ShopeeItemWriteResponse> {
  const { reserva } = rascunho;
  reserva.fase = 'travada';
  await rascunho.controles.aquecerCredencial();
  portaoDeEnvio(reserva.linkDocId, rascunho.trava, rascunho.controles);
  reserva.fase = 'enviando';
  const resposta = await deps.client.addItem(corpo);
  reserva.fase = 'criada';
  return resposta;
}

/**
 * Walk the re-list doors in the planned order.
 *
 * `RELIST_PRIMEIRO` decides the first door and the fallback is the other one.
 * **If both refuse there is no third attempt**: there is no other re-list API
 * for a BR shop item, so the publish is REJECTED at `relistagem` with the real
 * code.
 */
async function relistar(
  deps: PublicarAnuncioDeps,
  ordem: readonly OrdemDeRelistagem[],
  alvo: { readonly produtoId: string; readonly itemId: number },
  avisos: ColetorDeAviso,
): Promise<{ readonly porta: OrdemDeRelistagem; readonly chamadas: number }> {
  let chamadas = 0;
  let ultima: { readonly codigo: string; readonly mensagem: string } | null = null;

  for (const porta of ordem) {
    chamadas += 1;
    const verdicto =
      porta === 'unlist'
        ? await portaUnlist(deps.client, alvo.itemId)
        : await portaUpdateItem(deps.client, alvo.itemId);

    if (verdicto.kind === 'ok') {
      avisos.juntar(verdicto.aviso, ETAPA_PUBLICACAO.relistagem, alvo);
      return { porta, chamadas };
    }
    ultima = { codigo: verdicto.codigo, mensagem: verdicto.mensagem };
    if (!verdicto.outraPorta) break;
  }

  throw new ShopeePublishRejectedError({
    etapa: ETAPA_PUBLICACAO.relistagem,
    shopeeCode: ultima?.codigo ?? '',
    produtoId: alvo.produtoId,
    itemId: alvo.itemId,
    problemas: ultima === null ? [] : [problemaDeErroShopee(ultima.codigo, ultima.mensagem)],
  });
}

/**
 * The read-back — it DEGRADES, and never fails a publish that landed.
 *
 * `lerAnuncioShopee` raises `ShopeeImportBlockedError(item-nao-encontrado)` when
 * Shopee answers no row. At this point the item was just created or updated, so
 * that answer is eventual consistency, not a missing listing: the applier skips
 * write-back #2 and returns with the mechanism named. Turning a landed publish
 * into a 422 would tell the operator to fix a listing that exists.
 *
 * Everything else — a rate limit, a network failure, a schema mismatch —
 * propagates and is stamped: none of those is a property of this listing.
 */
async function lerDeVolta(
  deps: PublicarAnuncioDeps,
  itemId: number,
): Promise<{ readonly item: ItemLido | null; readonly chamadas: number }> {
  try {
    const item = await lerAnuncioShopee(deps.client, itemId);
    // ⚠️ The read-back is ONE call only for a plain listing. `lerAnuncioShopee`
    // spends a SECOND — `get_kit_item_info` for a kit, `get_model_list` for an
    // item with models — and both of its predicates read fields of the row that
    // decided it, so they answer the same here as they did there. A hardcoded
    // `1` made the publisher's `chamadasShopee` incomparable with the same figure
    // in `reverificarAnuncio.ts`, which counts per call.
    return { item, chamadas: ehKitDe(item.base) || temModelosDe(item) ? 2 : 1 };
  } catch (err) {
    if (!(err instanceof ShopeeImportBlockedError)) throw err;
    console.warn('[shopee/anuncios] leitura de volta não encontrou o anúncio recém-publicado', {
      itemId,
      motivo: err.motivo,
    });
    return { item: null, chamadas: 1 };
  }
}

/**
 * `http://` or `https://` (any case) followed by at least one non-space
 * character, after an edge trim — the only `size_chart` value that counts as "a
 * chart image came back".
 */
const URL_DE_IMAGEM_LIDA = /^https?:\/\/\S/i;

/**
 * Did the read-back's `size_chart` name an image?
 *
 * ⚠️ PRESENCE of a URL, never "a non-blank string": Shopee spells absence
 * `"-"` on this very page's response sample (and on other pages' strings — the
 * package keeps it verbatim), and a blank too. Counting the placeholder as an
 * echo would make the register-267 instrument read a silently ignored image
 * chart as accepted. Equal (`true`): an `http(s)://` URL, either scheme, either
 * case, edge whitespace trimmed. Distinct (`false`): `"-"`, `''`, blanks, a bare
 * `https://`, any other scheme, a relative path.
 */
function urlDeImagemLida(url: string | null): boolean {
  return url !== null && URL_DE_IMAGEM_LIDA.test(url.trim());
}

/**
 * The size-chart half of the result: the decision the bodies were built from
 * (`plano.item`, the ONE place it lives) plus the read-back's echo.
 *
 * ⚠️ `size_chart` is a URL on the READ side; only its presence is kept.
 */
function tabelaDeMedidasDaPublicacao(
  decisao: ResultadoTabelaDeMedidasShopee,
  lido: ItemLido | null,
): TabelaDeMedidasDaPublicacao {
  return {
    sizeChartId: decisao.sizeChartId,
    fonte: decisao.fonte.tipo,
    motivo: decisao.motivo,
    fotoOmitida: decisao.fotoOmitida,
    avisoObrigatoria: decisao.avisoObrigatoria,
    // `?? null` only maps an ABSENT key; a zero-filled `0` stays `0` (data).
    lidaDeVolta: lido === null ? null : (lido.base.size_chart_id ?? null),
    fotoLidaDeVolta: lido === null ? null : urlDeImagemLida(lido.base.size_chart ?? null),
  };
}

/** ONE line per publish: ids, counts, enum tokens and booleans. */
function registrarPublicacao(deps: PublicarAnuncioDeps, r: ResultadoPublicacao): void {
  // eslint-disable-next-line no-console -- expected on every healthy publish; a warn nobody can act on is what hides the real ones
  console.info('[shopee/anuncios] publicação de anúncio', {
    integracaoId: deps.integracaoId,
    produtoId: r.produtoId,
    itemId: r.itemId,
    ehAtualizacao: r.ehAtualizacao,
    statusPedido: r.plano.statusPedido,
    statusInicial: r.plano.statusInicial,
    estadoAnuncio: r.estadoAnuncio,
    deboost: r.deboost,
    leituraDeVolta: r.leituraDeVolta,
    relistagem: r.relistagem,
    taxInfoOmitido: r.taxInfoOmitido,
    fotos: r.fotos,
    falhasDeFoto: r.falhasDeFoto.length,
    modelos: {
      acao: r.modelos.acao,
      total: r.modelos.total,
      criados: r.modelos.criados,
      repontados: r.modelos.repontados,
      atualizados: r.modelos.atualizados,
      marcados: r.modelos.marcados,
      semFilho: r.modelos.semFilho.length,
      desaparecidos: r.modelos.desaparecidos.length,
      ignorados: r.modelos.ignorados,
    },
    canaisPulados: r.plano.logistica.pulados.length,
    // A template id is not PII (brand ids are logged too); the photo's id and
    // the read-back URL never are.
    tabelaDeMedidas: {
      fonte: r.tabelaDeMedidas.fonte,
      sizeChartId: r.tabelaDeMedidas.sizeChartId,
      motivo: r.tabelaDeMedidas.motivo,
      fotoOmitida: r.tabelaDeMedidas.fotoOmitida,
      avisoObrigatoria: r.tabelaDeMedidas.avisoObrigatoria,
      lidaDeVolta: r.tabelaDeMedidas.lidaDeVolta,
      fotoLidaDeVolta: r.tabelaDeMedidas.fotoLidaDeVolta,
    },
    temAviso: r.avisoShopee !== null,
    avisoResolvido: r.avisoResolvido,
    chamadasShopee: r.chamadasShopee,
  });
}

/* -------------------------------------------------------------------------- */
/*                            publicarAnuncioShopee                            */
/* -------------------------------------------------------------------------- */

/**
 * Publish ONE produto: read, resolve the pictures, plan, then apply.
 *
 * ⚠️ A NAMED link that is a DRAFT (#1911) is reserved FIRST — before `preparar`
 * reads the content the create will send, so no edit can change it underneath
 * (`reservaRascunho.ts`). A lock refusal throws `ConflitoDeRascunhoShopeeError`
 * (the route's 409) with nothing read beyond the links and nothing sent. Any
 * throw while nothing may have reached Shopee hands the lock back, unstamped
 * (a blocked plan, a photo or taxonomy read failure, the credential warm, the
 * send gate, a lost lock) — best-effort: a failed hand-back never replaces the
 * error being thrown; every other way out is `aplicarPublicacao`'s to decide.
 *
 * ⚠️ Before that, a live create of a produto the conta holds NO link of MINTS
 * its draft ({@link nomearCriacaoSemVinculo}, K1-5) and continues named. And a
 * reservation whose ENSURE ADOPTED the earlier attempt's listing goes on as an
 * UPDATE of it (`retomandoCriacao`), lock-free. An `add_item` whose outcome
 * nobody can know throws `CriacaoDeAnuncioIncertaError` (the 202 — the lock
 * kept, the attempt recorded), which `publicarShopee` turns into a result.
 *
 * @returns `null` when this conta has nothing to publish onto (the produto does
 *   not exist, or a named `linkDocId` is not this conta's) — the route's **404**.
 *   Every refusal is a throw: `ShopeePublishBlockedError` before the first write,
 *   `ShopeePublishRejectedError` for a wire refusal after writes began; the
 *   draft route's own `RecusaDeRascunhoShopeeError` when the mint is refused.
 */
export async function publicarAnuncioShopee(
  deps: PublicarAnuncioDeps,
  entrada: EntradaDePublicacao,
): Promise<ResultadoPublicacao | null> {
  const nomeada = await nomearCriacaoSemVinculo(deps, entrada);
  const desfechoDaReserva = await reservarSeForRascunho(deps, nomeada);
  const rascunho = desfechoDaReserva.tipo === 'travada' ? desfechoDaReserva.rascunho : null;
  const alvo: EntradaDePublicacao =
    desfechoDaReserva.tipo === 'adotada' ? { ...nomeada, retomandoCriacao: true } : nomeada;

  try {
    const resolvedorDeImagens =
      deps.resolvedorDeImagens ?? criarResolvedorDePublicacao(deps, alvo.produtoId);
    const contexto = await prepararPublicacao(deps, alvo, resolvedorDeImagens);
    if (contexto === null) {
      // No error to protect here: a failed release is the ONLY answer, so it
      // propagates (the reservation is then `encerrada`, so the catch below
      // does not release a second time).
      if (rascunho !== null) await liberarTravaShopee(deps.db, rascunho.reserva);
      return null;
    }

    // ⚠️ The pictures BEFORE the plan: `montarAnuncio` needs the real `image_id[]`
    // to build a body at all, and an empty list is the `sem-fotos` REFUSAL rather
    // than an error.
    const fotos = await resolverFotosDaPublicacao(contexto);
    const plano = planejarPublicacao(contexto, fotos);
    return await aplicarPublicacao(deps, plano, rascunho);
  } catch (err) {
    // ⚠️ EVERY error is rethrown; this catch only hands a DRAFT's lock back
    // when nothing that may have reached Shopee is outstanding. Any other
    // `fase` was already decided where it happened — released with its stamp,
    // claimed, or KEPT on purpose for an outcome nobody can know. The
    // hand-back never replaces `err`: a failed release leaves the lock to
    // expire, and the operator still gets the answer they act on.
    if (rascunho !== null && rascunho.reserva.fase === 'travada') {
      await liberarTravaShopeeSemSubstituirErro(deps.db, rascunho.reserva);
    }
    throw err;
  }
}

/** What the reservation step left this publish with. */
type ReservaDaPublicacao =
  /** No lock: a republish, or a named document that is gone / not this conta's. */
  | { readonly tipo: 'nenhuma' }
  | { readonly tipo: 'travada'; readonly rascunho: PublicacaoDeRascunho }
  /** ENSURE adopted the earlier attempt's listing: an update, lock-free. */
  | { readonly tipo: 'adotada' };

/**
 * The draft lock of this publish, when it addresses one: a NAMED `linkDocId`
 * (the dispatcher reaches a draft only by name; a no-link create was named by
 * {@link nomearCriacaoSemVinculo}) whose document is a draft. `nenhuma` = no
 * lock — `prepararPublicacao` then answers a gone document exactly as before
 * (the route's 404, after its produto refusals).
 */
async function reservarSeForRascunho(
  deps: PublicarAnuncioDeps,
  entrada: EntradaDePublicacao,
): Promise<ReservaDaPublicacao> {
  const linkDocId = textoUtilizavel(entrada.linkDocId);
  if (linkDocId === null) return { tipo: 'nenhuma' };
  const desfecho = await reservarRascunhoShopee(
    deps.db,
    { integracaoId: deps.integracaoId, produtoId: entrada.produtoId, linkDocId },
    deps.aoVivo ?? null,
    // ENSURE reads Shopee with the run's own client (an `incerta` draft only).
    { client: deps.client, nowMs: deps.nowMs },
  );
  if (desfecho.tipo === 'adotada') return { tipo: 'adotada' };
  if (desfecho.tipo !== 'travada') return { tipo: 'nenhuma' };
  // `reservarRascunhoShopee` refuses a draft without the controls BEFORE any
  // write, so a reservation exists only when they do.
  if (deps.aoVivo === undefined) {
    throw new Error('[shopee/anuncios] reserva de rascunho sem deps.aoVivo');
  }
  return {
    tipo: 'travada',
    rascunho: {
      reserva: desfecho.reserva,
      controles: deps.aoVivo,
      skuJaBuscado: desfecho.skuBuscadoNaReserva,
    },
  };
}

/**
 * A live FIRST create of a produto the conta holds NO link of (K1-5): MINT its
 * draft through the draft route's own create (`rascunho.ts` — tier 0, a fresh
 * `newDocId`, the same document shape and checks the tab's «Novo anúncio»
 * writes), then publish it NAMED — the lock, the attempt's memory and D15 all
 * need a document to live on.
 *
 * The draft carries the brand `{brand_id: 0, original_brand_name: null}` —
 * "Sem marca", the `?? 0` this path always sent, byte for byte — and the
 * operator's `categoryId` when one came (the body the create sends is the
 * same; an uncertain attempt's category is then on record, D8). Its title is
 * the produto's `nome`, verbatim (the route's fallback).
 *
 * ⚠️ **The mint race (#1911 batch-A review).** The dispatcher hands
 * `linkDocId: null` only after ITS read found no link; this re-read finding
 * one means another run minted (or claimed) a draft, or the import added a
 * link, in between. Falling back to step 11's lexical resolver then would pick
 * that run's DRAFT and send `add_item` on it with no lock — two listings, and
 * the other run's lock stranded on a live link. So, with NOTHING written or
 * sent, 409 `CONTENCAO` (the operator retries, and the dispatcher re-reads):
 * whenever the dispatcher said "no link" ({@link EntradaDePublicacao.despachoSemVinculo}),
 * and — for a direct caller — whenever any link read is a DRAFT.
 *
 * Anything else answers `entrada` unchanged, with NOTHING written:
 *  - a named `linkDocId` (the dispatcher's), or — for a direct caller only —
 *    links of this produto on the conta none of which is a draft: step 11's
 *    resolver keeps picking among those;
 *  - a produto that does not exist — `prepararPublicacao`'s 404;
 *  - a produto the plan refuses before any send for want of a NAME
 *    (`sem-nome`): nothing can reach `add_item`, so nothing needs a lock — and
 *    the draft route would refuse to mint it (its 400).
 * A variation child or a native kit is refused here by `preparar`'s OWN
 * refusal ({@link recusarProdutoNaoPublicavel}), before any write — the same
 * error, the same precedence.
 *
 * ⚠️ `deps.aoVivo` is REQUIRED from here on: a mint without the live controls
 * would leave a draft the reservation then refuses to lock. The defect throws
 * BEFORE the mint.
 */
async function nomearCriacaoSemVinculo(
  deps: PublicarAnuncioDeps,
  entrada: EntradaDePublicacao,
): Promise<EntradaDePublicacao> {
  if (textoUtilizavel(entrada.linkDocId) !== null) return entrada;
  const vinculos = await lerVinculosDaConta(deps.db, deps.integracaoId, entrada.produtoId);
  if (vinculos.length > 0) {
    // The mint race (docblock): never an unnamed fall-through onto a link the
    // dispatcher did not see — and never onto a draft at all.
    if (entrada.despachoSemVinculo === true || vinculos.some((v) => ehRascunhoShopee(v.raw))) {
      throw vinculoNovoDuranteAPublicacao(entrada.produtoId, vinculos);
    }
    return entrada;
  }
  const snap = await produtoCollection.docRef(deps.db, {}, entrada.produtoId).get();
  if (!snap.exists) return entrada;
  const produto = produtoParaPublicar(
    entrada.produtoId,
    (snap.data() ?? {}) as Record<string, unknown>,
  );
  recusarProdutoNaoPublicavel(produto, null);
  if (textoUtilizavelShopee(produto.nome) === null) return entrada;
  if (deps.aoVivo === undefined) {
    throw new Error(
      `[shopee/anuncios] a primeira publicação do produto ${entrada.produtoId} chegou sem o ` +
        'relógio da rota (deps.aoVivo): sem ele o rascunho não pode ser travado. Nada foi ' +
        'gravado nem enviado.',
    );
  }

  const linkDocId = produtoShopeeLinkCollection.newDocId(deps.db, {
    produtoId: entrada.produtoId,
  });
  await criarRascunhoShopee(
    { db: deps.db, nowMs: deps.nowMs },
    {
      integracaoId: deps.integracaoId,
      produtoId: entrada.produtoId,
      linkDocId,
      conteudo: {
        marca: { brand_id: 0, original_brand_name: null },
        ...(entrada.categoryId == null ? {} : { category_id: entrada.categoryId }),
      },
      confirmarSegundoAnuncio: deps.aoVivo.confirmarSegundoAnuncio,
    },
  );
  // eslint-disable-next-line no-console -- one line per mint: ids only
  console.info('[shopee/anuncios] rascunho criado para a primeira publicação sem vínculo', {
    integracaoId: deps.integracaoId,
    produtoId: entrada.produtoId,
    linkDocId,
  });
  return { ...entrada, linkDocId };
}

/**
 * The mint race's refusal ({@link nomearCriacaoSemVinculo}) — 409 `CONTENCAO`,
 * nothing written or sent. It names the draft that appeared when there is one
 * (the link the operator's retry will be about), else the first link read.
 */
function vinculoNovoDuranteAPublicacao(
  produtoId: string,
  vinculos: readonly { readonly id: string; readonly raw: Record<string, unknown> }[],
): ConflitoDeRascunhoShopeeError {
  const ids = vinculos.map((v) => v.id);
  const alvo = vinculos.find((v) => ehRascunhoShopee(v.raw))?.id ?? ids[0] ?? produtoId;
  console.warn('[shopee/anuncios] o produto ganhou um vínculo durante a publicação; nada enviado', {
    produtoId,
    vinculos: ids,
  });
  return new ConflitoDeRascunhoShopeeError({
    code: CODIGO_RASCUNHO_SHOPEE.contencao,
    linkDocId: alvo,
    mensagem:
      `o produto ${produtoId} ganhou um vínculo nesta conta durante a publicação ` +
      `(${ids.join(', ')}) — outra execução (ou a importação) o gravou depois que a publicação ` +
      'leu a conta sem nenhum. Nada foi enviado à Shopee; tente de novo.',
  });
}

/**
 * A DRAFT reached the send with no reservation (the aplicar guard) — 409
 * `CONTENCAO`, nothing written or sent: only its lock may carry its `add_item`.
 */
function rascunhoSemTrava(linkDocId: string): ConflitoDeRascunhoShopeeError {
  console.warn('[shopee/anuncios] add_item de um rascunho sem a trava dele; nada enviado', {
    linkDocId,
  });
  return new ConflitoDeRascunhoShopeeError({
    code: CODIGO_RASCUNHO_SHOPEE.contencao,
    linkDocId,
    mensagem:
      `o vínculo ${linkDocId} é um rascunho e esta publicação chegou ao add_item sem a trava ` +
      'dele (um rascunho só é publicado pelo nome, sob a trava). Nada foi enviado à Shopee; ' +
      'tente de novo.',
  });
}

/**
 * Re-exported for the CLI's dry run, which prints the PLAN and applies nothing.
 * One name, one implementation: a second import path is how a dry run starts
 * describing a different sequence from the one the publisher runs.
 */
export { planejarPublicacao };
export type { ContextoPublicacao, FotosResolvidas, PlanoPublicacao };
