import {
  clienteIdentidadeSchema,
  identityValue,
  normalizeDocumento,
  type Cliente,
  type ClienteIdentidade,
  type ClienteIdentidadeTipo,
  type ClienteResolveFields,
} from '@delfrance/schemas';
import { sha256Hex } from '../hash';

const ID_NAMESPACE = 'cliente-identidade-v1';

export interface ClienteIdentidadeSpec {
  readonly id: string;
  readonly tipo: ClienteIdentidadeTipo;
  /** Exists only in memory; the Firestore index stores the digest, never this value. */
  readonly valorNormalizado: string;
}

export function clienteIdentidadeId(tipo: ClienteIdentidadeTipo, valorNormalizado: string): string {
  return sha256Hex(JSON.stringify([ID_NAMESPACE, tipo, valorNormalizado]));
}

function documentoNormalizado(value: unknown): string | null {
  const present = identityValue(value);
  if (present == null) return null;
  return identityValue(normalizeDocumento(present));
}

/** Strong identities carried by one marketplace observation, sorted by lock id. */
export function clienteIdentidadesDosCampos(fields: ClienteResolveFields): ClienteIdentidadeSpec[] {
  const values: Array<readonly [ClienteIdentidadeTipo, string | null]> = [
    ['cpf_cnpj', documentoNormalizado(fields.cpf_cnpj)],
    ['idEstrangeiro', documentoNormalizado(fields.idEstrangeiro)],
    ['idMercadoLivre', identityValue(fields.idMercadoLivre)],
  ];

  return values
    .filter((entry): entry is readonly [ClienteIdentidadeTipo, string] => entry[1] != null)
    .map(([tipo, valorNormalizado]) => ({
      id: clienteIdentidadeId(tipo, valorNormalizado),
      tipo,
      valorNormalizado,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Exact ownership test used to remove stale side-index entries. */
export function clientePossuiIdentidade(cliente: Cliente, spec: ClienteIdentidadeSpec): boolean {
  const stored = cliente[spec.tipo];
  const normalized =
    spec.tipo === 'idMercadoLivre' ? identityValue(stored) : documentoNormalizado(stored);
  return normalized === spec.valorNormalizado;
}

/** Persisted shape: sorted owner ids plus the identity kind, never its value. */
export function buildClienteIdentidadeData(
  spec: ClienteIdentidadeSpec,
  clienteIds: Iterable<string>,
  nowMs: number,
): ClienteIdentidade {
  return clienteIdentidadeSchema.parse({
    tipo: spec.tipo,
    clienteIds: [...new Set(clienteIds)].sort(),
    ultimaModificacao: nowMs,
  });
}
