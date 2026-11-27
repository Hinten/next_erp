/**
 * Pure half of the throwaway credential scrub (ADR 0013, amendment 2026-11-26).
 *
 * A test project seeded from a copy of the legacy data receives that data's live
 * provider credentials. Some are single-use refresh tokens, so the first refresh
 * the test stack makes would kill production's connection. This script deletes
 * them from the TEST project right after the import, before anything is deployed
 * there, using the mirror's own definition of a credential
 * (`apps/legacy-mirror/functions/src/credentials.ts`), so the scrub and the
 * `deny` mirror cannot disagree.
 *
 * ⚠️ Never run it against the REAL new project: the real migration needs those
 * tokens current. `--confirm-throwaway` must repeat the project id on purpose.
 */

import { credentialFieldsOf, isCredentialPath } from '@delfrance/legacy-mirror/mirror';

export class ScrubArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrubArgError';
  }
}

export interface ScrubArgs {
  projectId: string;
  apply: boolean;
  serviceAccountPath?: string;
}

/**
 *   --project <test-id>             REQUIRED
 *   --confirm-throwaway <test-id>   REQUIRED, must equal --project
 *   --apply                         delete (omit for a dry-run that only lists)
 *   --service-account <path>
 */
export function parseScrubArgs(argv: readonly string[]): ScrubArgs {
  let projectId: string | undefined;
  let confirm: string | undefined;
  let apply = false;
  let serviceAccountPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ScrubArgError(`${flag} requires a value.`);
      }
      i += 1;
      return next;
    };
    switch (flag) {
      case '--apply':
        apply = true;
        break;
      case '--project':
        projectId = value().trim();
        break;
      case '--confirm-throwaway':
        confirm = value().trim();
        break;
      case '--service-account':
        serviceAccountPath = value();
        break;
      default:
        throw new ScrubArgError(`Unknown argument: ${arg}`);
    }
  }

  if (!projectId) throw new ScrubArgError('--project <test-project-id> is required.');
  if (confirm !== projectId) {
    throw new ScrubArgError(
      '--confirm-throwaway must repeat the --project id. This script DELETES credentials ' +
        'and must only ever run against a throwaway test project, never the real one.',
    );
  }
  return { projectId, apply, serviceAccountPath };
}

/** The documents a collection-group walk found that ARE credentials. */
export function credentialDocuments(paths: readonly string[]): string[] {
  return paths.filter(isCredentialPath);
}

/** The credential fields to delete from one document (empty when none). */
export function fieldsToScrub(path: string, data: Record<string, unknown>): string[] {
  return credentialFieldsOf(path, data);
}
