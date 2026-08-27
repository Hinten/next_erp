// Custom rule: never assert a type onto a body that came back from a fetch.
//
// ## What it exists for
//
// Six near-identical HTTP clients in this repo ended their success path with
// `return parsed as T` — a compile-time assertion with no runtime check. On any
// 2xx the caller received whatever arrived wearing a type nobody verified, and
// the three ways that could go wrong were all silent: the wrong shape came back
// cast (missing fields simply `undefined`), an empty body came back as
// `null as T`, and a proxy's HTML came back as `null` or — worse —
// `{error: '<html>…'}`, a TRUTHY object that sailed through `if (conta)` guards.
//
// It is what made the buyer-mint bug invisible (#1295 → #1302): a backend one
// revision behind minted nothing, wiped a credential and answered 200, and the
// cast reported it as success while the panel revealed the seller's password.
//
// The fix, everywhere, was to pass the schema the response is described by and
// return `z.infer<S>` — at which point there is no cast left to be wrong. This
// rule keeps the pattern from being copy-pasted back in a seventh time.
//
// ## What it flags — two shapes, both purely syntactic
//
//  1. A cast applied DIRECTLY to `JSON.parse(…)` or a zero-argument
//     `<expr>.json()` — a body read.
//  2. A cast to a TYPE PARAMETER of the enclosing function. A caller-chosen
//     type can never be verified by a cast, so the assertion is unsound by
//     construction.
//
// ⚠️ **Both additionally require a TRANSPORT CALL in an enclosing function**,
// and that qualifier is the whole reason this rule can sit at `error`. It was
// arrived at by measuring, three times, not by guessing:
//
//  - Without it on shape 1, the rule reported **~120 sites across 18
//    workspaces**: service-account files, test fixtures, `sessionStorage`
//    strings, cached JSON. JSON parsing is not networking.
//  - Relaxing it for `.json()` alone — on the theory that a zero-arg `.json()`
//    must be a Response read — still reported **~70**, nearly all of them TEST
//    files reading back the `NextResponse` their own route handler returned.
//    That is not a network response either.
//  - Without it on shape 2, it flags `snap.data() as T` on a Firestore
//    snapshot, which is character-for-character the banned shape and perfectly
//    correct — three real sites look like that (`pedido-print/assemble.ts`,
//    `etiqueta-generica/model.ts`, `etiquetaActions.ts`), as does the identity
//    cast in `apps/nfe/lib/nfe/log.ts`'s recursive redactor.
//
// With it: **6 sites, every one a genuine unvalidated provider response.**
//
// ⚠️ The transport list is EXPLICIT (`fetch`, `doFetch`, `fetchImpl`) rather
// than a `*fetch*` pattern, because this repo has a dozen functions named
// `fetchProdutoPesoMap`, `fetchStockFamilies`, `fetchPrecoPage` — every one of
// which reads Firestore. "Fetch" means "go and get"; it does not mean HTTP.
//
// This follows the doctrine `no-lossy-date-parse.js` states: precise over
// exhaustive, because zero false positives is what makes a rule safe at `error`
// — and `lint-staged` runs `--max-warnings 0`, so a noisy rule blocks commits
// repo-wide.
//
// ## The escape hatch, and why it is `as unknown`
//
// `JSON.parse(text) as unknown` is ALLOWED and is the repo's own good pattern
// (`packages/ai/src/admin/provider.ts`): it widens instead of asserting, so the
// caller is forced to narrow. Say it once, honestly, rather than claiming a
// shape nothing checked. Shape 2 has no escape on purpose — a caller-chosen
// type parameter in a fetch helper is exactly the thing being removed, and the
// fix is to take a schema.
//
// ## What it CANNOT catch — do not mistake a green run for coverage
//
//  - `const x: Foo = await res.json()`. An ANNOTATION, not a cast, and
//    `res.json()` is `any`, so TypeScript accepts it in silence. Catching it
//    needs the type checker, and `@typescript-eslint/no-unsafe-assignment`
//    floods on the untyped Firebase/SOAP surfaces (see the note in
//    `config-eslint/index.js` on why `recommendedTypeChecked` is off).
//  - An INBOUND `await req.json() as Body` in a route handler. Same defect,
//    opposite direction, and out of scope by construction: a handler does not
//    call the transport, so no evidence distinguishes it from a test reading
//    its own NextResponse. The ~40 in this repo already narrow each field by
//    hand.
//  - A schema that is too loose. `lerRespostaJson(text, z.any())` satisfies this
//    rule and checks nothing.
//  - A SEMANTIC mismatch: a well-formed body that describes work which did not
//    happen. No rule catches that class; `exigirMintAvulso` in
//    `apps/web/lib/mercado-livre/client.ts` is the hand-written answer, and the
//    reason it must not be "simplified" into a schema.
//  - `packages/integrations/nfe` ignores `generated/**`, `ca/**`, `test/**`,
//    `scripts/**` and `src/codegen/**`, so ESLint never sees those trees.
//
// A distinct rule NAME, so it survives the `no-restricted-syntax` overrides in
// the six apps that redeclare that rule — flat config does full replacement per
// name, never across names.

/**
 * The transport call, as an EXPLICIT short list — every real HTTP client in
 * this repo reaches the network through one of these names.
 *
 * ⚠️ Not a `\\w*[Ff]etch\\w*` pattern. That also matches `fetchProdutoPesoMap(`,
 * `fetchStockFamilies(`, `fetchPrecoPage(` and a dozen more — all of which read
 * FIRESTORE. "Fetch" in a function name means "go and get"; it does not mean
 * HTTP, and a rule sitting at `error` cannot guess.
 */
