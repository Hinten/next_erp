/**
 * Map a blocked publish back onto the control that caused it.
 *
 * `POST /publicar` answers 422 `ML_PUBLISH_BLOCKED` with `issues: string[]` —
 * free-text Portuguese assembled by `assemblePublishInput`. Several of those
 * strings already carry the field key in parentheses, which is what makes a
 * deterministic mapping possible at all.
 *
 * ⚠️ Regex-matching prose is a **stopgap**, and deliberately a safe one: every
 * issue is ALSO rendered verbatim in the blocked-publish alert, so a mapping
 * miss loses nothing — it just doesn't highlight a field. When the server grows
 * a structured `issueDetails` shape, {@link mapPublishIssues} prefers it and
 * this table becomes the fallback for older responses.
 */

/** Where an issue belongs, so the UI knows what to highlight or link to. */
export type PublishIssueScope = 'listing' | 'produto' | 'integracao' | 'variacao';

export interface PublishIssueTarget {
  scope: PublishIssueScope;
  /** A listing form field name, when the issue names one. */
  field: string | null;
  /** The produto tab to point at, when the fix lives there. */
  produtoSection: string | null;
  message: string;
}

/** The optional structured shape the server may send alongside `issues`. */
export interface PublishIssueDetail {
  code?: string | null;
  path?: string | null;
  message: string;
}

/** Field keys the server embeds in parentheses. */
const FIELD_KEYS: Record<string, PublishIssueTarget['scope']> = {
  category_id: 'listing',
  listing_type_id: 'listing',
  tabelaNormalOuterRef: 'integracao',
};

interface KeywordRule {
  match: RegExp;
  scope: PublishIssueScope;
  field?: string;
  produtoSection?: string;
}

/**
 * Ordered — first match wins, so the more specific patterns come first.
 * Mirrors the strings raised in `publishCore.ts` / `publish.ts`.
 */
const KEYWORD_RULES: KeywordRule[] = [
  { match: /sem preço na tabela/i, scope: 'produto', produtoSection: 'Preço e custo' },
  { match: /sem tabela de preços/i, scope: 'integracao' },
  { match: /sem atributos de combinação/i, scope: 'variacao' },
  { match: /caminho de variação inválido|grupo\/variante não encontrado/i, scope: 'variacao' },
  { match: /produto sem fotos/i, scope: 'produto', produtoSection: 'Fotos' },
  { match: /produto sem nome/i, scope: 'produto', produtoSection: 'Dados gerais' },
  { match: /é uma variação/i, scope: 'produto' },
  // #798 — the mid-UPtin block is a whole-listing STATE: nothing in the
  // integração form fixes it, so it must be caught above the generic
  // `user products` rule below (which would scope it to the account). Anchored
  // on its own wording rather than on "user products" alone, so it claims no
  // more than the one string it exists for.
  //
  // ⚠️ Its sibling — the UP + variations refusal — was DELETED with the fan-out
  // that made it unnecessary. A mapping rule outlives the message it was written
  // for silently, and then starts capturing whatever prose comes next; when a
  // block goes, its rule goes with it.
  { match: /em migração para o modelo user products/i, scope: 'listing' },
  { match: /user products|user_product_seller/i, scope: 'integracao' },
];

/** Map one free-text issue onto a target. Unmatched ⇒ a whole-listing banner. */
export function mapPublishIssue(issue: string): PublishIssueTarget {
  const keyed = /\(([a-zA-Z_]+)\)/.exec(issue);
  const key = keyed?.[1];
  if (key && key in FIELD_KEYS) {
    const scope = FIELD_KEYS[key]!;
    return {
      scope,
      field: scope === 'listing' ? key : null,
      produtoSection: null,
      message: issue,
    };
  }

  for (const rule of KEYWORD_RULES) {
    if (!rule.match.test(issue)) continue;
    return {
      scope: rule.scope,
      field: rule.field ?? null,
      produtoSection: rule.produtoSection ?? null,
      message: issue,
    };
  }

  return { scope: 'listing', field: null, produtoSection: null, message: issue };
}

/**
 * Map a whole 422 body. Prefers the structured `issueDetails` when the server
 * sends it, so this works against today's server and gets exact for free later.
 */
export function mapPublishIssues(
  issues: string[] | null | undefined,
  details?: PublishIssueDetail[] | null,
): PublishIssueTarget[] {
  if (details && details.length > 0) {
    return details.map((d) => ({
      scope: scopeForPath(d.path),
      field: fieldForPath(d.path),
      produtoSection: null,
      message: d.message,
    }));
  }
  return (issues ?? []).map(mapPublishIssue);
}

function scopeForPath(path: string | null | undefined): PublishIssueScope {
  if (!path) return 'listing';
  if (path.startsWith('variacao')) return 'variacao';
  if (path.startsWith('produto')) return 'produto';
  if (path.startsWith('integracao')) return 'integracao';
  return 'listing';
}

function fieldForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  // `attributes.BRAND` → the attribute row; `category_id` → the field itself.
  const [head, tail] = path.split('.');
  if (head === 'attributes' && tail) return `attributes.${tail}`;
  return head ?? null;
}

/**
 * ML's own rejections arrive as one prose message, not a field list. Pull out
 * SCREAMING_SNAKE tokens that match a **known** attribute id — never a blind
 * regex, which would highlight random words in a Portuguese sentence.
 */
export function attributeIdsInMessage(message: string, knownIds: Iterable<string>): string[] {
  const known = new Set(knownIds);
  const found = new Set<string>();
  for (const token of message.match(/[A-Z][A-Z0-9_]{2,}/g) ?? []) {
    if (known.has(token)) found.add(token);
  }
  return [...found];
}
