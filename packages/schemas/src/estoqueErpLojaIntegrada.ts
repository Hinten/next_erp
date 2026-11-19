import { makeEstoqueUid } from './produto/collection/estoque';
import { contaDoLinkLi, vinculoLiConta } from './produto/collection/lojaIntegradaLink';
import { inteiroPositivoCanonicoLi } from './mapaFreteLojaIntegrada';
import { toOuterRef, toOuterRefOrNull } from './shared/outerRef';

/**
 * The ERP-side READERS of the Loja Integrada stock sync (master plan step 12) that more than one
 * surface needs the identical answer from: which produto and record a stock path names, which
 * depósito a conta stocks from and the two stored forms of its ref, which record of a produto
 * the run reads at that depósito, and what the conta's links on one produto say.
 *
 * They moved here from `apps/loja-integrada/lib/lojaIntegrada/estoque/` (`quantidadeEstoqueLi.ts`,
 * `leituraEstoqueErp.ts` and `planoEstoqueLi.ts`, which re-export them, so no importer changed)
 * because a `tools/migrations` audit needs exactly these answers and cannot import an app — the
 * same move `contaDoLinkLi` and `vinculoLiConta` made for the anchor census. One copy of each
 * rule: a second one drifts toward plausible while reading correct (root `CLAUDE.md`, #1369).
 *
 * PURE: no clock, no network, no Firestore, no environment read.
 */

/* -------------------------------------------------------------------------- */
/*                                   Paths                                     */
/* -------------------------------------------------------------------------- */

/**
 * One stock record as a read hands it over: its full document path
 * (`produtos/{produtoId}/estoques/{estoqueId}`) and its raw data.
 */
export interface DocEstoqueLi {
  readonly caminho: string;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** A stock record's path, split. */
export interface CaminhoEstoqueLi {
  readonly produtoId: string;
  readonly estoqueId: string;
}

const CAMINHO_ESTOQUE = /^produtos\/([^/]+)\/estoques\/([^/]+)$/;

/**
 * The owner and the id of a stock record from its path, or `null` when the text is not exactly
 * `produtos/{produtoId}/estoques/{estoqueId}` (a leading slash, a `documents/` prefix, another
 * collection, an empty segment — an Admin SDK path is never any of those).
 *
 * Equal: `produtos/p1/estoques/e1` ⇒ `{ produtoId: 'p1', estoqueId: 'e1' }`.
 * Distinct (`null`): `/produtos/p1/estoques/e1`, `documents/produtos/p1/estoques/e1`,
 * `produtos/p1/historicoEstoque/e1`, `produtos//estoques/e1`, a record one level deeper.
 */
export function caminhoEstoqueLi(caminho: string): CaminhoEstoqueLi | null {
  const m = CAMINHO_ESTOQUE.exec(caminho);
  if (m === null) return null;
  const [, produtoId, estoqueId] = m;
  if (produtoId === undefined || estoqueId === undefined) return null;
  return { produtoId, estoqueId };
}

/** A document id that can sit in one path segment: not empty, no `/`. */
export function segmentoDeCaminhoLi(id: string): boolean {
  return id !== '' && !id.includes('/');
}

/* -------------------------------------------------------------------------- */
/*                                 Depósito                                    */
/* -------------------------------------------------------------------------- */

/**
 * Both stored forms of a depósito ref: `documents/depositos/<id>`, then `depositos/<id>`.
 * Firestore equality is exact, so every query and every in-code check names both; a spelling
 * neither form matches (a leading slash, a case change) is not found by them.
 */
export function formasDoDepositoLi(depositoId: string): readonly [string, string] {
  return [toOuterRef(`depositos/${depositoId}`), `depositos/${depositoId}`];
}

/**
 * The conta's depósito as a BARE document id, or `null` when its `depositoOuterRef` does not name
 * exactly one `depositos` document (absent, `null`, another collection, a nested path, junk).
 * Either stored form is read.
 *
 * Equal (⇒ `'D1'`): `'documents/depositos/D1'` ≡ `'depositos/D1'` ≡ `'/documents/depositos/D1'`.
 * Distinct: `'documents/depositos/D2'` ⇒ `'D2'`; `'documents/filiais/D1'`,
 * `'documents/depositos/D1/sub/x'`, `'D1'`, `null`, a number ⇒ `null`.
 */
export function depositoDaContaLi(conta: { readonly depositoOuterRef?: unknown }): string | null {
  const ref = toOuterRefOrNull(conta.depositoOuterRef);
  if (ref === null) return null;
  const partes = ref.split('/');
  const id = partes[2];
  if (partes.length !== 3 || partes[1] !== 'depositos' || id === undefined) return null;
  return segmentoDeCaminhoLi(id) ? id : null;
}

/** The produto's own stock records at the conta's depósito, resolved to at most one. */
export type EstoqueNoDepositoLi =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'um'; readonly registro: DocEstoqueLi }
  /** Two or more, none of them the canonical id: which one to read is not ours to guess. */
  | { readonly tipo: 'ambiguo' };

/**
 * One produto's records at the conta's depósito (the caller's query already filtered the
 * depósito) → the one to read: none; the only one; the canonical `est-<produto>-<depósito>`
 * (`makeEstoqueUid`) among several, since a legacy auto-id record may sit beside it; else
 * `ambiguo`. The same path read twice counts once.
 *
 * `depositoId` is the depósito's BARE document id, never its ref (`documents/depositos/<id>` or
 * `depositos/<id>`): a ref would build a canonical id no document can have, and every pair of a
 * canonical and a legacy record would read `ambiguo` — the produto held for good.
 *
 * Throws `RangeError` on a path that does not parse, a record of another produto, or a
 * `produtoId` / `depositoId` that is not one path segment (all three are bugs).
 */
