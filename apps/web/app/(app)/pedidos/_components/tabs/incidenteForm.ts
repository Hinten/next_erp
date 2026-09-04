import {
  ESTADO_FRETE,
  TIPO_INCIDENTE,
  type Incidente,
  type OrigemIncidente,
  type Resolucao,
  type TipoIncidente,
  type TipoResolucao,
} from '@delfrance/schemas';
import { valuesEqual } from '@delfrance/core/equality';

/**
 * Flat form state for the Incidentes editor. Enum-coded fields are kept as the
 * Mantine `Select` string values (`origem`/`resTipo` are the int code rendered
 * as a string, `''` meaning "none"); the pure builders below coerce them back to
 * the wire types. Keeping this UI-agnostic lets `incidenteForm.test.ts` exercise
 * the save logic without React.
 */
export interface IncidenteFormState {
  tipo: string;
  origem: string;
  motivo: string;
  comentarios: string;
  // --- Resolução (legacy `Resolucao`, `models.dart:1413`) ---
  /** Whether a resolução is recorded; gates both the UI section and the write. */
  registrarResolucao: boolean;
  /** `TipoResolucao` int as a string; `''` until picked (required when on). */
  resTipo: string;
  /** Resolution date, µs epoch; `null` defaults to `now` at save time. */
  resData: number | null;
  /** "Despesa da resolução" in reais; `null` saves as 0. */
  resValor: number | null;
  resComentarios: string;
}

export const EMPTY_INCIDENTE_FORM: IncidenteFormState = {
  tipo: TIPO_INCIDENTE.devolucao,
  origem: '',
  motivo: '',
  comentarios: '',
  registrarResolucao: false,
  resTipo: '',
  resData: null,
  resValor: null,
  resComentarios: '',
};

/** Populate the form from an existing incident doc (edit mode). */
export function formFromIncidente(inc: Incidente): IncidenteFormState {
  const res = inc.resolucao ?? null;
  return {
    tipo: inc.tipo,
    origem: inc.origem != null ? String(inc.origem) : '',
    motivo: inc.motivoDoIncidente ?? '',
    comentarios: inc.comentarios ?? '',
    registrarResolucao: res != null,
    resTipo: res != null ? String(res.tipo) : '',
    resData: res?.data ?? null,
    resValor: res?.valor ?? null,
    resComentarios: res?.comentarios ?? '',
  };
}

/**
 * A resolução is locked once its return shipping (frete) has moved past the
 * initial state — porting the legacy `bloquear` guard
 * (`pedidoCadastro.dart:1437`): the whole resolution becomes read-only so an
 * in-progress return isn't accidentally rewritten. The frete sub-editor itself
 * is deferred, but we honour the lock and preserve the frete verbatim.
 *
 * ⚠️ `doc` is whichever version the caller is DECIDING AGAINST, and which one
 * that is decides whether the lock works at all. The editor asks the LIVE
 * snapshot row (so the lock arms while the form is open) and the guarded save
 * asks the `tx.get`-fresh doc (so the write honours the version it lands on);
 * asking the copy captured when the editor opened is #1250.
 */
export function isResolucaoLocked(doc: Incidente | null): boolean {
  const frete = doc?.resolucao?.frete ?? null;
  return frete != null && frete.estado !== ESTADO_FRETE.iniciado;
}

