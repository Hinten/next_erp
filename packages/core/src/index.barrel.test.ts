import { describe, expect, it } from 'vitest';
import * as cep from './cep';
import * as core from './index';

/**
 * `@delfrance/schemas` depends on `@delfrance/core`, and `@delfrance/schemas`
 * is imported by everything — including `apps/web`, which is client-first. So
 * anything reachable from core's ROOT barrel is reachable from every browser
 * bundle in the monorepo.
 *
 * The `./cep` subpath is deliberately excluded from that barrel. It is small
 * and data-free today, but it is the CEP module's front door — and the thing
 * behind it (`ViaCepError`, the client) has no business in a bundle that only
 * wanted `formatReais`. Keeping it opt-in also means a future addition there
 * cannot silently reach every browser bundle in the monorepo.
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
