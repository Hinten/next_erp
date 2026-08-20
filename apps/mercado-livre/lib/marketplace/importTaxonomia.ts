/**
 * IO for the ML→ERP taxonomy resolver (#520): loads `grupoDeVariacoes`
 * candidates for a set of item combos, runs the pure `planTaxonomia` (#519
 * matching cascade), and persists whatever it couldn't match.
 *
 * ## The legacy embedded-array hazard
 * `grupoDeVariacoes.variacoes` is an EMBEDDED array on the grupo doc, not a
 * subcollection — and the legacy Flutter app treats the whole doc as one
 * `copyWith`-and-save unit (its own variation editor reads the full doc,
 * mutates the in-memory model, and overwrites the array wholesale). That
 * means a bare "read the array, push an entry, write it back" from this side
 * can lose a concurrent Flutter write with no Firestore-level signal at all —
 * Firestore only protects against contention on documents it's tracking
 * INSIDE a transaction, not against a stale in-memory array a Flutter session
 * had already loaded before this transaction committed. `db.runTransaction`
 * closes the window against concurrent ERP-side writers (this module retries
 * on contention and always mutates the freshly re-read doc) but cannot close
 * it against a Flutter `copyWith`-save that started before and lands after —
 * an inherent risk of the embedded-array-plus-whole-doc-save pattern the
 * legacy app chose. Nothing below can make that racier than it already is;
 * re-planning against the latest read on every attempt is the best available
 * mitigation.
 *
 * ## Per-grupo transactions, not one big transaction
 * One `db.runTransaction` per grupo that needs a write (mirrors the outer
 * plan, then re-reads + re-plans against the LATEST doc before writing — so a
 * concurrent ERP-side writer that already landed the same variante/link is
 * simply a no-op here, not a conflict). Grupo docs are otherwise independent,
 * so batching them into one transaction would only add contention between
 * unrelated groups for no benefit.
 *
 * ## Why the update path never runs `grupoDeVariacoesSchema.parse()`
 * The schema has no `.passthrough()`, so a full-schema parse silently STRIPS
 * any key the Flutter app wrote that isn't in our Zod shape — unacceptable for
 * a doc the other app keeps reading. Updates instead splice the planned delta
 * (new variante entries / link stamps) directly into the raw Firestore data
 * and `tx.set()` the whole spread-existing object. Only a brand-new doc (this
 * app's own future write, no pre-existing unknown keys to lose) goes through
 * `.parse()`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { MlItemAttribute } from '@delfrance/integrations-mercado-livre';
import { TIPO_VARIACAO, type GrupoComId, type GrupoDeVariacoes } from '@delfrance/schemas';
import { grupoDeVariacoesCollection } from '@delfrance/data/admin/collections';

import {
  comboAttrKey,
  nonEmptyString,
  planTaxonomia,
  type TaxonomiaResolution,
} from './taxonomiaCore';

function toGrupoComId(id: string, raw: FirebaseFirestore.DocumentData): GrupoComId {
  // Deliberately NOT `grupoDeVariacoesCollection.parseRead` — matching only
  // reads a handful of typed fields (nome/tipo/variacoes/variacoesIds), and
  // keeping `raw` as-is means it can be spread back out untouched later.
  return { id, data: raw as GrupoDeVariacoes };
}

/**
 * Candidate `grupoDeVariacoes` docs for the matching cascade: a direct get per
 * distinct attribute id, a `nome ==` query per distinct attribute name, and a
 * `tipo ==` query for tamanho/cor when a 'SIZE'/'COLOR' combo is present.
 * De-duped by doc id (the same grupo can surface from more than one query).
 */
async function loadCandidateGrupos(
  db: Firestore,
  combos: MlItemAttribute[],
): Promise<GrupoComId[]> {
  const attrIds = new Set<string>();
  const attrNames = new Set<string>();
  let needsTamanhoTipo = false;
  let needsCorTipo = false;

  for (const combo of combos) {
    const attrId = nonEmptyString(combo.id);
    const attrName = nonEmptyString(combo.name);
    if (attrId != null) attrIds.add(attrId);
    if (attrName != null) attrNames.add(attrName);
    if (attrId === 'SIZE') needsTamanhoTipo = true;
    if (attrId === 'COLOR') needsCorTipo = true;
  }

  const found = new Map<string, GrupoComId>();
  const col = grupoDeVariacoesCollection.ref(db, {});

  await Promise.all(
    [...attrIds].map(async (id) => {
      const snap = await grupoDeVariacoesCollection.docRef(db, {}, id).get();
      if (snap.exists) found.set(id, toGrupoComId(id, snap.data()!));
    }),
  );
  await Promise.all(
    [...attrNames].map(async (nome) => {
      const snap = await col.where('nome', '==', nome).get();
      for (const d of snap.docs) found.set(d.id, toGrupoComId(d.id, d.data()));
    }),
  );
  if (needsTamanhoTipo) {
    const snap = await col.where('tipo', '==', TIPO_VARIACAO.tamanho).get();
    for (const d of snap.docs) found.set(d.id, toGrupoComId(d.id, d.data()));
  }
  if (needsCorTipo) {
    const snap = await col.where('tipo', '==', TIPO_VARIACAO.cor).get();
    for (const d of snap.docs) found.set(d.id, toGrupoComId(d.id, d.data()));
  }

  return [...found.values()];
}

