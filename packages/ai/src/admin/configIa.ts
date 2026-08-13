/**
 * Reading the AI agent's settings document on the suggestion path.
 *
 * The doc is a singleton read by known id on every suggestion, and it changes
 * about as often as someone opens the settings page — so it is cached at the
 * config TTL (15 min), which *is* the staleness bound: a model change takes up
 * to 15 minutes to reach a warm instance. That is stated on the page rather than
 * hidden, because the alternative (an uncached read per suggestion) buys
 * immediacy nobody asked for at the cost of a Firestore read on every click.
 *
 * ⚠️ None of the three forbidden cache cases apply: no `tx.get`, no
 * read-modify-write, no OAuth token. The panel writes this doc through its own
 * transaction in `apps/web` and never reads it back through here.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { configIaCollection } from '@delfrance/data/admin/collections';
import { READ_CACHE_TTL, createCachedDocReader } from '@delfrance/data/admin/cache';
import {
  CONFIG_IA_ML_ATRIBUTOS_DOC_ID,
  CONFIG_IA_MODELO_PADRAO,
  PROVEDOR_IA,
  configIaSchema,
  type ConfigIa,
} from '@delfrance/schemas';

const configIaReader = createCachedDocReader(configIaCollection, {
  name: 'ai:configIa',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 8,
  // A missing doc is the NORMAL state until someone opens the settings page, and
  // it is the answer we want cached — otherwise every suggestion on a fresh
  // tenant pays a Firestore read to learn nothing. `0` would mean "never cache
  // the absence", which is exactly backwards here.
  negativeTtlMs: READ_CACHE_TTL.config,
});

/**
 * The agent's effective settings, with every field resolved.
 *
 * Returns the schema defaults when the document does not exist — which is the
 * state of every tenant that has never opened the settings page, so it must be
 * a first-class answer and not an error.
 */
export async function loadConfigIa(
  db: Firestore,
  docId: string = CONFIG_IA_ML_ATRIBUTOS_DOC_ID,
): Promise<ConfigIa> {
  const stored = await configIaReader.get(db, {}, docId);
  // `parse({})` rather than a hand-written literal: the defaults then live in
  // exactly one place (the schema), so a new field cannot be forgotten here.
  return stored ?? configIaSchema.parse({});
}

/** Test seam — the reader memoizes, so a test that swaps the store must clear it. */
export function __resetConfigIaCache(): void {
  configIaReader.clear();
}

export { CONFIG_IA_ML_ATRIBUTOS_DOC_ID, CONFIG_IA_MODELO_PADRAO, PROVEDOR_IA };
