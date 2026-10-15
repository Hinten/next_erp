/**
 * Body readers for the three Shopee import POSTs — the FIRST request bodies
 * this app validates (every route before step 9 took query parameters only).
 *
 * The discipline is `taxonomia/params.ts`'s, one layer up: a reader answers a
 * VALUE or a pt-BR MESSAGE, and turning a message into a `NextResponse` is the
 * route's job. This module is Next-free for the same reason every module under
 * `produtos/` is — the Cloud Functions bundle reaches this directory.
 *
 * ## Built by NAME, never spread
 *
 * Nothing here copies the caller's object. Every accepted field is read by name
 * and type-checked, and an unknown key is ignored rather than carried: the
 * options object ends up in a job document that a later dispatch parses, and a
 * body spread into it would let a caller write fields the schema never declared
 * and the job would then read back whatever survived the parse.
 *
 * ## ⚠️ `itemId` must be a NUMBER
 *
 * A numeric STRING is REFUSED, never coerced. A stringified Shopee id matches
 * NOTHING on the `prodshopee` composite — the exact silent miss
 * `produtoShopeeLinkCollection.ts` records — so accepting `"2500139861"` here
 * would import a second produto for a listing the ERP already carries, with no
 * error anywhere. Coercion is the defect, not the convenience.
 *
 * ## ⚠️ Two delete statuses are refused, loudly
 *
 * `SELLER_DELETE` / `SHOPEE_DELETE` are not members of
 * `shopeeImportStatusSchema` and a body naming one gets a 400 carrying
 * {@link CODIGO_STATUS_RECUSADO}. Dropping them silently would import a
 * NARROWER set than the operator asked for and report success — the schema's
 * own docblock makes the refusal the enum's job precisely so the request can
 * say so.
 */
import {
  OPCOES_IMPORTACAO_SHOPEE_PADRAO,
  SHOPEE_IMPORT_STATUS_PADRAO,
  shopeeImportStatusSchema,
  type ImportacaoShopeeOptions,
  type ShopeeImportStatus,
} from '@delfrance/schemas';

import type { LeituraParam } from '../taxonomia/params';

/**
 * A body read: the parsed value, or the pt-BR message the route puts in its 400.
 *
 * The same two arms as {@link LeituraParam}, widened by exactly one OPTIONAL
 * field — `codigo`, the machine code a 400 body carries when the refusal is one
 * a UI branches on (today: a refused `item_status`). Every `LeituraParam` is
 * therefore already one of these; the extra field exists because the param
 * readers answer query strings, where no refusal has ever needed a code.
 */
export type LeituraCorpo<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly erro: string; readonly codigo?: string };

function ok<T>(valor: T): LeituraCorpo<T> {
  return { ok: true, valor };
}

function erro<T>(mensagem: string, codigo?: string): LeituraCorpo<T> {
  return codigo === undefined
    ? { ok: false, erro: mensagem }
    : { ok: false, erro: mensagem, codigo };
}

/** The one sentence a malformed body gets, whatever made it malformed. */
export const MSG_BODY_INVALIDO = 'Body JSON inválido.';

/** The code a refused `item_status` carries — the UI offers the four legal values. */
export const CODIGO_STATUS_RECUSADO = 'SHOPEE_IMPORT_STATUS_RECUSADO';

/** The sentence behind {@link CODIGO_STATUS_RECUSADO}. */
export const MSG_STATUS_RECUSADO =
  'statuses aceita apenas NORMAL, UNLIST, BANNED e REVIEWING. ' +
  'SELLER_DELETE e SHOPEE_DELETE são recusados: um anúncio apagado continua legível por 90 ' +
  'dias, e cadastrar um produto a partir dele criaria uma entrada para algo que já não existe ' +
  'no marketplace e que nada remove depois.';

