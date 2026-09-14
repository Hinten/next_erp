/**
 * Consulta Cadastro (layout 2.00) typed shapes (interfaces + META + ROOTS) —
 * shim re-export.
 *
 * The generated source lives under `generated/conscad/types/conscad-schema.ts`,
 * next to the layout 2.00 XSDs it was generated from. It is a SEPARATE codegen
 * pack from `nfe-schema` (`gen:nfe-types` runs `--pack conscad`), because this
 * layout declares its own `TEndereco` — see `generated/conscad/README.md`.
 *
 * Deliberately NOT re-exported from the package barrel: its `TEndereco`,
 * `META` and `ROOTS` would collide with the NF-e ones.
 */
export * from '../../generated/conscad/types/conscad-schema';
