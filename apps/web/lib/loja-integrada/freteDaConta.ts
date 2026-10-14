import type { DocumentReference, Firestore } from 'firebase/firestore';
import { valuesEqual } from '@delfrance/core';
import { INTEGRACAO_FRETE, TIPOS_ALVO_MAPA_FRETE_LI } from '@delfrance/schemas';
import type {
  TransactionDocumentGuard,
  TransactionFormProjection,
  TransactionWrite,
  TransactionWriteContext,
} from '@delfrance/ui';
import { intFreteCollection } from '@/lib/data/intFreteCollection';

/**
 * The Loja Integrada conta screen's two freight tabs ("Mapeamento do Frete" and
 * "Horário de Corte", master plan step 20, #1826) — the pure half: what one edit
 * does to a `mapa` row, and what the conta's save writes to the conta's
 * `int_frete` doc.
 *
 * The two tabs edit TRANSIENT fields of the conta's `ObjectView` (the page model
 * widens `integracaoSchema` with them). They never reach the `integracao` doc:
 * {@link escritasFreteDaContaLi} turns them into ONE guarded sibling write inside
 * `saveRecord`'s transaction, so one "Salvar" commits the conta and its freight
 * doc together, and a concurrent change to either written field raises the
 * conflict modal instead of being overwritten (ADR 0011 tier 3; root `CLAUDE.md`
 * rule 7). The browser never CREATES the freight doc: the server keeps it in step
 * with the conta, and a conta without one shows the "absent" state instead.
 */

/** The page model's transient key holding the freight doc's `mapa`, RAW as stored. */
export const CAMPO_MAPA_FRETE_LI = 'freteMapa';
/** The page model's transient key holding the freight doc's `horarioDeCorte`. */
export const CAMPO_HORARIO_CORTE_LI = 'freteHorarioDeCorte';

/** What the conflict modal names the freight doc by. */
export const ROTULO_FRETE_DA_CONTA_LI = 'Frete da conta';

/** A Melhor Envio carrier service, as the service list route returns it (`ShipmentService`). */
export interface ServicoMelhorEnvioLi {
  readonly id: number;
  readonly name?: string | null;
  readonly company?: { readonly id: number; readonly name: string } | null;
}

/** The internal freight integration a row is mapped to: an `int_frete` doc. */
export interface AlvoMapaFreteLi {
  /** The target doc's id — stored BARE in `integracaoUid`. */
  readonly id: string;
  /** The target doc's stored `tipo`. */
  readonly tipo: string;
  /** Required for a Melhor Envio target (the service that ships it); ignored otherwise. */
  readonly servico?: ServicoMelhorEnvioLi | null;
}

/** Why {@link aplicarAlvoLi} refused an edit. */
export type MotivoRecusaAlvoLi =
  /** The target's tipo is not one a Loja Integrada row may be mapped to. */
  | 'tipo-nao-suportado'
  /** A Melhor Envio target needs the service that ships the row. */
  | 'servico-obrigatorio'
  /** A row with no string `idOriginal` has no key to route by; it stays read-only. */
  | 'linha-sem-chave';

export type ResultadoAlvoLi =
  | { readonly ok: true; readonly linha: Record<string, unknown> }
  | { readonly ok: false; readonly motivo: MotivoRecusaAlvoLi };

/** The readable label of a Melhor Envio service: "empresa — serviço". Display only. */
export function rotuloServicoMelhorEnvioLi(servico: ServicoMelhorEnvioLi): string {
  const servicoNome =
    typeof servico.name === 'string' && servico.name.trim().length > 0
      ? servico.name.trim()
      : String(servico.id);
  const empresa = servico.company?.name?.trim();
  return empresa ? `${empresa} — ${servicoNome}` : servicoNome;
}

function ehTipoAlvo(tipo: string): boolean {
  return (TIPOS_ALVO_MAPA_FRETE_LI as readonly string[]).includes(tipo);
}

