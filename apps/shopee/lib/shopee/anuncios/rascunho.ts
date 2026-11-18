/**
 * **The draft route's decisions** (#1911, D1/D2/D4/D15/D18) — create, edit and
 * discard a Shopee DRAFT: the `prodshopee` document with no `item_id`
 * (`ehRascunhoShopee`) that the produto's Shopee tab authors before the first
 * publish. The browser never writes `prodshopee` (D1): the three `POST
 * …/rascunho{,/atualizar,/descartar}` routes parse their body with the strict
 * schemas of `@delfrance/schemas` (`shopeeRascunho.ts`) and hand it here.
 *
 * Every write names its rule-7 tier, and every guard is a SINGLE-document
 * precondition — nothing here opens a multi-document atomic write:
 *
 *  - **create** ({@link criarRascunhoShopee}) — tier **0**: `create()` at the
 *    CLIENT-generated id, so two creates of one draft cannot both land. The
 *    loser's `ALREADY_EXISTS` reads the document and decides: the same conta's
 *    draft holding EXACTLY what this create would have written (every
 *    projected field — a key the retry leaves out counts as the `null`, or the
 *    produto's `nome`, the write gives it — through THE write comparison) ⇒
 *    200 `criado: false` (a double click, a lost first answer); other content
 *    ⇒ 409 `CONFLITO` (K1-9); anything else at that id (another conta's link,
 *    a listing) ⇒ 409 `ID_EM_USO`. Before it: the conta (404 when absent or not
 *    Shopee), the produto (404 absent; 422 `PRODUTO_INVALIDO` for a variation
 *    child or a virtual kit — K2-10) and **D15**: the conta already holding a
 *    live listing or another draft of this produto
 *    (`vinculosQueExigemConfirmacaoShopee`, the SAME set the publish
 *    reservation and the web's confirmation decide with) without
 *    `confirmarSegundoAnuncio: true` ⇒ 409 `CONTA_JA_TEM_ANUNCIO`.
 *  - **edit** ({@link atualizarRascunhoShopee}) — edits a DRAFT (`alvo:
 *    'rascunho'`, the default) or a PUBLISHED listing (`alvo: 'anuncio'`; Lucas
 *    2026-11-17: save ONLY to the link, «Republicar» sends). The published arm
 *    writes the same six fields plus the two edit stamps (`edicaoErpRevisao` +1,
 *    `edicaoErpPendenteEm`) that `produtos/links.ts`'s guarded arm reads, so
 *    nothing silently discards the unsent edit. Tier **3 + 1**: the baseline
 *    compare (the operator's `base` against THE projection of what is stored,
 *    over the fields `camposDaBaseDoRascunhoShopee` names: the PATCH's, plus
 *    the stored `attributes` a category change clears — K1-12 — or the stored
 *    `category_id` an attributes-only list was chosen in — its mirror, P13 Q1,
 *    compared and never written) tells the human
 *    about a concurrent edit (409 `CONFLITO`, nothing written); the patch's
 *    fields that THE write comparison finds already stored are left out (all
 *    of them ⇒ 200 `gravados: []`, nothing written); the write is
 *    `update(…, {lastUpdateTime})` against the snapshot that decided, and a
 *    lost precondition re-reads and RE-RUNS every check — never re-applies (a
 *    racing edit then surfaces as `CONFLITO`, a racing publish as
 *    `EM_ANDAMENTO`/`JA_PUBLICADO`). `attributes` (P6, D9) is written in the
 *    REQUEST shape the body's write schema normalised to, and compared through
 *    the projection's ONE decoder — never a stored shape read raw here.
 *    `logistic_info` (P15) is written as the whitelist's sorted list WITH
 *    `logisticaGravadaEm` = `nowMs` in the SAME literal and the SAME `update`,
 *    a `null` («Automática») included — the fifth writer of #2015's inventory;
 *    the baseline compares it through the projection, so an unstamped legacy
 *    list reads `null`, and an edit that does not name it writes neither key.
 *  - **discard** ({@link descartarRascunhoShopee}) — tier **3 + 1**: the same
 *    baseline over the six form fields (K1-13) — the body reads an ABSENT
 *    `logistic_info` as `null` («Automática», what every screen before the
 *    logistics editor showed; #1911 P16, D-LOG-10), so a stale tab's five-key
 *    discard over channels chosen meanwhile is a 409 `CONFLITO`, never a
 *    silent delete — then `delete({lastUpdateTime})`
 *    with the same re-derive. The FIRST deleter of `prodshopee` — the one named
 *    exception to the import's "resolve, then write, never delete"
 *    (`produtos/links.ts`). A draft has no `variashopee` rows (they are minted
 *    only after the first create's write-back), and a late write-back of a
 *    create nobody can see any more `add`s a fresh link rather than resurrect
 *    this one (`reservaRascunho.ts`, step 4).
 *
 * The publish LOCK (`publicacaoEmCurso`) is read here through the ONE reading,
 * `estadoPublicacaoRascunhoShopee`, and NEVER written: an edit or a discard
 * while a run holds it (or inside its post-expiry grace) is 409
 * `EM_ANDAMENTO`; in `incerta` (the last create may have reached Shopee) an
 * edit may not even NAME `category_id` — re-sending the stored value included,
 * and nothing beside it in the patch is written either (409
 * `CATEGORIA_TRAVADA` — the uncertain create may have made the listing in the
 * stored one, D8; DA-4 keys the lock on the patch, never on a value change) —
 * and a discard needs the
 * operator's attestation `confirmarCriacaoIncerta: true` (409 `CRIACAO_INCERTA`
 * otherwise, K1-6), because the draft is the only record of that attempt.
 *
 * Every refusal is a {@link RecusaDeRascunhoShopeeError} carrying its HTTP
 * status and a `code` of `CODIGO_RASCUNHO_SHOPEE` — the ONE vocabulary the web
 * reads too — except the conta check, which throws the app's own
 * `ShopeeContaNotConfiguredError` (the route's `shopeeErrorResponse` 404, the
 * same answer every conta-scoped route gives).
 *
 * Clock-free and Next-free like the rest of `anuncios/`: the instant is the
 * route's clock, handed down as `nowMs` (MILLISECONDS — `dataCadastro`,
 * `ultimaModificacao`, a logistics write's `logisticaGravadaEm` and the lock
 * reading). Zero Shopee calls.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  ALVO_EDICAO_SHOPEE,
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  INTEGRACAO_TIPO,
  MOTIVO_RASCUNHO_INVALIDO_SHOPEE,
  campoRascunhoShopeeSchema,
  camposDaBaseDoRascunhoShopee,
  camposDoRascunhoShopee,
  anuncioShopeeEditavel,
  camposPresentesDoRascunhoShopee,
  ehKitVirtualEfetivo,
  ehRascunhoShopee,
  estadoPublicacaoRascunhoShopee,
  logisticaDoAnuncioEditavelShopee,
  mesclarLogisticaGravadaShopee,
  mesmoValorDoRascunhoShopee,
  mesmoValorGravadoDoRascunhoShopee,
  revisaoDeEdicaoErpShopee,
  textoUtilizavelShopee,
  toOuterRef,
  vinculoShopeeEhDaConta,
  vinculosQueExigemConfirmacaoShopee,
  type AlvoEdicaoShopee,
  type CampoRascunhoShopee,
  type CamposRascunhoShopee,
  type CodigoRascunhoShopee,
  type ConflitoRascunhoShopee,
  type CorpoAtualizarRascunhoShopee,
  type CorpoCriarRascunhoShopee,
  type CorpoDescartarRascunhoShopee,
  type MarcaRascunhoShopee,
  type MotivoRascunhoInvalidoShopee,
  type RespostaAtualizarRascunhoShopee,
  type RespostaCriarRascunhoShopee,
  type RespostaDescartarRascunhoShopee,
  type VinculoConflitanteShopee,
} from '@delfrance/schemas';
import {
  integracaoCollection,
  produtoCollection,
  produtoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';

import { readConta } from '../core/contaCache';
import { ShopeeContaNotConfiguredError } from '../core/shopee';
import { lerVinculosDaConta } from './linkAnuncio';

/* -------------------------------------------------------------------------- */
/*                                 the inputs                                  */
/* -------------------------------------------------------------------------- */

