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
//  1. A position with NO declaration behind it is not flagged. A patch object
//     typed `Record<string, unknown>` — e.g. what `PedidoDataPort.updatePedido`'s
//     `apply` returns — has no per-property declaration to read, so no literal
//     inside it can be flagged. Those write paths are caught in review instead.
//  2. `const S: ReadonlySet<EstadoFrete> = new Set(['postado'])` is NOT flagged:
//     an array element's only "declaration" is a positional slot in
//     `readonly T[]`, which names nothing. Write `new Set<EstadoFrete>([...])`,
//     the form used everywhere in this repo, and the written type ARGUMENT names
//     the enum.
//  3. An inferred local loses the thread — `const e = pedido.estado;` then
//     `e === 'pago'` resolves `e` to a `VariableDeclaration` carrying neither an
//     annotation nor a Zod initializer. Compare the property directly, or
//     annotate the local.
//
// A literal reached through `??` / `||` IS resolved: it stands in for the whole
// expression, so `const m: ModalidadeFrete = frete?.modalidade ?? '9'` reports
// against the declarator's annotation. And `z.enum(FILETYPE)` — members in a
// separate `as const` array rather than inline — is registered like any other,
// which is what brought `Filetype` and `TipoMovimentoEstoque` into scope.
//
// Identifying enums by their MEMBER SET was tried and removed. A set is not an
// identity: `'0' | '1'` is `IndIntermedOperacao`, and equally the generated
// `ide.tpNF` (entrada / saída) and any flag union; `'1' | '2'` is `IndIncentivo`,
// and equally `TpAmb` (produção / homologação). Each collision produced a
// suggestion that compiled, passed tests and meant something else — `tpImp: '1'`
// (DANFE layout) rewritten to `MOD_BCST.listaNegativa`. Fiscal code is full of
// single-digit SEFAZ enums, so those were routine, not edge cases. Two follow
// from dropping it: an operand narrowed by control flow now IS flagged (its
// declaration is unchanged by narrowing), and two enums sharing a member set —
// `Origem` and `OrigemProdutoImposto` are both '0'…'8' — are told apart by name,
// so the ambiguity guard that #718 needed is gone with the mechanism.
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

/** `['a', 'b'] as const` → its string members, or null if not statically known. */
function stringArrayMembers(node) {
  let cur = node;
  while (ts.isAsExpression(cur)) cur = cur.expression;
  if (!ts.isArrayLiteralExpression(cur)) return null;
  const values = [];
  for (const el of cur.elements) {
    if (!ts.isStringLiteral(el)) return null;
    values.push(el.text);
  }
  return values.length > 0 ? values : null;
}

/**
 * The string members of a `z.enum(...)` call, or null if not statically known.
 *
 * The argument is usually an array literal, but `z.enum(FILETYPE)` — an
 * identifier naming an `as const` array declared alongside — is equally valid
 * Zod, and two schemas here use it (`filetypeSchema`,
 * `tipoMovimentoEstoqueSchema`). Resolving it against the file's array constants
 * is what makes those two visible to this rule at all.
 */
function enumMembers(callNode, arrayConsts) {
  const [arg] = callNode.arguments;
  if (!arg) return null;
  if (ts.isIdentifier(arg)) return arrayConsts.get(arg.text) ?? null;
  return stringArrayMembers(arg);
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
 * `{ byTypeName, byEnumSchemaVar }` — both keyed by a NAME, which is what
 * `resolveEntry` recovers from the declaration behind a literal's position.
 */
function buildRegistry(program) {
  const cached = registryCache.get(program);
  if (cached) return cached;

  const bySchemaVar = new Map(); // schema variable name → members
  const typeToSchemaVar = new Map(); // type alias name → schema variable name
  const constByTypeName = new Map(); // type alias name → constant name

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.fileName.replace(/\\/g, '/').includes(SCHEMAS_DIR)) continue;

    // Pre-pass: the file's `as const` string arrays, so a `z.enum(FILETYPE)`
    // below resolves regardless of which declaration comes first.
    const arrayConsts = new Map();
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const members = stringArrayMembers(decl.initializer);
        if (members) arrayConsts.set(decl.name.text, members);
      }
    }

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
          const members = enumMembers(zodEnum, arrayConsts);
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
  const byEnumSchemaVar = new Map();
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
    // Both keys are NAMES, and both are unique across the package — unlike a
    // member set, which several enums share. That uniqueness is what makes this
    // keying sound, so it is asserted rather than assumed:
    // `packages/schemas/src/enumNames.test.ts` fails on a duplicate schema
    // variable or type alias, naming both files.
    byTypeName.set(typeName, entry);
    byEnumSchemaVar.set(schemaVar, entry);
  }
  const registry = { byTypeName, byEnumSchemaVar };
  registryCache.set(program, registry);
  return registry;
}

