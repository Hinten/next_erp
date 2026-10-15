import ts from 'typescript';
import { gitLsFiles } from './repo-scan.js';

const ENTRYPOINT_PATHSPECS = ['apps/functions/src/index.ts', 'apps/*/functions/src/index.ts'];

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Discover source entrypoints, including new files before they are staged. */
export function discoverFunctionEntrypoints(listFiles = gitLsFiles) {
  return [...new Set(listFiles(ENTRYPOINT_PATHSPECS, { includeUntracked: true }))]
    .sort(compareText)
    .flatMap((path) => {
      if (path === 'apps/functions/src/index.ts') return [{ codebase: 'storage', path }];
      const match = /^apps\/([^/]+)\/functions\/src\/index\.ts$/.exec(path);
      return match ? [{ codebase: match[1], path }] : [];
    });
}

/**
 * Read export keys without importing triggers or resolving their dependencies.
 * Entrypoints must expose flat, explicitly named runtime exports. Unsupported
 * forms fail instead of making part of the function inventory invisible (#1707).
 * @param {string} source
 * @param {string} path
 * @returns {{ name: string, line: number }[]}
 */
export function collectRuntimeExports(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exports = [];
  const lineAt = (pos) => file.getLineAndCharacterOfPosition(pos).line + 1;
  const fail = (node, reason) => {
    throw new Error(
      `${path}:${lineAt(node.getStart(file))}: ${reason}. ` +
        'Functions entrypoints must use explicit named runtime exports.',
    );
  };
  const add = (name) => exports.push({ name: name.text, line: lineAt(name.getStart(file)) });
  const addBinding = (name) => {
    if (ts.isIdentifier(name)) add(name);
    else {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBinding(element.name);
      }
    }
  };

  if (file.parseDiagnostics.length > 0) {
    const diagnostic = file.parseDiagnostics[0];
    throw new Error(
      `${path}:${lineAt(diagnostic.start ?? 0)}: Cannot parse Functions entrypoint: ` +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
  }

  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) fail(statement, 'Default/export-assignment unsupported');
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) fail(statement, 'Wildcard export unsupported');
      if (!ts.isNamedExports(statement.exportClause)) {
        fail(statement, 'Namespace export unsupported');
      }
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        if (element.name.text === 'default') fail(element, 'Default export unsupported');
        add(element.name);
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      fail(statement, 'Default export unsupported');
    }
    // These declarations are erased by TypeScript and expose no deployed key.
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBinding(declaration.name);
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      add(statement.name);
    } else {
      fail(statement, 'Unsupported runtime export declaration');
    }
  }
  return exports;
}

/**
 * The same validation path serves both repository state and planted fixtures.
 * Equality is exact: suffixes and case are meaningful function-name differences.
 * @param {{ codebase: string, path: string, source: string }[]} entrypoints
 * @returns {{ codebase: string, path: string, name: string, line: number }[]}
 */
export function assertUniqueFunctionNames(entrypoints) {
  const ownersByName = new Map();
  const inventory = [];
  for (const { codebase, path, source } of entrypoints) {
    const exports = collectRuntimeExports(source, path);
    if (exports.length === 0) {
      throw new Error(
        `${codebase} (${path}): No runtime exports found; the inventory would be empty.`,
      );
    }
    for (const exported of exports) {
      const owner = { codebase, path, ...exported };
      inventory.push(owner);
      const owners = ownersByName.get(owner.name) ?? [];
      owners.push(owner);
      ownersByName.set(owner.name, owners);
    }
  }

  const collisions = [...ownersByName]
    .filter(([, owners]) => new Set(owners.map((owner) => owner.codebase)).size > 1)
    .sort(([a], [b]) => compareText(a, b));
  if (collisions.length > 0) {
    throw new Error(
      [
        'Cloud Function export names must be unique across codebases (#1707).',
        ...collisions.flatMap(([name, owners]) => [
          `  ${name}:`,
          ...owners
            .sort(
              (a, b) =>
                compareText(a.codebase, b.codebase) ||
                compareText(a.path, b.path) ||
                a.line - b.line,
            )
            .map((owner) => `    - ${owner.codebase}: ${owner.path}:${owner.line}`),
        ]),
        'Choose distinct export names and update any enqueue targets together.',
      ].join('\n'),
    );
  }
  return inventory;
}
