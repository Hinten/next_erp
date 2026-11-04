import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProjectId } from './admin';

const h = vi.hoisted(() => ({ getFirestore: vi.fn(), app: { name: 'fake-app' } }));

// Only the Firestore factory and the app registry are faked, so the database id
// that `getAdminFirestore` passes can be read off the call.
vi.mock('firebase-admin/firestore', () => ({ getFirestore: h.getFirestore }));
vi.mock('firebase-admin/app', () => ({
  cert: vi.fn(),
  getApps: () => [h.app],
  initializeApp: vi.fn(() => h.app),
}));

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

/**
 * Enterprise names the database `default`, not the `(default)` sentinel that a
 * bare `getFirestore(app)` resolves — a handle on the wrong name fails
 * `5 NOT_FOUND` on EVERY operation. `FIREBASE_DATABASE_ID` is an override only.
 */
describe('getAdminFirestore', () => {
  beforeEach(() => {
    vi.resetModules();
    h.getFirestore.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens the database 'default' when FIREBASE_DATABASE_ID is unset", async () => {
    // Truly absent (not an empty string, which `??` would keep), the way a
    // deployed backend has it.
    vi.stubEnv('FIREBASE_DATABASE_ID', undefined);
    const { getAdminFirestore } = await import('./admin');
    getAdminFirestore();
    expect(h.getFirestore).toHaveBeenCalledTimes(1);
    expect(h.getFirestore).toHaveBeenCalledWith(h.app, 'default');
    expect(h.getFirestore).not.toHaveBeenCalledWith(h.app, '(default)');
  });

  it('honours an explicit FIREBASE_DATABASE_ID override', async () => {
    vi.stubEnv('FIREBASE_DATABASE_ID', 'outra-base');
    const { getAdminFirestore } = await import('./admin');
    getAdminFirestore();
    expect(h.getFirestore).toHaveBeenCalledWith(h.app, 'outra-base');
  });
});