/** What every draft operation needs from its route. */
export interface DepsDoRascunhoShopee {
  readonly db: Firestore;
  /**
   * MILLISECONDS — the route's clock, read ONCE per request: the created
   * draft's `dataCadastro`, every write's `ultimaModificacao`, a logistics
   * write's `logisticaGravadaEm` and the instant the lock is read at. One
   * instant per request, so a re-derive after a lost precondition judges the
   * lock at the same moment the first attempt did.
   */
  readonly nowMs: number;
  /**
   * The conta reader of a CREATE — `readConta` (cached, token-free) when
   * absent, which is what the route passes. A seam for the emulator suite
   * only: writing `integracao/{id}` there would fire this codebase's conta
   * trigger.
   */
  readonly lerConta?: (
    db: Firestore,
    integracaoId: string,
  ) => Promise<{ readonly tipo?: unknown } | null>;
}

/**
 * How many times an edit, a discard or a create re-reads after losing to a
 * concurrent write before it gives up with 409 `CONFLITO` and an empty
 * `conflitos` — bounded, never a spin (`isFailedPrecondition`'s contract).
 */
export const TENTATIVAS_DO_RASCUNHO = 3;

/* -------------------------------------------------------------------------- */
/*                                 the refusal                                 */
/* -------------------------------------------------------------------------- */

/** The HTTP status a refused draft operation answers with. */
export type StatusDaRecusaDeRascunhoShopee = 400 | 404 | 409 | 422;

/**
 * A draft operation REFUSED — nothing was written. The route answers `status`
 * with {@link corpoDaRecusaDeRascunhoShopee}.
 *
 * ⚠️ An APP class, deliberately NOT a `ShopeeError` (nothing here is a Shopee
 * answer — the route makes zero Shopee calls) and NOT the publish lock's
 * `ConflitoDeRascunhoShopeeError` (a 404 or a 422 is not a conflict). The route
 * tests it with `instanceof` BEFORE `isShopeeError`.
 *
 * `code` is `CODIGO_RASCUNHO_SHOPEE`'s, and `null` only on the 400 (a create
 * with no title to fall back to — the route's other 400s are its body parse).
 * The detail fields are the ones the code's docblock names, `null` when they
 * do not apply. `message` is a pt-BR mechanism sentence — ids and field names,
 * never content.
 */
export class RecusaDeRascunhoShopeeError extends Error {
  readonly status: StatusDaRecusaDeRascunhoShopee;
  readonly code: CodigoRascunhoShopee | null;
  /** The draft the request addressed. */
  readonly linkDocId: string;
  /** `CONFLITO`: the fields that differ, with what is stored NOW (`[]` = lost to concurrent writes). */
  readonly conflitos: readonly ConflitoRascunhoShopee[] | null;
  /** `EM_ANDAMENTO`: MILLISECONDS until the lock reading can change. */
  readonly aguardarMs: number | null;
  /** `CONTA_JA_TEM_ANUNCIO`: the conta's other links of this produto (D15). */
  readonly vinculos: readonly VinculoConflitanteShopee[] | null;
  /** `PRODUTO_INVALIDO`: why the produto cannot carry a draft. */
  readonly motivo: MotivoRascunhoInvalidoShopee | null;

  constructor(args: {
    readonly status: StatusDaRecusaDeRascunhoShopee;
    readonly code: CodigoRascunhoShopee | null;
    readonly linkDocId: string;
    readonly mensagem: string;
    readonly conflitos?: readonly ConflitoRascunhoShopee[] | null;
    readonly aguardarMs?: number | null;
    readonly vinculos?: readonly VinculoConflitanteShopee[] | null;
    readonly motivo?: MotivoRascunhoInvalidoShopee | null;
  }) {
    super(args.mensagem);
    this.name = 'RecusaDeRascunhoShopeeError';
    this.status = args.status;
    this.code = args.code;
    this.linkDocId = args.linkDocId;
    this.conflitos = args.conflitos ?? null;
    this.aguardarMs = args.aguardarMs ?? null;
    this.vinculos = args.vinculos ?? null;
    this.motivo = args.motivo ?? null;
  }
}

/** The body of a refused draft operation, built BY NAME. */
export interface CorpoDaRecusaDeRascunhoShopee {
  error: string;
  code?: string;
  linkDocId: string;
  conflitos?: { campo: CampoRascunhoShopee; atual: unknown }[];
  aguardarMs?: number;
  vinculos?: { linkDocId: string; itemId: number | null; rascunho: boolean }[];
  motivo?: MotivoRascunhoInvalidoShopee;
}

