// Custom rule: a value typed as a Zod enum from `packages/schemas` must be
// written through that enum's companion constant, never as a raw string.
//
// The schemas package is the source of truth for every persisted value, and the
// established convention there pairs each `z.enum([...])` with a constant:
//
//   export const estadoPedidoSchema = z.enum(['iniciado', …, 'cancelado']);
//   export type EstadoPedido = z.infer<typeof estadoPedidoSchema>;
//   export const ESTADO_PEDIDO = { … } as const satisfies Record<string, EstadoPedido>;
//
// Once the constant exists, `estado === 'cancelado'` and `ESTADO_PEDIDO.cancelado`
// mean the same thing to the compiler but not to a human editing the schema: the
// constant is the only spelling that survives `Find all references`, and — for
// the enums whose wire value differs from the member name, like `ESTADO_NFE`
// (`aprovada: 'a'`) — the only one that is readable at all.
//
// Flagged (the literal sits in a position typed as the enum):
//   estado === 'pago'                       → ESTADO_PEDIDO.pago
//   return { estado: 'cancelado' }          (when the return type says so)
//   new Set<EstadoPedido>(['iniciado'])     → ESTADO_PEDIDO.iniciado
//   switch (estado) { case 'pago': }        → case ESTADO_PEDIDO.pago
//
// NOT flagged:
//   - `ESTADO_PEDIDO.pago` — a member access, not a string literal
//   - a Zod enum with NO companion constant. The constant is what opts an enum
//     into this rule: there is nothing to point the author at without one, and a
//     rule that only ever says "go write a constant first" would be noise. Adding
//     the constant is the (deliberate, reviewable) act of opting in.
//   - a hand-written string union (`type EstadoBucket = 'aberto' | …`) — not a
//     Zod enum, so no schema invariant is at stake
//   - a plain `string`-typed position, or a literal that is not a member
//   - the constant's OWN declaration — `satisfies Record<string, EstadoPedido>`
//     gives every member there the enum's type, and it has to spell them out.
//     Only that object is exempt: the rest of `packages/schemas` (the pure-logic
//     allow-lists in `pedido/pureLogic/estado.ts`, say) is held to the rule like
//     any other code.
//
// KNOWN LIMITATIONS, by design — the rule is precise over exhaustive, because
// zero false positives is what makes it safe at `error`:
//
//  1. It only fires where the TYPE at the literal's position is the enum. A
//     patch object typed `Record<string, unknown>` — e.g. what
//     `PedidoDataPort.updatePedido`'s `apply` returns — has contextual type
//     `unknown`, so no literal inside it can be flagged. Those write paths are
//     caught in review instead.
//  2. `const S: ReadonlySet<EstadoFrete> = new Set(['postado'])` is NOT flagged:
//     TypeScript infers `Set`'s `T` from the ARGUMENT, so the element's
//     contextual type collapses to its own literal (`"postado"`) and the
//     annotation only checks assignability afterwards. Nothing is unsafe — a
//     typo still fails to compile — but the enum never reaches the position.
//     Write `new Set<EstadoFrete>([...])`, the form used everywhere in this
//     repo, and the members are checked.
//  3. An operand NARROWED by control flow is not flagged:
//     `estado !== ESTADO_PEDIDO.pago && estado !== 'cancelado'` narrows the
//     second comparison to the 15 remaining members, which is neither the alias
//     nor the whole member set. Matching a subset instead was tried and is
//     unsound — see the note on `enumEntryFor`.
//  4. Two enums that share a member set (`Origem` and `OrigemProdutoImposto` are
//     both '0'…'8') are not enforced AT ALL. `z.infer` erases the type alias, so
//     the member set is the only thing that identifies an enum here — and when
//     two claim the same one, nothing left in the type says which is meant.
//     Answering anyway would name the wrong module's constant in code that still
//     compiles. Seven enums are parked this way today; see `buildRegistry`.
//
// Error (not warn): the constants exist precisely so the enum members have one
// spelling; a second spelling drifting back in is the thing this prevents.
import ts from 'typescript';

const SCHEMAS_DIR = '/packages/schemas/src/';
const SCHEMAS_PACKAGE = '@delfrance/schemas';

// One registry per TS program (a lint run reuses the program across files).
const registryCache = new WeakMap();

/** `z.enum([...])`, however many `.meta()` / `.describe()` calls wrap it. */
function unwrapZodEnumCall(node) {
  let cur = node;
  while (ts.isCallExpression(cur)) {
    const callee = cur.expression;
    if (!ts.isPropertyAccessExpression(callee)) return null;
    if (callee.name.text === 'enum') return cur;
    cur = callee.expression;
  }
  return null;
}

