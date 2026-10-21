import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './lib/repo-scan.js';

// #1431: apps own SDK initialization and response adapters; security decisions
// live once in data/admin. Discover conventional adapters so a ninth copy cannot
// silently acquire its own token parsing or error classification.
const AUTH_APPS = [
  'amazon',
  'integrations',
  'loja-integrada',
  'melhor-envio',
  'mercado-livre',
  'mercado-pago',
  'nfe',
  'shopee',
  'whatsapp',
];
const HMAC_APPS = ['integrations', 'melhor-envio', 'mercado-livre', 'mercado-pago', 'whatsapp'];
const AUTH_FILES = AUTH_APPS.map((app) =>
  app === 'nfe' ? 'apps/nfe/lib/nfe/auth.ts' : 'apps/' + app + '/lib/auth/verifyCaller.ts',
);

function read(file) {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

function authAdapterProblems(source) {
  const file = ts.createSourceFile('adapter.ts', source, ts.ScriptTarget.Latest, true);
  const problems = [];
  let sharedImport = false;
  let factoryCalls = 0;
  let delegateCalls = 0;
  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@delfrance/data/admin/auth'
    ) {
      const bindings = node.importClause?.namedBindings;
      sharedImport ||=
        !!bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (binding) => (binding.propertyName ?? binding.name).text === 'createCallerVerifier',
        );
    }
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      const name = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target)
          ? target.name.text
          : '';
      if (name === 'createCallerVerifier') factoryCalls += 1;
      if (name === 'verifyCallerCore') delegateCalls += 1;
      if (name === 'hasPerm' || name === 'verifyIdToken') problems.push('local ' + name + ' call');
    }
    if (ts.isCatchClause(node)) problems.push('local error classification');
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'headers') {
      problems.push('local header parsing');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!sharedImport) problems.push('missing shared factory import');
  if (factoryCalls !== 1) problems.push('expected one shared factory binding');
  if (delegateCalls !== 1) problems.push('expected one shared verifier call');
  return problems;
}

const VALID_ADAPTER = [
  "import { createCallerVerifier } from '@delfrance/data/admin/auth';",
  'const verifyCallerCore = createCallerVerifier(options);',
  'export async function verifyCaller(req, required) {',
  '  return verifyCallerCore(req, required);',
  '}',
].join('\n');

describe('shared security adapters (#1431)', () => {
  it('includes every conventional auth adapter and the NFe original', () => {
    const discovered = readdirSync(resolve(REPO_ROOT, 'apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => 'apps/' + entry.name + '/lib/auth/verifyCaller.ts')
      .filter((file) => existsSync(resolve(REPO_ROOT, file)));
    expect([...discovered, 'apps/nfe/lib/nfe/auth.ts'].sort()).toEqual([...AUTH_FILES].sort());
  });

  it.each(AUTH_FILES)('%s delegates authentication decisions to the shared verifier', (file) => {
    expect(authAdapterProblems(read(file))).toEqual([]);
  });

  it.each(HMAC_APPS)('%s re-exports the shared HMAC primitive', (app) => {
    const source = read('apps/' + app + '/lib/signatures/hmac.ts');
    const file = ts.createSourceFile('hmac.ts', source, ts.ScriptTarget.Latest, true);
    const reexports = file.statements.filter(
      (node) =>
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '@delfrance/data/admin/signatures',
    );
    expect(reexports).toHaveLength(1);
    expect(source).not.toMatch(/\b(?:createHmac|timingSafeEqual)\s*\(/);
  });

  it('accepts a thin adapter and ignores security words in comments', () => {
    expect(
      authAdapterProblems(VALID_ADAPTER + '\n// req.headers; hasPerm(); try {} catch {}'),
    ).toEqual([]);
  });

  it.each([
    ['hasPerm()', 'local hasPerm call'],
    ['auth.verifyIdToken(token)', 'local verifyIdToken call'],
    ['req.headers.get("authorization")', 'local header parsing'],
    ['try {} catch (err) {}', 'local error classification'],
  ])('rejects renewed security decisions: %s', (statement, problem) => {
    expect(authAdapterProblems(VALID_ADAPTER + '\n' + statement)).toContain(problem);
  });

  it('rejects an unshared or unused factory', () => {
    expect(authAdapterProblems('export function verifyCaller() {}')).toContain(
      'missing shared factory import',
    );
    expect(
      authAdapterProblems(
        VALID_ADAPTER.replace('return verifyCallerCore(req, required);', 'return {};'),
      ),
    ).toContain('expected one shared verifier call');
  });
});