/**
 * The route's body for a {@link RecusaDeRascunhoShopeeError}, BY NAME. A detail
 * key rides only when the refusal carries it — an ABSENT key is "not
 * applicable", which the web reads differently from a `0` wait or an empty
 * list (the publish route's `corpoDoConflito` rule).
 */
export function corpoDaRecusaDeRascunhoShopee(
  err: RecusaDeRascunhoShopeeError,
): CorpoDaRecusaDeRascunhoShopee {
  return {
    error: err.message,
    ...(err.code === null ? {} : { code: err.code }),
    linkDocId: err.linkDocId,
    ...(err.conflitos === null
      ? {}
      : { conflitos: err.conflitos.map((c) => ({ campo: c.campo, atual: c.atual })) }),
    ...(err.aguardarMs === null ? {} : { aguardarMs: err.aguardarMs }),
    ...(err.vinculos === null
      ? {}
      : {
          vinculos: err.vinculos.map((v) => ({
            linkDocId: v.linkDocId,
            itemId: v.itemId,
            rascunho: v.rascunho,
          })),
        }),
    ...(err.motivo === null ? {} : { motivo: err.motivo }),
  };
}

/** Whole seconds, rounded UP, for a sentence — never for a decision. */
function segundos(ms: number): string {
  return String(Math.max(Math.ceil(ms / 1000), 0));
}

function listaDeVinculos(vinculos: readonly VinculoConflitanteShopee[]): string {
  return vinculos
    .map((v) =>
      v.rascunho ? `${v.linkDocId} (rascunho)` : `${v.linkDocId} (item ${String(v.itemId)})`,
    )
    .join(', ');
}

function inexistente(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 404,
    code: CODIGO_RASCUNHO_SHOPEE.inexistente,
    linkDocId,
    mensagem:
      `o rascunho ${linkDocId} não existe neste produto, ou é de outra conta. Recarregue a ` +
      'aba. Nada foi gravado.',
  });
}

/**
 * 409 `JA_PUBLICADO` of the draft SAVE and DISCARD routes — the stored
 * document is no longer a draft. The sentence claims only what the read
 * showed — the document RECORDS a listing — never that the listing still
 * exists on Shopee: an adopted or claimed link may have been removed in Seller
 * Centre since (#1911 batch-B review round 5, the reservation's round-4 fix).
 */
function jaPublicado(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.jaPublicado,
    linkDocId,
    mensagem:
      `o vínculo ${linkDocId} já não é um rascunho: ele já registra um anúncio da Shopee, ` +
      'que se edita como anúncio publicado. Recarregue a aba. Nada foi gravado.',
  });
}

function emAndamento(
  linkDocId: string,
  aguardarMs: number,
  posExpiracao: boolean,
): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
    linkDocId,
    aguardarMs,
    mensagem: posExpiracao
      ? `a publicação anterior do rascunho ${linkDocId} expirou, mas ainda pode estar ` +
        `terminando na Shopee — aguarde ${segundos(aguardarMs)} s e recarregue. Nada foi gravado.`
      : `o rascunho ${linkDocId} está sendo publicado agora — aguarde ` +
        `${segundos(aguardarMs)} s e recarregue para ver o resultado. Nada foi gravado.`,
  });
}

function conflito(
  linkDocId: string,
  conflitos: readonly ConflitoRascunhoShopee[],
): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.conflito,
    linkDocId,
    conflitos,
    mensagem:
      conflitos.length === 0
        ? `não foi possível gravar o rascunho ${linkDocId}: gravações concorrentes venceram ` +
          `${String(TENTATIVAS_DO_RASCUNHO)} vezes seguidas. Nada foi gravado; tente de novo.`
        : `o rascunho ${linkDocId} mudou desde que foi aberto ` +
          `(${conflitos.map((c) => c.campo).join(', ')}). Recarregue para ver o que está ` +
          'gravado. Nada foi gravado.',
  });
}

/* -------------------------------------------------------------------------- */
/*                                  reading                                    */
/* -------------------------------------------------------------------------- */

/** A non-empty string, or `null` — the publish dispatcher's reading of `paiId`. */
function textoOuNull(bruto: unknown): string | null {
  return typeof bruto === 'string' && bruto !== '' ? bruto : null;
}

/**
 * The stored draft named by the request, or the refusal: absent, or not this
 * conta's ⇒ 404 `INEXISTENTE` (both stored ref encodings count as this conta's,
 * `vinculoShopeeEhDaConta`); not a draft (any more) ⇒ 409 `JA_PUBLICADO`.
 */
function rascunhoDaConta(
  snap: { readonly exists: boolean; data(): unknown },
  integracaoId: string,
  linkDocId: string,
): Record<string, unknown> {
  if (!snap.exists) throw inexistente(linkDocId);
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  if (!vinculoShopeeEhDaConta(raw, integracaoId)) throw inexistente(linkDocId);
  if (!ehRascunhoShopee(raw)) throw jaPublicado(linkDocId);
  return raw;
}

/** 409 `ANUNCIO_NAO_EDITAVEL`: the link is not a published listing the ERP edits. */
function anuncioNaoEditavel(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.anuncioNaoEditavel,
    linkDocId,
    mensagem:
      `o vínculo ${linkDocId} não é um anúncio publicado editável: ele é um rascunho, um kit ` +
      'nativo, ou um anúncio removido ou substituído. Recarregue a aba. Nada foi gravado.',
  });
}

/** 422 `ANUNCIO_EDICAO_INVALIDA`: an edit a PUBLISHED listing cannot take. */
function edicaoInvalidaDoAnuncio(linkDocId: string, mensagem: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 422,
    code: CODIGO_RASCUNHO_SHOPEE.anuncioEdicaoInvalida,
    linkDocId,
    mensagem: `${mensagem} Nada foi gravado.`,
  });
}

/**
 * The stored link the EDIT addresses, by mode: absent / another conta's ⇒ 404;
 * `alvo` rascunho on a non-draft ⇒ 409 `JA_PUBLICADO`; `alvo` anuncio on a link
 * that is not an editable published listing ⇒ 409 `ANUNCIO_NAO_EDITAVEL`.
 */
function vinculoDaEdicao(
  snap: { readonly exists: boolean; data(): unknown },
  integracaoId: string,
  linkDocId: string,
  alvo: AlvoEdicaoShopee,
): Record<string, unknown> {
  if (!snap.exists) throw inexistente(linkDocId);
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  if (!vinculoShopeeEhDaConta(raw, integracaoId)) throw inexistente(linkDocId);
  if (alvo === ALVO_EDICAO_SHOPEE.rascunho) {
    if (!ehRascunhoShopee(raw)) throw jaPublicado(linkDocId);
  } else if (!anuncioShopeeEditavel(raw)) {
    throw anuncioNaoEditavel(linkDocId);
  }
  return raw;
}

