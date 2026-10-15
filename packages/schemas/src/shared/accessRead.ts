import { z } from 'zod';
import { cargoSchema } from '../cargo';
import { usuarioSchema } from '../usuario';

/** Authorization never uses the soft-read fallback: malformed flags or masks
 * must stop the operation, while unrelated legacy fields are ignored. */
export const usuarioAccessSchema = usuarioSchema.pick({
  cargos: true,
  ativo: true,
  colaborador: true,
  isSuperUser: true,
  externalId: true,
});
export const cargoAccessSchema = cargoSchema.pick({ permissoes: true });

/** Display-only tolerance shared by the HTTP editor and its browser decoder.
 * Keep legacy strings visible for correction; missing/unrenderable presentation
 * values get empty defaults. Saving still uses the strict collection schemas.
 * No authorization field is weakened by these overrides. */
export const cargoEditorReadSchema = cargoSchema.extend({
  nome: z.string().catch(''),
  descricao: z.string().nullable().catch(null),
  timestamp: cargoSchema.shape.timestamp.catch(null),
  ultimaModificacao: cargoSchema.shape.ultimaModificacao.catch(null),
});
export const usuarioEditorReadSchema = usuarioSchema.extend({
  nome: z.string().catch(''),
  email: z.string().nullable().catch(null),
  ultimoAcesso: usuarioSchema.shape.ultimoAcesso.catch(null),
  timestamp: usuarioSchema.shape.timestamp.catch(null),
  ultimaModificacao: usuarioSchema.shape.ultimaModificacao.catch(null),
  jaFoiColaborador: usuarioSchema.shape.jaFoiColaborador.catch(false),
  jaFoiSuperUser: usuarioSchema.shape.jaFoiSuperUser.catch(false),
});
