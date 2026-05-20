import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const HERE = dirname(fileURLToPath(import.meta.url));
// Hoist .env / .env.local from the repo root into process.env so the
// homologação smoke test picks up NFE_CERT_BASE64 / NFE_CERT_PASSWORD
// without callers having to set them in the shell each session. We
// parse the dotenv format inline (no `vite` / `dotenv` dep — neither is
// declared at this workspace).
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function parseDotenv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// `.env.local` overrides `.env`; the shell environment overrides both
// (so a one-off `$env:NFE_CERT_BASE64 = '…'` still wins).
const envFromFiles: Record<string, string> = {
  ...parseDotenv(resolve(REPO_ROOT, '.env')),
  ...parseDotenv(resolve(REPO_ROOT, '.env.local')),
};

// Resolve a relative NFE_CERT_PATH against the repo root (the dir where
// `.env.local` lives), not against vitest's CWD (the package dir). Users
// write paths like `.ignore/cert.pfx` thinking from the project root —
// match that mental model.
if (envFromFiles.NFE_CERT_PATH && !isAbsolute(envFromFiles.NFE_CERT_PATH)) {
  envFromFiles.NFE_CERT_PATH = resolve(REPO_ROOT, envFromFiles.NFE_CERT_PATH);
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: { ...envFromFiles, ...process.env },
  },
});