/**
 * Splice `planTaxonomia`'s delta for ONE existing grupo onto its freshly-read
 * raw doc: append brand-new Variante entries, stamp a link onto an existing
 * Variante that's missing it, and keep `variacoesIds` in sync. Never touches a
 * key it doesn't know about — everything else in `raw` survives untouched.
 */
function applyDeltaToRaw(
  raw: Record<string, unknown>,
  appends: { variante: Record<string, unknown> }[],
  stamps: { varianteId: string; link: Record<string, unknown> }[],
  now: number,
): Record<string, unknown> {
  const variacoes = Array.isArray(raw.variacoes)
    ? [...(raw.variacoes as Record<string, unknown>[])]
    : [];
  for (const a of appends) variacoes.push(a.variante);
  for (const s of stamps) {
    const idx = variacoes.findIndex((v) => v.id === s.varianteId);
    if (idx < 0) continue; // matched against a doc that's since lost the variante (shouldn't happen)
    const links = Array.isArray(variacoes[idx]!.externalVariacaoLinks)
      ? [...(variacoes[idx]!.externalVariacaoLinks as unknown[])]
      : [];
    links.push(s.link);
    variacoes[idx] = { ...variacoes[idx], externalVariacaoLinks: links };
  }
  const variacoesIds = [
    ...new Set([
      ...(Array.isArray(raw.variacoesIds) ? (raw.variacoesIds as string[]) : []),
      ...variacoes.map((v) => v.id as string),
    ]),
  ];
  return { ...raw, variacoes, variacoesIds, ultimaModificacao: now };
}

/**
 * Resolve (matching what already exists) or create (what doesn't) the
 * `grupoDeVariacoes` / `Variante` taxonomy for one item's unioned
 * `attribute_combinations[]`. Returns one resolution per usable combo — the
 * caller (#520's child-produto assembly) looks each variation's combos up by
 * `comboAttrKey` to build its `grupoDeVariacoesUid` / `variacoesUid`.
 */
export async function resolveTaxonomia(
  deps: { db: Firestore },
  args: { combos: MlItemAttribute[]; integracaoId: string; now: number },
): Promise<TaxonomiaResolution[]> {
  const { db } = deps;
  const { combos, integracaoId, now } = args;

  const candidates = await loadCandidateGrupos(db, combos);
  const outerPlan = planTaxonomia(candidates, combos, integracaoId, now);

  const mutatedGrupoIds = new Set<string>([
    ...outerPlan.gruposToCreate.map((g) => g.id),
    ...outerPlan.variantesToAppend.map((v) => v.grupoId),
    ...outerPlan.linksToStamp.map((l) => l.grupoId),
  ]);
  if (mutatedGrupoIds.size === 0) return outerPlan.resolutions; // everything already matched cleanly

  // attrKey -> original combo, so each grupo's transaction can re-scope the
  // combos to just the ones IT owns (per the outer plan) for its re-plan.
  const comboByAttrKey = new Map<string, MlItemAttribute>();
  for (const combo of combos) {
    const key = comboAttrKey(combo);
    if (!comboByAttrKey.has(key)) comboByAttrKey.set(key, combo);
  }

  const finalResolutions: TaxonomiaResolution[] = outerPlan.resolutions.filter(
    (r) => !mutatedGrupoIds.has(r.grupoId),
  );

  for (const gid of mutatedGrupoIds) {
    const relevantCombos = outerPlan.resolutions
      .filter((r) => r.grupoId === gid)
      .map((r) => comboByAttrKey.get(r.attrKey))
      .filter((c): c is MlItemAttribute => c != null);

    const ref = grupoDeVariacoesCollection.docRef(db, {}, gid);
    // Re-entrant: Firestore retries this closure on contention, so every
    // attempt re-reads and re-plans from scratch — no state carried across
    // attempts except the immutable `relevantCombos`/`gid`/`integracaoId`/`now`.
    const txResolutions = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const fresh: GrupoComId[] = snap.exists ? [toGrupoComId(gid, snap.data()!)] : [];
      const rePlan = planTaxonomia(fresh, relevantCombos, integracaoId, now);

      const created = rePlan.gruposToCreate.find((g) => g.id === gid);
      if (created) {
        // `snap.exists` was false a moment ago (else `fresh` wouldn't be
        // empty and `rePlan` couldn't have decided to create) — no
        // ALREADY_EXISTS race is possible here, the read-before-create IS
        // the guard.
        tx.create(
          ref,
          grupoDeVariacoesCollection.parse(created.data) as FirebaseFirestore.DocumentData,
        );
        return rePlan.resolutions;
      }

      const appends = rePlan.variantesToAppend.filter((v) => v.grupoId === gid);
      const stamps = rePlan.linksToStamp.filter((l) => l.grupoId === gid);
      if (appends.length === 0 && stamps.length === 0) {
        // A concurrent writer already landed the same variante/link between
        // the outer plan and this transaction — contention self-resolved.
        return rePlan.resolutions;
      }

      const raw = applyDeltaToRaw(
        { ...(snap.data() as Record<string, unknown>) },
        appends.map((a) => ({ variante: a.variante as unknown as Record<string, unknown> })),
        stamps.map((s) => ({
          varianteId: s.varianteId,
          link: s.link as unknown as Record<string, unknown>,
        })),
        now,
      );
      tx.set(ref, raw as FirebaseFirestore.DocumentData);
      return rePlan.resolutions;
    });

    finalResolutions.push(...txResolutions);
  }

  return finalResolutions;
}
