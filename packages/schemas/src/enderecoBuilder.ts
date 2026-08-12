/**
 * Shared endereço builder — the "force" fill every marketplace importer needs.
 *
 * Ports `Endereco.forceEndereco` (`.old/packages/clientes/lib/src/models.dart:903-990`)
 * with **one** change: the CEP is *essential*. Legacy filled a missing CEP with
 * `'0000000'`, which is 7 digits and fails `enderecoSchema.cep`'s 8-digit regex
 * anyway; here a CEP we cannot sanitise means the endereço is unbuildable and
 * the caller must say so out loud. Everything else is force-filled exactly as
 * legacy did.
 *
 * Lives in `@delfrance/schemas` because it is the only package that can see
 * both halves of what it needs: `ufSchema`/`enderecoSchema` are here, and
 * `@delfrance/core/cep` is a dependency of this package (never the reverse).
 * It is deliberately channel-agnostic — Mercado Livre is the first caller, the
 * next marketplace is the reason it is not sitting in `apps/mercado-livre`.
 *
 * ## Two properties worth knowing before you change anything here
 *
 * **1. The input is `unknown`, and parsing it never throws.** Provider payloads
 * are not to be trusted: ML's `receiver_address` is reached through an
 * unchecked cast, and every schema on that path — the webhook body's included,
 * even after #810 Zod-validated it — is `.passthrough()`, which checks the
 * fields it names and nothing else. So a `street_number` can still arrive as
 * the number `50` and would otherwise be written into Firestore as a number.
 * {@link rawEnderecoInputSchema} coerces scalars to strings and everything else
 * to `null`.
 *
 * **2. The output is emissible, not merely storable.** `enderecoSchema` is
 * looser than the NF-e `TEndereco` XSD in both directions — it accepts a
 * 1-character `logradouro` that the pre-send XSD gate then *rejects*, and a
 * 150-character one that `requireSanitized(…, 60)` silently truncates at
 * emission, so the stored endereço is not the signed endereço. Every value here
 * is clamped to {@link NFE_ENDERECO_LIMITES}, the intersection of the two. See
 * the drift backstop in `packages/integrations/nfe`.
 *
 * What this module deliberately does NOT do: fill `codigoMunicipio`. That field
 * is a manual operator override, not a cache — the CEP → município cache is the
 * `CMUN` table, and teaching it is the job of the resolver in
 * `@delfrance/data/admin` (#785). Writing a município here would defeat it.
 */
import { z } from 'zod';
import { type EnderecoViaCep, type ViaCepClient, ViaCepError } from '@delfrance/core/cep';
import { UF_SIGLA, type UF, ufSchema } from './endereco';

/* ------------------------------- output shape ------------------------------ */

/**
 * The writable half of `enderecoSchema` — every field a builder can fill,
 * without the server-stamped `timestamp`/`ultimaModificacao`. Structurally what
 * `enderecoCollection.parse()` expects.
 */
export interface EnderecoForcado {
  idExterno: string | null;
  cep: string;
  logradouro: string;
  numero: string;
  bairro: string;
  complemento: string | null;
  codigoMunicipio: string | null;
  cidade: string;
  estado: UF;
  cPais: string | null;
  pais: string | null;
  nome: string | null;
  cpf_cnpj: string | null;
  rg: string | null;
  ie: string | null;
  imun: string | null;
  email: string | null;
  telefone: string | null;
}

/**
 * What {@link buildEnderecoForcado} concluded.
 *
 * `uf-desconhecida` is NOT a failure — it carries a complete, storable endereço
 * whose `estado` is provisionally `AC` (legacy's `Endereco.vazio()` UF). Hand it
 * to {@link recoverEnderecoFromCep} to have the real UF resolved from the CEP.
 * `sem-cep` is the only genuinely unbuildable outcome.
 */
export type EnderecoBuildOutcome =
  | { kind: 'ok'; fields: EnderecoForcado }
  | { kind: 'uf-desconhecida'; fields: EnderecoForcado; estadoRaw: string }
  | { kind: 'sem-cep'; cepRaw: string | null };

/** What {@link recoverEnderecoFromCep} concluded. */
export interface EnderecoRecuperado {
  fields: EnderecoForcado;
  /**
   * `false` means ViaCEP could not answer (unknown CEP, network failure,
   * timeout) or answered with a UF that is not a valid sigla, so `fields.estado`
   * is still `forceEndereco`'s `AC`. Callers log on this rather than comparing
   * against `AC` — a CEP in Acre resolves to `AC` legitimately.
   */
  ufResolvida: boolean;
}

/* --------------------------------- limits ---------------------------------- */