/** Whether `bruto` is a stored list holding at least one entry. */
function listaNaoVazia(bruto: unknown): boolean {
  return Array.isArray(bruto) && bruto.length > 0;
}

/**
 * One of `@delfrance/schemas`' two field comparisons — the CONFLICT one
 * (`mesmoValorDoRascunhoShopee`: a brand by `brand_id`) or the WRITE one
 * (`mesmoValorGravadoDoRascunhoShopee`: the brand PAIR). Every caller names
 * which question it asks; there is no default.
 */
type ComparacaoDoRascunho = typeof mesmoValorDoRascunhoShopee;

/**
 * The fields among `campos` whose `valores` (a `base`, or the document a
 * create retry would write) are NOT what `projecao` holds under `mesmo` — each
 * with what is stored now, in the projection's form.
 */
function divergencias(
  campos: readonly CampoRascunhoShopee[],
  projecao: CamposRascunhoShopee,
  valores: Partial<CamposRascunhoShopee>,
  mesmo: ComparacaoDoRascunho,
): ConflitoRascunhoShopee[] {
  return campos
    .filter((campo) => !mesmo(campo, projecao[campo], valores[campo]))
    .map((campo) => ({ campo, atual: projecao[campo] ?? null }));
}

/** The brand pair as its TWO stored keys — always both (D10); `null` ⇒ both `null`. */
function chavesDaMarca(marca: MarcaRascunhoShopee | null): {
  brand_id: number | null;
  original_brand_name: string | null;
} {
  return marca === null
    ? { brand_id: null, original_brand_name: null }
    : { brand_id: marca.brand_id, original_brand_name: marca.original_brand_name };
}

/* -------------------------------------------------------------------------- */
/*                                  1. create                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create the draft at the client-generated `linkDocId` (D2) — see the module
 * docblock. The order of the checks:
 *
 *  1. the conta exists and is Shopee, else `ShopeeContaNotConfiguredError`
 *     (404);
 *  2. the produto exists (else 404 `INEXISTENTE`), is not a variation child
 *     (a non-empty `paiId` — the publish dispatcher's test; 422 `filho`) and is
 *     not a virtual kit (`ehKitVirtualEfetivo`; 422 `kit-virtual`);
 *  3. D15 — the conta's OTHER links of this produto that make a second listing
 *     (the draft's own id excluded, so a retry never refuses itself) without
 *     `confirmarSegundoAnuncio === true` ⇒ 409 `CONTA_JA_TEM_ANUNCIO`;
 *  4. the title: `conteudo.item_name`, else the produto's `nome` verbatim —
 *     neither usable ⇒ 400 (a draft's title is never blank);
 *  5. `create()`; on `ALREADY_EXISTS`, the content compare — the stored
 *     projection against the projection of the document THIS create would have
 *     written, over EVERY projected field, through the WRITE comparison
 *     (`mesmoValorGravadoDoRascunhoShopee`: the brand's name counts). A key the
 *     retry leaves out is NOT a wildcard: it is the `null` (or, for
 *     `item_name`, the produto's `nome`) this create writes for it, so a retry
 *     that omits a brand the first create stored is a 409, never a 200 over a
 *     brand the tab believes cleared (the K1-9 lost-response class).
 *
 * Writes the WHOLE document through the link schema's full parse: the canonical
 * conta ref, `item_id: null`, the whitelisted content (absent ⇒ `null`: no
 * description = the produto's own, D2; `attributes` in the REQUEST shape the
 * body normalised to, D9), BOTH brand keys, `dataCadastro` and
 * `ultimaModificacao` = `nowMs`. Never a lock, and never logistics: the body
 * cannot name `logistic_info` (they are chosen on a SAVED draft, D-13), so the
 * link schema's default `null` is written with no stamp.
 *
 * @returns `criado: true` (the route's 201) or `criado: false` (200 — the same
 *   draft already there, holding exactly what this create would write).
 * @throws RecusaDeRascunhoShopeeError for 400 / 404 / 409 / 422;
 *   ShopeeContaNotConfiguredError for the conta's 404.
 */
