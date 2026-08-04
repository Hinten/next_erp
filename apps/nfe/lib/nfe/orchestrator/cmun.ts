import type { DocumentReference } from 'firebase-admin/firestore';
import { isNotFound } from '@delfrance/data/admin';
import {
  CodigoMunicipioNaoResolvidoError,
  type EnderecoCMunInput,
  type ResolveCodigoMunicipioOptions,
  resolveCodigoMunicipio,
} from '@delfrance/core/cep/cmun';
import { NFeOrchestratorError } from './errors';

/**
 * Last-resort `codigoMunicipio` resolution at emission time (#785).
 *
 * `parties.ts` and `ide.ts` hard-require the 7-digit IBGE código for
 * `enderDest.cMun`, `enderEmit.cMun` and `ide.cMunFG`, but nothing on any
 * server path ever produced it: the Mercado Livre importer wrote `null`, and
 * the only resolver in the repo was a manual "Buscar CEP" button in the web UI
 * — with the field hidden from every address form, so an operator could not
 * even type it. A hand-created endereço whose operator never pressed that
 * button failed emission exactly like an ML-imported one.
 *
 * The ML importer and the backfill both fill the field now, so in steady state
 * this is a no-op that costs one regex. It exists for the long tail: endereços
 * created before the fix, and endereços created by hand after it.
 */

/** Where to persist a resolved value, or `null` to resolve without writing. */
export interface CMunPersistTarget {
  readonly ref: DocumentReference;
  /**
   * Dotted field path. For an embedded endereço this MUST be the nested leaf
   * (`'sede.codigoMunicipio'`), never the whole map — see `ensureCodigoMunicipio`.
   */
  readonly field: string;
}

export interface EnsureCodigoMunicipioOptions {
  /** Where to write the resolved value; omit or pass `null` to resolve only. */
  readonly persist?: CMunPersistTarget | null;
  /** Names the document in the error message, e.g. `endereco 'clientes/c1/enderecos/e1'`. */
  readonly contexto: string;
  /** Forwarded to the resolver. Test seam — production passes nothing. */
  readonly resolve?: ResolveCodigoMunicipioOptions;
}

/**
 * The input with `codigoMunicipio` narrowed to a guaranteed string.
 *
 * `Omit` rather than an intersection: `E & { codigoMunicipio: string }`
 * collapses to `never` whenever `E` infers the field as the literal `null`,
 * which is exactly what an object literal at a call site produces.
 */
export type ComCodigoMunicipio<E> = Omit<E, 'codigoMunicipio'> & { codigoMunicipio: string };

function isResolved(value: string | null | undefined): value is string {
  return value != null && /^\d{7}$/.test(value);
}

/**
 * Return `endereco` with a guaranteed 7-digit `codigoMunicipio`, resolving and
 * persisting it when it is missing.
 *
 * The write is a **dotted-path `update()` on the snapshot's own ref**, which
 * touches exactly one leaf. That matters most for `filial.sede`: routing it
 * through `filialCollection.merge()` would make `parseMergePatch` demand a full
 * valid `enderecoSchema` for `sede` and write the whole map back, clobbering
 * whatever a human edited concurrently in a config collection. Using
 * `snap.ref` also keeps the `no-inline-admin-collection` lint quiet.
 *
 * Persistence is best-effort only for a vanished document — anything else
 * rethrows. `apps/nfe` runs under a service account with Admin SDK access, so a
 * write failure there is a real misconfiguration worth surfacing, not
 * something to swallow on the highest-stakes path in the system.
 */
export async function ensureCodigoMunicipio<E extends EnderecoCMunInput>(
  endereco: E,
  options: EnsureCodigoMunicipioOptions,
): Promise<ComCodigoMunicipio<E>> {
  if (isResolved(endereco.codigoMunicipio)) {
    return endereco as ComCodigoMunicipio<E>;
  }

  let codigoMunicipio: string;
  try {
    codigoMunicipio = await resolveCodigoMunicipio(endereco, options.resolve);
  } catch (err) {
    if (err instanceof CodigoMunicipioNaoResolvidoError) {
      // Fail here rather than in the generator: this message names the document
      // and the CEP, so an operator knows exactly what to fix.
      throw new NFeOrchestratorError(
        `${options.contexto}: não foi possível resolver codigoMunicipio (IBGE) do CEP ` +
          `'${endereco.cep}' — ${err.motivo}. Preencha o código do município no endereço.`,
      );
    }
    throw err;
  }

  const { persist } = options;
  if (persist) {
    try {
      await persist.ref.update({ [persist.field]: codigoMunicipio });
    } catch (err) {
      // The doc was deleted between our read and this write — the emission has
      // the value it needs, so carry on rather than failing on a cache update.
      if (!isNotFound(err)) throw err;
    }
  }

  return { ...endereco, codigoMunicipio } as ComCodigoMunicipio<E>;
}
