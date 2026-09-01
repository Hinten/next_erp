/**
 * Pure ML→ERP taxonomy resolver (issue #520; matching design decided on #519 —
 * "HYBRID"). Turns one item's `attribute_combinations[]` (unioned across all of
 * an item's `variations[]`) into `grupoDeVariacoes` / `Variante` resolutions —
 * deciding what already matches in the ERP taxonomy and what must be created.
 * No Firestore here — reads/writes live in `importTaxonomia.ts`, which loads the
 * `grupos` candidates this module matches against and persists what it plans.
 *
 * Matching cascade (per combo):
 *   grupo:    doc id == attribute id
 *             → exact nome == attribute name
 *             → (attribute id is EXACTLY 'SIZE'/'COLOR') any candidate grupo
 *               with the matching `tipo` (1 = tamanho, 2 = cor)
 *   variante: value_id == Variante.id
 *             → exact nome == value_name
 *             → trailing gender-vowel swap ('Vermelha' ↔ 'Vermelho')
 *             → space↔hyphen swap ('Azul Marinho' ↔ 'Azul-Marinho')
 *   (the last two variante retries are literal single-character-class swaps
 *   compared by exact string equality — never combined with each other, never
 *   case-folded.)
 *
 * A combo missing BOTH an attribute id and name, or missing BOTH a value id and
 * a value name, has nothing stable to key off and is skipped entirely — no
 * resolution, no grupo/variante created for it.
 *
 * Whatever the cascade can't match gets CREATED, deterministically:
 *   - grupo id = attribute id; when the combo carries only a name (id absent —
 *     essentially never happens for real ML attributes, but combos aren't
 *     required to have one), falls back to `n-<slug(attribute name)>`;
 *   - grupo tipo = 1 for 'SIZE', 2 for 'COLOR', else 0 (outros);
 *     permiteFotos = true only for 'COLOR';
 *   - Variante id = value_id, else `n-<slug(value_name)>`.
 *
 * Every resolved Variante — matched OR freshly created — is stamped with an
 * `externalVariacaoLinks` entry keyed by `(integracaoId, externalId)`
 * (`externalId = value_id ?? value_name`), but ONLY when that key isn't already
 * present on it, so re-importing the same listing never appends a duplicate
 * link. A freshly created Variante carries its stamp inline (in
 * `gruposToCreate`/`variantesToAppend`); a matched one that needs stamping is
 * reported separately in `linksToStamp`.
 *
 * `planTaxonomia` processes the WHOLE combos list for an item in one call, so
 * two combos landing on the same brand-new grupo (e.g. two never-before-seen
 * sizes on one item) both fold into that grupo's single `gruposToCreate` entry
 * instead of one clobbering the other.
 */
import type { MlItemAttribute } from '@delfrance/integrations-mercado-livre';
import {
  INTEGRACAO_TIPO,
  TIPO_VARIACAO,
  type ExternalVariacaoLink,
  type GrupoComId,
  type GrupoDeVariacoes,
  type Variante,
  varianteFakePath,
} from '@delfrance/schemas';

/** One resolved (matched or freshly planned) grupo/variante pair for a combo. */
export interface TaxonomiaResolution {
  /** This combo's identity key — see `comboAttrKey`. */
  attrKey: string;
  grupoId: string;
  varianteId: string;
  /** Bare grupo id — the `produto.grupoDeVariacoesUid` wire format. */
  grupoUid: string;
  /** `documents/grupoDeVariacoes/<grupoId>/variacoes/<varianteId>` — the `variacoesUid` wire format. */
  varianteFake: string;
  /**
   * The variante's `codigo`, carried out so the User-Products parent-sku
   * recovery (#1400) can run without re-reading the grupo docs this plan already
   * had in hand.
   *
   * ⚠️ `null` for every variante this pass CREATED — a freshly planned variante
   * is written `codigo: null` below — and that is exactly the case
   * `skuPaiPorSufixo` must refuse rather than guess through. Do not "fix" it by
   * falling back to the value_name: the código is the seller's own sku fragment,
   * and inventing one yields a parent sku that matches no child.
   *
   * ⚠️ The grupo's `ordem` is deliberately NOT carried alongside it.
   * `skuPaiPorSufixo` is order-independent because it has to be — every grupo
   * `planTaxonomia` creates gets `ordem: 1`, so a multi-grupo imported taxonomy
   * ties and no ordering can be recovered from it anyway.
   */
  varianteCodigo: string | null;
}

export interface TaxonomiaPlan {
  /** One entry per usable combo (skipped combos produce none). */
  resolutions: TaxonomiaResolution[];
  /** Brand-new grupo docs — `data` already carries every variante planned for it this pass. */
  gruposToCreate: { id: string; data: GrupoDeVariacoes }[];
  /** New Variante entries to append onto an EXISTING grupo's `variacoes` array. */
  variantesToAppend: { grupoId: string; variante: Variante }[];
  /** A link-stamp to append onto an EXISTING (matched) Variante that doesn't have it yet. */
  linksToStamp: { grupoId: string; varianteId: string; link: ExternalVariacaoLink }[];
}

