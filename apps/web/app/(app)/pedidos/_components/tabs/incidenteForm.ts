import {
  TIPO_INCIDENTE,
  type Incidente,
  type OrigemIncidente,
  type Resolucao,
  type TipoIncidente,
  type TipoResolucao,
} from '@delfrance/schemas';

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
 */
export function isResolucaoLocked(base: Incidente | null): boolean {
  const frete = base?.resolucao?.frete ?? null;
  return frete != null && frete.estado !== 'iniciado';
}

/** Empty (or whitespace-only) string → null; otherwise the trimmed-aware value. */
function emptyToNull(s: string): string | null {
  return s.trim() === '' ? null : s;
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
 * verbatim. The deferred `frete` sub-object is always carried over from `base`
 * so an existing return-shipping record is never dropped. Assumes the form has
 * already passed {@link validateIncidenteForm}.
 */
export function buildResolucao(
  form: IncidenteFormState,
  base: Incidente | null,
  now: number,
): Resolucao | null {
  if (isResolucaoLocked(base)) return base?.resolucao ?? null;
  if (!form.registrarResolucao) return null;
  return {
    tipo: Number(form.resTipo) as TipoResolucao,
    data: form.resData ?? now,
    valor: form.resValor ?? 0,
    comentarios: emptyToNull(form.resComentarios),
    frete: base?.resolucao?.frete ?? null,
  };
}

/**
 * Build the full incidente record handed to `saveIncidente`. Spreads the
 * existing doc first so out-of-band fields (`externalId`, `timestamp`) survive,
 * then overrides the edited fields and the (re)built resolução. `now` is injected
 * (µs epoch) for the resolução date default.
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
    motivoDoIncidente: emptyToNull(form.motivo),
    comentarios: emptyToNull(form.comentarios),
    resolucao: buildResolucao(form, base, now),
  };
}