/** Trim, then map an empty (or whitespace-only) string to null. */
function trimToNull(s: string): string | null {
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate the resolução part of the form. Returns a user-facing error message,
 * or `null` when valid. Mirrors the legacy validators: `tipo` is required and
 * `valor` must be ≥ 0. Runs before `saveIncidente` so the Zod converter never
 * receives an invalid resolução (which would throw an uncaught `ZodError`).
 */
export function validateIncidenteForm(form: IncidenteFormState): string | null {
  if (!form.registrarResolucao) return null;
  if (form.resTipo === '') return 'Selecione o tipo de resolução.';
  if (form.resValor != null && form.resValor < 0)
    return 'A despesa da resolução não pode ser negativa.';
  return null;
}

/**
 * Build the `Resolucao` object from the form, or `null` when the switch is off.
 * Pure: `now` (µs epoch) is injected for the `data` default (legacy default is
 * `DateTime.now()`). When the resolução is locked the existing one is preserved
 * verbatim. The deferred `frete` sub-object is always carried over from `doc`
 * so an existing return-shipping record is never dropped. Assumes the form has
 * already passed {@link validateIncidenteForm}.
 *
 * ⚠️ `doc` must be the version the caller is deciding against — see
 * {@link isResolucaoLocked}.
 */
export function buildResolucao(
  form: IncidenteFormState,
  doc: Incidente | null,
  now: number,
): Resolucao | null {
  if (isResolucaoLocked(doc)) return doc?.resolucao ?? null;
  if (!form.registrarResolucao) return null;
  return {
    tipo: Number(form.resTipo) as TipoResolucao,
    data: form.resData ?? now,
    valor: form.resValor ?? 0,
    comentarios: trimToNull(form.resComentarios),
    frete: doc?.resolucao?.frete ?? null,
  };
}

/**
 * Build the full incidente record handed to `saveIncidente` — a whole-document
 * `set`, so it spreads `base` first to keep out-of-band fields (`externalId`,
 * `timestamp`, the ML claim state) alive.
 *
 * ⚠️ CREATE ONLY. On an update that spread is a lost-update machine: `base` is
 * a copy of the document taken when the editor opened, and `buildIncidenteOp`
 * writes it back verbatim over whatever the server holds now — regressing
 * `claimStatus` / `claimStage` / `entregue` / `resolucao`, which the Mercado
 * Livre claims webhook owns and merges onto the same doc (#1250). An update
 * goes through `saveIncidenteEdit` (`@/lib/pedidos/saveIncidenteEdit`), which
 * writes {@link buildIncidentePatch} — authored keys only — inside a
 * transaction. Creates keep this: there is no stored document to regress.
 */
export function incidenteDataFromForm(
  form: IncidenteFormState,
  base: Incidente | null,
  now: number,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    tipo: form.tipo as TipoIncidente,
    origem: form.origem === '' ? null : (Number(form.origem) as OrigemIncidente),
    motivoDoIncidente: trimToNull(form.motivo),
    comentarios: trimToNull(form.comentarios),
    resolucao: buildResolucao(form, base, now),
  };
}

/* -------------------------------------------------------------------------- */
/*            Update path — authored keys only, plus the conflict test         */
/* -------------------------------------------------------------------------- */

/**
 * The incidente fields THIS EDITOR can author. Everything else on the document
 * belongs to somebody else: `claimStatus` / `claimStage` / `entregue` are ML's
 * own facts (merged by the claims webhook), `overrideBloqueio` is
 * `serverOwned`, `timestamp` / `ultimaModificacao` are stamps, and
 * `incidenteSchema` is `.passthrough()` so a legacy row can carry keys nothing
 * here models.
 *
 * ⚠️ An ALLOW-list, deliberately, where the pedido guard uses an ignore-list
 * (`CONCURRENCY_IGNORE`). Same rule — "excluded iff no interactive editor can
 * author it" — read from the other side, because passthrough means the set of
 * keys a document may hold is open: an ignore-list would have to keep up with
 * data it has never seen, and would both write and conflict on it meanwhile.
 *
 * This is `OPERATOR_OWNED_KEYS`'s shape (`@/lib/mercado-livre/listingPatch`).
 */
export const CAMPOS_AUTORAIS_INCIDENTE = [
  'tipo',
  'origem',
  'motivoDoIncidente',
  'comentarios',
  'resolucao',
] as const;

export type CampoAutoralIncidente = (typeof CAMPOS_AUTORAIS_INCIDENTE)[number];