/**
 * Per-field `{ min, max }`, the **intersection** of `enderecoSchema`'s own caps
 * and the NF-e `TEndereco` XSD facets (`leiauteNFe_v4.00.xsd`, complexType
 * `TEndereco`). Where they disagree the stricter one wins, so a value that
 * survives this table satisfies both.
 *
 * `numero` and `complemento` are schema-limited (10 / 50, against the XSD's 60);
 * the rest are XSD-limited (60, against the schema's 150 / 100 / 100 / ∞).
 *
 * ⚠️ Hand-copied facets rot. `packages/integrations/nfe` re-reads the XSD and
 * asserts this table against it — that test is the reason this constant may be
 * trusted.
 */
export const NFE_ENDERECO_LIMITES = {
  logradouro: { min: 2, max: 60 },
  numero: { min: 1, max: 10 },
  complemento: { min: 1, max: 50 },
  bairro: { min: 2, max: 60 },
  cidade: { min: 2, max: 60 },
  pais: { min: 2, max: 60 },
} as const;

/**
 * `forceEndereco`'s fallback text (`models.dart:903-990`), with one substitution:
 * legacy's `numero` fallback was the same `'NAO INFORMADO'` as `logradouro`, 13
 * characters against `enderecoSchema.numero`'s `max(10)`. Dart's `@MaxLength(10)`
 * was a form-level annotation it violated silently; Zod's runs at write time and
 * would abort the import, so `numero` uses the standard Brazilian "sem número"
 * shorthand instead. `'S/N'` is valid at every NF-e layer — `/` (U+002F) is
 * inside `TString`'s `[!-ÿ]` pattern, is not a restricted character, and is not
 * XML-significant.
 *
 * Every literal here is ≥2 and ≤60, so the fallbacks themselves can never be the
 * reason an emission is rejected.
 */
export const ENDERECO_FALLBACKS = {
  logradouro: 'NAO INFORMADO',
  numero: 'S/N',
  bairro: 'SEM BAIRRO',
  cidade: 'NAO INFORMADA',
} as const;

/**
 * Completion prefixes for the two fields the XSD requires to be 2+ characters.
 *
 * Clientes really do send a single-character `logradouro`/`bairro`. That value
 * stores fine and then fails the pre-send XSD gate — so rather than discard a
 * real character in favour of a `NAO INFORMADO` that says less, complete it:
 * `'A'` → `'Rua A'`, `'B'` → `'Bairro B'`. Title-case on purpose: these complete
 * a real value, they do not label an unknown one like the SCREAMING fallbacks
 * above.
 */
export const ENDERECO_PREFIXOS_MINIMO = {
  logradouro: 'Rua',
  bairro: 'Bairro',
} as const;

/* ------------------------------- raw input --------------------------------- */

/**
 * Anything scalar becomes a trimmed non-empty string; anything else becomes
 * `null`. Objects, arrays, booleans and non-finite numbers are all garbage in an
 * address slot, and a garbage value must not become the string `"[object
 * Object]"`.
 */
const textoTolerante = z.preprocess((valor) => {
  if (typeof valor === 'string') {
    const limpo = valor.trim();
    return limpo === '' ? null : limpo;
  }
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : null;
  if (typeof valor === 'bigint') return String(valor);
  return null;
}, z.string().nullable());

/**
 * The channel-agnostic address shape. Each importer extracts these eight values
 * from its own payload; nothing else about the provider reaches this module.
 *
 * Every field is parsed through {@link textoTolerante}, so callers may pass raw
 * provider values — including `undefined`, numbers and nested objects — without
 * pre-validating them.
 */
export const rawEnderecoInputSchema = z.object({
  cepRaw: textoTolerante,
  logradouro: textoTolerante,
  numero: textoTolerante,
  complemento: textoTolerante,
  bairro: textoTolerante,
  cidade: textoTolerante,
  estadoRaw: textoTolerante,
  /** Provider country code (ML's `country_id`). `BR` is the implicit default and stores as `null`. */
  paisId: textoTolerante,
});

export type RawEnderecoInput = z.input<typeof rawEnderecoInputSchema>;

const RAW_VAZIO: z.output<typeof rawEnderecoInputSchema> = {
  cepRaw: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: null,
  estadoRaw: null,
  paisId: null,
};

/* ------------------------------- CEP + UF ---------------------------------- */

/**
 * `forceEndereco`'s `cep.replaceAll(RegExp(r'\D'), '')` (models.dart:930), plus
 * the 8-digit gate `enderecoSchema.cep` demands. Legacy's exception-safe
 * `forceEndereco` never threw on a bad CEP (it fell back to `'0000000'`); here a
 * non-8-digit value would ZodError at write time and abort the whole import, so
 * it returns `null` and the caller degrades instead.
 */
