/**
 * Hard stop well below the platform's 256 KB source / 250 KB compiled limits.
 * The emulator does NOT enforce them — the old Flutter project only found out
 * at deploy time — so the gate runs at generate time, BEFORE the file is
 * written, and the `projects.test` API check in CI covers the compiled side.
 */
export const FAIL_BYTES = 120 * 1024;
export const WARN_BYTES = 90 * 1024;

export function sizeGate(source: string, warn: (msg: string) => void = console.warn): void {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > FAIL_BYTES) {
    throw new Error(
      `generated ruleset is ${bytes} bytes (> ${FAIL_BYTES}). Shrink the validator ` +
        'whitelist or the emitted clauses before raising this gate — the deploy ' +
        'limit is 256 KiB source / 250 KiB compiled.',
    );
  }
  if (bytes > WARN_BYTES) {
    warn(`rules-gen: generated ruleset is ${bytes} bytes (warn threshold ${WARN_BYTES}).`);
  }
}
