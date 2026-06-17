/**
 * Shared CLI argument parsing for the user-fixture scripts (grant-all-perms,
 * create-super-user): `<email> [--service-account|-s <path>] [--grupo|-g <id>]`.
 *
 * A flag only consumes the following token as its value when that token exists
 * and is not itself a flag — so a missing value reliably trips `flagValueError`
 * instead of silently swallowing the next flag (e.g. `--grupo --service-account x`
 * must NOT set grupo to "--service-account").
 */
export interface ScriptArgs {
  email?: string;
  serviceAccountPath?: string;
  grupo?: string;
}

const FLAGS: ReadonlyArray<{ aliases: ReadonlyArray<string>; label: string }> = [
  { aliases: ['--service-account', '-s'], label: '--service-account' },
  { aliases: ['--grupo', '-g'], label: '--grupo' },
];

export function parseScriptArgs(argv: string[]): ScriptArgs {
  const [email, ...rest] = argv;
  let serviceAccountPath: string | undefined;
  let grupo: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];
    const value = next !== undefined && !next.startsWith('-') ? next : undefined;
    if (arg === '--service-account' || arg === '-s') {
      serviceAccountPath = value;
      if (value !== undefined) index += 1;
    } else if (arg === '--grupo' || arg === '-g') {
      grupo = value;
      if (value !== undefined) index += 1;
    }
  }

  return { email, serviceAccountPath, grupo };
}

/** A "Missing value for <flag>" message if a known flag was passed without a value, else null. */
export function flagValueError(argv: string[]): string | null {
  for (const { aliases, label } of FLAGS) {
    for (let i = 0; i < argv.length; i += 1) {
      if (aliases.includes(argv[i]!)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) return `Missing value for ${label}`;
      }
    }
  }
  return null;
}
