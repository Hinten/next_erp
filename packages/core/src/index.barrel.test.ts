import { describe, expect, it } from 'vitest';
import * as cep from './cep';
import * as region from './region';
import * as wire from './wire';
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

  it('does not re-export anything from the ./region subpath', () => {
    // Same rule as ./cep, different reason: ./region reads `process.env` to
    // resolve a Cloud Tasks region — a server-only concern. Nothing that ends up
    // in a browser bundle should be able to reach it, and a root-barrel
    // re-export would put it there for every consumer of `formatReais`.
    const rootExports = new Set(Object.keys(core));
    const leaked = Object.keys(region).filter((name) => rootExports.has(name));

    expect(leaked).toEqual([]);
  });

  it('is comparing against a non-empty ./region surface', () => {
    expect(Object.keys(region).length).toBeGreaterThan(0);
  });

  it('is comparing against a non-empty ./cep surface', () => {
    // Guards the test above from passing vacuously if `./cep` is ever emptied
    // or its barrel stops re-exporting values.
    expect(Object.keys(cep).length).toBeGreaterThan(0);
  });

  it('does not re-export anything from the ./wire subpath', () => {
    // Same rule as ./cep and ./region, third reason: `./wire` is an
    // explicit-import coercer for provider RESPONSE schemas, not something
    // `formatReais` should drag into every browser bundle. Its own docstring
    // states this invariant — and a stated-but-unenforced invariant is exactly
    // the failure shape that module is about, since `export * from './wire'`
    // is a one-line, obviously-correct-looking diff that nothing else fails.
    const rootExports = new Set(Object.keys(core));
    const leaked = Object.keys(wire).filter((name) => rootExports.has(name));

    expect(leaked).toEqual([]);
  });

  it('is comparing against a non-empty ./wire surface', () => {
    expect(Object.keys(wire).length).toBeGreaterThan(0);
  });
});