/* -------------------------------------------------------------------------- */
/*  The request → body step                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `req.json()`, with its one failure mode folded into the same 400 a non-object
 * body gets.
 *
 * ⚠️ `SyntaxError` is narrowed explicitly and everything else rethrows (root
 * `CLAUDE.md` rule 6): a body that never arrived (a socket reset mid-read) is
 * not a malformed body, and answering 400 for it would tell the operator to fix
 * a request that was already correct.
 *
 * It takes the WHOLE request rather than a pre-read body so that the three
 * routes have ONE failure branch each instead of two, and so the SyntaxError
 * rule is testable beside the rules it shares a response with. The pure
 * `ler…` readers below still take a plain `unknown`, which is what their own
 * tests drive.
 */
export async function lerJsonDoCorpo(req: Request): Promise<LeituraCorpo<unknown>> {
  try {
    return ok(await req.json());
  } catch (err) {
    if (err instanceof SyntaxError) return erro(MSG_BODY_INVALIDO);
    throw err;
  }
}

/** The 400 body, built by name. Next-free: the route wraps it in a response. */
export function corpoDeErro(leitura: { readonly erro: string; readonly codigo?: string }): {
  error: string;
  code?: string;
} {
  return leitura.codigo === undefined
    ? { error: leitura.erro }
    : { error: leitura.erro, code: leitura.codigo };
}

/* -------------------------------------------------------------------------- */
/*  Primitive readers                                                          */
/* -------------------------------------------------------------------------- */

/** The body as a plain record, or the one malformed-body message. */
function objeto(body: unknown): LeituraCorpo<Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return erro(MSG_BODY_INVALIDO);
  }
  return ok(body as Record<string, unknown>);
}

/**
 * A required free-text field, trimmed — blank counts as ABSENT.
 *
 * Text is trimmed and ids are not, exactly as `taxonomia/params.ts` argues:
 * whitespace around a provider id is never legitimate, while a blank text field
 * is what a form submits for something the operator did not fill in.
 *
 * Typed {@link LeituraParam} rather than {@link LeituraCorpo}: no missing-field
 * refusal has a machine code, and saying so in the type is cheaper than a
 * comment.
 */
function lerTexto(src: Record<string, unknown>, nome: string): LeituraParam<string> {
  const bruto = src[nome];
  if (typeof bruto !== 'string') return { ok: false, erro: `${nome} é obrigatório.` };
  const valor = bruto.trim();
  if (valor.length === 0) return { ok: false, erro: `${nome} é obrigatório.` };
  return { ok: true, valor };
}

/** The exact sentence a stringified id gets. Asserted by a test, so it is a constant. */
export const MSG_ITEM_ID_STRING = 'itemId deve ser um número, não uma string.';

/**
 * `itemId` — a number, a safe integer, strictly positive.
 *
 * ⚠️ The string arm answers its OWN sentence before the generic one. "deve ser
 * um número" is true of `"2500139861"` and useless: the caller sent the right
 * digits and needs to be told that the JSON type is the problem.
 */
function lerItemId(src: Record<string, unknown>): LeituraCorpo<number> {
  const bruto = src['itemId'];
  if (typeof bruto === 'string') return erro(MSG_ITEM_ID_STRING);
  if (typeof bruto !== 'number') return erro('itemId é obrigatório e deve ser um número.');
  if (!Number.isSafeInteger(bruto) || bruto <= 0) {
    return erro('itemId deve ser um inteiro positivo.');
  }
  return ok(bruto);
}

/* -------------------------------------------------------------------------- */
/*  The options sanitizer                                                      */
/* -------------------------------------------------------------------------- */

/** One boolean toggle: absent ⇒ its default, present ⇒ it must really be a boolean. */
type ChaveBooleana = {
  [K in keyof ImportacaoShopeeOptions]: ImportacaoShopeeOptions[K] extends boolean ? K : never;
}[keyof ImportacaoShopeeOptions];

function lerBooleano(src: Record<string, unknown>, nome: ChaveBooleana): LeituraCorpo<boolean> {
  const bruto = src[nome];
  if (bruto === undefined) return ok(OPCOES_IMPORTACAO_SHOPEE_PADRAO[nome]);
  // ⚠️ No truthiness: `'false'` is a truthy string and `0` is a falsy number,
  // and either would flip a toggle the operator never touched.
  if (typeof bruto !== 'boolean') return erro(`${nome} deve ser um booleano.`);
  return ok(bruto);
}

