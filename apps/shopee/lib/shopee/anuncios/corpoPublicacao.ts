/**
 * Body readers for the three step-11 listing-lifecycle POSTs — `publicar`,
 * `anuncio-status` and `reverificar-anuncio`.
 *
 * The discipline is `produtos/corpoImportacao.ts`'s, and this module REUSES it
 * rather than restating it: {@link LeituraCorpo}, `lerJsonDoCorpo` and
 * `corpoDeErro` all come from there, so the `SyntaxError`-only narrowing, the
 * one malformed-body sentence and the `{error, code?}` shape have exactly one
 * home. What is new here is the field rules of these three bodies.
 *
 * Next-free, clock-free and IO-free for the same reason every module under
 * `anuncios/` is: the Cloud Functions bundle reaches this folder through the
 * link trigger. A reader answers a VALUE or a pt-BR MESSAGE; turning a message
 * into a response is the route's job.
 *
 * ## ⚠️ Every id is checked BEFORE it can reach `.doc(id)`
 *
 * `.doc()` validates the resulting PATH, not the id, and it does so outside any
 * `try` the handler owns — so a separator-bearing value escapes as a 500 for
 * what is plainly a client error. Measured against a real `firebase-admin`
 * Firestore: `''` throws ("Path must be a non-empty string"), `'a/b'` throws
 * ("must point to a document"), and `'a/b/c'` does NOT throw — it resolves to a
 * document two levels below the collection we meant, which comes back as a
 * puzzling 404. {@link naoDocId} refuses all three with one condition, plus the
 * two relative-path names Firestore reserves.
 *
 * ## ⚠️ The selection cap REJECTS; it never truncates
 *
 * `definirStatusAnunciosShopee` raises a `ShopeeConfigError` above the cap and
 * `core/respond.ts` maps that class to a 500 — "server misconfig, not the
 * caller's fault" — which is the wrong answer for an operator who selected too
 * many rows. So the bound is enforced HERE, on the DEDUPED count, and answers
 * {@link CODIGO_SELECAO_EXCEDE_LIMITE} with the limit and what was asked. A
 * silently dropped tail under a green summary is the failure this whole area
 * exists to prevent.
 */
import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_UNLIST_MAX_ITEMS,
  type ShopeeItemStatusWritable,
} from '@delfrance/integrations-shopee';
import { ACAO_STATUS_ANUNCIO, type AcaoStatusAnuncio } from '@delfrance/schemas';

import { MSG_BODY_INVALIDO, type LeituraCorpo } from '../produtos/corpoImportacao';

/* -------------------------------------------------------------------------- */
/*  Codes and messages                                                         */
/* -------------------------------------------------------------------------- */

/** `acao` is neither `pausar` nor `reativar`. */
export const CODIGO_ACAO_INVALIDA = 'SHOPEE_ACAO_INVALIDA';

/** `produtoIds` is empty, holds an unusable id, or disagrees with `linkDocId`. */
export const CODIGO_SELECAO_INVALIDA = 'SHOPEE_SELECAO_INVALIDA';

/** More distinct produtos than `unlist_item`'s own `item_list` bound. */
export const CODIGO_SELECAO_EXCEDE_LIMITE = 'SHOPEE_SELECAO_EXCEDE_LIMITE';

/**
 * The one sentence an unusable document id gets, per field.
 *
 * ⚠️ ONE spelling: {@link MSG_PRODUTO_ID_INVALIDO} is built FROM it rather than
 * written beside it, so the constant a route test asserts and the sentence a
 * caller actually receives cannot drift apart.
 */
function msgIdInvalido(nome: string): string {
  return `${nome} deve ser um id de documento (sem "/" nem "..").`;
}

/** The sentence a bad `produtoId` gets. Asserted by a test, so it is a constant. */
export const MSG_PRODUTO_ID_INVALIDO = msgIdInvalido('produtoId');

/** The sentence a `status` outside the two writable values gets. */
export const MSG_STATUS_PUBLICACAO = `status aceita apenas ${SHOPEE_ITEM_STATUS_WRITABLE.normal} e ${SHOPEE_ITEM_STATUS_WRITABLE.unlist}.`;

