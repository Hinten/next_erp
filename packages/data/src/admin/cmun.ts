import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import {
  type ViaCepClient,
  ViaCepError,
  cleanCep,
  createViaCepClient,
  ufFromCodigoMunicipio,
} from '@delfrance/core/cep';
import { ORIGEM_CMUN, type Cmun, cmunDocId, ufSchema } from '@delfrance/schemas';
import { cmunCollection } from './collections/cmunCollection';
import { isAlreadyExists } from './grpcErrors';

/**
 * CEP → IBGE município code (`cMun`), from the `CMUN` table (#785).
 *
 * The port of the legacy `Endereco.cMun` getter
 * (`.old/packages/clientes/lib/src/models.dart:1059-1087`): stored value →
 * table → ViaCEP. With one addition that is the point of the whole design —
 * **a ViaCEP answer is written back into the table**, so a CEP costs at most
 * one external call, ever. ViaCEP rate-limits hard (HTTP 429), so it must never
 * become the routine path; the table absorbs it.
 *
 * Nothing here writes to the endereço. `endereco.codigoMunicipio` is a manual
 * override, not a cache — see the note on that field in
 * `packages/schemas/src/endereco.ts`.
 */

/** A well-formed IBGE município code: exactly 7 digits. */
const CMUN_RE = /^\d{7}$/;

export type MotivoCodigoMunicipioNaoResolvido =
  /** The endereço's CEP is not 8 digits — nothing to look up. */
  | 'cep-invalido'
  /** Neither the table nor ViaCEP knows this CEP. */
  | 'desconhecido'
  /** ViaCEP answered but gave no usable IBGE code (including "CEP not found"). */
  | 'viacep-sem-ibge'
  /** ViaCEP could not be reached, timed out, or returned unparseable JSON. */
  | 'viacep-indisponivel'
  /** A code WE derived contradicts the endereço's `estado`. */
  | 'uf-divergente';

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

/** The endereço fields resolution needs. Structural — any endereço-shaped object. */
export interface EnderecoCMunInput {
  readonly cep: string;
  readonly codigoMunicipio?: string | null;
  /** UF sigla. When present, a code we derive is cross-checked against it. */
  readonly estado?: string | null;
}

export interface ResolveCodigoMunicipioOptions {
  /** Overrides the shared ViaCEP client. Test seam. */
  readonly viaCep?: ViaCepClient;
  /** Skip the ViaCEP leg — table only. */
  readonly offline?: boolean;
}

/**
 * Process-wide memo of resolved CEPs.
 *
 * The table is effectively static, so there is no staleness to manage, and a
 * lote of pedidos routinely shares addresses. Write-through on the ViaCEP path
 * below. `@delfrance/data/admin/cache` (#753/#762) is not merged yet — adopt it
 * here once it is, and drop this Map.
 */
const memo = new Map<string, string>();

function storedCodigoMunicipio(endereco: EnderecoCMunInput): string | null {
  // `enderecoSchema.codigoMunicipio` is `.max(8).regex(/^\d*$/)`, so `''` is
  // storable and would otherwise reach the NF-e generator as an empty <cMun>.
  const stored = endereco.codigoMunicipio;
  return stored != null && CMUN_RE.test(stored) ? stored : null;
}

/**
 * The faixa covering `cepInt`, or `null`.
 *
 * ⚠️ ONE inequality, with the lower bound checked in code — do not "modernise"
 * this into `where('cepInicial','<=',n).where('cepFinal','>=',n)`. Firestore
 * supports that now, but a second inequality is a POST-FILTER: per Google's own
 * docs the extra constraint "does not reduce the number of index entries that
 * Cloud Firestore scans". Enterprise bills data scanned, so that shape would
 * scan half the table on a hit and — because faixas are disjoint and ascending,
 * meaning no later entry can ever satisfy `cepInicial <= n` — the ENTIRE tail
 * on a miss. Misses are the hot path here: they are exactly what ViaCEP fills
 * in. As written this reads one document either way.
 *
 * Needs `CMUN(cepFinal ASC)` in `firestore.indexes.json`; Enterprise
 * auto-creates nothing.
 */
async function faixaCobrindo(db: Firestore, cepInt: number): Promise<Cmun | null> {
  const snap = await cmunCollection
    .ref(db, {})
    .where('cepFinal', '>=', cepInt)
    .orderBy('cepFinal')
    .limit(1)
    .get();

  const doc = snap.docs[0];
  if (!doc) return null;

  const row = cmunCollection.parseRead(doc.data(), cmunCollection.docPath({}, doc.id));
  // The legacy query stopped here — it had NO lower-bound check at all (its
  // `startAt` cursor was inert), so a CEP in a gap between faixas silently
  // returned the next faixa ABOVE it: a wrong município, into the signed XML.
  return row.cepInicial <= cepInt ? row : null;
}

