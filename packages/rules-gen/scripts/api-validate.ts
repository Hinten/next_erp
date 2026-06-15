/**
 * Server-side compile validation of the committed firestore.rules against the
 * REAL Firebase Rules API: `projects.test` with a source-only payload compiles
 * on the production service and persists nothing — no ruleset is created, no
 * release touched, no quota burned. This covers the exact blind spot that
 * burned the old Flutter project: the emulator does not enforce the 256 KiB
 * source / 250 KiB compiled deploy limits.
 *
 * Env (mapped from the FIREBASE_*_STAGING secrets in ci-rules.yml):
 *   FIREBASE_PROJECT_ID      target project id
 *   FIREBASE_SERVICE_ACCOUNT service-account JSON (scope: auth/firebase)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GaxiosError } from 'gaxios';
import { GoogleAuth } from 'google-auth-library';

const RULES_PATH = fileURLToPath(new URL('../../../firestore.rules', import.meta.url));

interface Issue {
  sourcePosition?: { line?: number; column?: number };
  description?: string;
  severity?: string;
}

function parseServiceAccount(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    }
    throw err;
  }
}

async function main(): Promise<number> {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!projectId || !serviceAccountRaw) {
    console.error('FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT are required.');
    return 1;
  }

  const content = readFileSync(RULES_PATH, 'utf8');
  const auth = new GoogleAuth({
    credentials: parseServiceAccount(serviceAccountRaw),
    scopes: ['https://www.googleapis.com/auth/firebase'],
  });
  const client = await auth.getClient();

  let issues: Issue[];
  try {
    const res = await client.request<{ issues?: Issue[] }>({
      url: `https://firebaserules.googleapis.com/v1/projects/${projectId}:test`,
      method: 'POST',
      // No testSuite: source-only payloads just compile server-side.
      data: { source: { files: [{ name: 'firestore.rules', content }] } },
    });
    issues = res.data.issues ?? [];
  } catch (err) {
    if (err instanceof GaxiosError) {
      console.error(`Rules API rejected the request (HTTP ${err.status ?? '?'}):`);
      console.error(JSON.stringify(err.response?.data ?? err.message, null, 2));
      return 1;
    }
    throw err;
  }

  let failed = false;
  for (const issue of issues) {
    const pos = issue.sourcePosition;
    const where = pos ? `${pos.line ?? '?'}:${pos.column ?? '?'}` : '?:?';
    console.log(
      `[${issue.severity ?? 'UNKNOWN'}] firestore.rules:${where} ${issue.description ?? ''}`,
    );
    if (issue.severity === 'ERROR') failed = true;
  }
  if (failed) return 1;

  console.log(
    `firestore.rules compiled cleanly on project ${projectId}` +
      (issues.length > 0 ? ` (${issues.length} non-error issue(s) above)` : ''),
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
