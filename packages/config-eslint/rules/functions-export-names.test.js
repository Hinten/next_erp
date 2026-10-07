import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertUniqueFunctionNames,
  collectRuntimeExports,
  discoverFunctionEntrypoints,
} from './lib/functions-export-names.js';
import { REPO_ROOT } from './lib/repo-scan.js';

const fixture = (codebase, source) => ({
  codebase,
  path:
    codebase === 'storage'
      ? 'apps/functions/src/index.ts'
      : `apps/${codebase}/functions/src/index.ts`,
  source,
});

describe('Functions export source scanner (#1707)', () => {
  it('collects named exports, multiline lists and exported aliases with their source lines', () => {
    expect(
      collectRuntimeExports(
        [
          "export { first } from './first';",
          'export {',
          '  second,',
          '  localName as deployedName,',
          "} from './handlers';",
          'export { importedName as anotherName };',
          "export { default as namedHandler } from './default';",
        ].join('\n'),
        'index.ts',
      ),
    ).toEqual([
      { name: 'first', line: 1 },
      { name: 'second', line: 3 },
      { name: 'deployedName', line: 4 },
      { name: 'anotherName', line: 6 },
      { name: 'namedHandler', line: 7 },
    ]);
  });

  it('collects inline declarations and every binding in variable declarations', () => {
    const source = [
      'export const first = onSchedule({}, () => {}), second = onSchedule({}, () => {});',
      'export let third = handler;',
      'export var fourth = handler;',
      'export async function fifth() {}',
      'export class Sixth {}',
      'export enum Seventh { A }',
      'export const { source: eighth, nested: { ninth }, ...tenth } = handlers;',
      'export const [eleventh, , twelfth] = handlers;',
    ].join('\n');
    expect(collectRuntimeExports(source, 'index.ts').map(({ name }) => name)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
      'fifth',
      'Sixth',
      'Seventh',
      'eighth',
      'ninth',
      'tenth',
      'eleventh',
      'twelfth',
    ]);
  });

  it('ignores comments, strings, nested declarations and type-only exports', () => {
    const source = [
      '// export const comment = handler;',
      '/* export { blockComment } from "./fake"; */',
      'const text = "export const stringContent = handler;";',
      'const template = `export { templateContent };`;',
      'function local() { const nested = handler; }',
      'export interface Shape { value: string }',
      'export type Alias = string;',
      'export declare const ambient: unknown;',
      "export type { TypeOnly } from './types';",
      "export type * from './more-types';",
      "export type * as Types from './types';",
      "export { type MixedType, realHandler } from './mixed';",
    ].join('\n');
    expect(collectRuntimeExports(source, 'index.ts')).toEqual([{ name: 'realHandler', line: 12 }]);
  });

  it('handles CRLF without changing diagnostic line numbers', () => {
    expect(
      collectRuntimeExports('// header\r\nexport const handler = trigger;\r\n', 'index.ts'),
    ).toEqual([{ name: 'handler', line: 2 }]);
  });

  it.each([
    ["export * from './handlers';", 'Wildcard'],
    ["export * as handlers from './handlers';", 'Namespace'],
    ['export default handler;', 'Default/export-assignment'],
    ['export default function handler() {}', 'Default'],
    ['export default class Handler {}', 'Default'],
    ['export { handler as default };', 'Default'],
    ['export = handler;', 'Default/export-assignment'],
    ['export namespace handlers { export const nested = trigger; }', 'Unsupported runtime'],
    ["export import handler = require('./handler');", 'Unsupported runtime'],
  ])('rejects unsupported runtime exports: %s', (source, reason) => {
    expect(() =>
      collectRuntimeExports(`// header\n${source}`, 'apps/new/functions/src/index.ts'),
    ).toThrow(`apps/new/functions/src/index.ts:2: ${reason}`);
    expect(() => collectRuntimeExports(source, 'index.ts')).toThrow(
      'Functions entrypoints must use explicit named runtime exports.',
    );
  });

  it('rejects malformed source instead of accepting a partial export inventory', () => {
    expect(() =>
      collectRuntimeExports('export const valid = handler;\nexport {', 'index.ts'),
    ).toThrow('index.ts:2: Cannot parse Functions entrypoint:');
  });
});