/**
 * Record a CEP that ViaCEP resolved but the table did not know.
 *
 * A single-CEP faixa (`cepInicial === cepFinal`), because that is all ViaCEP
 * actually tells us — do not invent a range. It can only ever land in a genuine
 * gap (an enclosing faixa would have been found already), so it cannot overlap.
 *
 * Best-effort: we already have the answer, so a failed write must not fail the
 * caller. The deterministic doc id makes concurrent writers converge.
 */
async function registrarFaixa(
  db: Firestore,
  cepInt: number,
  cMun: string,
  nomeMunicipio: string,
  estado: string,
): Promise<void> {
  const now = Date.now();
  const data = cmunCollection.parse({
    cepInicial: cepInt,
    cepFinal: cepInt,
    cMun,
    nomeMunicipio,
    estado,
    origem: ORIGEM_CMUN.viacep,
    timestamp: now,
    ultimaModificacao: now,
  }) as DocumentData;

  try {
    await cmunCollection.docRef(db, {}, cmunDocId(cepInt)).create(data);
  } catch (err) {
    // Another emission resolved the same CEP first — same value, same id.
    if (!isAlreadyExists(err)) throw err;
  }
}

let sharedViaCep: ViaCepClient | undefined;

/**
 * Resolve an endereço's `codigoMunicipio`.
 *
 * stored override → `CMUN` table → ViaCEP (written back) → throw.
 */
export async function resolveCodigoMunicipio(
  db: Firestore,
  endereco: EnderecoCMunInput,
  options: ResolveCodigoMunicipioOptions = {},
): Promise<string> {
  const stored = storedCodigoMunicipio(endereco);
  if (stored) return stored;

  const clean = cleanCep(endereco.cep);
  if (clean.length !== 8) {
    throw new CodigoMunicipioNaoResolvidoError(clean, 'cep-invalido');
  }

  const cached = memo.get(clean);
  if (cached) return cached;

  // `Number` drops the leading zero — exactly what the legacy `int.parse(cep)`
  // did, and how `cepInicial`/`cepFinal` are stored.
  const cepInt = Number(clean);

  const faixa = await faixaCobrindo(db, cepInt);
  if (faixa) {
    assertUfAgrees(clean, faixa.cMun, endereco.estado);
    memo.set(clean, faixa.cMun);
    return faixa.cMun;
  }

  if (options.offline) {
    throw new CodigoMunicipioNaoResolvidoError(clean, 'desconhecido');
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

  if (found == null || !CMUN_RE.test(found.codigoMunicipio)) {
    throw new CodigoMunicipioNaoResolvidoError(clean, 'viacep-sem-ibge');
  }
  const fromViaCep = found.codigoMunicipio;
  assertUfAgrees(clean, fromViaCep, endereco.estado);

  // The whole point: teach the table, so this CEP never costs a call again.
  // Prefer the UF implied by the código itself — it is the authority, and
  // ViaCEP's `uf` is free text we would otherwise have to trust.
  const uf = ufFromCodigoMunicipio(fromViaCep) ?? ufSchema.safeParse(found.estado).data ?? 'EX';
  await registrarFaixa(db, cepInt, fromViaCep, found.cidade || 'NAO INFORMADO', uf);
  memo.set(clean, fromViaCep);
  return fromViaCep;
}

/**
 * Reject a code WE derived that contradicts the endereço's UF.
 *
 * Only derived values are checked — a stored value is operator data. This
 * matters because the ML mapper defaults a genuinely-absent estado to `'AC'`:
 * emitting a São Paulo cMun under `UF=AC` earns SEFAZ rejection 273, and a
 * named error beats that round trip.
 */
function assertUfAgrees(cep: string, codigoMunicipio: string, estado: string | null | undefined) {
  if (estado == null || estado === '') return;
  // The first 2 digits of an IBGE município code are its state's code.
  if (!ufMatches(codigoMunicipio, estado)) {
    throw new CodigoMunicipioNaoResolvidoError(cep, 'uf-divergente');
  }
}

function ufMatches(codigoMunicipio: string, estado: string): boolean {
  const uf = ufFromCodigoMunicipio(codigoMunicipio);
  return uf !== null && uf === estado.toUpperCase();
}

/** Test-only: clear the process-wide memo between cases. */
export function __resetCmunMemo(): void {
  memo.clear();
}
