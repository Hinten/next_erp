import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { gitGrep, REPO_ROOT } from './lib/repo-scan.js';

// #836: repository refs share their extraction contract. This deliberately
// checks the audited adapters, not every slash in the repository: notification
// resources, Storage objects and variation fake paths have different grammars.
// OuterRef is an unbranded string alias, so a type-aware rule cannot recover
// that distinction. Behavioral tests in the owning workspaces pin the contract;
// this small source guard prevents the known copies from returning unnoticed.
const ML_REFS = 'apps/mercado-livre/lib/marketplace/core/linkRefs.ts';
const SHARED_MATCHER = 'packages/schemas/src/integracao.ts';

const ADAPTERS = [
  ['packages/schemas/src/impostoProduto.ts', 'operacaoIdFromImpostoRef'],
  ['packages/schemas/src/produto/pureLogic/dimensoes.ts', 'normalizeProdutoId'],
  ['packages/data/src/admin/imposto/resolverImposto.ts', 'parseCategoriaUid'],
  ['apps/web/lib/produtos/fotoRefs.ts', 'arquivoIdFromRef'],
  [
    'apps/web/lib/pedido/downloadAnexos.ts',
    'arquivoIdFromOuterRef',
    {
      // Slice checks for descendants after normalization; schemas extracts the id.
      allowedMethods: ['slice'],
      requiredHelpers: ['toDocPathOrNull', 'idFromRefOrNull'],
    },
  ],
  ['apps/web/app/(app)/medidas/_components/SizeChartEditorModal.tsx', 'grupoIdOf'],
  ['apps/web/app/(app)/pedidos/_components/integracaoLookup.ts', 'integracaoIdFromOuterRef'],
  ['apps/web/app/(app)/pedidos/_components/ClienteColumnFilter.tsx', 'formatClienteFilterValue'],
];

// Slash splitting is forbidden only in these migrated modules. Exceptions are
// functions, not whole files, so another repository parser beside one still reds
// CI. The comments explain why each surviving grammar cannot use idFromRef.
const MODULES = {
  [ML_REFS]: [
    'parsePmlOuterRef', // Reads the ML link hierarchy with its existing tolerant grammar.
    'lastSegment', // ML notification resources also carry bare provider ids.
    'parseItemIdFromResource', // A provider resource, not a stored document ref.
  ],
  'apps/mercado-livre/lib/marketplace/importacao/import.ts': [],
  'apps/mercado-livre/lib/marketplace/importacao/importCore.ts': [],
  'apps/mercado-livre/lib/marketplace/importacao/importMigration.ts': [],
  'apps/mercado-livre/lib/marketplace/importacao/importVariations.ts': [],
  'apps/mercado-livre/lib/marketplace/pedidos/orderProdutoResolve.ts': [],
  'apps/mercado-livre/lib/marketplace/pedidos/pedidoTravadoSweep.ts': [],
  'apps/mercado-livre/lib/marketplace/size-charts/sizeChart.ts': [],
  'packages/schemas/src/produto/pureLogic/variacoes.ts': [
    'parseFakePath', // Domain-specific virtual variation hierarchy.
  ],
  'packages/schemas/src/produto/pureLogic/kitVariacoes.ts': [],
  'packages/schemas/src/produto/pureLogic/dimensoes.ts': [],
  'packages/schemas/src/impostoProduto.ts': [],
  'packages/data/src/admin/defineAdminCollection.ts': [],
  'packages/data/src/admin/imposto/resolverImposto.ts': [],
  'apps/functions/src/estoques/sincronizarEstoquePedido.ts': [],
  'apps/nfe/lib/nfe/imposto-resolver.ts': [],
  'apps/nfe/lib/nfe/orchestrator/cancelar.ts': [],
  'apps/web/lib/produtos/fotoRefs.ts': [],
  'apps/web/lib/pedido/downloadAnexos.ts': [],
  'apps/web/lib/mercado-livre/listingLinks.ts': [],
  'apps/web/components/photo-manager/arquivoRef.ts': [],
  'apps/web/app/(app)/listas-de-precos/_components/FormulasPorCategoriaEditor.tsx': [],
  'apps/web/app/(app)/medidas/_components/SizeChartEditorModal.tsx': [],
  'apps/web/app/(app)/operacoes/_components/MacrosTab.tsx': [],
  'apps/web/app/(app)/pedidos/_components/ClienteColumnFilter.tsx': [],
  'apps/web/app/(app)/pedidos/_components/integracaoLookup.ts': [],
  'apps/web/app/(app)/pedidos/_components/rowReadPrefetch.ts': [],
  'apps/web/app/(app)/produtos/[id]/editar/page.tsx': [],
  'apps/web/app/(app)/produtos/_components/AnexoManager.tsx': [],
  'apps/web/app/(app)/produtos/_components/PrecoCustoManager.tsx': [],
  'apps/web/app/(app)/produtos/_components/VariationManager.tsx': [],
  'apps/web/app/(app)/produtos/_components/VideoManager.tsx': [],
};