/** The sentence a `categoryId` that is not a wire id gets. */
export const MSG_CATEGORY_ID_INVALIDO = 'categoryId deve ser um inteiro positivo.';

/** The sentence an empty or malformed `produtoIds` gets. */
export const MSG_SELECAO_INVALIDA = 'Selecione ao menos 1 produto (ids de documento válidos).';

/** The sentence a `linkDocId` arriving with a wider selection gets. */
export const MSG_LINK_EXIGE_UM_PRODUTO = 'linkDocId exige exatamente 1 produto.';

/** The sentence an unknown `acao` gets. */
export const MSG_ACAO_INVALIDA = `acao deve ser "${ACAO_STATUS_ANUNCIO.pausar}" ou "${ACAO_STATUS_ANUNCIO.reativar}".`;

/* -------------------------------------------------------------------------- */
/*  Primitive readers                                                          */
/* -------------------------------------------------------------------------- */

function ok<T>(valor: T): LeituraCorpo<T> {
  return { ok: true, valor };
}

function erro<T>(mensagem: string, codigo?: string): LeituraCorpo<T> {
  return codigo === undefined
    ? { ok: false, erro: mensagem }
    : { ok: false, erro: mensagem, codigo };
}

/** The body as a plain record, or the one malformed-body message. */
function objeto(body: unknown): LeituraCorpo<Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return erro(MSG_BODY_INVALIDO);
  }
  return ok(body as Record<string, unknown>);
}

/** Firestore reserves both relative-path names; either one addresses elsewhere. */
const NOMES_RELATIVOS = new Set(['.', '..']);

/**
 * Is this request-body value unusable as a Firestore **document id**?
 *
 * The mechanism is spelled out in the module docblock: `.doc()` validates the
 * PATH and does it outside our `try`, so a separator either throws a 500 or
 * silently addresses a document the caller had no business naming. TYPE-checked
 * and never truthiness-checked — a non-string that happens to be truthy sails
 * past a `!value` guard and then throws deep inside `.doc(id)`.
 *
 * ⚠️ Other apps carry their own copy of this rule. `apps/*` has no dependency
 * edge to another `apps/*` and none is possible, so a shared one would have to
 * be promoted to a package; that is a follow-up this step does not carry.
 * Nothing here asserts what any other copy does.
 */
export function naoDocId(v: unknown): boolean {
  return typeof v !== 'string' || v === '' || v.includes('/') || NOMES_RELATIVOS.has(v);
}

/** A REQUIRED document id. */
function lerId(src: Record<string, unknown>, nome: string): LeituraCorpo<string> {
  const bruto = src[nome];
  if (bruto === undefined || bruto === null) return erro(`${nome} é obrigatório.`);
  if (naoDocId(bruto)) return erro(msgIdInvalido(nome));
  return ok(bruto as string);
}

/**
 * An OPTIONAL document id: absent or `null` ⇒ `null`, anything else must be
 * usable. An explicit `null` is "no narrowing", which is what a form sends for
 * a field the operator left alone.
 */
function lerIdOpcional(src: Record<string, unknown>, nome: string): LeituraCorpo<string | null> {
  const bruto = src[nome];
  if (bruto === undefined || bruto === null) return ok(null);
  if (naoDocId(bruto)) return erro(msgIdInvalido(nome));
  return ok(bruto as string);
}

/* -------------------------------------------------------------------------- */
/*  `POST /publicar`                                                           */
/* -------------------------------------------------------------------------- */

/** `{ integracaoId, produtoId, linkDocId?, status?, categoryId? }`. */
export interface CorpoPublicar {
  readonly integracaoId: string;
  readonly produtoId: string;
  /** Narrows to ONE `prodshopee` document; another conta's resolves to a 404. */
  readonly linkDocId: string | null;
  /** What the operator asked for. Absent ⇒ `NORMAL`. */
  readonly status: ShopeeItemStatusWritable;
  /**
   * The operator's explicit category choice (C36). Used **only** when the
   * resolved link has no `category_id` — it never overrides a stored value.
   */
  readonly categoryId: number | null;
}

