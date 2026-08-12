import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProjectId } from './admin';

/**
 * The project id must resolve WITHOUT per-backend config on App Hosting /
 * Cloud Run (which inject GOOGLE_CLOUD_PROJECT / FIREBASE_CONFIG for free) —
 * requiring FIREBASE_PROJECT_ID there caused an unhandled 500 on the first
 * deployed rollout. Precedence: explicit env → GOOGLE_CLOUD_PROJECT →
 * FIREBASE_CONFIG.projectId → service-account project_id → null.
 */
describe('resolveProjectId', () => {
  beforeEach(() => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('FIREBASE_CONFIG', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers the explicit FIREBASE_PROJECT_ID', () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', 'explicit-project');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'gcp-project');
    expect(resolveProjectId(null)).toBe('explicit-project');
  });

  it('falls back to GOOGLE_CLOUD_PROJECT (Cloud Run / App Hosting)', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'gcp-project');
    expect(resolveProjectId(null)).toBe('gcp-project');
  });

  it('falls back to FIREBASE_CONFIG.projectId (Firebase-managed runtimes)', () => {
    vi.stubEnv('FIREBASE_CONFIG', JSON.stringify({ projectId: 'config-project' }));
    expect(resolveProjectId(null)).toBe('config-project');
  });

  it('ignores a malformed FIREBASE_CONFIG and keeps falling back', () => {
    vi.stubEnv('FIREBASE_CONFIG', '{not json');
    expect(resolveProjectId({ project_id: 'sa-project' })).toBe('sa-project');
  });

  it('falls back to the service account project_id', () => {
    expect(resolveProjectId({ project_id: 'sa-project' })).toBe('sa-project');
  });

  it('returns null when nothing provides a project id', () => {
    expect(resolveProjectId(null)).toBeNull();
  });
});
