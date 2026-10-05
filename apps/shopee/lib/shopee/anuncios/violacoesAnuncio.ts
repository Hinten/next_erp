/**
 * **The ONE violation-detail builder** (#1519, step 11) — the rows Shopee sends
 * about a listing become the `violations[]` elements the link document stores.
 *
 * Shopee says what is wrong with a listing in exactly TWO places, and they carry
 * **byte-identical detail rows**: the `violation_item_push` (push_api_id 18,
 * push_code **16**) and the `get_item_violation_info` READ. Each carries two
 * arrays — `item_status_details[]` (the listing was taken down or held) and the
 * deboost array (the listing is live but demoted, only its search ranking is
 * lowered) — and both are flattened into the one `violations[]`
 * ({@link ShopeeViolacao}), where `kind` is the ONLY thing that tells the two
 * sides apart once they share an array.
 *
 * ## ⚠️ Why this module exists at all
 *
 * The push handler and the re-verify are two different files written by two
 * different hands. A second copy of this function is the drift shape the root
 * `CLAUDE.md` names — two readers of one wire shape, each commented to say it
 * mirrors the other, disagreeing while both stay green (#1369). There is one
 * function; both import it.
 *
 * ## ⚠️ PURE, CLOCK-FREE and TOTAL
 *
 * No clock, no Firestore, no Shopee call, and nothing here throws: it is handed
 * raw wire — a push body nobody validated — and must answer for every input. An
 * unreadable row is DROPPED and COUNTED ({@link ResultadoViolacoes.descartadas}),
 * never guessed at, and never allowed to cost the rows beside it.
 *
 * ## ⚠️ UNITS: the wire sends SECONDS, the link document stores MILLISECONDS
 *
 * `fix_deadline_time` and `update_time` cross through
 * {@link agendadoParaMsDe} — this folder's ONE seconds→milliseconds reader,
 * which floors at 2020-01-01 because Shopee zero-fills an absent numeric. So a
 * `0` and an absent value both answer `null`: never `0` (which is 1970 once
 * multiplied out) and never "now". The function is NAMED for
 * `scheduled_publish_time`; it is the converter, not the field.
 *
 * ## ⚠️ `days_to_fix` is never derived
 *
 * It is the LEGACY duration (in days) from the retired code-6 payload, kept
 * nullable for the migrated corpus. Deriving it from `fix_deadline_time` needs a
 * clock, loses the original value and is **not idempotent** — the same push
 * replayed a day later would yield a different number, so a re-verify would
 * rewrite the link document for no wire event. Every modern row leaves it
 * `null`.
 *
 * ## ⚠️ Only the eight modelled keys are copied
 *
 * `shopeeViolacaoSchema` is `.passthrough()` so a STORED document keeps a key
 * Shopee added; this is a WRITER, and a writer copying an unenumerated key would
 * put provider prose nobody enumerated into a Firestore document and into every
 * log line that renders it. `redact.ts`'s denylist covers `violation_reason`,
 * `suggestion` and `fail_message` by NAME — a ninth key would be redacted by
 * nothing. Unknown keys are dropped here, on purpose.
 */
import { z } from 'zod';

import { wireInt } from '@delfrance/core/wire';
import type { ShopeeViolacao } from '@delfrance/schemas';

import { agendadoParaMsDe } from './statusAnuncio';

/* -------------------------------------------------------------------------- */
/*                          the two wire spellings                            */
/* -------------------------------------------------------------------------- */

/**
 * Push 18's deboost array has TWO spellings and both are real: its parameter
 * TABLE says `deboost_details`, its own SAMPLE 3 prints `deboosted_details`.
 * `get_item_violation_info` declares both for the same reason
 * (`shopeeItemViolationRowSchema`).
 *
 * ⚠️ A reader that knew only one of them would silently drop every deboost
 * payload of the other — no error, no log, just a listing that is demoted at
 * Shopee and healthy in the ERP.
 */
export type GrafiaDeboost = 'deboost_details' | 'deboosted_details';

/** The parameter-table spelling — PREFERRED when both carry rows. */
const DEBOOST_TABELA = 'deboost_details';
/** The sample-3 spelling. */
const DEBOOST_AMOSTRA = 'deboosted_details';
/** The status side has ONE spelling on both surfaces. */
const STATUS_DETALHES = 'item_status_details';