const RETIRED = [
  ['packages/data/src/admin/defineAdminCollection.ts', 'lastSegment'],
  ['packages/data/src/admin/imposto/resolverImposto.ts', 'trailingSegment'],
  ['apps/functions/src/estoques/sincronizarEstoquePedido.ts', 'idDeOuterRef'],
  ['packages/schemas/src/produto/pureLogic/kitVariacoes.ts', 'lastId'],
  ['apps/mercado-livre/lib/marketplace/importacao/importCore.ts', 'lastSegment'],
  ['apps/mercado-livre/lib/marketplace/size-charts/sizeChart.ts', 'lastSegment'],
  ['apps/web/components/photo-manager/arquivoRef.ts', 'idFromRef'],
  ['apps/web/app/(app)/produtos/_components/AnexoManager.tsx', 'idFromRef'],
  ['apps/web/app/(app)/produtos/_components/VideoManager.tsx', 'idFromRef'],
  ['apps/web/app/(app)/listas-de-precos/_components/FormulasPorCategoriaEditor.tsx', 'idFromRef'],
  ['apps/web/app/(app)/operacoes/_components/MacrosTab.tsx', 'bareId'],
  ['apps/web/app/(app)/pedidos/_components/rowReadPrefetch.ts', 'idFromPath'],
];

const parsed = new Map();
function sourceFile(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

function read(path) {
  if (!parsed.has(path)) {
    parsed.set(path, sourceFile(path, readFileSync(resolve(REPO_ROOT, path), 'utf8')));
  }
  return parsed.get(path);
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function implementationName(node) {
  if (ts.isFunctionDeclaration(node) && node.body) return node.name?.text;
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return undefined;
}

function implementations(file, name) {
  const found = [];
  visit(file, (node) => {
    if (implementationName(node) === name) found.push(node);
  });
  return found;
}

function methodName(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : undefined;
}

function slashSplits(file, exceptions = []) {
  const problems = [];
  function walk(node) {
    if (exceptions.includes(implementationName(node))) return;
    if (
      methodName(node) === 'split' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === '/'
    ) {
      problems.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, walk);
  }
  walk(file);
  return problems;
}

function adapterProblems(
  file,
  name,
  { allowedMethods = [], requiredHelpers = ['idFromRefOrNull'] } = {},
) {
  const definitions = implementations(file, name);
  if (definitions.length !== 1) return ['expected one adapter implementation'];
  const sharedBindings = new Map();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    if (module !== '@delfrance/schemas' && !module.endsWith('/outerRef')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (
        ['idFromRefOrNull', 'toDocPathOrNull'].includes((binding.propertyName ?? binding.name).text)
      ) {
        sharedBindings.set(binding.name.text, (binding.propertyName ?? binding.name).text);
      }
    }
  }
  const delegates = new Set();
  const problems = [];
  visit(definitions[0], (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = sharedBindings.get(node.expression.text);
      if (helper) delegates.add(helper);
    }
    const method = methodName(node);
    if (
      ['split', 'filter', 'pop', 'at', 'slice', 'substring', 'substr', 'lastIndexOf'].includes(
        method,
      )
    ) {
      if (!allowedMethods.includes(method)) problems.push('local ' + method + ' extraction');
    }
  });
  if (!requiredHelpers.every((helper) => delegates.has(helper)))
    problems.push('missing shared ref extraction');
  return problems;
}

let namedSources;
function implementationPaths(name) {
  // Discover files once, then parse only candidates. Parsing the entire monorepo
  // would retain thousands of unrelated ASTs just to inspect two function names.
  namedSources ??= gitGrep({
    patterns: ['parsePmlOuterRef', 'refMatchesIntegracao'],
    pathspecs: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts', 'packages/**/*.tsx'],
    mode: 'fixed',
  })
    .filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))
    .filter((path) => !path.includes('/generated/'));
  return namedSources.flatMap((path) => implementations(read(path), name).map(() => path)).sort();
}

