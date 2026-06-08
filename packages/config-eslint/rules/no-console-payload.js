// Custom rule: no payload argument on `console.error` / `console.warn`.
//
// `console.error('label', obj)` dumps `obj` via Node's `util.inspect`, which
// enumerates every property — a leak vector for unredacted data — and produces
// unstructured output. Push such call sites to the structured logger
// (`createLogger` from `@delfrance/logger`), which censors sensitive keys and
// serializes errors to a safe shape: `log.error({ err }, 'message')`.
//
// Scope notes:
//   - Only STATIC `console.error(...)` / `console.warn(...)` with >1 argument
//     are flagged. Dynamic `console[level](...)` (e.g. the NF-e `safeLog`
//     wrapper) is intentionally NOT matched — those paths already route through
//     redaction and carry their own stricter ESLint guard.
//   - Single-arg `console.warn('text')` stays legal (the base `no-console`
//     rule still allows `warn`/`error`).
//   - A distinct rule name, so consumers can switch it off for tests / scripts
//     without disturbing `no-restricted-syntax` (flat config does
//     full-replacement per rule name, never across names).
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a payload argument on console.error / console.warn; use the structured logger.',
    },
    schema: [],
    messages: {
      noPayload:
        'Do not pass a payload to console.{{method}}(...) — it dumps unredacted, ' +
        'unstructured data. Use the structured logger: `createLogger(name)` from ' +
        '@delfrance/logger, e.g. `log.{{method}}({ err }, "message")`.',
    },
  },
  create(context) {
    return {
      "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.object.name='console'][callee.property.name=/^(error|warn)$/]"(
        node,
      ) {
        if (node.arguments.length > 1) {
          context.report({
            node,
            messageId: 'noPayload',
            data: { method: node.callee.property.name },
          });
        }
      },
    };
  },
};

export default rule;
