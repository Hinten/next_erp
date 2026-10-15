/**
 * Is a provider-supplied value USABLE, or is it a redaction?
 *
 * Every marketplace that hides buyer data outside an "unmask window" redacts it
 * IN PLACE rather than omitting it, so the value arrives NON-EMPTY and with a
 * plausible length: `P******n`, `******64`, `Ấp******`, and — measured on a
 * Shopee sandbox order, 2026-09-09 — the all-stars `****`. Truthiness passes. A
 * `.length` check passes. `!= null` passes. That is the whole bug class, and it
 * is why nothing here compares against a literal such as `'***'`: the mask is
 * PARTIAL, so the only reliable signal is "an asterisk anywhere".
 *
 * ⚠️ ONE predicate per FIELD, shared, because the capture rule is fill-once PER
 * FIELD: a name and a document can arrive on two different deliveries, and a
 * rule written twice is a rule that drifts (root `CLAUDE.md`, "a comment
 * asserting what the OTHER copy does is the smell").
 *
 * Named after the RULE, not after the channel or the actor — the same choice
 * `clienteIdentity.ts` and `enderecoBuilder.ts` made. There is no Shopee
 * vocabulary and no buyer concept in this module: it answers "is this provider
 * value usable", which WhatsApp, Magalu and Amazon will all ask. It is pure and
 * total, which is the test for whether a rule may live in `packages/schemas`
 * (root `CLAUDE.md`, "Re-implementing a rule that already runs on another
 * surface? Extract it").
 *
 * ⚠️ **`telefone` deliberately gets NO predicate here.** The rule is that a
 * phone is never stored from a marketplace payload, and the enforcement is the
 * ABSENCE of any path that could store one — a `telefoneUtilizavel` would be a
 * function whose only correct use is not to be called. `sanitizeTelefone`
 * (`clienteIdentity.ts`) stays the helper for the channels that DO store one.
 *
 * Every input is typed `unknown` on purpose, for the same reason
 * `clienteIdentity.ts` does it: reads go through `parseSoftRead`, which returns
 * the RAW document when it fails the schema, and a provider row reaches these
 * predicates punctuated, empty, or not a string at all.
 */

import { normalizeDocumento, validateCpfCnpj } from '@delfrance/core/documents';
import { normalizeNome } from './clienteIdentity';

/**
 * Any `*`, anywhere.
 *
 * ⚠️ NEVER `=== '***'` and never a prefix/suffix test. The documented shapes are
 * `P******n` (stars in the middle), `******64` (stars in front) and `****` (all
 * stars); a literal comparison catches exactly one of the three and reports the
 * other two as real buyer data.
 */
const MASCARADO = /\*/;

/**
 * The placeholder providers print where a field has no value. It is not a name
 * and it is not a document — Shopee's own console prints it for an absent
 * `error` — so it is absence, not a one-character value.
 */
const TRACO = '-';

/** A name shorter than this is mask residue or a typo, never a legal name. */
const NOME_MINIMO = 2;

/** The two lengths `validateCpfCnpj` recognises, after `normalizeDocumento`. */
const COMPRIMENTO_CPF = 11;
const COMPRIMENTO_CNPJ = 14;

/**
 * WHY a value was refused.
 *
 * Field NAMES and this verdict are the only things that may be logged or stored
 * about a refusal — never the value, never its length, never a prefix.
 */
export type MotivoRecusa = 'ausente' | 'mascarado' | 'invalido';

/** Named members of {@link MotivoRecusa} — the companion const readers branch on. */
export const MOTIVO_RECUSA = {
  /** Absent, blank, or the `-` placeholder. Nothing was sent. */
  ausente: 'ausente',
  /** Sent, but redacted: an `*` somewhere in it. */
  mascarado: 'mascarado',
  /** Sent in the clear and still unusable — a bad check digit, a 1-char name. */
  invalido: 'invalido',
} as const satisfies Record<string, MotivoRecusa>;

/** Which predicate {@link motivoDaRecusa} should answer for. */
export type TipoDeValor = 'texto' | 'nome' | 'documento';

/** Named members of {@link TipoDeValor}. */
export const TIPO_DE_VALOR = {
  texto: 'texto',
  nome: 'nome',
  documento: 'documento',
} as const satisfies Record<string, TipoDeValor>;