/**
 * One operator edit of one `mapa` row: point it at `alvo`, or clear it (`null`,
 * the "Nenhum" option). Returns the new row; every other key of `linha` (the
 * method's `nomeOriginal`/`idOriginal`/`observacao`, unknown legacy keys) is kept
 * verbatim.
 *
 * - **A target** writes `integracaoUid` (the bare doc id) and
 *   `targetTipoIntegracao` (the target's tipo). For Melhor Envio it also writes
 *   `targetData = { id, name, company: { id, name } }` — the service that ships
 *   the row — and a readable `nomeTarget` ("empresa — serviço"); for every other
 *   tipo both are `null`, so a stale service never survives a remap.
 * - **"Nenhum"** stores `integracaoUid: null`, `targetTipoIntegracao: 'outros'`
 *   (the stored "cleared" form) and both `null`.
 *
 * Refused (the row is not touched): a tipo outside `TIPOS_ALVO_MAPA_FRETE_LI` —
 * a marketplace's freight is never a target; a Melhor Envio target without a
 * service; a row without a string `idOriginal`.
 */
export function aplicarAlvoLi(
  linha: Readonly<Record<string, unknown>>,
  alvo: AlvoMapaFreteLi | null,
): ResultadoAlvoLi {
  if (typeof linha.idOriginal !== 'string') return { ok: false, motivo: 'linha-sem-chave' };
  if (alvo === null) {
    return {
      ok: true,
      linha: {
        ...linha,
        integracaoUid: null,
        targetTipoIntegracao: INTEGRACAO_FRETE.outros,
        targetData: null,
        nomeTarget: null,
      },
    };
  }
  if (!ehTipoAlvo(alvo.tipo)) return { ok: false, motivo: 'tipo-nao-suportado' };
  if (alvo.tipo !== INTEGRACAO_FRETE.melhorEnvios) {
    return {
      ok: true,
      linha: {
        ...linha,
        integracaoUid: alvo.id,
        targetTipoIntegracao: alvo.tipo,
        targetData: null,
        nomeTarget: null,
      },
    };
  }
  const servico = alvo.servico;
  if (servico == null) return { ok: false, motivo: 'servico-obrigatorio' };
  return {
    ok: true,
    linha: {
      ...linha,
      integracaoUid: alvo.id,
      targetTipoIntegracao: alvo.tipo,
      targetData: {
        id: servico.id,
        name: servico.name ?? null,
        company:
          servico.company == null ? null : { id: servico.company.id, name: servico.company.name },
      },
      nomeTarget: rotuloServicoMelhorEnvioLi(servico),
    },
  };
}

/**
 * The two transient form values a freight doc seeds: its stored `mapa` and
 * `horarioDeCorte`, VERBATIM (`null` when the doc or the field is absent).
 *
 * ⚠️ Verbatim even when the stored value has the wrong shape (a `mapa` that is
 * not a list). The save writes a field only when the form value differs from the
 * seeded one, so a value seeded as-is is never rewritten; a projection that
 * turned it into `null` would make an untouched tab overwrite it on the next
 * save.
 */
export function valoresDoFreteDaContaLi(
  doc: Readonly<Record<string, unknown>> | null,
): Record<typeof CAMPO_MAPA_FRETE_LI | typeof CAMPO_HORARIO_CORTE_LI, unknown> {
  return {
    [CAMPO_MAPA_FRETE_LI]: doc?.mapa ?? null,
    [CAMPO_HORARIO_CORTE_LI]: doc?.horarioDeCorte ?? null,
  };
}

