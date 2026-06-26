'use client';

/**
 * Endereço deduplication for the CNPJ lookup (#341). When the lookup resolves an
 * address for a cliente that already exists, we must not register a duplicate —
 * so before opening the prefilled "Novo endereço" modal we check whether the
 * cliente already has this address and, if so, open the existing one for review
 * instead. Two addresses are considered "the same" when their CEP + número match.
 */

import { FirebaseError } from 'firebase/app';
import { type Firestore, getDocs, limit, query, where } from 'firebase/firestore';
import type { Endereco } from '@delfrance/schemas';
import { enderecoCollection } from '@/lib/data/enderecoCollection';
import type { ClienteCnpjEndereco } from './consultaCnpj';

/** Keep only digits — CEP is stored as 8 digits but may arrive formatted. */
function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Whether an already-registered endereço is the same place as the resolved one.
 * Compares CEP + número: número is the discriminator within a CEP (a CEP can
 * span a whole street), while logradouro/bairro/cidade are derived from the CEP
 * and add nothing. Both sides are normalized (CEP to digits, número trimmed) so
 * formatting differences don't cause a false miss.
 */
export function enderecoMatchesResolved(
  existing: Pick<Endereco, 'cep' | 'numero'>,
  resolved: Pick<ClienteCnpjEndereco, 'cep' | 'numero'>,
): boolean {
  return (
    digits(existing.cep) === digits(resolved.cep) &&
    existing.numero.trim() === resolved.numero.trim()
  );
}

/**
 * Finds an endereço already registered under the cliente that matches the
 * resolved one (CEP + número). Queries by CEP equality — a single-field filter,
 * cheap on a cliente's small enderecos subcollection (Enterprise needs no index)
 * — and matches número in memory. Returns the first match's id, or null.
 *
 * Dedup is best-effort: a Firestore failure resolves to null (offer the address
 * rather than block on a transient read error); non-Firebase errors propagate
 * (CLAUDE.md rule 6 — no generic catch).
 */
export async function findExistingEndereco(
  db: Firestore,
  clienteId: string,
  resolved: ClienteCnpjEndereco,
): Promise<{ id: string } | null> {
  const cep = digits(resolved.cep);
  if (cep === '') return null;
  try {
    const snap = await getDocs(
      query(enderecoCollection.ref(db, { clienteId }), where('cep', '==', cep), limit(20)),
    );
    const hit = snap.docs.find((d) => enderecoMatchesResolved(d.data(), resolved));
    return hit ? { id: hit.id } : null;
  } catch (err) {
    if (err instanceof FirebaseError) return null;
    throw err;
  }
}
