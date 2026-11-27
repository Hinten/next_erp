/**
 * Pure half of the legacy-mirror replay (ADR 0013, amendment 2026-11-26).
 *
 * The seed import writes every document as it was at the export's T0 and never
 * touches `_mirrorWatermarks`. So any document the mirror had already updated
 * after T0 holds the OLDER T0 version again, while its watermark still says
 * "current". The replay re-applies exactly those paths — every watermark whose
 * stamp is after T0 — through the mirror's own `mirrorPath`, whose equal-stamp
 * rule is what lets it repair them. Nothing else is touched.
 *
 * `--verify` compares document counts, legacy against new.
 */

import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  type CredentialPolicy,
  InvalidCredentialPolicyError,
  type Stamp,
  compareStamps,
  parseCredentialPolicy,
} from '@delfrance/legacy-mirror/mirror';

export class ReplayArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayArgError';
  }
}

export interface ReplayArgs {
  /** The LEGACY project the mirror reads. Required, never inferred. */
  sourceProjectId: string;
  /** The NEW project the mirror writes. Required, never inferred. */
  projectId: string;
  /** The export's `--snapshot-time`: replay watermarks stamped strictly after it. */
  since: Stamp;
  apply: boolean;
  /** Count documents per collection on both sides instead of replaying. */
  verify: boolean;
  /** Collection-group ids to count in `--verify`, beyond the root collections. */
  groups: string[];
  /**
   * The SAME policy the deployed mirror runs with — `deny` for a test project,
   * `copy` for the real migration. Required to replay: a replay under the other
   * policy would undo what the mirror decided.
   */
  credentials: CredentialPolicy | null;
  sourceServiceAccountPath?: string;
  serviceAccountPath?: string;
}

function requireValue(next: string | undefined, flag: string): string {
  if (next === undefined || next.startsWith('--'))
    throw new ReplayArgError(`${flag} requires a value.`);
  return next;
}

/**
 * The export's T0. A whole minute in UTC with an explicit zone, like the
 * `--snapshot-time` it has to match: an offset-less string would be read in the
 * machine's zone and replay the wrong window without any error.
 */
export function parseSince(value: string): Stamp {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ReplayArgError(
      `--since must be the export's --snapshot-time, a whole minute with a zone ` +
        `(e.g. 2026-12-17T03:00:00Z). Got "${value}".`,
    );
  }
  const ms = parseIsoToMillis(value);
  if (ms === null) throw new ReplayArgError(`--since "${value}" is not a valid date.`);
  return { seconds: Number(ms) / 1000, nanoseconds: 0 };
}

/**
 *   --source-project <legacy>   REQUIRED
 *   --project <new>             REQUIRED, and must differ from the source
 *   --since <T0>                REQUIRED unless --verify
 *   --apply                     write (omit for a dry-run that only lists)
 *   --verify                    count both sides; writes nothing
 *   --credentials <deny|copy>   REQUIRED unless --verify; the mirror's own policy
 *   --groups <a,b>              extra collection groups for --verify
 *   --source-service-account <path> / --service-account <path>
 */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  let sourceProjectId: string | undefined;
  let projectId: string | undefined;
  let sinceRaw: string | undefined;
  let apply = false;
  let verify = false;
  let groupsRaw = '';
  let credentialsRaw: string | undefined;
  let sourceServiceAccountPath: string | undefined;
  let serviceAccountPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = requireValue(argv[i + 1], flag);
      i += 1;
      return v;
    };
    switch (flag) {
      case '--apply':
        apply = true;
        break;
      case '--verify':
        verify = true;
        break;
      case '--source-project':
        sourceProjectId = value().trim();
        break;
      case '--project':
        projectId = value().trim();
        break;
      case '--since':
        sinceRaw = value().trim();
        break;
      case '--groups':
        groupsRaw = value();
        break;
      case '--credentials':
        credentialsRaw = value();
        break;
      case '--source-service-account':
        sourceServiceAccountPath = value();
        break;
      case '--service-account':
        serviceAccountPath = value();
        break;
      default:
        throw new ReplayArgError(`Unknown argument: ${arg}`);
    }
  }

  if (!sourceProjectId) throw new ReplayArgError('--source-project <legacy-id> is required.');
  if (!projectId) throw new ReplayArgError('--project <new-id> is required.');
  if (sourceProjectId === projectId) {
    throw new ReplayArgError('--source-project and --project must name two different projects.');
  }
  if (apply && verify) throw new ReplayArgError('--verify writes nothing; drop --apply.');
  if (!verify && !sinceRaw)
    throw new ReplayArgError("--since <T0> is required (the export's --snapshot-time).");
  if (!verify && credentialsRaw === undefined) {
    throw new ReplayArgError(
      '--credentials <deny|copy> is required: pass the LEGACY_MIRROR_CREDENTIALS the mirror runs with.',
    );
  }
  let credentials: CredentialPolicy | null = null;
  if (credentialsRaw !== undefined) {
    try {
      credentials = parseCredentialPolicy(credentialsRaw);
    } catch (err) {
      if (err instanceof InvalidCredentialPolicyError) {
        throw new ReplayArgError(
          `--credentials must be 'deny' or 'copy', got "${credentialsRaw}".`,
        );
      }
      throw err;
    }
  }

  return {
    sourceProjectId,
    projectId,
    since: sinceRaw ? parseSince(sinceRaw) : { seconds: 0, nanoseconds: 0 },
    apply,
    verify,
    groups: groupsRaw
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g !== ''),
    credentials,
    sourceServiceAccountPath,
    serviceAccountPath,
  };
}

/**
 * Strictly after T0. A change AT T0 is inside the export already. Uses the
 * mirror's own comparison, so the replay and the guard cannot order two stamps
 * differently.
 */
export function isAfter(stamp: Stamp, since: Stamp): boolean {
  return compareStamps(stamp, since) > 0;
}

export interface CountRow {
  readonly collection: string;
  readonly legacy: number | null;
  readonly novo: number | null;
  readonly status: 'igual' | 'diferente' | 'so-legado' | 'so-novo';
}

/**
 * Compare per-collection counts. `_mirrorWatermarks` is the mirror's own
 * bookkeeping and exists only on the new side, so it is left out rather than
 * reported as a difference nobody should act on.
 */
export function compareCounts(
  legacy: ReadonlyMap<string, number>,
  novo: ReadonlyMap<string, number>,
  ignore: ReadonlySet<string>,
): CountRow[] {
  const names = [...new Set([...legacy.keys(), ...novo.keys()])]
    .filter((n) => !ignore.has(n))
    .sort();
  return names.map((collection) => {
    const l = legacy.get(collection) ?? null;
    const n = novo.get(collection) ?? null;
    const status =
      l === null ? 'so-novo' : n === null ? 'so-legado' : l === n ? 'igual' : 'diferente';
    return { collection, legacy: l, novo: n, status };
  });
}