const FETCH_CALL = /\b(?:globalThis\.)?(?:fetch|doFetch|fetchImpl)\s*\(/;

/**
 * A receiver name that means the INBOUND request, not a response. Casting
 * `await req.json()` is the same defect in the opposite direction and is
 * deliberately out of scope: those handlers have no fetch, and the ~40 of them
 * in this repo already narrow each field by hand.
 */
const INBOUND_RECEIVERS = new Set(['req', 'request']);

/** `unknown` — the sanctioned widening, never an assertion. */
function isUnknownType(typeAnnotation) {
  return typeAnnotation?.type === 'TSUnknownKeyword';
}

/** `JSON.parse(x)` */
function isJsonParse(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'JSON' &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'parse'
  );
}

/**
 * `<expr>.json()` reading a RESPONSE body.
 *
 * Zero arguments, because `NextResponse.json(body)` / `Response.json(body)` are
 * static BUILDERS that take one — the same member name doing the opposite job.
 * And not `req.json()` / `request.json()`, which is the inbound direction.
 */
function isResponseBodyRead(node) {
  if (node?.type !== 'CallExpression') return false;
  if (node.arguments.length > 0) return false;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression') return false;
  if (callee.property?.type !== 'Identifier' || callee.property.name !== 'json') return false;
  if (callee.object?.type === 'Identifier') {
    if (callee.object.name === 'JSON') return false;
    if (INBOUND_RECEIVERS.has(callee.object.name)) return false;
  }
  return true;
}

/** Strip `await` and `!` so `(await res.json()) as X` is seen. */
function unwrap(node) {
  let cur = node;
  while (cur && (cur.type === 'AwaitExpression' || cur.type === 'TSNonNullExpression')) {
    cur = cur.type === 'AwaitExpression' ? cur.argument : cur.expression;
  }
  return cur;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'TSDeclareFunction',
]);

/** The enclosing functions, innermost first. */
function enclosingFunctions(node) {
  const out = [];
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (FUNCTION_TYPES.has(cur.type)) out.push(cur);
  }
  return out;
}

/** Does this function declare a type parameter called `name`? */
function declaresTypeParam(fn, name) {
  const params = fn.typeParameters?.params ?? [];
  return params.some((p) => p.name?.name === name);
}

const httpCache = new WeakMap();

/** Does this function's own source call something fetch-shaped? */
function performsHttp(fn, sourceCode) {
  const cached = httpCache.get(fn);
  if (cached !== undefined) return cached;
  // Text-based on purpose: walking every descendant of every candidate function
  // is the expensive shape, and this only runs for a cast that ALREADY looks
  // like a body read — a handful of nodes per repo.
  const found = FETCH_CALL.test(sourceCode.getText(fn));
  httpCache.set(fn, found);
  return found;
}

/** Is `node` inside a function that fetches? */
function insideHttpFunction(node, sourceCode) {
  return enclosingFunctions(node).some((fn) => performsHttp(fn, sourceCode));
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Validate an HTTP response body against a schema; never assert a type onto it with `as`.',
    },
    schema: [],
    messages: {
      castOnBody:
        'This casts a fetched response body to `{{typeName}}` without checking it — on a 2xx the ' +
        'caller gets whatever arrived, and a wrong shape, an empty body and an HTML error page ' +
        'are all indistinguishable from success. Validate it with a Zod schema (see ' +
        '`lerRespostaJson` in @delfrance/core/wire), or cast to `unknown` and narrow it.',
      castToTypeParam:
        'This asserts the caller-chosen type `{{typeName}}` onto a fetched body, which no cast ' +
        'can verify. Take the schema as a parameter and return `z.infer<S>` instead — then there ' +
        'is no cast left to be wrong. See `call()` in apps/web/lib/mercado-livre/client.ts.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      TSAsExpression(node) {
        // `as unknown` widens rather than asserts — the sanctioned escape.
        if (isUnknownType(node.typeAnnotation)) return;

        const operand = unwrap(node.expression);
        const typeName =
          node.typeAnnotation?.type === 'TSTypeReference' &&
          node.typeAnnotation.typeName?.type === 'Identifier'
            ? node.typeAnnotation.typeName.name
            : null;

        // Shape 1 — a cast onto a body read, inside a function that calls the
        // transport. Both halves are needed: reading a body is ambiguous (a
        // fixture, a cached string, a test reading back its own NextResponse)
        // and only the transport call says it came off the network.
        if (isResponseBodyRead(operand) || isJsonParse(operand)) {
          if (!insideHttpFunction(node, sourceCode)) return;
          context.report({
            node,
            messageId: 'castOnBody',
            data: { typeName: typeName ?? sourceCode.getText(node.typeAnnotation) },
          });
          return;
        }

        // Shape 2 — a cast to a type parameter of an enclosing fetch helper.
        if (typeName === null) return;
        for (const fn of enclosingFunctions(node)) {
          if (!declaresTypeParam(fn, typeName)) continue;
          if (performsHttp(fn, sourceCode)) {
            context.report({ node, messageId: 'castToTypeParam', data: { typeName } });
          }
          // The nearest declarer wins; an outer one cannot shadow it.
          return;
        }
      },
    };
  },
};

export default rule;