/**
 * `status` — the two values `add_item` accepts, defaulting to `NORMAL`.
 *
 * ⚠️ No case fold: `'normal'` is not `'NORMAL'` on this wire, and lowercasing
 * here would send a value Shopee refuses while the operator was told the
 * request was fine (`lerStatuses`'s own rule, one folder over).
 */
function lerStatusPublicacao(src: Record<string, unknown>): LeituraCorpo<ShopeeItemStatusWritable> {
  const bruto = src['status'];
  if (bruto === undefined || bruto === null) return ok(SHOPEE_ITEM_STATUS_WRITABLE.normal);
  if (
    bruto !== SHOPEE_ITEM_STATUS_WRITABLE.normal &&
    bruto !== SHOPEE_ITEM_STATUS_WRITABLE.unlist
  ) {
    return erro(MSG_STATUS_PUBLICACAO);
  }
  return ok(bruto);
}

/**
 * `categoryId` — absent or `null` ⇒ `null`, else a positive safe integer.
 *
 * ⚠️ A numeric STRING is REFUSED, never coerced, for the reason
 * `corpoImportacao.ts` records about `itemId`: a stringified Shopee id matches
 * nothing on the wire or in the category index, and coercion is the defect
 * rather than the convenience. Whether the id is a LEAF is not this reader's
 * question — `ehFolha` answers that inside the publisher, against the index.
 */
function lerCategoryId(src: Record<string, unknown>): LeituraCorpo<number | null> {
  const bruto = src['categoryId'];
  if (bruto === undefined || bruto === null) return ok(null);
  if (typeof bruto !== 'number' || !Number.isSafeInteger(bruto) || bruto <= 0) {
    return erro(MSG_CATEGORY_ID_INVALIDO);
  }
  return ok(bruto);
}

export function lerCorpoPublicar(body: unknown): LeituraCorpo<CorpoPublicar> {
  const src = objeto(body);
  if (!src.ok) return src;

  const integracaoId = lerId(src.valor, 'integracaoId');
  if (!integracaoId.ok) return integracaoId;
  const produtoId = lerId(src.valor, 'produtoId');
  if (!produtoId.ok) return produtoId;
  const linkDocId = lerIdOpcional(src.valor, 'linkDocId');
  if (!linkDocId.ok) return linkDocId;
  const status = lerStatusPublicacao(src.valor);
  if (!status.ok) return status;
  const categoryId = lerCategoryId(src.valor);
  if (!categoryId.ok) return categoryId;

  return ok({
    integracaoId: integracaoId.valor,
    produtoId: produtoId.valor,
    linkDocId: linkDocId.valor,
    status: status.valor,
    categoryId: categoryId.valor,
  });
}

/* -------------------------------------------------------------------------- */
/*  `POST /anuncio-status`                                                     */
/* -------------------------------------------------------------------------- */

/** `{ integracaoId, produtoIds, acao, linkDocId? }`. */
export interface CorpoAnuncioStatus {
  readonly integracaoId: string;
  /** DEDUPED, request order kept — the orchestrator's `solicitados`. */
  readonly produtoIds: readonly string[];
  readonly acao: AcaoStatusAnuncio;
  readonly linkDocId: string | null;
}

/**
 * {@link LeituraCorpo} widened by the two NUMBERS the oversize refusal carries.
 *
 * They ride the refusal because the operator needs both the bound and what was
 * counted — the count is the DEDUPED one, so "I selected 51 rows" and "the
 * request says 50" is a difference the body has to be able to explain. Every
 * other arm is an ordinary {@link LeituraCorpo} and is assignable as-is.
 */
export type LeituraCorpoAnuncioStatus =
  | { readonly ok: true; readonly valor: CorpoAnuncioStatus }
  | {
      readonly ok: false;
      readonly erro: string;
      readonly codigo?: string;
      readonly limite?: number;
      readonly solicitados?: number;
    };

const ACOES = new Set<string>(Object.values(ACAO_STATUS_ANUNCIO));

