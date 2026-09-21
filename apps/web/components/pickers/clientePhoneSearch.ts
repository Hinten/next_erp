import { limit, or, query, where, type Firestore } from 'firebase/firestore';
import {
  formatTelefoneInternacional,
  isValidTelefone,
  normalizeTelefone,
  telefoneQueryShapes,
} from '@delfrance/core/phone';
import type { Cliente } from '@delfrance/schemas';
import { clienteCollection } from '@/lib/data/clienteCollection';

const PHONE_RESULTS_LIMIT = 15;

/** Only full phone terms trigger array lookup; a name or partial number remains a scalar search. */
export function clientePhoneSearchShapes(term: string): string[] {
  if (!/^\+?[\d\s().-]+$/.test(term.trim())) return [];
  const normalized = normalizeTelefone(term);
  if (!isValidTelefone(normalized)) return [];
  return telefoneQueryShapes(term);
}

/** Explicit operator search only. A historical phone never establishes an automatic identity. */
export function clientePhoneSearchQuery(db: Firestore, term: string) {
  const shapes = clientePhoneSearchShapes(term);
  if (shapes.length === 0) return null;
  return query(
    clienteCollection.ref(db, {}),
    or(where('telefone', 'in', shapes), where('telefonesAdicionais', 'array-contains-any', shapes)),
    limit(PHONE_RESULTS_LIMIT),
  );
}

export function describeClienteOption(cliente: Cliente, term: string): string | undefined {
  const shapes = clientePhoneSearchShapes(term);
  const historicalMatch = cliente.telefonesAdicionais.some((phone) => shapes.includes(phone));
  return (
    [
      cliente.cpf_cnpj || cliente.idEstrangeiro,
      cliente.telefone
        ? `Principal: ${formatTelefoneInternacional(cliente.telefone)}`
        : 'Sem telefone principal',
      historicalMatch ? 'Histórico inativo' : null,
    ]
      .filter(Boolean)
      .join(' · ') || undefined
  );
}
