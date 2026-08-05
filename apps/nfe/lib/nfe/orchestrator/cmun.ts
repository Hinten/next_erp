import type { Firestore } from 'firebase-admin/firestore';
import {
  CodigoMunicipioNaoResolvidoError,
  type EnderecoCMunInput,
  type ResolveCodigoMunicipioOptions,
  resolveCodigoMunicipio,
} from '@delfrance/data/admin';
import { NFeOrchestratorError } from './errors';

/**
 * `codigoMunicipio` (IBGE) resolution at emission time (#785).
 *
 * `parties.ts` and `ide.ts` require the 7-digit código for `enderDest.cMun`,
 * `enderEmit.cMun` and `ide.cMunFG`, but nothing on any server path produced
 * it: the Mercado Livre importer stores `null`, and the only resolver in the
 * repo was a manual "Buscar CEP" button in the web UI — with the field hidden
 * from every address form, so an operator could not even type it.
 *
 * ⚠️ **This is a pure lookup — it NEVER writes to the endereço.** The `CMUN`
 * table is what caches CEP → município, and `resolveCodigoMunicipio` teaches it
 * a CEP it did not know by writing THERE. `endereco.codigoMunicipio` is a
 * manual operator override, not a cache; see the note on that field in
 * `packages/schemas/src/endereco.ts`.
 */

/**
 * The input with `codigoMunicipio` narrowed to a guaranteed string.
 *
 * `Omit` rather than an intersection: `E & { codigoMunicipio: string }`
 * collapses to `never` whenever `E` infers the field as the literal `null`,
 * which is exactly what an object literal at a call site produces.
 */
export type ComCodigoMunicipio<E> = Omit<E, 'codigoMunicipio'> & { codigoMunicipio: string };

export interface EnsureCodigoMunicipioOptions {
  /** Names the document in the error, e.g. `endereco 'clientes/c1/enderecos/e1'`. */
  readonly contexto: string;
  /** Forwarded to the resolver. Test seam — production passes nothing. */
  readonly resolve?: ResolveCodigoMunicipioOptions;
}

function isResolved(value: string | null | undefined): value is string {
  return value != null && /^\d{7}$/.test(value);
}

/**
 * Return `endereco` with a guaranteed 7-digit `codigoMunicipio`.
 *
 * Resolves through `@delfrance/data/admin`: stored override → `CMUN` table →
 * ViaCEP (whose answer is written back into `CMUN`). Failing here rather than
 * in the generator is deliberate — `NFePartiesError: endereco.codigoMunicipio
 * is required` told an operator nothing about WHICH endereço to fix.
 */
export async function ensureCodigoMunicipio<E extends EnderecoCMunInput>(
  db: Firestore,
  endereco: E,
  options: EnsureCodigoMunicipioOptions,
): Promise<ComCodigoMunicipio<E>> {
  if (isResolved(endereco.codigoMunicipio)) {
    return endereco as ComCodigoMunicipio<E>;
  }

  let codigoMunicipio: string;
  try {
    codigoMunicipio = await resolveCodigoMunicipio(db, endereco, options.resolve);
  } catch (err) {
    if (err instanceof CodigoMunicipioNaoResolvidoError) {
      throw new NFeOrchestratorError(
        `${options.contexto}: could not resolve codigoMunicipio (IBGE) from CEP ` +
          `'${endereco.cep}' — ${err.motivo}. Fill the município code on the endereço.`,
      );
    }
    throw err;
  }

  return { ...endereco, codigoMunicipio } as ComCodigoMunicipio<E>;
}
