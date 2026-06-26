'use client';

/**
 * One-shot relay for an address resolved by the CNPJ lookup, used where the
 * enderecos subcollection can't be written yet — the **create** page (no cliente
 * id before save) and the **quick-create modal** (no endereço UI). It stashes the
 * address keyed by the new cliente id; the detail page pops it on mount and opens
 * the prefilled `EnderecoFormModal`.
 *
 * Uses **localStorage**, not sessionStorage: the quick-create modal links to the
 * cadastro with `target="_blank"`, and a `noopener` new tab starts with an empty
 * sessionStorage (so the relay would be lost) but shares localStorage with the
 * opener. Consume-once removal + a short TTL keep a relay that was never consumed
 * from resurfacing the modal on a much-later visit.
 */

import type { ClienteCnpjEndereco } from './consultaCnpj';

const key = (clienteId: string): string => `cliente-cnpj-endereco:${clienteId}`;

/** A stash older than this is ignored (and discarded) — guards against a relay
 *  that was never consumed lingering in localStorage and resurfacing later. */
const TTL_MS = 30 * 60 * 1000;

interface StashedEndereco {
  endereco: ClienteCnpjEndereco;
  savedAt: number;
}

export function stashEnderecoForCliente(clienteId: string, endereco: ClienteCnpjEndereco): void {
  if (typeof window === 'undefined') return;
  const payload: StashedEndereco = { endereco, savedAt: Date.now() };
  try {
    window.localStorage.setItem(key(clienteId), JSON.stringify(payload));
  } catch (err) {
    // The relay is best-effort — a disabled/over-quota localStorage (private
    // mode, etc.) must never crash the just-completed cadastro. The spec error
    // for both quota + access-denied is a DOMException; rethrow anything else.
    if (err instanceof DOMException) return;
    throw err;
  }
}

/** Reads and removes the stashed address (consume-once); null if absent or stale. */
export function popEnderecoForCliente(clienteId: string): ClienteCnpjEndereco | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(key(clienteId));
  if (!raw) return null;
  window.localStorage.removeItem(key(clienteId));
  try {
    const parsed = JSON.parse(raw) as StashedEndereco;
    if (typeof parsed?.savedAt !== 'number' || Date.now() - parsed.savedAt > TTL_MS) return null;
    return parsed.endereco;
  } catch (err) {
    // Corrupt relay payload → treat as "nothing stashed" (no generic catch).
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}
