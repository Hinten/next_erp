import type { DocumentReference, Firestore } from 'firebase/firestore';
import { valuesEqual } from '@delfrance/core';
import { INTEGRACAO_FRETE, TIPOS_ALVO_MAPA_FRETE_LI, intFreteSchema } from '@delfrance/schemas';
import type {
  TransactionDocumentGuard,
  TransactionFormProjection,
  TransactionWrite,
  TransactionWriteContext,
  ValidationIssue,
} from '@delfrance/ui';
import { intFreteCollection } from '@/lib/data/intFreteCollection';
import { stripThenNullIfEmpty } from '@/lib/freight/stripThenNullIfEmpty';

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
 *   differs from the seeded doc's (structural equality; the horário compared, and
 *   written, as its save transform leaves it — see
 *   {@link alteracoesDoFreteDaContaLi}), so a conta-only save, or an edit undone
 *   before saving, leaves the freight doc alone.
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
  const alteracoes = alteracoesDoFreteDaContaLi(db, intFreteId, values, context);
  if (alteracoes === null) return [];
  const { ref, baseline, data } = alteracoes;
  const guard: TransactionDocumentGuard = {
    baseline,
    label: ROTULO_FRETE_DA_CONTA_LI,
    ...projecaoDoFreteDaContaLi(CAMPO_MAPA_FRETE_LI, data, baseline),
    extraFormFields: [projecaoDoFreteDaContaLi(CAMPO_HORARIO_CORTE_LI, data, baseline)],
  };
  return [{ type: 'update', ref: ref as DocumentReference<unknown>, data, guard }];
}

/**
 * The page model's check of the two freight tabs: the freight schema's own
 * `horarioDeCorte` rule (one row per weekday, hours in range) — run on the
 * horário ONLY when this save would write it, i.e. exactly when
 * {@link escritasFreteDaContaLi} would put it in its update.
 *
 * ⚠️ An untouched horário is never judged. It is seeded verbatim from the
 * stored doc, and the imported corpus carries values these schemas do not
 * model (root `CLAUDE.md` rule 8): a weekday stored twice, an out-of-range
 * hour, a value that is not a list. Such a value is not written by this save,
 * so refusing it would block renaming the conta, or rotating its token, over a
 * tab the operator never opened. Once the operator changes the horário the
 * whole list is written, so the whole list must then pass — "changed" is
 * {@link alteracoesDoFreteDaContaLi}'s decision, never a second comparison.
 *
 * `values` is what `ObjectView` validates — the form with EVERY field's
 * `prepareForSave` applied — while `transactionWrites` gets only the DIRTY
 * fields' transforms. The two inputs differ for a pristine horário the
 * transform changes (a stored row carrying the staged-deletion key, a stored
 * `[]`); the decision is reached under that same transform on both sides, so
 * it holds either way and nothing is refused that the save would not write.
 *
 * `mapa` is never checked: the editor only replaces one row's target through
 * {@link aplicarAlvoLi}, so every other row is written back as stored.
 *
 * Issues are keyed under {@link CAMPO_HORARIO_CORTE_LI}, so `ObjectView` shows
 * them on the "Horário de Corte" tab, switches to it, and names it in its
 * refusal toast. `ObjectView` keeps them as ONE flat message at that key; the
 * tab marks the rows with {@link errosPorLinhaDoHorarioLi}.
 */