export function estoqueNoDepositoLi(args: {
  readonly produtoId: string;
  readonly depositoId: string;
  readonly registros: readonly DocEstoqueLi[];
}): EstoqueNoDepositoLi {
  if (!segmentoDeCaminhoLi(args.produtoId) || !segmentoDeCaminhoLi(args.depositoId)) {
    throw new RangeError('estoqueNoDepositoLi: produto e depósito são ids, nunca refs');
  }
  const porId = new Map<string, DocEstoqueLi>();
  for (const registro of args.registros) {
    const partes = caminhoEstoqueLi(registro.caminho);
    if (partes === null || partes.produtoId !== args.produtoId) {
      throw new RangeError('estoqueNoDepositoLi: registro de outro produto ou caminho inválido');
    }
    porId.set(partes.estoqueId, registro);
  }
  const unicos = [...porId.values()];
  const [primeiro] = unicos;
  if (primeiro === undefined) return { tipo: 'nenhum' };
  if (unicos.length === 1) return { tipo: 'um', registro: primeiro };
  const canonico = porId.get(makeEstoqueUid(args.produtoId, args.depositoId));
  return canonico === undefined ? { tipo: 'ambiguo' } : { tipo: 'um', registro: canonico };
}

/* -------------------------------------------------------------------------- */
/*                         The conta's links on a produto                      */
/* -------------------------------------------------------------------------- */

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Readonly<Record<string, unknown>>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/** A parent link: a root whose `grades` is a non-empty list. */
function ehLinkPai(link: Readonly<Record<string, unknown>>): boolean {
  const grades = proprio(link, 'grades');
  return Array.isArray(grades) && grades.length > 0;
}

/** What the conta's links on one produto say, before anything else is read. */
export type VinculoDaContaLi =
  | { readonly tipo: 'sem-vinculo' }
  | { readonly tipo: 'pai' }
  | { readonly tipo: 'nao-suportado' }
  | { readonly tipo: 'vinculo-ambiguo' }
  /** Exactly one store product of the conta, linked as a child. */
  | { readonly tipo: 'vinculado'; readonly idLi: string };

/** The conta's COUNTING links among a produto's own (`contaDoLinkLi` + `vinculoLiConta`). */
function vinculosQueContamLi(
  contaId: string,
  links: readonly unknown[],
): Readonly<Record<string, unknown>>[] {
  return links
    .filter(ehObjeto)
    .filter((link) => contaDoLinkLi(link) === contaId && vinculoLiConta(link));
}

/** The distinct store ids of counting links, as canonical decimal text, sorted. */
function idsDosVinculosQueContamLi(
  daConta: readonly Readonly<Record<string, unknown>>[],
): string[] {
  const ids = new Set<string>();
  for (const link of daConta) {
    const id = inteiroPositivoCanonicoLi(proprio(link, 'id'));
    if (id !== null) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * The store ids the conta's COUNTING links on one produto name — roots and children alike — as
 * canonical decimal text, deduplicated and sorted: the ids {@link vinculoDaContaLi} decides over,
 * through the SAME two steps (one copy of the rule). The daily reconcile keys its snapshot entries
 * of a produto it does not send (`pai`, `nao-suportado`, `vinculo-ambiguo`, which carry no id)
 * by them.
 *
 * Equal: `123` and `'123'` on two links ⇒ `['123']`. Distinct: two ids ⇒ both; another conta's
 * link, one in the trash and `'0123'` ⇒ none.
 */
export function idsDosVinculosDaContaLi(contaId: string, links: readonly unknown[]): string[] {
  return idsDosVinculosQueContamLi(vinculosQueContamLi(contaId, links));
}

/**
 * The first three steps of the stock run's plan for one (conta, produto), from the produto's OWN
 * `produtolojaintegrada` documents (raw, every conta's) alone, in this order:
 *
 *  1. no counting link of the conta (`contaDoLinkLi` + `vinculoLiConta`, the anchor's readers)
 *     ⇒ `sem-vinculo`;
 *  2. the conta's counting links — roots AND children — naming two store ids ⇒ `vinculo-ambiguo`
 *     (two documents of ONE id are one store product: a number and its canonical decimal text);
 *  3. no counting CHILD link (`paiProdutoIntegradaId` set; absent or `null` is a root): only
 *     parent roots (a non-empty `grades`) ⇒ `pai`, any root without grades ⇒ `nao-suportado`;
 *  4. otherwise `vinculado`, with the store id as canonical decimal text.
 *
 * Equal: a child link with `id: 123` and another of the same conta with `id: '123'` ⇒
 * `vinculado` `'123'`. Distinct: two different ids ⇒ `vinculo-ambiguo`; another conta's link,
 * a link in the trash or with `id: '0123'` ⇒ not counted at all.
 */
export function vinculoDaContaLi(contaId: string, links: readonly unknown[]): VinculoDaContaLi {
  const daConta = vinculosQueContamLi(contaId, links);
  if (daConta.length === 0) return { tipo: 'sem-vinculo' };

  const ids = idsDosVinculosQueContamLi(daConta);
  if (ids.length > 1) return { tipo: 'vinculo-ambiguo' };
  const [idLi] = ids;
  // Unreachable: `vinculoLiConta` counts a link only when the same reader reads its id.
  if (idLi === undefined) return { tipo: 'sem-vinculo' };

  if (!daConta.some((link) => proprio(link, 'paiProdutoIntegradaId') != null)) {
    return daConta.every(ehLinkPai) ? { tipo: 'pai' } : { tipo: 'nao-suportado' };
  }
  return { tipo: 'vinculado', idLi };
}
