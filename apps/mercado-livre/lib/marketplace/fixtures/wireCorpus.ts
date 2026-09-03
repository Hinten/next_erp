/**
 * Reader for the committed `__wire__/` corpus — real Mercado Livre response
 * bodies from the #1087 live run, redacted by `scripts/promote-fixtures.ts`.
 *
 * ⚠️ **These are the only ML bodies in this repository that ML actually sent.**
 * Every other fixture in the offline suite is hand-written, which means it agrees
 * with our *belief* about the wire rather than with the wire. That gap is not
 * hypothetical: `orderMLWire.ts:267` hardcodes `date_last_updated: null` because
 * ML sends the field as `date_last_modified`, and no hand-written fixture caught
 * it because every one of them was written from the same wrong belief.
 *
 * ⚠️ **Read them, never rewrite them.** A test that adjusts a body to make an
 * assertion pass has converted the one piece of evidence in the suite back into
 * a hand-written fixture. If a body looks wrong, the finding is about our code
 * or about ML — not about the file.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { WireValue } from './redact';

export const WIRE_DIR = join(import.meta.dirname, '__wire__');

/** Every committed body, sorted. Excludes the README and any dotfile. */
export function listWireFixtures(): string[] {
  if (!existsSync(WIRE_DIR)) return [];
  return readdirSync(WIRE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/** Parse one committed body. Throws on malformed JSON — a corpus file must parse. */
export function readWireFixture(file: string): WireValue {
  return JSON.parse(readFileSync(join(WIRE_DIR, file), 'utf8')) as WireValue;
}

/**
 * The HTTP status a fixture recorded, read off its filename.
 * `orders-1.json` → 200 · `orders-1.404.json` → 404 · `orders-1.206.json` → 206.
 *
 * ⚠️ The convention is `fixtureFileName`'s (`fixtureCapture.ts`): only a **200**
 * takes the bare `.json` name. A 206 is a partial body that OMITS fields rather
 * than nulling them, so reading one as if it were complete is exactly the
 * omitted-vs-null confusion this corpus exists to prevent.
 */
export function statusOfFixture(file: string): number {
  const match = /\.(\d{3})\.json$/.exec(file);
  return match ? Number(match[1]) : 200;
}

/** Only the complete (200) bodies — the ones safe to assert full shape against. */
export function listCompleteWireFixtures(): string[] {
  return listWireFixtures().filter((f) => statusOfFixture(f) === 200);
}

/**
 * The endpoint slug a fixture filename encodes: `.json` and any `.NNN` status
 * suffix removed. `orders-1.json` and `orders-1.404.json` both → `orders-1`.
 */
export function fixtureStem(file: string): string {
  return file.replace(/\.json$/, '').replace(/\.\d{3}$/, '');
}

/**
 * The committed fixture for a capture-plan slug, whatever status it was filed
 * under — or `null` when the corpus never captured that endpoint.
 *
 * ⚠️ **Anchored on the WHOLE stem, and that is the entire point.** The first
 * version asked `/^\d{3}\.json$/.test(f.slice(slug.length + 1))`, which never
 * checked that `f` starts with `slug` — it only asked whether some filename's
 * tail, cut at a fixed offset, looked like `NNN.json`. On the real corpus that
 * resolved **15 of 33 plan slugs to a different resource**, including every
 * `items-MLB…` to an ORDER fixture. A live verify would then have diffed an item
 * against an order and reported the difference as ML drift.
 *
 * ⚠️ It lives HERE, next to the corpus reader, so the script and its tests share
 * one implementation. A hand-copied predicate in a test is the "two copies drift
 * toward plausible" shape from root `CLAUDE.md` — and it happened: the test's
 * copy carried the same bug, so it was green while production was wrong.
 */
export function findFixtureForSlug(slug: string): string | null {
  return listWireFixtures().find((f) => fixtureStem(f) === slug) ?? null;
}