/** What a guarded update writes: authored keys only, each one actually changed. */
export type IncidentePatch = Partial<Pick<Incidente, CampoAutoralIncidente>>;

const has = (patch: IncidentePatch, campo: CampoAutoralIncidente): boolean =>
  Object.prototype.hasOwnProperty.call(patch, campo);

/**
 * The patch for an UPDATE: every authored field whose form value actually
 * differs from `doc`, and nothing else.
 *
 * Two properties carry the fix, and both come from dropping keys rather than
 * from checking them:
 *
 *  - a field the operator did not change is not written at all, so it cannot
 *    lose a race it never entered (tier 0, root `CLAUDE.md` rule 7);
 *  - `resolucao` is omitted entirely when `doc` is locked, so honouring the
 *    legacy `bloquear` guard stops being a re-write of the value we just read
 *    and becomes structural — there is no longer a version of the resolução in
 *    the payload to be stale.
 *
 * ⚠️ `doc` is load-bearing twice over: it supplies the lock state AND the
 * "unchanged" comparison. The caller passes the baseline to decide what the
 * operator MEANT to write, and the `tx.get`-fresh document to decide what is
 * actually written.
 */
export function buildIncidentePatch(
  form: IncidenteFormState,
  doc: Incidente,
  now: number,
): IncidentePatch {
  const proposto: Required<IncidentePatch> = {
    tipo: form.tipo as TipoIncidente,
    origem: form.origem === '' ? null : (Number(form.origem) as OrigemIncidente),
    motivoDoIncidente: trimToNull(form.motivo),
    comentarios: trimToNull(form.comentarios),
    resolucao: buildResolucao(form, doc, now),
  };
  const patch: IncidentePatch = {};
  for (const campo of CAMPOS_AUTORAIS_INCIDENTE) {
    // The frete sub-editor is deferred, so a locked resolução has no editable
    // half left — drop the key rather than write the server's own value back.
    if (campo === 'resolucao' && isResolucaoLocked(doc)) continue;
    if (valuesEqual(proposto[campo], doc[campo] ?? null)) continue;
    Object.assign(patch, { [campo]: proposto[campo] });
  }
  return patch;
}

/** The verdict {@link detectIncidenteConflict} returns. */
export interface ConflitoIncidente {
  /** True ⇒ show the operator the diff before writing anything. */
  conflito: boolean;
  /** Authored fields this save would overwrite that also changed remotely. */
  campos: CampoAutoralIncidente[];
  /** The resolução lock ARMED while the editor was open (#1250). */
  bloqueouAgora: boolean;
}

/**
 * Compare the document the operator reviewed (`baseline`) against the one in
 * Firestore now (`current`), counting only what `patch` would overwrite.
 *
 * A remote write to a key this save does not carry is NOT a conflict: the ML
 * claim sync advances `claimStatus` / `claimStage` / `entregue` on its own
 * schedule and blocking on that would make the tab unusable on any incidente ML
 * is working — the same trade `detectConflict` makes for a listing ML is
 * actively syncing.
 *
 * `bloqueouAgora` is reported separately because it changes the MESSAGE, not
 * the verdict: when the lock arms and the operator had edited the resolução,
 * `resolucao` is in `patch` and already conflicts on its own; when they had
 * not, the key was dropped and there is nothing to warn about.
 */
export function detectIncidenteConflict(
  baseline: Incidente,
  current: Incidente,
  patch: IncidentePatch,
): ConflitoIncidente {
  const campos = CAMPOS_AUTORAIS_INCIDENTE.filter(
    (campo) => has(patch, campo) && !valuesEqual(baseline[campo] ?? null, current[campo] ?? null),
  );
  return {
    conflito: campos.length > 0,
    campos: [...campos],
    bloqueouAgora: isResolucaoLocked(current) && !isResolucaoLocked(baseline),
  };
}