export function sanitizeCep(raw: string | null): string | null {
  if (raw == null) return null;
  const digits = raw.replace(/\D/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

const UF_CODES = new Set<string>(ufSchema.options);

/**
 * `UFS.stateMap` (`.old/packages/global/lib/src/constantes.dart:195-225`) —
 * accented, uppercase Portuguese state names → UF code. The corrupted mojibake
 * duplicate key in the Dart source (a `PARANÁ` encoding artifact) is not
 * reproduced here; repairing that input class is #788's job, at the decode
 * boundary where the original bytes still exist.
 */
const UF_NAME_MAP: Record<string, UF> = {
  'SÃO PAULO': UF_SIGLA.SP,
  'RIO DE JANEIRO': UF_SIGLA.RJ,
  'MINAS GERAIS': UF_SIGLA.MG,
  'ESPÍRITO SANTO': UF_SIGLA.ES,
  PARANÁ: UF_SIGLA.PR,
  'RIO GRANDE DO SUL': UF_SIGLA.RS,
  'SANTA CATARINA': UF_SIGLA.SC,
  'MATO GROSSO DO SUL': UF_SIGLA.MS,
  'MATO GROSSO': UF_SIGLA.MT,
  GOIÁS: UF_SIGLA.GO,
  'DISTRITO FEDERAL': UF_SIGLA.DF,
  BAHIA: UF_SIGLA.BA,
  CEARÁ: UF_SIGLA.CE,
  PARÁ: UF_SIGLA.PA,
  PERNAMBUCO: UF_SIGLA.PE,
  TOCANTINS: UF_SIGLA.TO,
  ALAGOAS: UF_SIGLA.AL,
  AMAZONAS: UF_SIGLA.AM,
  AMAPÁ: UF_SIGLA.AP,
  MARANHÃO: UF_SIGLA.MA,
  PIAUÍ: UF_SIGLA.PI,
  'RIO GRANDE DO NORTE': UF_SIGLA.RN,
  RONDÔNIA: UF_SIGLA.RO,
  SERGIPE: UF_SIGLA.SE,
  RORAIMA: UF_SIGLA.RR,
  ACRE: UF_SIGLA.AC,
  PARAÍBA: UF_SIGLA.PB,
  EXTERIOR: UF_SIGLA.EX,
};

/**
 * `UFS.fromValue` (constantes.dart:227-245), restricted to the string branch.
 * `null` in mirrors `forceEndereco`'s `estado != null ? UFS.fromValue(estado) :
 * UFS.AC`; `null` out means the name was present but unrecognised, which is the
 * case {@link recoverEnderecoFromCep} exists to rescue.
 */
export function resolveUf(raw: string | null): UF | null {
  if (raw == null) return UF_SIGLA.AC;
  const alvo = raw.trim().toUpperCase();
  const porNome = UF_NAME_MAP[alvo];
  if (porNome) return porNome;
  if (UF_CODES.has(alvo)) return alvo as UF;
  return null;
}

/* -------------------------------- the build -------------------------------- */

interface Limite {
  readonly min: number;
  readonly max: number;
}

/**
 * Clamp to the max, then satisfy the min — completing with `prefixo` when one is
 * given, discarding otherwise. Returns `null` for "nothing usable here", which
 * is the caller's cue to apply a fallback.
 */
function ajustar(valor: string | null, limite: Limite, prefixo?: string): string | null {
  if (valor == null) return null;
  const cortado = valor.length > limite.max ? valor.slice(0, limite.max).trimEnd() : valor;
  if (cortado.length === 0) return null;
  if (cortado.length >= limite.min) return cortado;
  if (prefixo == null) return null;
  const completo = `${prefixo} ${cortado}`;
  // A completion can only overflow if `max` were absurdly small; keep the raw
  // value rather than emit something longer than the field allows.
  return completo.length <= limite.max ? completo : null;
}

/**
 * Force-fill an endereço from an untrusted provider address.
 *
 * Never throws and never rejects for anything but a missing/unusable CEP. See
 * this module's header for the two properties that matter, and
 * {@link EnderecoBuildOutcome} for what `uf-desconhecida` means.
 */
export function buildEnderecoForcado(raw: unknown): EnderecoBuildOutcome {
  const parsed = rawEnderecoInputSchema.safeParse(raw);
  const input = parsed.success ? parsed.data : RAW_VAZIO;

  const cep = sanitizeCep(input.cepRaw);
  if (cep == null) return { kind: 'sem-cep', cepRaw: input.cepRaw };

  const paisId = input.paisId !== 'BR' ? input.paisId : null;

  const base = {
    idExterno: null,
    cep,
    logradouro:
      ajustar(
        input.logradouro,
        NFE_ENDERECO_LIMITES.logradouro,
        ENDERECO_PREFIXOS_MINIMO.logradouro,
      ) ?? ENDERECO_FALLBACKS.logradouro,
    numero: ajustar(input.numero, NFE_ENDERECO_LIMITES.numero) ?? ENDERECO_FALLBACKS.numero,
    bairro:
      ajustar(input.bairro, NFE_ENDERECO_LIMITES.bairro, ENDERECO_PREFIXOS_MINIMO.bairro) ??
      ENDERECO_FALLBACKS.bairro,
    complemento: ajustar(input.complemento, NFE_ENDERECO_LIMITES.complemento),
    // Never filled here — `endereco.codigoMunicipio` is a manual operator
    // override and the CEP → município cache is the `CMUN` table (#785).
    codigoMunicipio: null,
    cidade: ajustar(input.cidade, NFE_ENDERECO_LIMITES.cidade) ?? ENDERECO_FALLBACKS.cidade,
    cPais: null,
    pais: ajustar(paisId, NFE_ENDERECO_LIMITES.pais),
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
  } satisfies Omit<EnderecoForcado, 'estado'>;

  if (input.estadoRaw == null) {
    // `forceEndereco`'s null-branch (models.dart:925,953) — an ABSENT estado is
    // AC by definition, not a lookup failure.
    return { kind: 'ok', fields: { ...base, estado: UF_SIGLA.AC } };
  }

  const estado = resolveUf(input.estadoRaw);
  if (estado != null) return { kind: 'ok', fields: { ...base, estado } };

  return {
    kind: 'uf-desconhecida',
    fields: { ...base, estado: UF_SIGLA.AC },
    estadoRaw: input.estadoRaw,
  };
}

/* ------------------------------ ViaCEP recovery ---------------------------- */

/**
 * Resolve an unmappable `estado` from the CEP, the arm legacy had and this port
 * dropped: `forceEndereco` caught the `UFS.fromValue` throw and rebuilt from
 * `Endereco.buscarCEP(cep)` (models.dart:955-977), degrading to
 * `Endereco.vazio()` (UF `AC`) only when the lookup itself failed.
 *
 * Two deliberate departures from that rebuild:
 *
 * - **The payload wins over ViaCEP.** Legacy took ViaCEP's logradouro/bairro/
 *   cidade wholesale; here they only fill fields that fell back, and only when
 *   ViaCEP actually answered with something. ViaCEP returns an empty logradouro
 *   and bairro for CEP-geral (city-wide) codes, so an unconditional overwrite
 *   would replace a real street with `''`.
 * - **A failed lookup is not a failed endereço.** `AC` is kept and the endereço
 *   is returned, because a wrong UF cannot reach a signed XML: `codigoMunicipio`
 *   is null, so `parties.ts`'s `requireField` throws at emission — and the
 *   `CMUN` resolver's own UF cross-check rejects the mismatch by name. Losing
 *   the endereço, by contrast, strands the pedido short of `pago` forever.
 *
 * The caller owns the `ViaCepClient` so its memoisation is shared across an
 * import run — and so tests can inject one. ⚠️ A test that does not inject
 * shares the process-wide client and can pass vacuously off another test's
 * cached answer.
 */
export async function recoverEnderecoFromCep(
  outcome: Extract<EnderecoBuildOutcome, { kind: 'uf-desconhecida' }>,
  viaCep: ViaCepClient,
): Promise<EnderecoRecuperado> {
  let encontrado: EnderecoViaCep | null;
  try {
    encontrado = await viaCep.buscarCep(outcome.fields.cep);
  } catch (err) {
    if (!(err instanceof ViaCepError)) throw err;
    encontrado = null;
  }
  if (encontrado == null) return { fields: outcome.fields, ufResolvida: false };

  const fields: EnderecoForcado = { ...outcome.fields };

  const uf = ufSchema.safeParse(encontrado.estado.trim().toUpperCase());
  if (uf.success) fields.estado = uf.data;

  if (fields.logradouro === ENDERECO_FALLBACKS.logradouro) {
    fields.logradouro =
      ajustar(
        nonEmpty(encontrado.logradouro),
        NFE_ENDERECO_LIMITES.logradouro,
        ENDERECO_PREFIXOS_MINIMO.logradouro,
      ) ?? fields.logradouro;
  }
  if (fields.bairro === ENDERECO_FALLBACKS.bairro) {
    fields.bairro =
      ajustar(
        nonEmpty(encontrado.bairro),
        NFE_ENDERECO_LIMITES.bairro,
        ENDERECO_PREFIXOS_MINIMO.bairro,
      ) ?? fields.bairro;
  }
  if (fields.cidade === ENDERECO_FALLBACKS.cidade) {
    fields.cidade =
      ajustar(nonEmpty(encontrado.cidade), NFE_ENDERECO_LIMITES.cidade) ?? fields.cidade;
  }

  return { fields, ufResolvida: uf.success };
}

function nonEmpty(valor: string): string | null {
  const limpo = valor.trim();
  return limpo === '' ? null : limpo;
}
