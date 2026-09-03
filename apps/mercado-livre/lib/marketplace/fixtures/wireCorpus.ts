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