/* -------------------------------------------------------------------------- */
/*                          the row reader (tolerant)                         */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ `wireInt()` and not a bare `z.number()`: a serializer that quotes ONE field
 * must not cost the resource (#1087), and the PUSH side reaches this module as
 * raw JSON that no operation schema has coerced. It keeps `.int()`, so a
 * fractional epoch second reads as ABSENT rather than producing a fractional
 * millisecond — which `shopeeViolacaoSchema` (`z.number().int()`) would refuse
 * on the write, turning a malformed wire value into a failed publish.
 */
const categoriaSugeridaSchema = z.object({
  category_id: wireInt().nullable().catch(null),
  category_name: z.string().nullable().catch(null),
});

/**
 * One detail row, as either surface sends it.
 *
 * ⚠️ Every field is `.catch(null)`, so no FIELD can fail a row — only the
 * object-ness of the row itself can, which is exactly the "unreadable" this
 * module counts. The per-ELEMENT `.catch(null)` inside `suggested_category` is
 * the package's own sentinel idiom: one malformed category must not cost the
 * others.
 *
 * ⚠️ Unknown keys are STRIPPED (no `.passthrough()`) — see the module header.
 */
const linhaDeDetalheSchema = z.object({
  violation_type: z.string().nullable().catch(null),
  violation_reason: z.string().nullable().catch(null),
  suggestion: z.string().nullable().catch(null),
  /** SECONDS on the wire. "Empty if no deadline." */
  fix_deadline_time: wireInt().nullable().catch(null),
  /** SECONDS on the wire. PER DETAIL, not on the envelope. */
  update_time: wireInt().nullable().catch(null),
  suggested_category: z
    .array(categoriaSugeridaSchema.nullable().catch(null))
    .nullable()
    .catch(null),
});

/**
 * A wire string, or `null` when it carries nothing.
 *
 * ⚠️ **The fold, and its scope.** A string that is EMPTY after trimming is an
 * ABSENCE — `''`, `'   '` and a missing key are the same fact, and they must be,
 * because `avisoAnuncio.ts` reads the first `violation_type` through `??` and a
 * `''` would render an empty phrase into the operator inbox where the module's
 * own fallback phrase belongs.
 *
 * ⚠️ **Where it STOPS.** Any other string is copied VERBATIM and is never
 * trimmed: `'-'`, `'0'` and `' Spam '` are values. This is deliberately NOT
 * `textoShopeeUtilizavel` (`orderMapping.ts`), whose `'-'` alias is documented
 * for `get_package_detail.tracking_number` and for nothing else — here the field
 * is provider PROSE, and folding a prose value we do not understand would be an
 * invention. A hand-rolled comparison, invisible to
 * `equivalence-fold-inventory.test.js`; the #1372 obligation is discharged by
 * the PAIR and the NEAR-MISS named in this suite's titles.
 */
function textoDeViolacao(bruto: string | null): string | null {
  if (bruto === null) return null;
  return bruto.trim() === '' ? null : bruto;
}

/** `'status' | 'deboost'` — {@link ShopeeViolacao.kind} without the `null`. */
type KindViolacao = NonNullable<ShopeeViolacao['kind']>;

/**
 * ONE detail row → one {@link ShopeeViolacao}, or `null` when the row is not an
 * object at all (a string, a number, `null`, an array — all of which a raw push
 * body can legitimately hold).
 *
 * ⚠️ An object we can read NOTHING out of is **not** a discard: it is a row
 * Shopee sent, and it becomes a violação with every field `null`. That case is
 * reachable by construction (every member of `shopeeViolacaoSchema` is nullable)
 * and `avisoAnuncio.ts` carries a phrase for exactly it. Counting it as
 * "unreadable" would hide a real violation behind a diagnostic number.
 */
function violacaoDeDetalhe(bruto: unknown, kind: KindViolacao): ShopeeViolacao | null {
  const lido = linhaDeDetalheSchema.safeParse(bruto);
  if (!lido.success) return null;
  const linha = lido.data;

  // ⚠️ The deboost side ONLY. The page declares `suggested_category[]` there and
  // nowhere else; a status row that carried one would be reporting a category
  // suggestion for a listing that was taken down, which no page describes. The
  // refusal is tested rather than incidental.
  const categorias =
    kind === 'deboost' && linha.suggested_category !== null
      ? linha.suggested_category.filter((c): c is NonNullable<typeof c> => c !== null)
      : null;

  return {
    violation_type: textoDeViolacao(linha.violation_type),
    violation_reason: textoDeViolacao(linha.violation_reason),
    suggestion: textoDeViolacao(linha.suggestion),
    fix_deadline_time: agendadoParaMsDe(linha.fix_deadline_time),
    update_time: agendadoParaMsDe(linha.update_time),
    suggested_category: categorias,
    kind,
    // ⚠️ NEVER derived — see the module header.
    days_to_fix: null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                the builder                                 */
/* -------------------------------------------------------------------------- */

/** What one delivery (or one read) yielded. */
export interface ResultadoViolacoes {
  /** The flattened rows, status side first, in wire order within each side. */
  readonly violacoes: readonly ShopeeViolacao[];
  /**
   * How many rows were not objects and were dropped. A DIAGNOSTIC for the one
   * log line per delivery — never a value, never a body.
   *
   * ⚠️ It counts whole ROWS only. A `suggested_category` element that could not
   * be read is dropped inside its row and is not counted here.
   */
  readonly descartadas: number;
}

/**
 * The builder. Pure, total, never throws.
 *
 * ⚠️ It answers a PAIR — the rows AND the discard count — rather than the bare
 * array the design sketched. The count cannot be recovered afterwards (the
 * dropped rows are gone), and a second function that recounted them would be two
 * traversals that have to agree, which is the very drift this module exists to
 * prevent.
 *
 * @param statusDetails `item_status_details[]`, or `[]`
 * @param deboostDetails either deboost spelling's rows, through
 *   {@link detalhesDeDeboost}, or `[]`
 */
export function violacoesDeDetalhes(
  statusDetails: readonly unknown[],
  deboostDetails: readonly unknown[],
): ResultadoViolacoes {
  const violacoes: ShopeeViolacao[] = [];
  let descartadas = 0;

  for (const [linhas, kind] of [
    [statusDetails, 'status'],
    [deboostDetails, 'deboost'],
  ] as const) {
    for (const bruta of linhas) {
      const violacao = violacaoDeDetalhe(bruta, kind);
      if (violacao === null) descartadas += 1;
      else violacoes.push(violacao);
    }
  }

  return { violacoes, descartadas };
}

/* -------------------------------------------------------------------------- */
/*                        reading the two arrays off a body                    */
/* -------------------------------------------------------------------------- */

/** An array as read, or `[]` — never a `null` a `for…of` would throw on. */
function arrayOuVazio(bruto: unknown): readonly unknown[] {
  return Array.isArray(bruto) ? (bruto as readonly unknown[]) : [];
}

/**
 * WHICH deboost spelling this body used, or `null` when neither carried a row.
 *
 * ⚠️ **Exact keys.** The singular `deboost_detail` is NOT this field and never
 * matches: no page spells it that way, and accepting a near-miss key would let a
 * typo — ours or Shopee's — decide what an operator is told about a listing.
 *
 * ⚠️ "Carried a row" and not "is present": both keys exist on every parsed
 * `get_item_violation_info` row (each defaults to `null`), and an empty array
 * under one spelling must not hide rows under the other. When BOTH carry rows
 * the parameter-table spelling wins, and {@link detalhesDeDeboost} reads the
 * same one — the two answers are the same decision, made once.
 *
 * It exists so the handler's one log line can record `grafiaDeboosted` (W1 §8.1)
 * without spelling the two keys a second time.
 */
export function grafiaDeboostUsada(data: Record<string, unknown>): GrafiaDeboost | null {
  if (arrayOuVazio(data[DEBOOST_TABELA]).length > 0) return DEBOOST_TABELA;
  if (arrayOuVazio(data[DEBOOST_AMOSTRA]).length > 0) return DEBOOST_AMOSTRA;
  return null;
}

/**
 * The deboost detail rows of a raw body, under EITHER spelling, or `[]`.
 *
 * Built on {@link grafiaDeboostUsada} so the reader and the log line can never
 * disagree about which array was read.
 */
export function detalhesDeDeboost(data: Record<string, unknown>): readonly unknown[] {
  const grafia = grafiaDeboostUsada(data);
  return grafia === null ? [] : arrayOuVazio(data[grafia]);
}

/**
 * The status detail rows of a raw body, or `[]`.
 *
 * One spelling, so this is only the "an absent or non-array value is `[]`" half
 * — but it is the half both callers would otherwise write inline, beside a call
 * to {@link detalhesDeDeboost} that already does it.
 */
export function detalhesDeStatus(data: Record<string, unknown>): readonly unknown[] {
  return arrayOuVazio(data[STATUS_DETALHES]);
}