/**
 * The sibling write a conta save makes to its freight doc `intFreteId` — at most
 * ONE `update`, carrying only the fields the operator changed among `mapa` and
 * `horarioDeCorte`, under a guard whose baseline is the doc as the tabs were
 * seeded from server truth.
 *
 * - **Nothing changed ⇒ no write.** A field is written only when its form value
 *   differs from the seeded doc's (structural equality), so a conta-only save, or
 *   an edit undone before saving, leaves the freight doc alone.
 * - **No doc ⇒ no write**: no `intFreteId`, or a baseline that confirmed the doc
 *   ABSENT (`null`). The browser never creates it.
 * - **Not seeded yet (`undefined`)**: the tabs are read-only until the seed, so
 *   the two values are still `null` and nothing is written. A non-null value with
 *   no baseline cannot come from this screen; it is still emitted, with the
 *   `undefined` baseline, so `saveRecord` refuses the whole save
 *   (`MissingTransactionBaselineError`) rather than write it unguarded.
 *
 * The guard compares each written field against the baseline inside the
 * transaction: anyone else's change to it since load (another operator, or the
 * importer appending a newly seen shipping method) raises the conflict modal.
 *
 * ⚠️ **The guard projects BOTH tabs' fields**, the one this save does not write
 * included. The baseline is the whole doc, and every rebase moves it whole — a
 * commit to what was stored, "Recarregar do servidor" to the server's version —
 * while "changed" is decided per field against it. A tab left holding its old
 * value would then differ from a baseline that moved under it, and the next save
 * would write that stale value back, unguarded, over the change it never saw
 * (another operator's horário, the importer's appended row). See
 * {@link projecaoDoFreteDaContaLi} for what each rebase shows.
 *
 * ⚠️ No `ultimaModificacao` stamp: `saveRecord` strips the stamp fields from a
 * guarded sibling update, so the stored stamp is left as it was.
 */
export function escritasFreteDaContaLi(
  db: Firestore,
  intFreteId: string | null,
  values: Readonly<Record<string, unknown>>,
  context: TransactionWriteContext,
): TransactionWrite[] {
  if (intFreteId === null) return [];
  const ref = intFreteCollection.docRef(db, {}, intFreteId);
  const baseline = context.getBaseline(ref.path);
  if (baseline === null) return [];
  const mapa = values[CAMPO_MAPA_FRETE_LI] ?? null;
  const horario = values[CAMPO_HORARIO_CORTE_LI] ?? null;
  const data: Record<string, unknown> = {};
  if (baseline === undefined) {
    if (mapa !== null) data.mapa = mapa;
    if (horario !== null) data.horarioDeCorte = horario;
  } else {
    if (!valuesEqual(mapa, baseline.mapa ?? null)) data.mapa = mapa;
    if (!valuesEqual(horario, baseline.horarioDeCorte ?? null)) data.horarioDeCorte = horario;
  }
  if (Object.keys(data).length === 0) return [];
  const guard: TransactionDocumentGuard = {
    baseline,
    label: ROTULO_FRETE_DA_CONTA_LI,
    ...projecaoDoFreteDaContaLi(CAMPO_MAPA_FRETE_LI, data, baseline),
    extraFormFields: [projecaoDoFreteDaContaLi(CAMPO_HORARIO_CORTE_LI, data, baseline)],
  };
  return [{ type: 'update', ref: ref as DocumentReference<unknown>, data, guard }];
}

/** The freight doc's field each transient form field shows. */
const CHAVE_DO_CAMPO = {
  [CAMPO_MAPA_FRETE_LI]: 'mapa',
  [CAMPO_HORARIO_CORTE_LI]: 'horarioDeCorte',
} as const;

/**
 * What form field `campo` shows after a rebase of the freight doc to `current`,
 * for a save that wrote `escrito` over `baseline`:
 *
 * - **the server's value** (`current`, projected as the seed projects it) —
 *   for a field this save did not write, and for one that collided;
 * - **the form's own value** — only for a field this save wrote and that did
 *   NOT collide (stored equals `baseline`, the comparison the guard makes), so
 *   "Recarregar do servidor" keeps the edit nobody contested. On a commit the
 *   two coincide: the stored value IS the one written.
 *
 * A deleted doc (`current === null`) shows `null` in both fields.
 */
export function projecaoDoFreteDaContaLi(
  campo: keyof typeof CHAVE_DO_CAMPO,
  escrito: Readonly<Record<string, unknown>>,
  baseline: Readonly<Record<string, unknown>> | undefined,
): TransactionFormProjection {
  const chave = CHAVE_DO_CAMPO[campo];
  return {
    formField: campo,
    toFormValue: (current, formValue) =>
      chave in escrito &&
      current !== null &&
      baseline !== undefined &&
      valuesEqual(baseline[chave], current[chave])
        ? formValue
        : valoresDoFreteDaContaLi(current)[campo],
  };
}