/* ---------------------------- pure helpers ---------------------------- */

export function nonEmptyString(s: string | null | undefined): string | null {
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/**
 * Deterministic id for a value with no usable external id: lowercase, trimmed,
 * internal whitespace runs collapsed to a single `-`, then every character
 * outside `[a-z0-9-]` is stripped. Callers prefix the result with `n-` (never
 * collides with a real ML numeric/code id).
 */
export function normalizeForSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Trailing gender-vowel swap ('Vermelha' → 'Vermelho' and back). Returns null
 * when the string doesn't end in a swappable vowel — nothing to retry.
 */
export function swapGenderVowel(s: string): string | null {
  if (s.length === 0) return null;
  const last = s[s.length - 1];
  if (last === 'a') return `${s.slice(0, -1)}o`;
  if (last === 'o') return `${s.slice(0, -1)}a`;
  if (last === 'A') return `${s.slice(0, -1)}O`;
  if (last === 'O') return `${s.slice(0, -1)}A`;
  return null;
}

/** Space↔hyphen swap — whichever the string contains; unchanged if neither. */
export function swapSpaceHyphen(s: string): string {
  if (s.includes(' ')) return s.replace(/ /g, '-');
  if (s.includes('-')) return s.replace(/-/g, ' ');
  return s;
}

/**
 * A combo's identity key — `(id ?? name) + '|' + (value_id ?? value_name)`.
 * `importCore.ts` keeps its OWN copy of this exact one-liner (to filter the
 * item-wide `taxonomia` array down to one variation's combos without an
 * import cycle) — the two MUST stay byte-identical, including the raw `??`
 * fallback (an empty-string `id`/`value_id` is NOT treated as absent here,
 * unlike the `nonEmptyString`-gated matching below): whichever module computes
 * a key for the same combo has to land on the same string, or a resolved
 * grupo/variante silently drops off the child instead of linking. This
 * function is purely an identity key — it does NOT decide whether a combo is
 * usable (see the skip checks in `planTaxonomia`, which use `nonEmptyString`
 * and are independent of this formula).
 */
export function comboAttrKey(combo: MlItemAttribute): string {
  return `${combo.id ?? combo.name ?? ''}|${combo.value_id ?? combo.value_name ?? ''}`;
}

/* ------------------------------ matching ------------------------------- */

function matchGrupo(
  working: Map<string, GrupoComId>,
  attrId: string | null,
  attrName: string | null,
): GrupoComId | null {
  if (attrId != null) {
    const byId = working.get(attrId);
    if (byId) return byId;
  }
  if (attrName != null) {
    for (const g of working.values()) {
      if (g.data.nome === attrName) return g;
    }
  }
  if (attrId === 'SIZE' || attrId === 'COLOR') {
    const tipo = attrId === 'SIZE' ? TIPO_VARIACAO.tamanho : TIPO_VARIACAO.cor;
    for (const g of working.values()) {
      if (g.data.tipo === tipo) return g;
    }
  }
  return null;
}

function matchVariante(
  variantes: Variante[],
  valueId: string | null,
  valueName: string | null,
): Variante | null {
  if (valueId != null) {
    const byId = variantes.find((v) => v.id === valueId);
    if (byId) return byId;
  }
  if (valueName != null) {
    const byName = variantes.find((v) => v.nome === valueName);
    if (byName) return byName;

    const gender = swapGenderVowel(valueName);
    if (gender != null) {
      const byGender = variantes.find((v) => v.nome === gender);
      if (byGender) return byGender;
    }

    const hyphen = swapSpaceHyphen(valueName);
    if (hyphen !== valueName) {
      const byHyphen = variantes.find((v) => v.nome === hyphen);
      if (byHyphen) return byHyphen;
    }
  }
  return null;
}

/** Deep-enough clone so mutating a working copy never touches the caller's input. */
function cloneGrupo(g: GrupoComId): GrupoComId {
  return {
    id: g.id,
    data: {
      ...g.data,
      variacoes: (g.data.variacoes ?? []).map((v) => ({
        ...v,
        externalVariacaoLinks: v.externalVariacaoLinks
          ? [...v.externalVariacaoLinks]
          : v.externalVariacaoLinks,
      })),
      variacoesIds: [...(g.data.variacoesIds ?? [])],
    },
  };
}

/** Union `variacoesIds` with every id actually present in `variacoes` (de-duped). */
function syncVariacoesIds(existing: string[], variacoes: Variante[]): string[] {
  return [...new Set([...existing, ...variacoes.map((v) => v.id)])];
}

/* -------------------------------- plan --------------------------------- */

export function planTaxonomia(
  grupos: GrupoComId[],
  combos: MlItemAttribute[],
  integracaoId: string,
  now: number,
): TaxonomiaPlan {
  // Working copies keyed by id — matches AND mutations (new/appended variantes)
  // both go through this map so later combos in the same pass see earlier ones.
  const working = new Map<string, GrupoComId>(grupos.map((g) => [g.id, cloneGrupo(g)]));
  const newGrupoIds = new Set<string>();
  const variantesToAppend: TaxonomiaPlan['variantesToAppend'] = [];
  const linksToStamp: TaxonomiaPlan['linksToStamp'] = [];
  const resolutions: TaxonomiaResolution[] = [];
  const seenAttrKeys = new Set<string>();

  for (const combo of combos) {
    const attrId = nonEmptyString(combo.id);
    const attrName = nonEmptyString(combo.name);
    if (attrId == null && attrName == null) continue; // no attribute id AND no name — skip
    const valueId = nonEmptyString(combo.value_id);
    const valueName = nonEmptyString(combo.value_name);
    if (valueId == null && valueName == null) continue; // no value id AND no value name — skip

    // The identity key is the RAW formula (see `comboAttrKey`'s docstring) —
    // computed from `combo` directly, not from the `nonEmptyString`-gated
    // locals above, so it stays byte-identical to `importCore.ts`'s copy.
    const attrKey = comboAttrKey(combo);
    if (seenAttrKeys.has(attrKey)) continue; // same combo shared across several variations
    seenAttrKeys.add(attrKey);

    const externalId = valueId ?? valueName!;

    // ---- grupo -------------------------------------------------------
    let grupo = matchGrupo(working, attrId, attrName);
    if (!grupo) {
      const id = attrId ?? `n-${normalizeForSlug(attrName!)}`;
      const tipo =
        attrId === 'SIZE'
          ? TIPO_VARIACAO.tamanho
          : attrId === 'COLOR'
            ? TIPO_VARIACAO.cor
            : TIPO_VARIACAO.outros;
      grupo = {
        id,
        data: {
          nome: attrName ?? attrId ?? id,
          codigo: null,
          ordem: 1,
          tipo,
          permiteFotos: attrId === 'COLOR',
          ultimaModificacao: null,
          timestamp: now,
          variacoesIds: [],
          variacoes: [],
          linksVariacoesShopee: null,
          linksVariacoesli: null,
          linksVariacoesAmazon: null,
        },
      };
      working.set(id, grupo);
      newGrupoIds.add(id);
    }

    // ---- variante ------------------------------------------------------
    const variantes = grupo.data.variacoes ?? [];
    const matched = matchVariante(variantes, valueId, valueName);
    let variante: Variante;
    if (!matched) {
      const id = valueId ?? `n-${normalizeForSlug(valueName!)}`;
      const link: ExternalVariacaoLink = {
        tipo: INTEGRACAO_TIPO.mercadoLivre,
        integracaoId,
        externalId,
        externalName: valueName ?? null,
        timestamp: now,
      };
      variante = {
        id,
        nome: valueName ?? valueId!,
        codigo: null,
        variantesVinculadasIds: null,
        externalVariacaoLinks: [link],
        timestamp: now,
      };
      grupo.data.variacoes = [...(grupo.data.variacoes ?? []), variante];
      grupo.data.variacoesIds = syncVariacoesIds(grupo.data.variacoesIds, grupo.data.variacoes);
      // A grupo still pending creation this pass gets the variante folded
      // straight into its create payload — no separate append needed.
      if (!newGrupoIds.has(grupo.id)) {
        variantesToAppend.push({ grupoId: grupo.id, variante });
      }
    } else {
      variante = matched;
      const already = (variante.externalVariacaoLinks ?? []).some(
        (l) => l.integracaoId === integracaoId && l.externalId === externalId,
      );
      if (!already) {
        const link: ExternalVariacaoLink = {
          tipo: INTEGRACAO_TIPO.mercadoLivre,
          integracaoId,
          externalId,
          externalName: valueName ?? null,
          timestamp: now,
        };
        // Mutate the working copy too, so a later combo in this same pass
        // that re-matches this variante sees the stamp already applied.
        variante.externalVariacaoLinks = [...(variante.externalVariacaoLinks ?? []), link];
        linksToStamp.push({ grupoId: grupo.id, varianteId: variante.id, link });
      }
    }

    resolutions.push({
      attrKey,
      grupoId: grupo.id,
      varianteId: variante.id,
      grupoUid: grupo.id,
      varianteFake: varianteFakePath(grupo.id, variante.id),
      varianteCodigo: variante.codigo ?? null,
    });
  }

  const gruposToCreate = [...newGrupoIds].map((id) => ({ id, data: working.get(id)!.data }));

  return { resolutions, gruposToCreate, variantesToAppend, linksToStamp };
}