describe('cross-codebase function name validation (#1707)', () => {
  it('rejects a planted duplicate with both codebases, paths and line numbers', () => {
    expect(() =>
      assertUniqueFunctionNames([
        fixture('mercado-livre', "// header\nexport { onNfeAprovada } from './approval';"),
        fixture('shopee', 'export const onNfeAprovada = trigger;'),
      ]),
    ).toThrow(
      [
        'Cloud Function export names must be unique across codebases (#1707).',
        '  onNfeAprovada:',
        '    - mercado-livre: apps/mercado-livre/functions/src/index.ts:2',
        '    - shopee: apps/shopee/functions/src/index.ts:1',
        'Choose distinct export names and update any enqueue targets together.',
      ].join('\n'),
    );
  });

  it('reports every owner and every collision in deterministic order', () => {
    const entrypoints = ['whatsapp', 'shopee', 'storage'].map((codebase) =>
      fixture(codebase, 'export const zebra = trigger, alpha = trigger;'),
    );
    const message = [
      'Cloud Function export names must be unique across codebases (#1707).',
      '  alpha:',
      '    - shopee: apps/shopee/functions/src/index.ts:1',
      '    - storage: apps/functions/src/index.ts:1',
      '    - whatsapp: apps/whatsapp/functions/src/index.ts:1',
      '  zebra:',
      '    - shopee: apps/shopee/functions/src/index.ts:1',
      '    - storage: apps/functions/src/index.ts:1',
      '    - whatsapp: apps/whatsapp/functions/src/index.ts:1',
      'Choose distinct export names and update any enqueue targets together.',
    ].join('\n');
    expect(() => assertUniqueFunctionNames(entrypoints)).toThrow(message);
    expect(() => assertUniqueFunctionNames([...entrypoints].reverse())).toThrow(message);
  });

  it('keeps suffixed and differently cased names distinct', () => {
    const inventory = assertUniqueFunctionNames([
      fixture('mercado-livre', 'export const onNfeAprovada = trigger;'),
      fixture('shopee', 'export const onNfeAprovadaShopee = trigger;'),
      fixture('storage', 'export const OnNfeAprovada = trigger;'),
    ]);
    expect(inventory.map(({ name }) => name)).toEqual([
      'onNfeAprovada',
      'onNfeAprovadaShopee',
      'OnNfeAprovada',
    ]);
  });

  it('compares deployed aliases rather than local binding names', () => {
    expect(() =>
      assertUniqueFunctionNames([
        fixture('mercado-livre', "export { first as deployed } from './first';"),
        fixture('shopee', "export { second as deployed } from './second';"),
      ]),
    ).toThrow('  deployed:');
    expect(
      assertUniqueFunctionNames([
        fixture('mercado-livre', "export { handler as first } from './handler';"),
        fixture('shopee', "export { handler as second } from './handler';"),
      ]),
    ).toHaveLength(2);
  });

  it('rejects an entrypoint with no runtime exports', () => {
    expect(() =>
      assertUniqueFunctionNames([fixture('shopee', 'export type Empty = string;')]),
    ).toThrow('shopee (apps/shopee/functions/src/index.ts): No runtime exports found');
  });
});

describe('repository function entrypoints (#1707)', () => {
  it('discovers a new nested codebase without adding it to a manual inventory', () => {
    const listFiles = vi.fn(() => [
      'apps/new-channel/functions/src/index.ts',
      'apps/functions/src/index.ts',
      'apps/new-channel/functions/src/index.ts',
      'apps/new-channel/functions/src/index.test.ts',
      'apps/new-channel/functions/nested/src/index.ts',
      'apps/web/src/index.ts',
    ]);
    expect(discoverFunctionEntrypoints(listFiles)).toEqual([
      { codebase: 'storage', path: 'apps/functions/src/index.ts' },
      { codebase: 'new-channel', path: 'apps/new-channel/functions/src/index.ts' },
    ]);
    expect(listFiles).toHaveBeenCalledExactlyOnceWith(
      ['apps/functions/src/index.ts', 'apps/*/functions/src/index.ts'],
      { includeUntracked: true },
    );
  });

  it('checks all current codebases and refuses a vacuous discovery result', () => {
    const entrypoints = discoverFunctionEntrypoints();
    expect(
      entrypoints.length,
      `Only ${entrypoints.length} Functions entrypoints discovered`,
    ).toBeGreaterThanOrEqual(7);
    expect(entrypoints.map(({ codebase }) => codebase)).toEqual(
      expect.arrayContaining([
        'storage',
        'nfe',
        'mercado-livre',
        'mercado-pago',
        'whatsapp',
        'shopee',
        'melhor-envio',
      ]),
    );
    const inventory = assertUniqueFunctionNames(
      entrypoints.map((entrypoint) => ({
        ...entrypoint,
        source: readFileSync(resolve(REPO_ROOT, entrypoint.path), 'utf8'),
      })),
    );
    // Pin both existing source forms: named re-export and inline declaration.
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codebase: 'mercado-livre', name: 'onNfeAprovada' }),
        expect.objectContaining({ codebase: 'shopee', name: 'onNfeAprovadaShopee' }),
        expect.objectContaining({ codebase: 'mercado-livre', name: 'importMercadoLivreOrders' }),
      ]),
    );
  });
});
