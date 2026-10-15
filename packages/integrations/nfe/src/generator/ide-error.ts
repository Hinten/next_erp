/**
 * The `ide` builders' error, in a module of its own so a builder `ide.ts` calls
 * (`compraGov.ts`) can throw it without importing `ide.ts` back. `ide.ts`
 * re-exports it, so every existing importer is unchanged.
 */
export class NFeIdeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeIdeError';
  }
}
