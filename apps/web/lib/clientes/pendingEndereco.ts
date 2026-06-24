'use client';

/**
 * One-shot relay for an address resolved by the CNPJ lookup on the **create**
 * page, where the enderecos subcollection can't be written yet (no cliente id).
 * The create page stashes it keyed by the new cliente id and redirects; the
 * detail page pops it on mount and opens the prefilled `EnderecoFormModal`.
 * sessionStorage survives the client-side `router.replace` and is scoped to the
 * tab, so a stale relay never leaks across sessions.
 */

import type { ClienteCnpjEndereco } from './consultaCnpj';

const key = (clienteId: string): string => `cliente-cnpj-endereco:${clienteId}`;

export function stashEnderecoForCliente(clienteId: string, endereco: ClienteCnpjEndereco): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(key(clienteId), JSON.stringify(endereco));
}

/** Reads and removes the stashed address (consume-once). */
export function popEnderecoForCliente(clienteId: string): ClienteCnpjEndereco | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(key(clienteId));
  if (!raw) return null;
  window.sessionStorage.removeItem(key(clienteId));
  try {
    return JSON.parse(raw) as ClienteCnpjEndereco;
  } catch (err) {
    // Corrupt relay payload → treat as "nothing stashed" (no generic catch).
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}
