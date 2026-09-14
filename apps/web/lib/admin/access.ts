import { z } from 'zod';
import {
  accessAcceptedSchema,
  accessOperationSchema,
  cargoEditorReadSchema,
  usuarioEditorReadSchema,
  type Cargo,
  type Usuario,
} from '@delfrance/schemas';
import { call } from './users';

export const readCargo = (id: string, token: string) =>
  call(
    `/api/admin/cargos/${encodeURIComponent(id)}`,
    z.object({ value: cargoEditorReadSchema, version: z.string() }),
    { method: 'GET' },
    token,
  );
export const readUsuario = (id: string, token: string) =>
  call(
    `/api/admin/users/${encodeURIComponent(id)}`,
    z.object({ value: usuarioEditorReadSchema, version: z.string() }),
    { method: 'GET' },
    token,
  );
export const readAccessOperation = (id: string, token: string) =>
  call(
    `/api/admin/access-operations/${encodeURIComponent(id)}`,
    accessOperationSchema,
    { method: 'GET' },
    token,
  );
export const retryAccessOperation = (id: string, token: string) =>
  call(
    `/api/admin/access-operations/${encodeURIComponent(id)}/retry`,
    accessAcceptedSchema,
    { method: 'POST' },
    token,
  );
export function saveCargo(
  id: string | null,
  cargo: Cargo | null,
  version: string | null,
  operationId: string,
  token: string,
) {
  return call(
    `/api/admin/cargos${id ? '/' + encodeURIComponent(id) : ''}`,
    accessAcceptedSchema,
    {
      method: id ? (cargo ? 'PATCH' : 'DELETE') : 'POST',
      body: JSON.stringify({ operationId, expectedVersion: version, cargo }),
    },
    token,
  );
}
export function saveUsuario(
  id: string,
  usuario: Usuario,
  version: string,
  operationId: string,
  token: string,
) {
  return call(
    `/api/admin/users/${encodeURIComponent(id)}`,
    accessAcceptedSchema,
    { method: 'PATCH', body: JSON.stringify({ operationId, expectedVersion: version, usuario }) },
    token,
  );
}