export async function criarRascunhoShopee(
  deps: DepsDoRascunhoShopee,
  corpo: CorpoCriarRascunhoShopee,
): Promise<RespostaCriarRascunhoShopee> {
  const { db } = deps;
  const { integracaoId, produtoId, linkDocId } = corpo;
  const conteudo = corpo.conteudo ?? {};

  const conta = await (deps.lerConta ?? readConta)(db, integracaoId);
  if (conta == null) {
    throw new ShopeeContaNotConfiguredError(`Integração ${integracaoId} não encontrada.`);
  }
  if (conta.tipo !== INTEGRACAO_TIPO.shopee) {
    throw new ShopeeContaNotConfiguredError(`Integração ${integracaoId} não é do tipo Shopee.`);
  }

  const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!produtoSnap.exists) {
    throw new RecusaDeRascunhoShopeeError({
      status: 404,
      code: CODIGO_RASCUNHO_SHOPEE.inexistente,
      linkDocId,
      mensagem: `o produto ${produtoId} não existe. Nada foi gravado.`,
    });
  }
  const produto = (produtoSnap.data() ?? {}) as Record<string, unknown>;
  const paiId = textoOuNull(produto.paiId);
  if (paiId !== null) {
    throw new RecusaDeRascunhoShopeeError({
      status: 422,
      code: CODIGO_RASCUNHO_SHOPEE.produtoInvalido,
      linkDocId,
      motivo: MOTIVO_RASCUNHO_INVALIDO_SHOPEE.filho,
      mensagem:
        `o produto ${produtoId} é uma variação do produto ${paiId}: o anúncio é do produto ` +
        'pai, nunca de uma variação. Nada foi gravado.',
    });
  }
  if (ehKitVirtualEfetivo(produto)) {
    throw new RecusaDeRascunhoShopeeError({
      status: 422,
      code: CODIGO_RASCUNHO_SHOPEE.produtoInvalido,
      linkDocId,
      motivo: MOTIVO_RASCUNHO_INVALIDO_SHOPEE.kitVirtual,
      mensagem:
        `o produto ${produtoId} é um kit virtual: a primeira publicação dele é um kit nativo ` +
        'da Shopee, nunca um rascunho de anúncio comum. Nada foi gravado.',
    });
  }

  // D15 — the SAME set the publish reservation re-checks, minus this draft's
  // own id (a retry of this very create must reach the content compare).
  const vinculos = await lerVinculosDaConta(db, integracaoId, produtoId);
  const exigem = vinculosQueExigemConfirmacaoShopee(
    vinculos.map((v) => ({ id: v.id, data: v.raw })),
    integracaoId,
    linkDocId,
  );
  if (exigem.length > 0 && corpo.confirmarSegundoAnuncio !== true) {
    throw new RecusaDeRascunhoShopeeError({
      status: 409,
      code: CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio,
      linkDocId,
      vinculos: exigem,
      mensagem:
        `este produto já tem anúncio ou rascunho nesta conta (${listaDeVinculos(exigem)}): um ` +
        'novo rascunho levaria a um SEGUNDO anúncio, que a Shopee pode tratar como duplicata. ' +
        'Confirme o segundo anúncio para seguir. Nada foi gravado.',
    });
  }

  // The title is never blank: the whitelist already refused a blank
  // `item_name`, and the fallback is the produto's `nome` VERBATIM (D2).
  const nomeDoProduto =
    typeof produto.nome === 'string' && textoUtilizavelShopee(produto.nome) !== null
      ? produto.nome
      : null;
  const itemName = conteudo.item_name ?? nomeDoProduto;
  if (itemName === null) {
    throw new RecusaDeRascunhoShopeeError({
      status: 400,
      code: null,
      linkDocId,
      mensagem:
        `o produto ${produtoId} não tem nome: informe item_name para criar o rascunho. Nada ` +
        'foi gravado.',
    });
  }

  const dados = produtoShopeeLinkCollection.parse({
    // Always the canonical encoding — the conta filter every reader applies.
    contaProdutoShopeeOuterRef: toOuterRef(integracaoCollection.docPath({}, integracaoId)),
    item_id: null,
    item_name: itemName,
    description: conteudo.description ?? null,
    category_id: conteudo.category_id ?? null,
    ...chavesDaMarca(conteudo.marca ?? null),
    attributes: conteudo.attributes ?? null,
    dataCadastro: deps.nowMs,
    ultimaModificacao: deps.nowMs,
  });

  const ref = produtoShopeeLinkCollection.docRef(db, { produtoId }, linkDocId);
  // K1-9: what a retry is compared against is the document THIS create writes
  // — through the SAME projection that reads the stored one, so an absent key
  // is its written `null`, `item_name` its fallback, the brand the pair and
  // `attributes` the decoder's request shape. Every field the projection
  // produces is compared — `logistic_info` too since P15: this create writes
  // the link schema's `null` with no stamp, which projects `null`, so a retry
  // over a list another tab chose since (stamped) is a 409, while an unstamped
  // legacy list, which also projects `null`, is still the same draft.
  const pretendido = camposDoRascunhoShopee(dados as Record<string, unknown>);
  const comparados = camposPresentesDoRascunhoShopee(pretendido);
  for (let tentativa = 1; tentativa <= TENTATIVAS_DO_RASCUNHO; tentativa += 1) {
    try {
      await ref.create(dados as Record<string, unknown>);
      return { linkDocId, criado: true };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }

    // ALREADY_EXISTS: whatever is at this id decides.
    const snap = await ref.get();
    // Deleted between the create and this read (a racing discard): the id is
    // free again — try the create once more, bounded.
    if (!snap.exists) continue;
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    if (!vinculoShopeeEhDaConta(raw, integracaoId) || !ehRascunhoShopee(raw)) {
      throw new RecusaDeRascunhoShopeeError({
        status: 409,
        code: CODIGO_RASCUNHO_SHOPEE.idEmUso,
        linkDocId,
        mensagem:
          `o id ${linkDocId} já é de outro vínculo deste produto (de outra conta, ou um ` +
          'anúncio). Gere um id novo. Nada foi gravado.',
      });
    }
    // K1-9: a retry is "the same draft" only when what is stored is exactly
    // what this create would have written — a WRITE question, so the brand's
    // name counts too.
    const conflitos = divergencias(
      comparados,
      camposDoRascunhoShopee(raw),
      pretendido,
      mesmoValorGravadoDoRascunhoShopee,
    );
    if (conflitos.length > 0) throw conflito(linkDocId, conflitos);
    return { linkDocId, criado: false };
  }
  console.warn('[shopee/anuncios] a criação do rascunho perdeu para gravações concorrentes', {
    produtoId,
    linkDocId,
  });
  throw conflito(linkDocId, []);
}

/* -------------------------------------------------------------------------- */
/*                                   2. edit                                   */
/* -------------------------------------------------------------------------- */

/**
 * The stored keys one edited field writes: its own key — or, for `marca`, BOTH
 * brand keys (D10) — or, for `logistic_info`, the list AND its stamp (#2015's
 * rule: the same patch, the same condition). `attributes` is written as the
 * patch carries it: the REQUEST shape the body's write schema already
 * normalised to (D9), so the next identical save reads back EQUAL and writes
 * nothing. The clearing of the attributes a category change leaves behind is
 * the caller's ({@link limpaAtributosNaTrocaDeCategoria}), never this
 * function's.
 *
 * `logistic_info` (#1911 P15) is written as the whitelist parsed it, MERGED with
 * the stored raw list (`mesclarLogisticaGravadaShopee`): ONLY a TRUSTED stored
 * list (the publisher's one provenance predicate, applied inside schemas) carries
 * its `size_id` / `shipping_fee` over to a channel it still holds — the form
 * never sends them and a republish needs them. A draft's list was written by
 * this very route with neither, and a legacy draft's DISTRUSTED list (#2015)
 * carries nothing: the stamp below must not launder a value nobody confirmed.
 * On a PUBLISHED edit (`desligarOmitidos`) a channel the trusted stored list
 * holds ON and the edit omits is recorded `enabled: false`, so the republish
 * turns it off at Shopee instead of leaving it ON while the ERP lost it. Sorted by
 * `logistic_id`, each channel `{logistic_id, enabled, is_free}`, or `null`
 * («Automática», which the operator CHOSE, so it is stamped too) — with
 * `logisticaGravadaEm: nowMs` in the SAME object literal. This arm runs only
 * when the caller writes `logistic_info`, so the stamp rides the list's own
 * condition by construction: an edit that leaves the list alone (a title-only
 * save, or a list equal to the stored projection) writes neither key. ⚠️ ONE
 * literal with PLAIN keys: `logisticaProveniencia.test.ts` reads the writers
 * from the syntax tree, and a stamp spread in by the caller, a shorthand, a
 * later assignment or a computed key reds it.
 */