describe('shared repository reference adoption (#836)', () => {
  it('has exactly one PML parser and one integration matcher implementation', () => {
    expect(implementationPaths('parsePmlOuterRef')).toEqual([ML_REFS]);
    expect(implementationPaths('refMatchesIntegracao')).toEqual([SHARED_MATCHER]);
  });

  it.each(ADAPTERS)('%s: %s delegates extraction to schemas', (path, name, options) => {
    expect(adapterProblems(read(path), name, options)).toEqual([]);
  });

  it.each(Object.entries(MODULES))('%s has no renewed slash parser', (path, exceptions) => {
    const file = read(path);
    for (const name of exceptions) expect(implementations(file, name)).toHaveLength(1);
    expect(slashSplits(file, exceptions)).toEqual([]);
  });

  it.each(RETIRED)('%s does not reintroduce %s', (path, name) => {
    expect(implementations(read(path), name)).toHaveLength(0);
  });

  it('recognizes declarations and arrow copies but ignores imports, re-exports and prose', () => {
    const file = sourceFile(
      'fixture.ts',
      `import { parsePmlOuterRef } from './shared';
       export { parsePmlOuterRef } from './shared';
       // function parsePmlOuterRef(ref) {}
       const prose = 'function parsePmlOuterRef(ref) {}';
       function parsePmlOuterRef(ref) { return null; }
       const parsePmlOuterRef = (ref) => null;`,
    );
    expect(implementations(file, 'parsePmlOuterRef')).toHaveLength(2);
  });

  it('rejects renamed slash extraction beside an explicitly permitted provider parser', () => {
    const file = sourceFile(
      'fixture.ts',
      `function parseItemIdFromResource(resource) { return resource.split('/').pop(); }
       const anotherRefCopy = (ref) => ref.split('/').filter(Boolean).pop();`,
    );
    expect(slashSplits(file, ['parseItemIdFromResource'])).toHaveLength(1);
  });

  it('keeps provider and Storage grammars outside the repository-ref policy', () => {
    const file = sourceFile(
      'fixture.ts',
      `function resourceId(resource) { return resource.split('/').pop(); }
       function storageFilename(name) { return name.split('/').pop(); }
       // ref.split('/').pop();
       const prose = "ref.split('/').pop()";
       const dottedField = field.split('.');`,
    );
    expect(slashSplits(file)).toHaveLength(2);
    expect(slashSplits(file, ['resourceId', 'storageFilename'])).toEqual([]);
  });

  it('accepts an imported alias, and refuses an unused import or a renewed extraction', () => {
    const adapter = `import { idFromRefOrNull as sharedId } from '@delfrance/schemas';
      export function arquivoIdFromRef(ref) { return sharedId(ref); }`;
    expect(adapterProblems(sourceFile('fixture.ts', adapter), 'arquivoIdFromRef')).toEqual([]);
    expect(
      adapterProblems(
        sourceFile('fixture.ts', adapter.replace('sharedId(ref)', 'ref')),
        'arquivoIdFromRef',
      ),
    ).toContain('missing shared ref extraction');
    for (const extraction of [
      "ref.split('/').filter(Boolean).pop()",
      'ref.slice(9)',
      'ref.at(-1)',
    ]) {
      const mutated = adapter.replace(
        'return sharedId(ref);',
        `sharedId(ref); return ${extraction};`,
      );
      expect(
        adapterProblems(sourceFile('fixture.ts', mutated), 'arquivoIdFromRef').length,
      ).toBeGreaterThan(0);
    }
    expect(adapterProblems(sourceFile('fixture.ts', ''), 'arquivoIdFromRef')).toContain(
      'expected one adapter implementation',
    );
  });

  it('allows strict descendant checks only while both shared path and id readers are called', () => {
    const options = {
      allowedMethods: ['slice'],
      requiredHelpers: ['toDocPathOrNull', 'idFromRefOrNull'],
    };
    const adapter = `import { toDocPathOrNull, idFromRefOrNull } from '@delfrance/schemas';
      function arquivoIdFromOuterRef(ref) {
        const path = toDocPathOrNull(ref);
        if (path === null || path.slice(9).includes('/')) return null;
        return idFromRefOrNull(path);
      }`;
    expect(
      adapterProblems(sourceFile('fixture.ts', adapter), 'arquivoIdFromOuterRef', options),
    ).toEqual([]);
    for (const [shared, local] of [
      ['toDocPathOrNull(ref)', 'ref'],
      ['idFromRefOrNull(path)', 'path.slice(9)'],
    ]) {
      expect(
        adapterProblems(
          sourceFile('fixture.ts', adapter.replace(shared, local)),
          'arquivoIdFromOuterRef',
          options,
        ),
      ).toContain('missing shared ref extraction');
    }
  });
});
