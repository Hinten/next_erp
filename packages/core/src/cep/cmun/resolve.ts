import { type CMunTable } from './codec';
import { cmunTable, lookupCodigoMunicipioIn } from './table';
import { codigoMunicipioMatchesUf } from '../ibgeUf';
import { type ViaCepClient, ViaCepError, createViaCepClient } from '../viaCep';
import { cleanCep } from '../cep';

/** A well-formed IBGE município code: exactly 7 digits. */
const CMUN_RE = /^\d{7}$/;

export type MotivoCodigoMunicipioNaoResolvido =
  /** The endereço's CEP is not 8 digits — nothing to look up. */
  | 'cep-invalido'
  /** Offline resolution was requested and the CEP is outside every faixa. */
  | 'fora-das-faixas'
  /** ViaCEP answered but gave no usable IBGE code (including "CEP not found"). */
  | 'viacep-sem-ibge'
  /** ViaCEP could not be reached, timed out, or returned unparseable JSON. */
  | 'viacep-indisponivel'
  /** A code WE derived contradicts the endereço's `estado`. */
  | 'uf-divergente';

/**
 * No `codigoMunicipio` could be produced for an endereço. Thrown rather than
 * returned because every caller of the async resolver needs a value — NF-e
 * emission cannot proceed without `cMun` — so a silent `null` would just
 * relocate the failure to `parties.ts` with less context.
 */
export class CodigoMunicipioNaoResolvidoError extends Error {
  readonly cep: string;
  readonly motivo: MotivoCodigoMunicipioNaoResolvido;

  constructor(
    cep: string,
    motivo: MotivoCodigoMunicipioNaoResolvido,
    options?: { cause?: unknown },
  ) {
    super(`Não foi possível resolver o código do município (cMun) do CEP ${cep}: ${motivo}.`, {
      cause: options?.cause,
    });
    this.name = 'CodigoMunicipioNaoResolvidoError';
    this.cep = cep;
    this.motivo = motivo;
  }
}

/**
 * The endereço fields the resolution needs. Structural, not `Endereco` — the
 * schema lives in `@delfrance/schemas`, which depends on this package, so
 * `estado` is a plain `string` here rather than the `UF` enum.
 */
export interface EnderecoCMunInput {
  readonly cep: string;
  readonly codigoMunicipio?: string | null;
  /** UF sigla. When present, a code we derive is cross-checked against it. */
  readonly estado?: string | null;
}

export interface ResolveCodigoMunicipioOptions {
  /** Overrides the shared ViaCEP client. Ignored when `offline` is true. */
  readonly viaCep?: ViaCepClient;
  /** Overrides the vendored table. Test seam. */
  readonly table?: CMunTable;
  /**
   * Skip the ViaCEP leg entirely. The backfill migration sets this: ten
   * thousand calls against a service that rate-limits without documenting its
   * limit is a self-inflicted outage.
   */
  readonly offline?: boolean;
}

/** A stored value counts only if it is a well-formed 7-digit code. */
function storedCodigoMunicipio(endereco: EnderecoCMunInput): string | null {
  const stored = endereco.codigoMunicipio;
  // `enderecoSchema.codigoMunicipio` is `z.string().max(8).regex(/^\d*$/)`, so
  // `''` parses fine and reaches the NF-e generator, whose `requireField` only
  // rejects `== null` — producing a silently empty `<cMun>`. Treat anything
  // that is not 7 digits as absent and re-resolve it.
  return stored != null && CMUN_RE.test(stored) ? stored : null;
}

/**
 * Reject a code WE derived that contradicts the endereço's UF.
 *
 * Only derived values are checked — a stored value is operator data and is
 * returned untouched (the backfill reports such conflicts instead of silently
 * "fixing" them). The check matters because the ML mapper's `resolveUf`
 * defaults a genuinely-absent estado to `'AC'`: emitting a São Paulo cMun under
 * `UF=AC` earns SEFAZ rejection 273, and a named error beats that round trip.
 */
function assertUfAgrees(cep: string, codigoMunicipio: string, estado: string | null | undefined) {
  if (estado == null || estado === '') return;
  if (!codigoMunicipioMatchesUf(codigoMunicipio, estado)) {
    throw new CodigoMunicipioNaoResolvidoError(cep, 'uf-divergente');
  }
}

/**
 * Offline resolution: stored value → vendored CEP-range table.
 *
 * Synchronous, no IO, returns `null` rather than throwing. For bulk callers
 * (the backfill) and any synchronous context.
 */
export function resolveCodigoMunicipioSync(
  endereco: EnderecoCMunInput,
  options: Pick<ResolveCodigoMunicipioOptions, 'table'> = {},
): string | null {
  const stored = storedCodigoMunicipio(endereco);
  if (stored) return stored;

  const clean = cleanCep(endereco.cep);
  if (clean.length !== 8) return null;

  return lookupCodigoMunicipioIn(options.table ?? cmunTable(), clean);
}

let sharedViaCep: ViaCepClient | undefined;

/**
 * Resolve an endereço's `codigoMunicipio`, mirroring the legacy `Endereco.cMun`
 * getter (`.old/packages/clientes/lib/src/models.dart:1059-1087`): stored value
 * → offline CEP-range table → ViaCEP. Minus that getter's gap bug — see
 * `searchRanges`.
 *
 * Throws {@link CodigoMunicipioNaoResolvidoError} when nothing resolves.
 */
export async function resolveCodigoMunicipio(
  endereco: EnderecoCMunInput,
  options: ResolveCodigoMunicipioOptions = {},
): Promise<string> {
  const stored = storedCodigoMunicipio(endereco);
  if (stored) return stored;

  const clean = cleanCep(endereco.cep);
  if (clean.length !== 8) {
    throw new CodigoMunicipioNaoResolvidoError(clean, 'cep-invalido');
  }

  const fromTable = lookupCodigoMunicipioIn(options.table ?? cmunTable(), clean);
  if (fromTable) {
    assertUfAgrees(clean, fromTable, endereco.estado);
    return fromTable;
  }

  if (options.offline) {
    throw new CodigoMunicipioNaoResolvidoError(clean, 'fora-das-faixas');
  }

  const client = options.viaCep ?? (sharedViaCep ??= createViaCepClient());

  let found: Awaited<ReturnType<ViaCepClient['buscarCep']>>;
  try {
    found = await client.buscarCep(clean);
  } catch (err) {
    if (err instanceof ViaCepError) {
      throw new CodigoMunicipioNaoResolvidoError(clean, 'viacep-indisponivel', { cause: err });
    }
    throw err;
  }

  const fromViaCep = found?.codigoMunicipio;
  if (fromViaCep == null || !CMUN_RE.test(fromViaCep)) {
    throw new CodigoMunicipioNaoResolvidoError(clean, 'viacep-sem-ibge');
  }

  assertUfAgrees(clean, fromViaCep, endereco.estado);
  return fromViaCep;
}
