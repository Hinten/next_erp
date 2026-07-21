// Custom rule: inside a `catch`, `Error` may not be the ONLY class narrowed on.
//
// This is the half of critical rule 6 that the base `no-restricted-syntax`
// selectors can't express. Those selectors already require every catch body to
// contain either an `instanceof` check OR a `throw`. What they cannot see is
// WHICH class sits on the right-hand side — and `err instanceof Error` narrows
// nothing, because `Error` is the parent of every exception. A catch that only
// asks `instanceof Error` swallows `FirebaseError`, `ZodError`, `SyntaxError`
// and every in-repo error class exactly as silently as a bare `catch {}`.
//
// Flagged:
//   try { … } catch (e) { if (e instanceof Error) log(e.message); }
//   try { … } catch (e) { return e instanceof Error ? e.message : 'erro'; }
//
// NOT flagged:
//   - any catch that narrows on a specific class (`FirebaseError`, `ZodError`,
//     an in-repo class), even if it ALSO tests `instanceof Error` afterwards to
//     read `.message`
//   - a catch that rethrows unconditionally (`catch (e) { throw e }`) — nothing
//     is swallowed
//   - a catch with no `instanceof` at all: that shape is the base
//     `no-restricted-syntax` selectors' job, not this rule's
//
// Warn, not error: 25 sites currently trip this (17 of them in apps/nfe, which
// is precisely where the base catch selectors are switched off by that
// workspace's own `no-restricted-syntax` override — flat config replaces a rule
// by NAME, and this rule's distinct name is what lets it reach there). A guard
// against backsliding, mirroring how `no-inline-admin-collection` is
// registered. NOTE lint-staged runs `--max-warnings 0`, so editing one of those
// 25 files means fixing it first.

/** Right-hand identifier of an `x instanceof Y` expression, or null. */
function instanceofRhsName(node) {
  if (!node || node.type !== 'BinaryExpression' || node.operator !== 'instanceof') return null;
  const right = node.right;
  if (right.type === 'Identifier') return right.name;
  // `e instanceof foo.Bar` — use the trailing property as the class name.
  if (
    right.type === 'MemberExpression' &&
    !right.computed &&
    right.property.type === 'Identifier'
  ) {
    return right.property.name;
  }
  return null;
}

/**
 * Collect every `instanceof` RHS name inside a subtree, without descending into
 * a nested `CatchClause` (that inner catch is judged on its own).
 */
function collectInstanceofNames(root) {
  const names = [];
  const seen = new Set();

  const walk = (node) => {
    if (!node || typeof node.type !== 'string' || seen.has(node)) return;
    seen.add(node);
    if (node.type === 'CatchClause' && node !== root) return;

    const name = instanceofRhsName(node);
    if (name) names.push(name);

    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === 'string') walk(c);
        }
      } else if (child && typeof child.type === 'string') {
        walk(child);
      }
    }
  };

  walk(root);
  return names;
}

/** Does this subtree rethrow? (a `throw` anywhere outside a nested catch) */
function hasThrow(root) {
  let found = false;
  const seen = new Set();

  const walk = (node) => {
    if (found || !node || typeof node.type !== 'string' || seen.has(node)) return;
    seen.add(node);
    if (node.type === 'CatchClause' && node !== root) return;
    if (node.type === 'ThrowStatement') {
      found = true;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === 'string') walk(c);
        }
      } else if (child && typeof child.type === 'string') {
        walk(child);
      }
    }
  };

  walk(root);
  return found;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '`Error` may not be the only class narrowed on inside a catch — it is the ' +
        'parent of every exception, so it narrows nothing.',
    },
    schema: [],
    messages: {
      soleError:
        '`err instanceof Error` is not narrowing — `Error` is the parent of every ' +
        'exception, so this catch swallows FirebaseError, ZodError and every in-repo ' +
        'error class alike. Narrow on the specific class you expect and `throw err` ' +
        'for anything else (testing `instanceof Error` as well, to read `.message`, ' +
        'is fine).',
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const names = collectInstanceofNames(node);
        // No instanceof at all → the base no-restricted-syntax selectors own it.
        if (names.length === 0) return;
        // Narrowed on something real → fine.
        if (names.some((n) => n !== 'Error')) return;
        // Unconditional-ish rethrow → nothing is swallowed.
        if (hasThrow(node)) return;

        context.report({ node: node.param ?? node, messageId: 'soleError' });
      },
    };
  },
};

export default rule;