/**
 * A usable string, trimmed — or `null`.
 *
 * Absent: `null`, `undefined`, a non-string, `''`, whitespace-only, `'-'`, and
 * anything carrying an `*`.
 *
 * ⚠️ The mask test runs on the RAW value, before trimming, because trimming
 * cannot remove an asterisk and running it first would only invite someone to
 * "simplify" the order later.
 */
export function valorUtilizavel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (MASCARADO.test(raw)) return null;
  const limpo = raw.trim();
  if (limpo === '' || limpo === TRACO) return null;
  return limpo;
}

/**
 * A usable legal NAME, whitespace-collapsed — or `null`.
 *
 * {@link valorUtilizavel} plus at least {@link NOME_MINIMO} characters after
 * `normalizeNome`. The normalisation is load-bearing rather than cosmetic:
 * `clienteSchema.nome` is only `z.string().max(255)`, so it accepts `'   '`
 * happily, and a padded/double-spaced payload would otherwise be stored as the
 * buyer's legal name and reach the NF-e `dest.xNome`.
 */
export function nomeUtilizavel(raw: unknown): string | null {
  const valor = valorUtilizavel(raw);
  if (valor === null) return null;
  const nome = normalizeNome(valor);
  if (nome === null || nome.length < NOME_MINIMO) return null;
  return nome;
}

/**
 * A usable CPF/CNPJ in its CANONICAL stored form — or `null`.
 *
 * `normalizeDocumento` (strips `.`, `-`, `/` and whitespace, uppercases — it
 * keeps letters for the alphanumeric CNPJ of IN RFB 2.229/2024), then EXACTLY
 * 11 or 14 characters, then `validateCpfCnpj`.
 *
 * ⚠️ **THE CHECK DIGITS ARE VALIDATED HERE, AND THAT IS NOT OPTIONAL.**
 * `clienteSchema.cpf_cnpj` carries `.refine(v => v === '' || validateCpfCnpj(v))`,
 * so an invalid document is not "stored for an operator to fix" — it throws a
 * `ZodError` inside `clienteCollection.add`, which an unattended importer reads
 * as a transient failure and retries for ever. That is the identical crash shape
 * `sanitizeTelefone` exists to prevent, one field over.
 *
 * The cost is stated rather than hidden: a buyer who mistyped their own CPF on
 * the marketplace gets no cliente and no NF-e until a human fixes it — which is
 * the true state of the world, since that CPF cannot be fiscalized either.
 *
 * ⚠️ `normalizeDocumento` does NOT strip `*`, so `***.***.***-**` normalises to
 * ELEVEN characters and passes the length test. The mask gate in
 * {@link valorUtilizavel} is what refuses it, not the length — do not "simplify"
 * this function by dropping that call.
 */
export function cpfCnpjUtilizavel(raw: unknown): string | null {
  const valor = valorUtilizavel(raw);
  if (valor === null) return null;
  const documento = normalizeDocumento(valor);
  if (documento.length !== COMPRIMENTO_CPF && documento.length !== COMPRIMENTO_CNPJ) return null;
  return validateCpfCnpj(documento) ? documento : null;
}

/**
 * WHY a value was refused, or `null` when it was not refused at all.
 *
 * The `tipo` argument is required because "invalido" is not decidable without
 * it: a one-character string is a fine `texto`, an unusable `nome`, and a
 * malformed `documento`. Splitting the three verdicts is what lets a capture
 * record say `nome:mascarado` (wait for the unmask window) apart from
 * `cpf_cnpj:invalido` (a human has to fix it, waiting achieves nothing).
 */
export function motivoDaRecusa(raw: unknown, tipo: TipoDeValor): MotivoRecusa | null {
  if (typeof raw === 'string' && MASCARADO.test(raw)) return MOTIVO_RECUSA.mascarado;
  const valor = valorUtilizavel(raw);
  if (valor === null) return MOTIVO_RECUSA.ausente;
  if (tipo === TIPO_DE_VALOR.nome) {
    return nomeUtilizavel(valor) === null ? MOTIVO_RECUSA.invalido : null;
  }
  if (tipo === TIPO_DE_VALOR.documento) {
    return cpfCnpjUtilizavel(valor) === null ? MOTIVO_RECUSA.invalido : null;
  }
  return null;
}