/** Walk `origemSchema.nullable().optional().default(x)` back to `origemSchema`. */
function zodSchemaVarOf(node) {
  let cur = node;
  for (;;) {
    if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

/**
 * A written type ANNOTATION reduced to its type name: `Origem`, `Origem | null`
 * and `(Origem | undefined)` all give `'Origem'`. Anything else — a union of
 * bare literals, an indexed access, a generic — gives null, which is what keeps
 * a generated XSD field like `tpImp: '0' | '1' | …` out of the registry.
 */
function annotatedTypeNameOf(typeNode) {
  if (!typeNode) return null;
  const strip = (n) => {
    let cur = n;
    while (ts.isParenthesizedTypeNode(cur)) cur = cur.type;
    return cur;
  };
  let n = strip(typeNode);
  if (ts.isUnionTypeNode(n)) {
    const real = n.types.filter(
      (t) =>
        t.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
    );
    if (real.length !== 1) return null;
    n = strip(real[0]);
  }
  return ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) ? n.typeName.text : null;
}

/**
 * The enum a SYMBOL's declaration names, or null — the whole identification
 * strategy of this rule.
 *
 * Two shapes count, and both name the enum EXPLICITLY rather than inferring it
 * from the shape of a type:
 *
 *  1. a Zod object property — `origem: origemProdutoImpostoSchema.nullable()` —
 *     whose initializer walks back to the schema variable;
 *  2. a written annotation — `declare const o: Origem`, `(e: EstadoPedido) => …`.
 *
 * Everything else answers null. That is the point: the previous approach matched
 * an enum by its MEMBER SET, which is not an identity. `'0' | '1'` is
 * `IndIntermedOperacao`, but it is equally the generated `ide.tpNF` (entrada /
 * saída) and any hand-written flag union; `'1' | '2'` is `IndIncentivo` and also
 * `TpAmb` (produção / homologação). Those collisions produced suggestions that
 * compiled, passed tests and said something entirely different — `tpImp: '1'`
 * (DANFE layout) rewritten to `MOD_BCST.listaNegativa`. A name cannot collide
 * that way.
 */
/**
 * The symbol an expression refers to. `getSymbolAtLocation` answers directly for
 * a plain identifier, but returns UNDEFINED for a property access whose object
 * is a union — including every `current.estado` where `current` was narrowed
 * from `Pedido | null`, which is most real call sites. Fall back to looking the
 * property up on the object's type, where a union yields a synthesized symbol
 * carrying each constituent's declaration.
 */
function symbolBehind(expr, checker) {
  const direct = checker.getSymbolAtLocation(expr);
  if (direct) return direct;
  if (!ts.isPropertyAccessExpression(expr)) return undefined;
  const objectType = checker.getTypeAtLocation(expr.expression);
  return objectType ? checker.getPropertyOfType(objectType, expr.name.text) : undefined;
}

function entryFromSymbol(symbol, checker, registry, depth = 0) {
  if (depth > 4) return null; // a destructure of a destructure of a … — bail
  for (const decl of symbol?.declarations ?? []) {
    if (ts.isPropertyAssignment(decl)) {
      const schemaVar = zodSchemaVarOf(decl.initializer);
      const bySchema = schemaVar && registry.byEnumSchemaVar.get(schemaVar);
      if (bySchema) return bySchema;
    }
    const typeName = annotatedTypeNameOf(decl.type);
    const byName = typeName && registry.byTypeName.get(typeName);
    if (byName) return byName;

    // `const { estado } = input` — the binding element itself declares nothing.
    // Follow it to the property it destructures, which does. This shape is
    // everywhere (`efeitoEstoquePedido` and most pure-logic helpers open with
    // one), so skipping it would leave most real call sites unenforced.
    if (ts.isBindingElement(decl)) {
      const owner = decl.parent?.parent;
      const key = decl.propertyName ?? decl.name;
      if (!owner || !ts.isIdentifier(key)) continue;
      // Ask the INITIALIZER, not the declaration: `getTypeAtLocation` on a
      // `const { … } = input` answers `any`, since the declaration's own type is
      // the binding pattern. A destructured parameter has no initializer, and
      // there the declaration does carry the annotation.
      const source =
        ts.isVariableDeclaration(owner) && owner.initializer ? owner.initializer : owner;
      const ownerType = checker.getTypeAtLocation(source);
      const prop = ownerType && checker.getPropertyOfType(ownerType, key.text);
      const fromProp = prop && entryFromSymbol(prop, checker, registry, depth + 1);
      if (fromProp) return fromProp;
    }
  }
  return null;
}

/**
 * The enum the literal's POSITION names, or null.
 *
 * Each branch finds the declaration that gives the position its type, then hands
 * it to `entryFromSymbol`. A position whose declaration is not a Zod enum — a
 * generated interface field, a hand-written union — resolves to null and is
 * never reported.
 */
function resolveEntry(node, tsNode, checker, esToTs, registry) {
  const parent = node.parent;

  // `estado === 'pago'` / `pedido.estado === 'pago'` → the other operand.
  if (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) {
    const other = parent.left === node ? parent.right : parent.left;
    const otherTs = esToTs.get(other);
    return otherTs ? entryFromSymbol(symbolBehind(otherTs, checker), checker, registry) : null;
  }

  // `switch (estado) { case 'pago': }` → the discriminant.
  if (parent?.type === 'SwitchCase' && parent.test === node) {
    const discriminantTs = esToTs.get(parent.parent.discriminant);
    return discriminantTs
      ? entryFromSymbol(symbolBehind(discriminantTs, checker), checker, registry)
      : null;
  }

  // `freteInicial?.modalidade ?? '9'` — the literal is the fallback of a `??`
  // (or `||`) chain, so it stands in for the whole expression and the position
  // that types it is the one the EXPRESSION occupies, not the operator's.
  // Without this, an annotated declarator two tokens away never reaches it.
  let positioned = tsNode;
  while (
    positioned.parent &&
    ts.isBinaryExpression(positioned.parent) &&
    positioned.parent.right === positioned &&
    (positioned.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      positioned.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    positioned = positioned.parent;
  }

  const tsParent = positioned.parent;
  if (!tsParent) return null;

  // `{ estado: 'pago' }` → the contextual type's property, whose declaration is
  // the Zod `estado: estadoPedidoSchema` line.
  if (ts.isPropertyAssignment(tsParent) && tsParent.initializer === positioned) {
    const objectLiteral = tsParent.parent;
    if (!ts.isObjectLiteralExpression(objectLiteral)) return null;
    const name =
      ts.isIdentifier(tsParent.name) || ts.isStringLiteral(tsParent.name)
        ? tsParent.name.text
        : null;
    const objectType = checker.getContextualType(objectLiteral);
    if (!name || !objectType) return null;
    return entryFromSymbol(checker.getPropertyOfType(objectType, name), checker, registry);
  }

  // `g('carrinho')` → the resolved signature's parameter.
  if (ts.isCallExpression(tsParent) || ts.isNewExpression(tsParent)) {
    const index = tsParent.arguments?.indexOf(positioned) ?? -1;
    if (index < 0) return null;
    const signature = checker.getResolvedSignature(tsParent);
    return entryFromSymbol(signature?.parameters?.[index], checker, registry);
  }

  // `new Set<EstadoPedido>(['iniciado'])` → the written type ARGUMENT. The
  // element's own declaration is a positional slot in `readonly T[]`, which names
  // nothing, but the explicit `<EstadoPedido>` does — and spelling it out is
  // already the house style here (see limitation 2).
  if (ts.isArrayLiteralExpression(tsParent)) {
    const call = tsParent.parent;
    const isArg =
      (ts.isCallExpression(call) || ts.isNewExpression(call)) &&
      (call.arguments?.includes(tsParent) ?? false);
    const typeName = isArg ? annotatedTypeNameOf(call.typeArguments?.[0]) : null;
    return (typeName && registry.byTypeName.get(typeName)) ?? null;
  }

  // `const x: EstadoPedido = 'pago'` / `estado = 'pago'` on a declared variable.
  if (ts.isVariableDeclaration(tsParent) && tsParent.initializer === positioned) {
    const typeName = annotatedTypeNameOf(tsParent.type);
    return (typeName && registry.byTypeName.get(typeName)) ?? null;
  }

  // `return 'finalizado'` → the enclosing function's declared return type.
  if (ts.isReturnStatement(tsParent)) {
    let fn = tsParent.parent;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    const typeName = fn ? annotatedTypeNameOf(fn.type) : null;
    return (typeName && registry.byTypeName.get(typeName)) ?? null;
  }

  return null;
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

        const entry = resolveEntry(node, tsNode, checker, esToTs, registry);
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