/** The string members of a `z.enum([...])` call, or null if not statically known. */
function enumMembers(callNode) {
  const [arg] = callNode.arguments;
  if (!arg || !ts.isArrayLiteralExpression(arg)) return null;
  const values = [];
  for (const el of arg.elements) {
    if (!ts.isStringLiteral(el)) return null;
    values.push(el.text);
  }
  return values.length > 0 ? values : null;
}

/**
 * `{ aprovada: 'a' } as const satisfies Record<string, TypeName>` →
 * `{ typeName, valueToKey }`, or null. Both orders (`as const satisfies T` /
 * `satisfies T as const`) resolve, since each is a nested
 * expression-with-type-node.
 *
 * The value→KEY map is the point: several enums here store a wire value that is
 * not the member name (`ESTADO_NFE.aprovada === 'a'`), so the replacement for a
 * raw `'a'` is `ESTADO_NFE.aprovada`, never `ESTADO_NFE.a`.
 */
function satisfiesRecordOf(initializer) {
  // `{…} as const satisfies Record<…>` parses as satisfies(as(object, const)),
  // so the object literal sits BELOW the remaining type assertions, not directly
  // under the node carrying the Record type.
  const objectLiteralUnder = (node) => {
    let cur = node;
    while (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    return ts.isObjectLiteralExpression(cur) ? cur : null;
  };

  let cur = initializer;
  while (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) {
    const typeNode = cur.type;
    if (
      ts.isTypeReferenceNode(typeNode) &&
      ts.isIdentifier(typeNode.typeName) &&
      typeNode.typeName.text === 'Record' &&
      typeNode.typeArguments?.length === 2
    ) {
      const valueType = typeNode.typeArguments[1];
      const object = objectLiteralUnder(cur.expression);
      if (ts.isTypeReferenceNode(valueType) && ts.isIdentifier(valueType.typeName) && object) {
        const valueToKey = new Map();
        for (const prop of object.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key =
            ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
          if (key === null || !ts.isStringLiteral(prop.initializer)) continue;
          valueToKey.set(prop.initializer.text, key);
        }
        if (valueToKey.size > 0) return { typeName: valueType.typeName.text, valueToKey };
      }
    }
    cur = cur.expression;
  }
  return null;
}

/** `CONST.member` when the key is a plain identifier, else `CONST['member']`. */
function memberAccess(constName, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${constName}.${key}` : `${constName}['${key}']`;
}

/**
 * Scan every `packages/schemas/src` file in the program for the three
 * declarations that make up an enum: the `z.enum()` schema, the `z.infer` type
 * alias, and the `as const satisfies Record<string, T>` constant. Returns
 * `{ byTypeName, byValueKey }` — the second keyed by the sorted member list, so
 * a type the checker flattened (e.g. `EstadoPedido | null`, which loses its
 * `aliasSymbol`) still resolves.
 */
function buildRegistry(program) {
  const cached = registryCache.get(program);
  if (cached) return cached;

  const bySchemaVar = new Map(); // schema variable name → members
  const typeToSchemaVar = new Map(); // type alias name → schema variable name
  const constByTypeName = new Map(); // type alias name → constant name

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.fileName.replace(/\\/g, '/').includes(SCHEMAS_DIR)) continue;

    for (const stmt of sourceFile.statements) {
      if (ts.isTypeAliasDeclaration(stmt)) {
        // type X = z.infer<typeof someSchema>
        const t = stmt.type;
        if (
          ts.isTypeReferenceNode(t) &&
          t.typeArguments?.length === 1 &&
          t.typeName.getText(sourceFile).endsWith('infer')
        ) {
          const arg = t.typeArguments[0];
          if (ts.isTypeQueryNode(arg) && ts.isIdentifier(arg.exprName)) {
            typeToSchemaVar.set(stmt.name.text, arg.exprName.text);
          }
        }
        continue;
      }
      if (!ts.isVariableStatement(stmt)) continue;

      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;

        const zodEnum = unwrapZodEnumCall(decl.initializer);
        if (zodEnum) {
          const members = enumMembers(zodEnum);
          if (members) bySchemaVar.set(decl.name.text, members);
          continue;
        }
        const constant = satisfiesRecordOf(decl.initializer);
        if (constant) {
          constByTypeName.set(constant.typeName, {
            constName: decl.name.text,
            valueToKey: constant.valueToKey,
          });
        }
      }
    }
  }

  const byTypeName = new Map();
  const byValueKey = new Map();
  const ambiguous = new Set();
  for (const [typeName, schemaVar] of typeToSchemaVar) {
    const members = bySchemaVar.get(schemaVar);
    const constant = constByTypeName.get(typeName);
    // No constant → this enum has not opted in (see the header note).
    if (!members || !constant) continue;
    const entry = {
      typeName,
      constName: constant.constName,
      // Keyed by wire VALUE; the map resolves it back to the member name.
      valueToKey: constant.valueToKey,
    };
    byTypeName.set(typeName, entry);
    const valueKey = [...members].sort().join(' ');
    if (byValueKey.has(valueKey)) ambiguous.add(valueKey);
    byValueKey.set(valueKey, entry);
  }
  // Two enums that share a member set are INDISTINGUISHABLE here, and
  // `byValueKey` is last-writer-wins, so leaving them in would silently answer
  // for whichever was registered last. Three real groups collide: `Origem`
  // ('0'…'8', imposto/tribute.ts) with `OrigemProdutoImposto` (the same SEFAZ
  // concept declared again in operacao.ts); `IndIncentivo` with `AmbienteNFE`
  // ('1' | '2'); and the three 'failed' | 'parked' notification statuses. Because
  // the colliding enums carry the SAME strings, a suggestion naming the wrong
  // module's constant still compiles and still passes tests — undetectable
  // downstream. `IndIncentivo` vs `AmbienteNFE` is the vivid one: it would turn
  // "incentivo fiscal: sim" into "ambiente: produção".
  //
  // Dropping the key parks those enums ENTIRELY, not just in nullable positions:
  // `z.infer` erases the alias (verified against real zod — `getTypeAtLocation`
  // on an `EstadoPedido` operand reports no `aliasSymbol`), so the member set is
  // the only signal that ever arrives and `byTypeName` is a formality. Parked is
  // still the right trade against emitting a wrong constant that compiles. The
  // way out is to identify enums by the DECLARATION behind the operand — a
  // property's `origem: origemProdutoImpostoSchema.…` names its schema variable
  // in the AST — which is a coverage-increasing change and belongs with its own
  // fallout, not in this fix.
  for (const key of ambiguous) byValueKey.delete(key);

  const registry = { byTypeName, byValueKey };
  registryCache.set(program, registry);
  return registry;
}

/**
 * The type the literal is being used AS. For a comparison that is the other
 * operand's type and for a `case` clause the discriminant's; everywhere else
 * (object property, argument, return, annotated declarator, array element) the
 * contextual type.
 */
function targetType(node, tsNode, checker, esToTs) {
  const parent = node.parent;
  if (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) {
    const other = parent.left === node ? parent.right : parent.left;
    const otherTs = esToTs.get(other);
    return otherTs ? checker.getTypeAtLocation(otherTs) : null;
  }
  if (parent?.type === 'SwitchCase' && parent.test === node) {
    const discriminantTs = esToTs.get(parent.parent.discriminant);
    return discriminantTs ? checker.getTypeAtLocation(discriminantTs) : null;
  }
  return checker.getContextualType(tsNode) ?? null;
}

/**
 * The enum entry a type corresponds to, or null. Ignores null/undefined members.
 *
 * Two ways in, and deliberately only two:
 *  1. the type alias (`EstadoPedido`). Kept for completeness, but it almost never
 *     fires: `z.infer` resolves through a conditional/indexed-access type and the
 *     result carries NO `aliasSymbol`, verified against real zod. Every enum in
 *     the schemas package is declared that way.
 *  2. the EXACT member set — which is therefore the path that does the work, not
 *     a fallback. Only a set that exactly ONE enum owns resolves: `buildRegistry`
 *     drops the shared ones, so a set two enums both claim returns null here
 *     rather than whichever won the registration race.
 *
 * A third rule — "the literals are a SUBSET of exactly one enum's members" —
 * was tried, to also catch an operand that control-flow narrowing had shrunk
 * (`estado !== ESTADO_PEDIDO.pago && estado !== '…'`). It is UNSOUND and was
 * removed: enums whose values are generic numeric-ish codes collide across
 * unrelated domains. The NF-e `PISNT.CST` field is typed
 * `'04' | … | '09'`, which sits entirely inside `BANDEIRA`'s
 * `'01' | … | '09' | '99'` (credit-card brands), so the subset rule "resolved"
 * a SEFAZ tax code to `BANDEIRA.hipercard`. It compiled, and it was nonsense.
 * Matching only the whole member set cannot make that mistake.
 */
function enumEntryFor(type, registry) {
  if (!type) return null;
  if (type.aliasSymbol) {
    const entry = registry.byTypeName.get(type.aliasSymbol.name);
    if (entry) return entry;
  }
  if (!type.isUnion()) return null;
  const values = [];
  for (const part of type.types) {
    if (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    if (!part.isStringLiteral()) return null;
    values.push(part.value);
  }
  if (values.length < 2) return null;
  return registry.byValueKey.get([...values].sort().join(' ')) ?? null;
}

/**
 * Where to land the constant's import: preferentially the declaration that
 * already pulls in the enum's own type (`EstadoPedido`) — whatever specifier it
 * uses — otherwise any named import from `@delfrance/schemas`.
 *
 * A type-only declaration (`import type { EstadoPedido } from …`) can't take a
 * value specifier, so it gets a sibling `import { … }` statement rather than a
 * new member — inserting into it would compile to TS1361 ("cannot be used as a
 * value because it was imported using 'import type'"). Returns null when there
 * is nowhere obvious, and the rule then reports without a suggestion.
 */
function importAnchorFor(sourceCode, typeName) {
  const anchorFor = (stmt, named) =>
    stmt.importKind === 'type'
      ? { mode: 'sibling', node: stmt, source: stmt.source.raw }
      : { mode: 'member', node: named[0] };

  let fallback = null;
  for (const stmt of sourceCode.ast.body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const named = stmt.specifiers.filter((s) => s.type === 'ImportSpecifier');
    if (named.length === 0) continue;
    if (named.some((s) => s.imported?.name === typeName)) return anchorFor(stmt, named);
    if (!fallback && stmt.source.value === SCHEMAS_PACKAGE) fallback = anchorFor(stmt, named);
  }
  return fallback;
}

/**
 * Whether the literal is a member of the very object that DECLARES this enum's
 * constant — `{ pago: 'pago', … } as const satisfies Record<string, EstadoPedido>`.
 * That object must spell the members out; nothing else in the schemas package is
 * exempt.
 */
function isOwnConstantDeclaration(node, typeName) {
  const prop = node.parent;
  if (prop?.type !== 'Property' || prop.value !== node) return false;
  let cur = prop.parent;
  if (cur?.type !== 'ObjectExpression') return false;
  while (
    cur?.type === 'ObjectExpression' ||
    cur?.type === 'TSAsExpression' ||
    cur?.type === 'TSSatisfiesExpression'
  ) {
    const ann = cur.typeAnnotation;
    if (
      ann?.type === 'TSTypeReference' &&
      ann.typeName?.name === 'Record' &&
      ann.typeArguments?.params?.length === 2
    ) {
      const valueType = ann.typeArguments.params[1];
      if (valueType?.type === 'TSTypeReference' && valueType.typeName?.name === typeName)
        return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** Whether `name` already resolves in this file (imported or declared). */
function isInScope(sourceCode, node, name) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    if (scope.variables.some((v) => v.name === name)) return true;
    scope = scope.upper;
  }
  return false;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Write a Zod enum value through its companion constant ' +
        '(`ESTADO_PEDIDO.cancelado`), never as a raw string.',
    },
    hasSuggestions: true,
    schema: [],
    messages: {
      rawLiteral:
        '`{{typeName}}` is a Zod enum from @delfrance/schemas — write `{{replacement}}` ' +
        "instead of the raw string '{{value}}'. The constant is the single spelling of that " +
        'member; a raw literal drifts silently when the schema changes.',
      useConstant: 'Replace with `{{replacement}}`',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    // Not running type-aware (no `projectService`) — nothing to check against.
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};

    const checker = services.program.getTypeChecker();
    const esToTs = services.esTreeNodeToTSNodeMap;
    const registry = buildRegistry(services.program);
    if (registry.byTypeName.size === 0) return {};

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;

        const tsNode = esToTs.get(node);
        if (!tsNode) return;

        const entry = enumEntryFor(targetType(node, tsNode, checker, esToTs), registry);
        // Resolve the wire value back to the MEMBER NAME — they differ for
        // several enums here (`ESTADO_NFE.aprovada === 'a'`). A value the
        // constant is missing is a schemas bug, not a call-site one: skip it.
        const member = entry?.valueToKey.get(node.value);
        if (!entry || member === undefined) return;

        const { constName, typeName } = entry;
        if (isOwnConstantDeclaration(node, typeName)) return;
        const replacement = memberAccess(constName, member);
        const data = { constName, typeName, member, value: node.value, replacement };

        const suggest = [];
        if (isInScope(context.sourceCode, node, constName)) {
          suggest.push({
            messageId: 'useConstant',
            data,
            fix: (fixer) => fixer.replaceText(node, replacement),
          });
        } else {
          // Only offer a fix that also lands the import — a suggestion that
          // leaves the file failing to compile is worse than no suggestion.
          const anchor = importAnchorFor(context.sourceCode, typeName);
          if (anchor) {
            suggest.push({
              messageId: 'useConstant',
              data,
              fix: (fixer) => [
                anchor.mode === 'member'
                  ? fixer.insertTextBefore(anchor.node, `${constName}, `)
                  : fixer.insertTextAfter(
                      anchor.node,
                      `\nimport { ${constName} } from ${anchor.source};`,
                    ),
                fixer.replaceText(node, replacement),
              ],
            });
          }
        }

        context.report({ node, messageId: 'rawLiteral', data, suggest });
      },
    };
  },
};

export default rule;
