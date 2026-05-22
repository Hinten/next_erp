/**
 * NF-e typed shapes (interfaces + META) — shim re-export.
 *
 * The actual generated source lives under
 * `generated/moc7.0/types/nfe-schema.ts`, alongside the XSDs it was
 * generated from (`generated/moc7.0/schemas/`). This shim keeps the
 * `src/types/nfe-schema` import path stable for the ~20 internal
 * consumers so MOC version bumps stay localized.
 *
 * To pin a different MOC version, change the path below to point at
 * the desired `generated/mocX.Y/types/nfe-schema` and update
 * `src/xsd/index.ts` + `src/codegen/generate.mjs` to match.
 * See `CLAUDE.md` for the version-pinning playbook.
 */
export * from '../../generated/moc7.0/types/nfe-schema';
