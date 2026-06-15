// Custom rule: every collection `defaultQuery` must have a matching Firestore
// composite index in `firestore.indexes.json`.
//
// Firestore Enterprise (this project's edition) creates NO indexes
// automatically — an unindexed query silently degrades to a full collection
// scan — so a declared default query without its index is a latent
// performance/cost bug. This rule derives the required index statically from
// the `defaultQuery` literal (via the shared `lib/required-index.js`) and
// checks it against the committed index file, reporting right at the
// declaration with ready-to-paste JSON.
//
// To stay honest the rule requires `defaultQuery` to be a plain literal: if it
// can't be evaluated statically (spreads, identifiers, calls) it reports
// `notStaticLiteral` rather than skipping — otherwise the check could be
// silently bypassed.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { deriveRequiredIndex, formatIndexJson, indexSatisfies } from './lib/required-index.js';

const PARSE_ERROR = Symbol('parse-error');

// Cache parsed index files by path, invalidated by mtime — a single lint run
// visits every meta but the file changes at most once.
const indexCache = new Map();

/** Walk up from `startDir` to the dir containing `pnpm-workspace.yaml`. */
function findRepoRoot(startDir) {
  let dir = startDir;
  while (dir && dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** Resolve the firestore.indexes.json path from rule options or the repo root. */
function resolveIndexesPath(context) {
  const configured = context.options?.[0]?.indexesPath;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(context.cwd ?? process.cwd(), configured);
  }
  const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
  const start = filename ? dirname(filename) : (context.cwd ?? process.cwd());
  const root = findRepoRoot(start) ?? findRepoRoot(context.cwd ?? process.cwd());
  return root ? resolve(root, 'firestore.indexes.json') : null;
}

/** Read + parse the index file, cached by mtime. Returns PARSE_ERROR on bad JSON. */
function loadIndexes(indexesPath) {
  const { mtimeMs } = statSync(indexesPath);
  const cached = indexCache.get(indexesPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.parsed;
  const text = readFileSync(indexesPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return PARSE_ERROR;
    throw err;
  }
  indexCache.set(indexesPath, { mtimeMs, parsed });
  return parsed;
}

/**
 * Statically evaluate an AST node into a JS value. Accepts only plain literals,
 * arrays and objects (plus unary minus on numbers). Returns
 * `{ ok: false, node }` pointing at the first non-static node.
 */
function evalNode(node) {
  switch (node.type) {
    case 'Literal':
      return { ok: true, value: node.value };
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal') {
        return { ok: true, value: -node.argument.value };
      }
      return { ok: false, node };
    case 'ArrayExpression': {
      const out = [];
      for (const el of node.elements) {
        if (!el) return { ok: false, node };
        const r = evalNode(el);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case 'ObjectExpression': {
      const out = {};
      for (const prop of node.properties) {
        if (prop.type !== 'Property' || prop.computed) return { ok: false, node: prop };
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'Literal'
              ? String(prop.key.value)
              : null;
        if (key === null) return { ok: false, node: prop.key };
        const r = evalNode(prop.value);
        if (!r.ok) return r;
        out[key] = r.value;
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false, node };
  }
}

/** Find a sibling `collectionPath` string literal in the enclosing object. */
function collectionPathSibling(defaultQueryProp) {
  const obj = defaultQueryProp.parent;
  if (!obj || obj.type !== 'ObjectExpression') return null;
  for (const prop of obj.properties) {
    if (
      prop.type === 'Property' &&
      !prop.computed &&
      prop.key.type === 'Identifier' &&
      prop.key.name === 'collectionPath' &&
      prop.value.type === 'Literal' &&
      typeof prop.value.value === 'string'
    ) {
      return prop.value.value;
    }
  }
  return null;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a matching Firestore index in firestore.indexes.json for every collection defaultQuery.',
    },
    schema: [
      {
        type: 'object',
        properties: { indexesPath: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      missingIndex:
        'No matching Firestore index for this defaultQuery. Firestore Enterprise creates no ' +
        'indexes automatically, so this query would scan the whole collection. Add to the ' +
        '"indexes" array of firestore.indexes.json and run `firebase deploy --only ' +
        'firestore:indexes`:\n{{json}}',
      notStaticLiteral:
        'defaultQuery must be a plain literal (no spreads, identifiers or calls) so the ' +
        'Firestore index validator can derive its index at lint time.',
      indexesUnreadable:
        'Could not read firestore.indexes.json ({{reason}}) to validate this defaultQuery.',
    },
  },
  create(context) {
    return {
      "Property[key.name='defaultQuery']"(node) {
        // Only fire inside an object that also declares a string collectionPath
        // — i.e. a CollectionMetadata literal. Keeps the rule safe repo-wide.
        const collectionPath = collectionPathSibling(node);
        if (collectionPath === null) return;

        const evaluated = evalNode(node.value);
        if (!evaluated.ok) {
          context.report({ node: evaluated.node, messageId: 'notStaticLiteral' });
          return;
        }
        const defaultQuery = evaluated.value;
        if (
          !defaultQuery ||
          typeof defaultQuery !== 'object' ||
          !Array.isArray(defaultQuery.orderBy)
        ) {
          // Malformed shape — let the type system flag it; nothing to derive.
          return;
        }

        const indexesPath = resolveIndexesPath(context);
        if (!indexesPath || !existsSync(indexesPath)) {
          context.report({
            node: node.value,
            messageId: 'indexesUnreadable',
            data: { reason: indexesPath ? 'file not found' : 'repo root not found' },
          });
          return;
        }
        const parsed = loadIndexes(indexesPath);
        if (parsed === PARSE_ERROR) {
          context.report({
            node: node.value,
            messageId: 'indexesUnreadable',
            data: { reason: 'invalid JSON' },
          });
          return;
        }

        const required = deriveRequiredIndex(collectionPath, defaultQuery);
        const indexes = Array.isArray(parsed.indexes) ? parsed.indexes : [];
        if (!indexes.some((idx) => indexSatisfies(idx, required))) {
          context.report({
            node: node.value,
            messageId: 'missingIndex',
            data: { json: formatIndexJson(required) },
          });
        }
      },
    };
  },
};

export default rule;
