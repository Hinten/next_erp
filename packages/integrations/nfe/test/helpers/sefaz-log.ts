/**
 * The one place a live suite prints a SEFAZ response.
 *
 * ⚠️ **This repository is PUBLIC, so every GitHub Actions log is public.**
 * SEFAZ writes fiscal identifiers into the free-text `xMotivo` — the rejection
 * that prompted this helper reads *"CNPJ <do emitente> do Emitente não
 * cadastrado na Receita Federal"* — and the live suites printed `xMotivo`
 * verbatim, so the emitente's CNPJ was published on every failing run (#1471).
 *
 * The fix is redaction, not silence. The rejection's meaning lives entirely in
 * the RULE ("CNPJ do Emitente não cadastrado"), never in the digits: there is
 * exactly one certificate in CI and we already know whose it is. Dropping
 * `xMotivo` instead would re-open the gap #1470 closed, which cost two
 * diagnoses that dead-ended on a bare code (`999` in #1247, `178` in #1471).
 *
 * ⚠️ Scope is TESTS, deliberately. `apps/nfe`'s runtime logs go to Cloud
 * Logging, which is private, and there the CNPJ is the diagnostic — with
 * per-filial certs the whole question is *which* CNPJ SEFAZ rejected. Redacting
 * that surface would hurt real debugging. The boundary is "public CI log" vs
 * "private ops log", not "CNPJ everywhere".
 */

/**
 * Fiscal identifiers SEFAZ embeds in free text, longest-first so a CNPJ inside
 * a 44-digit chave is not half-eaten by the CNPJ pattern.
 *
 * ⚠️ Bounded by DIGIT lookarounds, not `\b`, and every entry is a FIXED width.
 *
 * The fixed widths are what keep `nProt`/`nRec` (15 digits) and `nNF` (9)
 * readable — they carry no personal data and are often the only way to
 * correlate a run with a document, so a greedy `\d{11,}` would swallow both.
 *
 * ⚠️ `\b` was WRONG here and shipped in the first draft. It is a
 * word-character boundary, and both letters and digits are word characters, so
 * `\b` never fires between them: `NFe<44 digits>` — literally how a chave is
 * written in `infNFe/@Id`, and the shape that turns up in SOAP faults — passed
 * through completely untouched, leaking the very CNPJ (positions 7-20) that
 * masking the bare chave exists to hide. `CNPJ<14 digits>` did the same.
 * `(?<!\d)…(?!\d)` still refuses to match inside a longer digit run, so the
 * fixed-width property the whole design rests on is unchanged.
 */
const PADROES: readonly { readonly re: RegExp; readonly rotulo: string }[] = [
  // Chave de acesso — 44 digits, and it EMBEDS the CNPJ at positions 7-20, so
  // printing one leaks the issuer just as surely as printing the CNPJ itself.
  { re: /(?<!\d)\d{44}(?!\d)/g, rotulo: '[chave]' },
  // CNPJ, punctuated then bare.
  { re: /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g, rotulo: '[CNPJ]' },
  { re: /(?<!\d)\d{14}(?!\d)/g, rotulo: '[CNPJ]' },
  // CPF, punctuated then bare. A destinatário can be a person.
  { re: /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, rotulo: '[CPF]' },
  { re: /(?<!\d)\d{11}(?!\d)/g, rotulo: '[CPF]' },
];

/**
 * Mask fiscal identifiers in provider free text.
 *
 * Replaces the VALUE and keeps the surrounding sentence, so
 * `"Rejeição: CNPJ 11.222.333/0001-44 do Emitente não cadastrado"` becomes
 * `"Rejeição: CNPJ [CNPJ] do Emitente não cadastrado"` — every word that
 * explains the rejection survives.
 */
export function redigirIdentificadores(texto: string | null | undefined): string {
  if (typeof texto !== 'string' || texto === '') return '';
  let out = texto;
  for (const { re, rotulo } of PADROES) {
    out = out.replace(re, rotulo);
  }
  return out;
}

/** The fields a live suite has in hand after any SEFAZ call. */
export interface RespostaSefaz {
  readonly cStat: string;
  readonly xMotivo: string;
  /** SEFAZ's supplementary detail — present only on some rejections. */
  readonly cMsg?: string;
  readonly xMsg?: string;
  /** The protNFe's own cStat, when the caller resolved one. */
  readonly protCStat?: string;
}

/**
 * The redacted one-line form: `[escopo] cStat=<n> xMotivo="<texto>"`.
 *
 * Exposed separately from {@link logSefaz} because the same string belongs in
 * the ASSERTION MESSAGE too — a vitest message lands in the CI *annotation*,
 * which is the same public surface as the log and is easy to forget.
 */
export function descreverSefaz(escopo: string, r: RespostaSefaz): string {
  const partes = [
    `[${escopo}]`,
    `cStat=${r.cStat}`,
    `xMotivo="${redigirIdentificadores(r.xMotivo)}"`,
  ];
  if (r.protCStat !== undefined) partes.push(`prot.cStat=${r.protCStat}`);
  // ⚠️ `cMsg || xMsg`, not `xMsg` alone. Keying on `xMsg` reproduced the old
  // `svc.homologacao.test.ts` behaviour, where a response carrying `cMsg` with
  // no `xMsg` printed NEITHER — and this pair exists precisely to serve the
  // uncatalogued-cStat case, where a bare supplementary code is still the only
  // extra signal there is. `cMsg` is numeric, so there is nothing to redact.
  if (r.cMsg || r.xMsg) {
    partes.push(`cMsg=${r.cMsg ?? '-'} xMsg="${redigirIdentificadores(r.xMsg)}"`);
  }
  return partes.join(' ');
}

/**
 * Print a SEFAZ response. Every live suite goes through here — a raw
 * `console.log` of `xMotivo` in a `*.homologacao.test.ts` is blocked by
 * `packages/config-eslint/rules/sefaz-log-redaction.test.js`, because a new
 * log site that forgot to redact would fail nothing at all.
 */
export function logSefaz(escopo: string, r: RespostaSefaz): void {
  // eslint-disable-next-line no-console
  console.log(descreverSefaz(escopo, r));
}