export function lerCorpoAnuncioStatus(body: unknown): LeituraCorpoAnuncioStatus {
  const src = objeto(body);
  if (!src.ok) return src;

  const integracaoId = lerId(src.valor, 'integracaoId');
  if (!integracaoId.ok) return integracaoId;

  const acaoBruta = src.valor['acao'];
  if (typeof acaoBruta !== 'string' || !ACOES.has(acaoBruta)) {
    return { ok: false, erro: MSG_ACAO_INVALIDA, codigo: CODIGO_ACAO_INVALIDA };
  }
  const acao = acaoBruta as AcaoStatusAnuncio;

  const brutos = src.valor['produtoIds'];
  if (!Array.isArray(brutos) || brutos.length === 0 || brutos.some((id) => naoDocId(id))) {
    return { ok: false, erro: MSG_SELECAO_INVALIDA, codigo: CODIGO_SELECAO_INVALIDA };
  }

  // DEDUPED, request order KEPT: the per-listing result rows come back in this
  // order, and the orchestrator's `solicitados` counts exactly this list.
  const vistos = new Set<string>();
  const produtoIds: string[] = [];
  for (const id of brutos as string[]) {
    if (vistos.has(id)) continue;
    vistos.add(id);
    produtoIds.push(id);
  }

  // ⚠️ REJECT, never truncate, and on the DEDUPED count — see the module
  // docblock. 51 ids of which 50 are distinct is a request this ACCEPTS.
  if (produtoIds.length > SHOPEE_UNLIST_MAX_ITEMS) {
    return {
      ok: false,
      erro: `Selecione no máximo ${String(SHOPEE_UNLIST_MAX_ITEMS)} produtos.`,
      codigo: CODIGO_SELECAO_EXCEDE_LIMITE,
      limite: SHOPEE_UNLIST_MAX_ITEMS,
      solicitados: produtoIds.length,
    };
  }

  const linkDocId = lerIdOpcional(src.valor, 'linkDocId');
  if (!linkDocId.ok) return linkDocId;
  // A single-listing run addresses ONE produto by construction: the link doc
  // lives under exactly one anchor, so a wider selection would silently mean
  // something other than what was asked.
  if (linkDocId.valor !== null && produtoIds.length !== 1) {
    return { ok: false, erro: MSG_LINK_EXIGE_UM_PRODUTO, codigo: CODIGO_SELECAO_INVALIDA };
  }

  return {
    ok: true,
    valor: { integracaoId: integracaoId.valor, produtoIds, acao, linkDocId: linkDocId.valor },
  };
}

/**
 * The 400 body of `anuncio-status`, built ON `corpoDeErro`'s two arms (never
 * beside them) and widened by the two numbers the oversize arm carries.
 */
export function corpoDeErroAnuncioStatus(leitura: {
  readonly erro: string;
  readonly codigo?: string;
  readonly limite?: number;
  readonly solicitados?: number;
}): { error: string; code?: string; limite?: number; solicitados?: number } {
  const base =
    leitura.codigo === undefined
      ? { error: leitura.erro }
      : { error: leitura.erro, code: leitura.codigo };
  return leitura.limite === undefined || leitura.solicitados === undefined
    ? base
    : { ...base, limite: leitura.limite, solicitados: leitura.solicitados };
}

/* -------------------------------------------------------------------------- */
/*  `POST /reverificar-anuncio`                                                */
/* -------------------------------------------------------------------------- */

/** `{ integracaoId, produtoId, linkDocId? }`. */
export interface CorpoReverificar {
  readonly integracaoId: string;
  readonly produtoId: string;
  readonly linkDocId: string | null;
}

export function lerCorpoReverificar(body: unknown): LeituraCorpo<CorpoReverificar> {
  const src = objeto(body);
  if (!src.ok) return src;

  const integracaoId = lerId(src.valor, 'integracaoId');
  if (!integracaoId.ok) return integracaoId;
  const produtoId = lerId(src.valor, 'produtoId');
  if (!produtoId.ok) return produtoId;
  const linkDocId = lerIdOpcional(src.valor, 'linkDocId');
  if (!linkDocId.ok) return linkDocId;

  return ok({
    integracaoId: integracaoId.valor,
    produtoId: produtoId.valor,
    linkDocId: linkDocId.valor,
  });
}
