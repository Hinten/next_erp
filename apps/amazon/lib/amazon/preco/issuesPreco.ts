/**
 * The price-issue classifier of the Amazon price push (step 13, PR 13-c), pure:
 * which of Amazon's listing issues are about the PRICE, and how much each one
 * weighs. The task's answer and its later check, a price feed's report and a
 * run's page read issues through it alone.
 *
 * ## A price issue
 *
 * An issue is about the price when ANY of these holds:
 *
 *  - one of its `categories` is `INVALID_PRICE` or `MISSING_PRICE`;
 *  - one of its `attributeNames` is the offer attribute (`purchasable_offer`)
 *    or one of the three prices inside it;
 *  - its `code` is one of the documented price codes (`19037` below the floor,
 *    `19038` above the ceiling, `18701` a potential pricing error, `18155` a
 *    floor above the selling price): the backstop for an issue that carries
 *    no category at all, as a feed report's own issues never do.
 *
 * …unless the issue NAMES the stores it applies to (`marketplaceIds`, a
 * non-empty list of strings) and the BR store is not among them. An issue
 * that names no store, or names them in a shape this reader cannot read, is
 * kept: counting a price issue too many raises an aviso, while counting one
 * too few hides a refusal.
 *
 * ## Its class
 *
 *  - `requer-pessoa` — code `18701`: Amazon asks a person to confirm the price,
 *    so no automatic path ever sends it again, whatever its severity;
 *  - `aviso` — severity exactly `WARNING` or `INFO`: it blocks nothing;
 *  - `erro` — `ERROR`, and every other or missing severity: an unknown
 *    severity is read as blocking.
 *
 * {@link temIssuePrecoBloqueanteAmazon} asks for `erro` or `requer-pessoa`
 * only: what a run counts toward the conta's price-refusal aviso, and what
 * keeps an accepted send `aceito-com-avisos` at its check.
 *
 * ## The codes a task carries
 *
 * {@link codigosPrecoAmazon}: the distinct price-issue codes of a read, in
 * code order, at most {@link MAX_CODIGOS_ANTES_PRECO_AMAZON}, each inside
 * {@link CODIGO_ISSUE_AMAZON_REGEX} (a code outside it is left out, so the
 * same issue read later counts as new, which only refuses more).
 *
 * Every code, category, attribute, severity and store id is compared as an
 * EXACT string; only an issue's OWN fields are read.
 *
 * PURE: no Firestore, no clock, no network.
 */
import { MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';

/** The categories that make an issue a price issue. */
export const CATEGORIAS_ISSUE_PRECO_AMAZON: readonly string[] = ['INVALID_PRICE', 'MISSING_PRICE'];

/** The attributes that make an issue a price issue: the offer, and its three prices. */
export const ATRIBUTOS_ISSUE_PRECO_AMAZON: readonly string[] = [
  'purchasable_offer',
  'our_price',
  'minimum_seller_allowed_price',
  'maximum_seller_allowed_price',
];

/** The documented price codes: the backstop for an issue with no category. */
export const CODIGOS_ISSUE_PRECO_AMAZON: readonly string[] = ['19037', '19038', '18701', '18155'];

/** The code a person must confirm: never sent again automatically. */
export const CODIGO_ISSUE_PRECO_REQUER_PESSOA_AMAZON = '18701';

/** The severities that block nothing; any other (or none) blocks. */
const SEVERIDADES_SEM_BLOQUEIO: readonly string[] = ['WARNING', 'INFO'];

/** An issue code a task payload may carry. */
export const CODIGO_ISSUE_AMAZON_REGEX = /^[A-Za-z0-9_.-]{1,32}$/;

/** The most price-issue codes one task carries. */
export const MAX_CODIGOS_ANTES_PRECO_AMAZON = 10;

/** How much one price issue weighs (module header). */
export type ClasseIssuePrecoAmazon = 'erro' | 'aviso' | 'requer-pessoa';

/** The closed set, so code names a member instead of spelling a slug. */
export const CLASSE_ISSUE_PRECO_AMAZON = {
  erro: 'erro',
  aviso: 'aviso',
  requerPessoa: 'requer-pessoa',
} as const satisfies Record<string, ClasseIssuePrecoAmazon>;

/** An OWN field of a plain object, or `undefined`. */
function campo(issue: unknown, chave: string): unknown {
  if (typeof issue !== 'object' || issue === null || Array.isArray(issue)) return undefined;
  return Object.hasOwn(issue, chave) ? (issue as Record<string, unknown>)[chave] : undefined;
}

/** The strings of a list field; an absent or non-list field holds none. */
function textos(valor: unknown): string[] {
  return Array.isArray(valor) ? valor.filter((v): v is string => typeof v === 'string') : [];
}

/** The issue names the stores it applies to, and the BR store is not one of them. */
function deOutraLoja(issue: unknown): boolean {
  const lojas = textos(campo(issue, 'marketplaceIds'));
  return lojas.length > 0 && !lojas.includes(MARKETPLACE_ID_BR);
}

/** The issue is about the price (module header), store aside. */
function falaDoPreco(issue: unknown): boolean {
  const codigo = campo(issue, 'code');
  return (
    textos(campo(issue, 'categories')).some((c) => CATEGORIAS_ISSUE_PRECO_AMAZON.includes(c)) ||
    textos(campo(issue, 'attributeNames')).some((a) => ATRIBUTOS_ISSUE_PRECO_AMAZON.includes(a)) ||
    (typeof codigo === 'string' && CODIGOS_ISSUE_PRECO_AMAZON.includes(codigo))
  );
}

/**
 * The class of one issue (module header), or `null` when it is not a price
 * issue of the BR store. Total: anything that is not an issue is `null`.
 */
export function classeDaIssuePrecoAmazon(issue: unknown): ClasseIssuePrecoAmazon | null {
  if (!falaDoPreco(issue) || deOutraLoja(issue)) return null;
  if (campo(issue, 'code') === CODIGO_ISSUE_PRECO_REQUER_PESSOA_AMAZON) {
    return CLASSE_ISSUE_PRECO_AMAZON.requerPessoa;
  }
  const severidade = campo(issue, 'severity');
  return typeof severidade === 'string' && SEVERIDADES_SEM_BLOQUEIO.includes(severidade)
    ? CLASSE_ISSUE_PRECO_AMAZON.aviso
    : CLASSE_ISSUE_PRECO_AMAZON.erro;
}

/** An issue's own `code`, when it is a string; else `null`. */
export function codigoDaIssueAmazon(issue: unknown): string | null {
  const codigo = campo(issue, 'code');
  return typeof codigo === 'string' ? codigo : null;
}

/** Whether one issue is a price issue of the BR store, of any class. */
export function ehIssuePrecoAmazon(issue: unknown): boolean {
  return classeDaIssuePrecoAmazon(issue) !== null;
}

/** The issues of a read, as a list: an absent or non-list value holds none. */
export function listaDeIssuesAmazon(issues: unknown): readonly unknown[] {
  return Array.isArray(issues) ? issues : [];
}

/** Whether a read carries at least one price issue of the BR store. */
export function temIssuePrecoAmazon(issues: unknown): boolean {
  return listaDeIssuesAmazon(issues).some(ehIssuePrecoAmazon);
}

/**
 * Whether one issue is a BLOCKING price issue of the BR store: class `erro`
 * or `requer-pessoa`. An `aviso` blocks nothing, so it never says Amazon
 * refused a price.
 */
export function ehIssuePrecoBloqueanteAmazon(issue: unknown): boolean {
  const classe = classeDaIssuePrecoAmazon(issue);
  return classe !== null && classe !== CLASSE_ISSUE_PRECO_AMAZON.aviso;
}

/** Whether a read carries at least one BLOCKING price issue of the BR store. */
export function temIssuePrecoBloqueanteAmazon(issues: unknown): boolean {
  return listaDeIssuesAmazon(issues).some(ehIssuePrecoBloqueanteAmazon);
}

/**
 * The distinct price-issue codes of a read (module header, "The codes a task
 * carries"): in code order, at most {@link MAX_CODIGOS_ANTES_PRECO_AMAZON}.
 */
export function codigosPrecoAmazon(issues: unknown): string[] {
  const codigos = new Set<string>();
  for (const issue of listaDeIssuesAmazon(issues)) {
    if (!ehIssuePrecoAmazon(issue)) continue;
    const codigo = codigoDaIssueAmazon(issue);
    if (codigo !== null && CODIGO_ISSUE_AMAZON_REGEX.test(codigo)) codigos.add(codigo);
  }
  return [...codigos].sort().slice(0, MAX_CODIGOS_ANTES_PRECO_AMAZON);
}
