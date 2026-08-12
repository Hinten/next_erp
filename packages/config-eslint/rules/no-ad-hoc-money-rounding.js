// Custom rule: funnel all money rounding/formatting through the canonical
// helpers in `@delfrance/core/money`.
//
// Money rounding used to be implemented four divergent ways (`Number(n.toFixed(2))`
// vs `Math.round(n * 100) / 100`), which disagree at x.xx5 edges. The
// consolidation moved every money calculation to `roundReais` and every BRL
// display to `formatReais`. This rule keeps it that way: it forbids the two
// ad-hoc patterns so a future change can't silently re-introduce a divergent
// rounding.
//
// Flagged:
//   - `x.toFixed(2)`         — 2-decimal money formatting/rounding
//   - `Math.round(x * 100)`  — the cents-scaling round (covers both
//                              `Math.round(x * 100) / 100` and the legacy
//                              display `money(Math.round(x * 100))`)
//
// NOT flagged: `.toFixed(4|10)` (XSD precision), `Math.round(x * 1000)` (ms),
// `Math.ceil(...)` (weight banding).
//
// Allow-listed files (by path) — the ONE place each pattern legitimately lives:
//   - packages/core/src/money/**          → the canonical `roundReais` /
//                                            `formatReais` impls + their tests
//   - the SEFAZ/ME wire-format (de)serializers, which convert between the
//     fixed-precision XML / API money strings and integer cents (not intermediate
//     reais math):
//       packages/integrations/nfe/src/tribute/format.ts
//       packages/integrations/nfe/src/generator/det.ts
//       apps/nfe/lib/nfe/orchestrator/generator-input.ts
//       packages/integrations/freight-br/src/melhor-envio/cart.ts
//       apps/web/lib/nfe/export/csv.ts  (parses authoritative NF-e XML money
//                                        strings → cents for the export sum)
//       tools/test-fixtures/src/debug-me-cart.ts  (debug repro of the Melhor
//                                        Envio wire format; mirrors the
//                                        allow-listed production serializer
//                                        packages/integrations/freight-br/src/melhor-envio/cart.ts)
//
// Error (not warn): re-introducing ad-hoc rounding is a real consistency bug
// (it diverges from the NF-e total at x.xx5 edges). Distinct rule name, so it
// coexists with any app's `no-restricted-syntax` override (flat config does
// full-replacement per rule name, never across names).

const ALLOW_LIST = [
  '/packages/core/src/money/',
  '/packages/integrations/nfe/src/tribute/format.ts',
  '/packages/integrations/nfe/src/generator/det.ts',
  '/apps/nfe/lib/nfe/orchestrator/generator-input.ts',
  '/packages/integrations/freight-br/src/melhor-envio/cart.ts',
  '/apps/web/lib/nfe/export/csv.ts',
  // Debug repro of the Melhor Envio wire format; mirrors the allow-listed
  // production serializer packages/integrations/freight-br/src/melhor-envio/cart.ts.
  '/tools/test-fixtures/src/debug-me-cart.ts',
];

function isHundredLiteral(node) {
  return node && node.type === 'Literal' && node.value === 100;
}

/**
 * Member name of a `MemberExpression`, normalized across dot AND bracket access:
 * `x.toFixed` (Identifier) and `x['toFixed']` (computed string Literal) both
 * return `'toFixed'`, so the rule can't be bypassed by bracket notation.
 */
function memberName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  const prop = member.property;
  if (!member.computed && prop.type === 'Identifier') return prop.name;
  if (member.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
    return prop.value;
  }
  return null;
}

/** Identifier name of the member's object (e.g. `Math` in `Math.round`). */
function objectIdentifier(member) {
  return member.object && member.object.type === 'Identifier' ? member.object.name : null;
}

/** `x * 100` / `100 * x` — the cents-scaling multiply (either operand order). */
function isTimes100(node) {
  return (
    node &&
    node.type === 'BinaryExpression' &&
    node.operator === '*' &&
    (isHundredLiteral(node.right) || isHundredLiteral(node.left))
  );
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Use roundReais() / formatReais() from @delfrance/core/money for money ' +
        'math + BRL display; ban ad-hoc .toFixed(2) and Math.round(x * 100).',
    },
    schema: [],
    messages: {
      banned:
        'Money rounding/formatting must use roundReais() / formatReais() from ' +
        '@delfrance/core/money. Ad-hoc `.toFixed(2)` and `Math.round(x * 100)` are ' +
        'forbidden (only the canonical helpers and the allow-listed XSD/API wire ' +
        'serializers may use them).',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (ALLOW_LIST.some((p) => filename.includes(p))) {
      return {};
    }
    // One visitor that normalizes the callee, so both `x.toFixed(2)` /
    // `x['toFixed'](2)` and `Math.round(x*100)` / `Math['round'](x*100)` are
    // caught (a selector keyed on `callee.property.name` would miss the bracket
    // forms).
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        const method = memberName(callee);
        const arg = node.arguments[0];
        if (method === 'toFixed') {
          if (arg && arg.type === 'Literal' && arg.value === 2) {
            context.report({ node, messageId: 'banned' });
          }
        } else if (method === 'round' && objectIdentifier(callee) === 'Math') {
          if (isTimes100(arg)) {
            context.report({ node, messageId: 'banned' });
          }
        }
      },
    };
  },
};

export default rule;