export function problemasDoFreteDaContaLi(
  db: Firestore,
  intFreteId: string | null,
  values: Readonly<Record<string, unknown>>,
  context: TransactionWriteContext,
): ValidationIssue[] {
  const alteracoes = alteracoesDoFreteDaContaLi(db, intFreteId, values, context);
  if (alteracoes === null || !('horarioDeCorte' in alteracoes.data)) return [];
  return problemasDoHorarioDeCorte(alteracoes.data.horarioDeCorte).map((issue) => ({
    path: [CAMPO_HORARIO_CORTE_LI, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/**
 * The error tree the "Horário de Corte" editor is handed, from the field's own
 * (`errorTree`) and its current form value.
 *
 * `ObjectView` keeps a `validate` refusal as ONE flat `{ type, message }` at the
 * form key — its merge cuts every issue's path at the first segment — so on its
 * own the refusal names no row, and on an imported list of several rows the
 * operator cannot tell which one breaks the rule. When, and ONLY when, the
 * field carries that refusal, this hangs each issue of the same rule, over the
 * same prepared value, under `[row][field]`, where the editor marks the cell
 * (row indices count the rows the save keeps, as the editor maps them); the
 * flat message stays, under the list. An issue about a whole row or the whole
 * value has no cell and stays only there.
 *
 * Without a refusal the tree is returned as is: an untouched stored list is
 * never judged ({@link problemasDoFreteDaContaLi}), so it is never marked either.
 */
export function errosPorLinhaDoHorarioLi(horario: unknown, errorTree: unknown): unknown {
  if (
    errorTree === null ||
    typeof errorTree !== 'object' ||
    typeof (errorTree as { message?: unknown }).message !== 'string'
  ) {
    return errorTree;
  }
  const arvore: Record<string, unknown> = { ...(errorTree as Record<string, unknown>) };
  for (const issue of problemasDoHorarioDeCorte(horario)) {
    const [linha, campo] = issue.path;
    if (typeof linha !== 'number' || typeof campo !== 'string') continue;
    const daLinha = (arvore[linha] ?? {}) as Record<string, unknown>;
    if (daLinha[campo] !== undefined) continue;
    arvore[linha] = { ...daLinha, [campo]: { type: 'custom', message: issue.message } };
  }
  return arvore;
}

/**
 * The freight schema's own `horarioDeCorte` rule (one row per weekday, hours in
 * range) over `horario` as the save prepares it — the ONE rule behind both the
 * refusal and the rows it marks. Paths are relative to the list.
 */
function problemasDoHorarioDeCorte(horario: unknown) {
  const resultado = intFreteSchema.shape.horarioDeCorte.safeParse(stripThenNullIfEmpty(horario));
  return resultado.success ? [] : resultado.error.issues;
}

/**
 * THE decision behind both {@link escritasFreteDaContaLi} and
 * {@link problemasDoFreteDaContaLi}: which freight fields this save writes, and
 * the doc and baseline they are written under — or `null` when it writes none.
 *
 * - **No doc ⇒ `null`**: no `intFreteId`, or a baseline that confirmed the doc
 *   ABSENT (`null`). The browser never creates it.
 * - **Seeded (`baseline` is the doc)**: a field is written only when its form
 *   value differs from the baseline's (`valuesEqual`), so a conta-only save, or
 *   an edit undone before saving, leaves it alone.
 * - **Not seeded yet (`undefined`)**: a field is written when it is non-null;
 *   `saveRecord` then refuses the whole save (see `escritasFreteDaContaLi`).
 *
 * ⚠️ The horário is compared, and written, as its save transform
 * ({@link stripThenNullIfEmpty}, the field's `prepareForSave`) leaves it, on
 * BOTH sides. `ObjectView` applies that transform to everything before
 * `validate` but only to dirty fields before `transactionWrites`, so the same
 * pristine list can arrive either way; compared raw, a stored row carrying the
 * staged-deletion key would read as "changed" to the validator and "unchanged"
 * to the write, and an untouched list would be refused over a write that never
 * happens. The transform is idempotent, so an already prepared value is
 * unaffected.
 */
function alteracoesDoFreteDaContaLi(
  db: Firestore,
  intFreteId: string | null,
  values: Readonly<Record<string, unknown>>,
  context: TransactionWriteContext,
): {
  readonly ref: ReturnType<typeof intFreteCollection.docRef>;
  readonly baseline: Readonly<Record<string, unknown>> | undefined;
  readonly data: Record<string, unknown>;
} | null {
  if (intFreteId === null) return null;
  const ref = intFreteCollection.docRef(db, {}, intFreteId);
  const baseline = context.getBaseline(ref.path);
  if (baseline === null) return null;
  const mapa = values[CAMPO_MAPA_FRETE_LI] ?? null;
  const horario = stripThenNullIfEmpty(values[CAMPO_HORARIO_CORTE_LI] ?? null);
  const data: Record<string, unknown> = {};
  if (baseline === undefined) {
    if (mapa !== null) data.mapa = mapa;
    if (horario !== null) data.horarioDeCorte = horario;
  } else {
    if (!valuesEqual(mapa, baseline.mapa ?? null)) data.mapa = mapa;
    const guardado = stripThenNullIfEmpty(baseline.horarioDeCorte ?? null);
    if (!valuesEqual(horario, guardado)) data.horarioDeCorte = horario;
  }
  if (Object.keys(data).length === 0) return null;
  return { ref, baseline, data };
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
