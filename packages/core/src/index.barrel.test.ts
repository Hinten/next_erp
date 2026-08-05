import { describe, expect, it } from 'vitest';
import * as cep from './cep';
import * as core from './index';

/**
 * `@delfrance/schemas` depends on `@delfrance/core`, and `@delfrance/schemas`
 * is imported by everything — including `apps/web`, which is client-first. So
 * anything reachable from core's ROOT barrel is reachable from every browser
 * bundle in the monorepo.
 *
 * The `./cep` subpath is deliberately excluded from that barrel: its sibling
 * `./cep/cmun` carries the vendored CEP-range → IBGE município table (#785,
 * ~150 KB), and a single `export * from './cep'` here would be one refactor
 * away from dragging it into the browser. This is the same containment the NF-e
 * package gets from its `./http-provider` subpath.
 *
 * Asserting on the real module namespaces rather than grepping `index.ts` also
 * catches an INDIRECT leak — some other core module re-exporting `./cep`.
 */
describe('packages/core root barrel', () => {
  it('does not re-export anything from the ./cep subpath', () => {
    const rootExports = new Set(Object.keys(core));
    const leaked = Object.keys(cep).filter((name) => rootExports.has(name));

    expect(leaked).toEqual([]);
  });

  it('is comparing against a non-empty ./cep surface', () => {
    // Guards the test above from passing vacuously if `./cep` is ever emptied
    // or its barrel stops re-exporting values.
    expect(Object.keys(cep).length).toBeGreaterThan(0);
  });
});