function escritaDoCampo(
  campo: CampoRascunhoShopee,
  patch: Partial<CamposRascunhoShopee>,
  nowMs: number,
  raw: Record<string, unknown>,
  publicado: boolean,
): Record<string, unknown> {
  switch (campo) {
    case CAMPO_RASCUNHO_SHOPEE.itemName:
      return { item_name: patch.item_name ?? null };
    case CAMPO_RASCUNHO_SHOPEE.description:
      return { description: patch.description ?? null };
    case CAMPO_RASCUNHO_SHOPEE.categoryId:
      return { category_id: patch.category_id ?? null };
    case CAMPO_RASCUNHO_SHOPEE.marca:
      return chavesDaMarca(patch.marca ?? null);
    case CAMPO_RASCUNHO_SHOPEE.attributes:
      return { attributes: patch.attributes ?? null };
    case CAMPO_RASCUNHO_SHOPEE.logisticInfo:
      return {
        logistic_info: mesclarLogisticaGravadaShopee(patch.logistic_info ?? null, raw, {
          desligarOmitidos: publicado,
        }),
        logisticaGravadaEm: nowMs,
      };
  }
}

/**
 * Whether this edit CLEARS the stored `attributes` (K1-12): the category is
 * among the fields WRITTEN (a real change, not a re-send of the stored one),
 * the patch does NOT name `attributes` itself — a patch that names them, even
 * with the stored list unchanged, is the operator choosing them for the new
 * category, so they are never wiped — and something is stored there at all
 * (`null`/absent is already clear: writing `null` over it would be a write
 * with nothing to say). The stored value is read RAW on purpose: a list that
 * PROJECTS to `[]` (nothing usable) or a value that is not a list still
 * belongs to the old category and goes. The baseline that decided this write
 * has already compared `base.attributes` against the projection, so what is
 * cleared is what the operator saw.
 */
function limpaAtributosNaTrocaDeCategoria(
  alterados: readonly CampoRascunhoShopee[],
  gravados: ReadonlySet<CampoRascunhoShopee>,
  raw: Record<string, unknown>,
): boolean {
  return (
    gravados.has(CAMPO_RASCUNHO_SHOPEE.categoryId) &&
    !alterados.includes(CAMPO_RASCUNHO_SHOPEE.attributes) &&
    raw.attributes !== null &&
    raw.attributes !== undefined
  );
}

/**
 * Edit a draft (D4) — see the module docblock. Loop ≤
 * {@link TENTATIVAS_DO_RASCUNHO}, each attempt re-deciding from a FRESH read:
 *
 *  1. absent / other conta ⇒ 404 `INEXISTENTE`; `alvo` rascunho on a non-draft ⇒
 *     409 `JA_PUBLICADO`; `alvo` anuncio on anything but an editable published
 *     listing (`anuncioShopeeEditavel`: a draft, a native kit, removed or
 *     superseded) ⇒ 409 `ANUNCIO_NAO_EDITAVEL`. Lucas 2026-11-17 reversed D8: a
 *     published listing's six form fields ARE edited here, SAVE-ONLY — the write
 *     stamps `edicaoErpRevisao` (+1) and `edicaoErpPendenteEm`, PR1's guards keep
 *     the import and the write-backs from discarding it, and «Republicar» sends
 *     and clears it. A published edit refuses (422 `ANUNCIO_EDICAO_INVALIDA`) a
 *     null brand, «Automática» logistics, a logistics edit over a list the ERP
 *     never wrote (`logisticaDoAnuncioEditavelShopee`: import first), and
 *     emptying a stored attribute list (explicitly, or by a category change
 *     that names none). A no-op stamps nothing; a draft edit never stamps;
 *  2. (drafts only — a republish takes no lock) the lock reads `em-andamento`
 *     (its grace included) ⇒ 409 `EM_ANDAMENTO`
 *     `{aguardarMs}`; `incerta` and the patch NAMES `category_id` ⇒ 409
 *     `CATEGORIA_TRAVADA` — even when it re-sends the stored value, and with
 *     nothing else of the patch written (DA-4; a patch WITHOUT `category_id`
 *     may still change any other field);
 *  3. the BASELINE — over `camposDaBaseDoRascunhoShopee(patch)`: the patch's
 *     fields, plus `attributes` when the patch changes `category_id` without
 *     them (K1-12), or plus `category_id` when the patch writes `attributes`
 *     without it (the mirror, P13 Q1; the body's refine made `base` name
 *     exactly that list), the operator's `base` against the stored projection —
 *     any field differs ⇒ 409 `CONFLITO` with every differing field and what
 *     is stored now. So an attribute save another operator landed meanwhile
 *     stops a category change that would wipe it, and a category another
 *     operator moved meanwhile stops an attribute list chosen in the old one,
 *     before anything is written. The extra field is compared, never written
 *     (step 4 iterates the PATCH's fields), and the `incerta` lock of step 2
 *     keys on the patch, so a list compared beside the stored category is no
 *     category write;
 *  4. the patch equals what is stored (THE WRITE comparison,
 *     `mesmoValorGravadoDoRascunhoShopee`, field by field) ⇒ 200
 *     `gravados: []`, NOTHING written — a legacy-shaped stored list included:
 *     it reads EQUAL through the decoder, and the write shape is only ever
 *     written by a write that has something to say (D9: no migration). The
 *     brand is compared as the PAIR here, never by id alone: re-picking the
 *     stored brand with its name over a legacy draft that stores the id only
 *     WRITES the name (the baseline of step 3 stays id-only);
 *  5. else `update` of the fields that differ (+ `ultimaModificacao`, and
 *     `logisticaGravadaEm` beside a `logistic_info` write — P15) with
 *     `{lastUpdateTime}` of the snapshot that decided — plus `attributes: null`
 *     when the category changes and the patch does not name `attributes`
 *     ({@link limpaAtributosNaTrocaDeCategoria}), reported as written. A lost
 *     precondition (or the document deleted meanwhile) re-reads and re-runs
 *     1–5.
 *
 * Never writes the lock: an `incerta` lock survives every edit.
 *
 * @returns the fields WRITTEN, canonical order (`[]` = nothing to write).
 * @throws RecusaDeRascunhoShopeeError for 404 / 409; a third lost precondition
 *   is 409 `CONFLITO` with `conflitos: []`.
 */
