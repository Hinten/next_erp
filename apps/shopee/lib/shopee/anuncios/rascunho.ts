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
 *    draft with the SAME content (the retry's `conteudo`, normalised, through
 *    THE comparison) ⇒ 200 `criado: false` (a double click); other content ⇒
 *    409 `CONFLITO` (K1-9); anything else at that id (another conta's link, a
 *    listing) ⇒ 409 `ID_EM_USO`. Before it: the conta (404 when absent or not
 *    Shopee), the produto (404 absent; 422 `PRODUTO_INVALIDO` for a variation
 *    child or a virtual kit — K2-10) and **D15**: the conta already holding a
 *    live listing or another draft of this produto
 *    (`vinculosQueExigemConfirmacaoShopee`, the SAME set the publish
 *    reservation and the web's confirmation decide with) without
 *    `confirmarSegundoAnuncio: true` ⇒ 409 `CONTA_JA_TEM_ANUNCIO`.
 *  - **edit** ({@link atualizarRascunhoShopee}) — tier **3 + 1**: the baseline
 *    compare (the operator's `base` against THE projection of what is stored,
 *    over the PATCH's fields only) tells the human about a concurrent edit
 *    (409 `CONFLITO`, nothing written); the write is `update(…, {lastUpdateTime})`
 *    against the snapshot that decided, and a lost precondition re-reads and
 *    RE-RUNS every check — never re-applies (a racing edit then surfaces as
 *    `CONFLITO`, a racing publish as `EM_ANDAMENTO`/`JA_PUBLICADO`).
 *  - **discard** ({@link descartarRascunhoShopee}) — tier **3 + 1**: the same
 *    baseline over EVERY projected field (K1-13), then `delete({lastUpdateTime})`
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
 * edit may not move the CATEGORY (409 `CATEGORIA_TRAVADA` — the uncertain
 * create may have made the listing in the old one, D8) and a discard needs the
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
 * `ultimaModificacao` and the lock reading). Zero Shopee calls.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  INTEGRACAO_TIPO,
  MOTIVO_RASCUNHO_INVALIDO_SHOPEE,
  campoRascunhoShopeeSchema,
  camposDoRascunhoShopee,
  camposPresentesDoRascunhoShopee,
  ehKitVirtualEfetivo,
  ehRascunhoShopee,
  estadoPublicacaoRascunhoShopee,
  mesmoValorDoRascunhoShopee,
  textoUtilizavelShopee,
  toOuterRef,
  vinculoShopeeEhDaConta,
  vinculosQueExigemConfirmacaoShopee,
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
   * draft's `dataCadastro`, every write's `ultimaModificacao` and the instant
   * the lock is read at. One instant per request, so a re-derive after a lost
   * precondition judges the lock at the same moment the first attempt did.
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

function jaPublicado(linkDocId: string): RecusaDeRascunhoShopeeError {
  return new RecusaDeRascunhoShopeeError({
    status: 409,
    code: CODIGO_RASCUNHO_SHOPEE.jaPublicado,
    linkDocId,
    mensagem:
      `o vínculo ${linkDocId} já não é um rascunho: o anúncio já existe na Shopee, e o ` +
      'conteúdo de um anúncio publicado não é editado aqui. Recarregue a aba. Nada foi gravado.',
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

/**
 * The fields among `campos` whose `valores` (a `base`, a `patch` or a
 * `conteudo`) are NOT what `projecao` holds, through THE comparison — each with
 * what is stored now, in the projection's form.
 */
function divergencias(
  campos: readonly CampoRascunhoShopee[],
  projecao: CamposRascunhoShopee,
  valores: Partial<CamposRascunhoShopee>,
): ConflitoRascunhoShopee[] {
  return campos
    .filter((campo) => !mesmoValorDoRascunhoShopee(campo, projecao[campo], valores[campo]))
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
 *  5. `create()`; on `ALREADY_EXISTS`, the content compare.
 *
 * Writes the WHOLE document through the link schema's full parse: the canonical
 * conta ref, `item_id: null`, the whitelisted content (absent ⇒ `null`: no
 * description = the produto's own, D2), BOTH brand keys, `dataCadastro` and
 * `ultimaModificacao` = `nowMs`. Never a lock.
 *
 * @returns `criado: true` (the route's 201) or `criado: false` (200 — the same
 *   draft, same content, already there).
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
    dataCadastro: deps.nowMs,
    ultimaModificacao: deps.nowMs,
  });

  const ref = produtoShopeeLinkCollection.docRef(db, { produtoId }, linkDocId);
  const pedidos = camposPresentesDoRascunhoShopee(conteudo);
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
    // K1-9: a retry is "the same draft" only with the same content — every
    // key the retry NAMES, normalised, through THE comparison.
    const conflitos = divergencias(pedidos, camposDoRascunhoShopee(raw), conteudo);
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
 * brand keys (D10). A `category_id` write also clears a stored `attributes`
 * (they belong to the old category), reported as written.
 */
function escritaDoCampo(
  campo: CampoRascunhoShopee,
  patch: Partial<CamposRascunhoShopee>,
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
    case CAMPO_RASCUNHO_SHOPEE.logisticInfo:
      // RESERVED: no body accepts them yet (`conteudoRascunhoShopeeSchema` is
      // strict), so reaching this is a defect, never a write.
      throw new Error(`[shopee/anuncios] o campo ${campo} do rascunho ainda não é editável`);
  }
}

/**
 * Edit a draft (D4) — see the module docblock. Loop ≤
 * {@link TENTATIVAS_DO_RASCUNHO}, each attempt re-deciding from a FRESH read:
 *
 *  1. absent / other conta ⇒ 404 `INEXISTENTE`; not a draft ⇒ 409
 *     `JA_PUBLICADO` (D8: a published listing's content is not edited here);
 *  2. the lock reads `em-andamento` (its grace included) ⇒ 409 `EM_ANDAMENTO`
 *     `{aguardarMs}`; `incerta` and the patch names `category_id` ⇒ 409
 *     `CATEGORIA_TRAVADA` (any other field may still change);
 *  3. the BASELINE — over the patch's fields only, the operator's `base`
 *     against the stored projection — any field differs ⇒ 409 `CONFLITO`
 *     with every differing field and what is stored now;
 *  4. the patch equals what is stored (THE comparison, field by field) ⇒ 200
 *     `gravados: []`, NOTHING written;
 *  5. else `update` of the fields that differ (+ `ultimaModificacao`) with
 *     `{lastUpdateTime}` of the snapshot that decided. A lost precondition (or
 *     the document deleted meanwhile) re-reads and re-runs 1–5.
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
  const { integracaoId, produtoId, linkDocId } = corpo;
  const base: Partial<CamposRascunhoShopee> = corpo.base;
  const patch: Partial<CamposRascunhoShopee> = corpo.patch;
  const alterados = camposPresentesDoRascunhoShopee(corpo.patch);
  const ref = produtoShopeeLinkCollection.docRef(deps.db, { produtoId }, linkDocId);

  for (let tentativa = 1; tentativa <= TENTATIVAS_DO_RASCUNHO; tentativa += 1) {
    const snap = await ref.get();
    const raw = rascunhoDaConta(snap, integracaoId, linkDocId);

    const estado = estadoPublicacaoRascunhoShopee(raw, deps.nowMs);
    if (estado.tipo === 'em-andamento') {
      throw emAndamento(linkDocId, estado.aguardarMs, estado.posExpiracao);
    }
    if (estado.tipo === 'incerta' && alterados.includes(CAMPO_RASCUNHO_SHOPEE.categoryId)) {
      throw new RecusaDeRascunhoShopeeError({
        status: 409,
        code: CODIGO_RASCUNHO_SHOPEE.categoriaTravada,
        linkDocId,
        mensagem:
          `a última tentativa de publicar o rascunho ${linkDocId} pode ter criado o anúncio na ` +
          'Shopee, na categoria gravada: ela não muda até isso se resolver. Confira no Seller ' +
          'Centre e importe o anúncio se ele existir. Nada foi gravado.',
      });
    }

    const projecao = camposDoRascunhoShopee(raw);
    const conflitos = divergencias(alterados, projecao, base);
    if (conflitos.length > 0) throw conflito(linkDocId, conflitos);

    const aGravar = alterados.filter(
      (campo) => !mesmoValorDoRascunhoShopee(campo, projecao[campo], patch[campo]),
    );
    if (aGravar.length === 0) return { linkDocId, gravados: [] };

    const escrita: Record<string, unknown> = {};
    const gravados = new Set<CampoRascunhoShopee>(aGravar);
    for (const campo of aGravar) Object.assign(escrita, escritaDoCampo(campo, patch));
    if (
      gravados.has(CAMPO_RASCUNHO_SHOPEE.categoryId) &&
      raw.attributes !== null &&
      raw.attributes !== undefined
    ) {
      // The stored attributes belong to the OLD category.
      escrita.attributes = null;
      gravados.add(CAMPO_RASCUNHO_SHOPEE.attributes);
    }
    const dados = produtoShopeeLinkCollection.parseMerge({
      ...escrita,
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
 *  3. the BASELINE over EVERY projected field (K1-13) — the stored draft is not
 *     what the operator saw ⇒ 409 `CONFLITO`: an edit made meanwhile is never
 *     discarded unseen;
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

    const conflitos = divergencias(vistos, camposDoRascunhoShopee(raw), base);
    if (conflitos.length > 0) throw conflito(linkDocId, conflitos);

    const incerta = estado.tipo === 'incerta';
    if (incerta && corpo.confirmarCriacaoIncerta !== true) {
      throw new RecusaDeRascunhoShopeeError({
        status: 409,
        code: CODIGO_RASCUNHO_SHOPEE.criacaoIncerta,
        linkDocId,
        mensagem:
          `a última tentativa de publicar o rascunho ${linkDocId} pode ter criado o anúncio na ` +
          'Shopee (resultado desconhecido), e o rascunho é o único registro dela. Confira no ' +
          'Seller Centre: se o anúncio existe, importe-o; se NÃO existe, confirme para ' +
          'descartar. Nada foi apagado.',
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