/** A `…S` window bound: absent ⇒ the default, `null` ⇒ null, else a positive int. */
function lerSegundos(
  src: Record<string, unknown>,
  nome: 'updateTimeFromS' | 'updateTimeToS',
): LeituraCorpo<number | null> {
  const bruto = src[nome];
  if (bruto === undefined) return ok(OPCOES_IMPORTACAO_SHOPEE_PADRAO[nome]);
  if (bruto === null) return ok(null);
  if (typeof bruto !== 'number' || !Number.isSafeInteger(bruto) || bruto <= 0) {
    return erro(`${nome} deve ser um inteiro positivo de SEGUNDOS (a unidade do wire).`);
  }
  return ok(bruto);
}

/** The status list: deduped, order-preserving, every element inside the four-value enum. */
function lerStatuses(src: Record<string, unknown>): LeituraCorpo<ShopeeImportStatus[]> {
  const bruto = src['statuses'];
  if (bruto === undefined) return ok([...SHOPEE_IMPORT_STATUS_PADRAO]);
  if (!Array.isArray(bruto)) return erro('statuses deve ser uma lista.');
  if (bruto.length === 0) {
    return erro(
      'statuses precisa de pelo menos um valor: o parâmetro é obrigatório no wire e uma lista ' +
        'vazia não emite chave nenhuma, o que a Shopee responde como error_param.',
    );
  }

  const vistos = new Set<string>();
  const aceitos: ShopeeImportStatus[] = [];
  for (const item of bruto as unknown[]) {
    // ⚠️ `safeParse` and never a case fold: `'normal'` is NOT `'NORMAL'` on this
    // wire, and lowercasing it here would send a value Shopee refuses while the
    // operator was told the request was fine.
    const lido = shopeeImportStatusSchema.safeParse(item);
    if (!lido.success) return erro(MSG_STATUS_RECUSADO, CODIGO_STATUS_RECUSADO);
    if (vistos.has(lido.data)) continue;
    vistos.add(lido.data);
    aceitos.push(lido.data);
  }
  return ok(aceitos);
}

/**
 * The run's toggles, filled from {@link OPCOES_IMPORTACAO_SHOPEE_PADRAO}.
 *
 * Unknown keys are IGNORED (the object is rebuilt by name), known keys are
 * type-checked, missing keys take the one default object the schema itself is
 * built from — so the route and `importacaoShopeeOptionsSchema` cannot disagree
 * about what a body that omits everything means.
 *
 * ⚠️ `options: null` is REFUSED rather than defaulted. An absent key is "I did
 * not choose"; an explicit `null` is a caller bug, and quietly running a full
 * catalogue import under default toggles is not the right answer to one.
 */