export async function atualizarRascunhoShopee(
  deps: DepsDoRascunhoShopee,
  corpo: CorpoAtualizarRascunhoShopee,
): Promise<RespostaAtualizarRascunhoShopee> {
  const { integracaoId, produtoId, linkDocId, alvo } = corpo;
  const publicado = alvo === ALVO_EDICAO_SHOPEE.anuncio;
  const base: Partial<CamposRascunhoShopee> = corpo.base;
  const patch: Partial<CamposRascunhoShopee> = corpo.patch;
  const alterados = camposPresentesDoRascunhoShopee(corpo.patch);
  // K1-12: the fields the baseline compares — the patch's, plus the
  // `attributes` a category change clears, or the `category_id` an
  // attributes-only list was chosen in (P13 Q1). The body's refine made `base`
  // name exactly these; iterating `alterados` instead would let a category
  // change wipe an attribute save it never compared, and an attribute list
  // land on a category another operator moved it out of. Only `alterados` is
  // ever written.
  const vistos = camposDaBaseDoRascunhoShopee(corpo.patch);
  const ref = produtoShopeeLinkCollection.docRef(deps.db, { produtoId }, linkDocId);

  for (let tentativa = 1; tentativa <= TENTATIVAS_DO_RASCUNHO; tentativa += 1) {
    const snap = await ref.get();
    const raw = vinculoDaEdicao(snap, integracaoId, linkDocId, alvo);

    // E-3: the publish lock is a DRAFT concern — a republish of a live listing
    // takes none, so these two checks never run on the published arm.
    const estado = estadoPublicacaoRascunhoShopee(raw, deps.nowMs);
    if (!publicado && estado.tipo === 'em-andamento') {
      throw emAndamento(linkDocId, estado.aguardarMs, estado.posExpiracao);
    }
    if (
      !publicado &&
      estado.tipo === 'incerta' &&
      alterados.includes(CAMPO_RASCUNHO_SHOPEE.categoryId)
    ) {
      // The exit after the import (#1911 batch-B review, round 3): the import
      // adopts this draft only with a readable window, one adoptable draft, a
      // known `create_time` and one parent produto (`produtos/resolveProduto.ts`)
      // — otherwise it links the listing apart, the draft stays `incerta` and
      // its category stays locked. Any `incerta` reading lands here, window or
      // not, so the sentence keys that exit on the draft still being there and
      // promises no adoption (the web words its own, FRASE_CATEGORIA_TRAVADA_SHOPEE).
      throw new RecusaDeRascunhoShopeeError({
        status: 409,
        code: CODIGO_RASCUNHO_SHOPEE.categoriaTravada,
        linkDocId,
        mensagem:
          `a última tentativa de publicar o rascunho ${linkDocId} pode ter criado o anúncio na ` +
          'Shopee, na categoria gravada: ela não muda até isso se resolver. Confira no Seller ' +
          'Centre e importe o anúncio se ele existir; se ele não existir, ou se este rascunho ' +
          'continuar depois da importação, descarte este rascunho confirmando a criação ' +
          'incerta. Nada foi gravado.',
      });
    }

    if (publicado) {
      // Refusals only a PUBLISHED listing has, decided from THIS attempt's
      // fresh read and before anything is written.
      if (alterados.includes(CAMPO_RASCUNHO_SHOPEE.marca) && (patch.marca ?? null) === null) {
        throw edicaoInvalidaDoAnuncio(
          linkDocId,
          'a marca (marca) de um anúncio publicado não pode ficar vazia: escolha uma marca ' +
            'ou «Sem marca».',
        );
      }
      if (
        alterados.includes(CAMPO_RASCUNHO_SHOPEE.logisticInfo) &&
        (patch.logistic_info ?? null) === null
      ) {
        throw edicaoInvalidaDoAnuncio(
          linkDocId,
          'a logística (logistic_info) «Automática» só existe em rascunho: um anúncio publicado ' +
            'precisa de canais escolhidos.',
        );
      }
      // The save stamps the list as the ERP's, and «Republicar» then sends its
      // offs: over a list the ERP never wrote (legacy, or none) that would
      // vouch for offs nobody chose (`logisticaDoAnuncioEditavelShopee`).
      if (
        alterados.includes(CAMPO_RASCUNHO_SHOPEE.logisticInfo) &&
        !logisticaDoAnuncioEditavelShopee(raw)
      ) {
        throw edicaoInvalidaDoAnuncio(
          linkDocId,
          'a logística (logistic_info) deste anúncio ainda não foi gravada pelo ERP: importe o ' +
            'anúncio (sem alterações pendentes) para gravar os canais atuais da Shopee e então ' +
            'edite-os.',
        );
      }
      if (
        alterados.includes(CAMPO_RASCUNHO_SHOPEE.attributes) &&
        (patch.attributes ?? []).length === 0 &&
        listaNaoVazia(raw.attributes)
      ) {
        throw edicaoInvalidaDoAnuncio(
          linkDocId,
          'os atributos (attributes) de um anúncio publicado não podem ser esvaziados de uma vez: ' +
            'remova só os que não se aplicam.',
        );
      }
    }

    const projecao = camposDoRascunhoShopee(raw);
    const conflitos = divergencias(vistos, projecao, base, mesmoValorDoRascunhoShopee);
    if (conflitos.length > 0) throw conflito(linkDocId, conflitos);

    // The WRITE question, not the conflict one: a brand re-picked with its
    // name over the same stored id is something to write.
    const aGravar = alterados.filter(
      (campo) => !mesmoValorGravadoDoRascunhoShopee(campo, projecao[campo], patch[campo]),
    );
    if (aGravar.length === 0) return { linkDocId, gravados: [] };

    const escrita: Record<string, unknown> = {};
    const gravados = new Set<CampoRascunhoShopee>(aGravar);
    for (const campo of aGravar) {
      Object.assign(escrita, escritaDoCampo(campo, patch, deps.nowMs, raw, publicado));
    }
    if (limpaAtributosNaTrocaDeCategoria(alterados, gravados, raw)) {
      if (publicado && listaNaoVazia(raw.attributes)) {
        // E-2: a republish omits an empty attribute list, so Shopee would keep
        // the OLD category's attributes — the new ones go in the same save.
        throw edicaoInvalidaDoAnuncio(
          linkDocId,
          'trocar a categoria de um anúncio publicado exige enviar, no mesmo salvamento, os ' +
            'atributos (attributes) da nova categoria.',
        );
      }
      // The stored attributes belong to the OLD category — and the baseline
      // above proved they are the ones the operator saw.
      escrita.attributes = null;
      gravados.add(CAMPO_RASCUNHO_SHOPEE.attributes);
    }
    const dados = produtoShopeeLinkCollection.parseMerge({
      ...escrita,
      // E-1: a published listing's edit is UNSENT until «Republicar»; the stamps
      // ride the same update, computed from THIS attempt's snapshot (rule 7).
      ...(publicado
        ? {
            edicaoErpRevisao: (revisaoDeEdicaoErpShopee(raw) ?? 0) + 1,
            edicaoErpPendenteEm: deps.nowMs,
          }
        : {}),
      ultimaModificacao: deps.nowMs,
    });
    try {
      await ref.update(dados as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return {
        linkDocId,
        gravados: campoRascunhoShopeeSchema.options.filter((campo) => gravados.has(campo)),
      };
    } catch (err) {
      // Another writer landed between the read and the write (or deleted the
      // draft): re-read and RE-DECIDE — never re-apply this decision.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  console.warn('[shopee/anuncios] a edição do rascunho perdeu a precondição três vezes', {
    produtoId,
    linkDocId,
  });
  throw conflito(linkDocId, []);
}

/* -------------------------------------------------------------------------- */
/*                                 3. discard                                  */
/* -------------------------------------------------------------------------- */

/**
 * Discard a draft (D18) — see the module docblock. Loop ≤
 * {@link TENTATIVAS_DO_RASCUNHO}, each attempt re-deciding from a FRESH read:
 *
 *  1. absent / other conta ⇒ 404 `INEXISTENTE`; not a draft ⇒ 409
 *     `JA_PUBLICADO`;
 *  2. `em-andamento` (its grace included) ⇒ 409 `EM_ANDAMENTO` `{aguardarMs}`;
 *  3. the BASELINE over the fields the `base` names (K1-13) — all six: the
 *     five form fields (`attributes` too since P6) and `logistic_info`, which
 *     the body reads as `null` when absent (#1911 P16; D-LOG-10: a tab from
 *     before the logistics editor sends five keys, and it SAW «Automática»),
 *     so {@link camposPresentesDoRascunhoShopee} names it — the stored draft
 *     is not what the operator saw ⇒ 409 `CONFLITO`: an edit made meanwhile,
 *     a channel choice included, is never discarded unseen;
 *  4. `incerta` without `confirmarCriacaoIncerta === true` ⇒ 409
 *     `CRIACAO_INCERTA` (K1-6) — the draft is the only record that a create
 *     may have reached Shopee; a `livre` draft needs no attestation;
 *  5. `delete({lastUpdateTime})` of the snapshot that decided; a lost
 *     precondition (or the document gone meanwhile) re-reads and re-runs 1–5.
 *
 * @returns `criacaoIncerta: true` when the draft deleted was `incerta`.
 * @throws RecusaDeRascunhoShopeeError for 404 / 409; a third lost precondition
 *   is 409 `CONFLITO` with `conflitos: []`.
 */
export async function descartarRascunhoShopee(
  deps: DepsDoRascunhoShopee,
  corpo: CorpoDescartarRascunhoShopee,
): Promise<RespostaDescartarRascunhoShopee> {
  const { integracaoId, produtoId, linkDocId } = corpo;
  const base: Partial<CamposRascunhoShopee> = corpo.base;
  const vistos = camposPresentesDoRascunhoShopee(corpo.base);
  const ref = produtoShopeeLinkCollection.docRef(deps.db, { produtoId }, linkDocId);

  for (let tentativa = 1; tentativa <= TENTATIVAS_DO_RASCUNHO; tentativa += 1) {
    const snap = await ref.get();
    const raw = rascunhoDaConta(snap, integracaoId, linkDocId);

    const estado = estadoPublicacaoRascunhoShopee(raw, deps.nowMs);
    if (estado.tipo === 'em-andamento') {
      throw emAndamento(linkDocId, estado.aguardarMs, estado.posExpiracao);
    }

    const conflitos = divergencias(
      vistos,
      camposDoRascunhoShopee(raw),
      base,
      mesmoValorDoRascunhoShopee,
    );
    if (conflitos.length > 0) throw conflito(linkDocId, conflitos);

    const incerta = estado.tipo === 'incerta';
    if (incerta && corpo.confirmarCriacaoIncerta !== true) {
      // «Normalmente» (batch-B review R7-roundtrip#5): the import adopts ONLY a
      // draft whose attempt window it can read, holding the listing's
      // `create_time`, and only when exactly one draft qualifies and the SKU
      // lands on one produto (`produtos/resolveProduto.ts`,
      // `veredictoDeAdocaoShopee`). An `incerta` reading does not promise that
      // — an unreadable lock or record reads `incerta` with NO window — so the
      // sentence names the other outcome too: a link apart, after which this
      // draft is case (b) and the confirmed discard is the exit.
      throw new RecusaDeRascunhoShopeeError({
        status: 409,
        code: CODIGO_RASCUNHO_SHOPEE.criacaoIncerta,
        linkDocId,
        mensagem:
          `a última tentativa de publicar o rascunho ${linkDocId} pode ter criado o anúncio na ` +
          'Shopee (resultado desconhecido), e o rascunho é o único registro dela. Confira no ' +
          'Seller Centre: se o anúncio NÃO existe, ou existe e já está vinculado no ERP, confirme ' +
          'para descartar; se existe SEM vínculo, não descarte — dê a ele o mesmo SKU do produto ' +
          '(sem SKU, a importação cria outro produto) e importe-o. Normalmente a importação adota ' +
          'este rascunho; se ela criar um vínculo à parte, o anúncio passa a estar vinculado no ' +
          'ERP e este rascunho pode ser descartado com a confirmação. Nada foi apagado.',
      });
    }

    try {
      await ref.delete({ lastUpdateTime: snap.updateTime });
      return { linkDocId, descartado: true, criacaoIncerta: incerta };
    } catch (err) {
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  console.warn('[shopee/anuncios] o descarte do rascunho perdeu a precondição três vezes', {
    produtoId,
    linkDocId,
  });
  throw conflito(linkDocId, []);
}