export function sanitizarOpcoesImportacao(v: unknown): LeituraCorpo<ImportacaoShopeeOptions> {
  const bruto = v === undefined ? {} : v;
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return erro('options deve ser um objeto.');
  }
  const src = bruto as Record<string, unknown>;

  const statuses = lerStatuses(src);
  if (!statuses.ok) return statuses;
  const importarEstoque = lerBooleano(src, 'importarEstoque');
  if (!importarEstoque.ok) return importarEstoque;
  const sobrescreverEstoque = lerBooleano(src, 'sobrescreverEstoque');
  if (!sobrescreverEstoque.ok) return sobrescreverEstoque;
  const importarPreco = lerBooleano(src, 'importarPreco');
  if (!importarPreco.ok) return importarPreco;
  const sobrescreverPreco = lerBooleano(src, 'sobrescreverPreco');
  if (!sobrescreverPreco.ok) return sobrescreverPreco;
  const atualizarProdutoPai = lerBooleano(src, 'atualizarProdutoPai');
  if (!atualizarProdutoPai.ok) return atualizarProdutoPai;
  const sobrescreverDadosProduto = lerBooleano(src, 'sobrescreverDadosProduto');
  if (!sobrescreverDadosProduto.ok) return sobrescreverDadosProduto;
  const importarFotos = lerBooleano(src, 'importarFotos');
  if (!importarFotos.ok) return importarFotos;
  const importarCategorias = lerBooleano(src, 'importarCategorias');
  if (!importarCategorias.ok) return importarCategorias;
  const atualizarCadastrados = lerBooleano(src, 'atualizarCadastrados');
  if (!atualizarCadastrados.ok) return atualizarCadastrados;
  const de = lerSegundos(src, 'updateTimeFromS');
  if (!de.ok) return de;
  const ate = lerSegundos(src, 'updateTimeToS');
  if (!ate.ok) return ate;

  // ⚠️ Both bounds are SECONDS and are only ever compared with each other — the
  // job document's stamps are milliseconds and never enter this comparison.
  if (de.valor !== null && ate.valor !== null && ate.valor <= de.valor) {
    return erro('updateTimeToS deve ser maior que updateTimeFromS.');
  }

  return ok({
    statuses: statuses.valor,
    importarEstoque: importarEstoque.valor,
    sobrescreverEstoque: sobrescreverEstoque.valor,
    importarPreco: importarPreco.valor,
    sobrescreverPreco: sobrescreverPreco.valor,
    atualizarProdutoPai: atualizarProdutoPai.valor,
    sobrescreverDadosProduto: sobrescreverDadosProduto.valor,
    importarFotos: importarFotos.valor,
    importarCategorias: importarCategorias.valor,
    atualizarCadastrados: atualizarCadastrados.valor,
    updateTimeFromS: de.valor,
    updateTimeToS: ate.valor,
  });
}

/* -------------------------------------------------------------------------- */
/*  The three bodies                                                           */
/* -------------------------------------------------------------------------- */

/** `POST /importar` — one listing. */
export interface CorpoImportar {
  readonly integracaoId: string;
  readonly itemId: number;
  readonly options: ImportacaoShopeeOptions;
}

/** `POST /importar-todos` — the whole catalogue. */
export interface CorpoImportarTodos {
  readonly integracaoId: string;
  readonly options: ImportacaoShopeeOptions;
}

/** `POST /importar-todos/cancelar`. */
export interface CorpoCancelar {
  readonly integracaoId: string;
  readonly jobId: string;
}

/**
 * `{ integracaoId, itemId, options? }`.
 *
 * ⚠️ `options` comes back COMPLETE, not partial: the per-item importer's deps
 * declare `ImportacaoShopeeOptions` and there is no second default-merge step
 * behind this route, so filling the gaps here is what keeps the single-item
 * path and the mass-import job running the same toggles.
 */
export function lerCorpoImportar(body: unknown): LeituraCorpo<CorpoImportar> {
  const src = objeto(body);
  if (!src.ok) return src;

  const integracaoId = lerTexto(src.valor, 'integracaoId');
  if (!integracaoId.ok) return integracaoId;
  const itemId = lerItemId(src.valor);
  if (!itemId.ok) return itemId;
  const options = sanitizarOpcoesImportacao(src.valor['options']);
  if (!options.ok) return options;

  return ok({ integracaoId: integracaoId.valor, itemId: itemId.valor, options: options.valor });
}

/** `{ integracaoId, options? }`. */
export function lerCorpoImportarTodos(body: unknown): LeituraCorpo<CorpoImportarTodos> {
  const src = objeto(body);
  if (!src.ok) return src;

  const integracaoId = lerTexto(src.valor, 'integracaoId');
  if (!integracaoId.ok) return integracaoId;
  const options = sanitizarOpcoesImportacao(src.valor['options']);
  if (!options.ok) return options;

  return ok({ integracaoId: integracaoId.valor, options: options.valor });
}

/** `{ integracaoId, jobId }`. */
export function lerCorpoCancelar(body: unknown): LeituraCorpo<CorpoCancelar> {
  const src = objeto(body);
  if (!src.ok) return src;

  const integracaoId = lerTexto(src.valor, 'integracaoId');
  if (!integracaoId.ok) return integracaoId;
  const jobId = lerTexto(src.valor, 'jobId');
  if (!jobId.ok) return jobId;

  return ok({ integracaoId: integracaoId.valor, jobId: jobId.valor });
}
