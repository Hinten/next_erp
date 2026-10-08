// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApps } from 'firebase/app';
import { readEmulatorAccessConfig, verifyEmulatorNamespaceAccess } from './verify-emulator-access';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  FIREBASE_PROJECT_ID: 'demo-erp',
  FIREBASE_DATABASE_ID: 'default',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
};

afterEach(() => vi.unstubAllEnvs());

describe('emulator client preflight configuration', () => {
  it('accepts the complete demo configuration and the app default loopback host', () => {
    expect(readEmulatorAccessConfig(validEnv)).toEqual({
      projectId: 'demo-erp',
      apiKey: 'emulator-api-key',
      authHost: '127.0.0.1',
      firestoreHost: '127.0.0.1',
    });
  });

  it('accepts localhost as another loopback address', () => {
    expect(
      readEmulatorAccessConfig({
        ...validEnv,
        NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost',
        FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
        FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      }),
    ).toMatchObject({ authHost: 'localhost', firestoreHost: 'localhost' });
  });

  it.each([
    ['FIREBASE_PROJECT_ID', undefined],
    ['FIREBASE_PROJECT_ID', 'staging-project'],
    ['FIREBASE_PROJECT_ID', 'demo-'],
    ['NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'staging-project'],
    ['NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-other-project'],
    ['FIREBASE_DATABASE_ID', undefined],
    ['FIREBASE_DATABASE_ID', '(default)'],
    ['NEXT_PUBLIC_FIREBASE_DATABASE_ID', '(default)'],
    ['NEXT_PUBLIC_USE_FIREBASE_EMULATOR', 'false'],
    ['NEXT_PUBLIC_FIREBASE_API_KEY', ''],
    ['FIREBASE_AUTH_EMULATOR_HOST', undefined],
    ['FIRESTORE_EMULATOR_HOST', undefined],
    ['FIREBASE_AUTH_EMULATOR_HOST', 'identitytoolkit.googleapis.com:9099'],
    ['FIRESTORE_EMULATOR_HOST', 'firestore.googleapis.com:8080'],
    ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:8080'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:9099'],
    ['FIRESTORE_EMULATOR_HOST', 'http://127.0.0.1:8080'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080/path'],
    ['NEXT_PUBLIC_FIREBASE_EMULATOR_HOST', 'firestore.googleapis.com'],
    ['NEXT_PUBLIC_FIREBASE_EMULATOR_HOST', ''],
  ] as const)('rejects unsafe or inconsistent %s = %s', (key, value) => {
    expect(() => readEmulatorAccessConfig({ ...validEnv, [key]: value })).toThrow(key);
  });

  it('rejects a partial emulator configuration before creating a client app', async () => {
    for (const [key, value] of Object.entries(validEnv)) vi.stubEnv(key, value);
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined);
    const existingApps = getApps();

    await expect(verifyEmulatorNamespaceAccess('user@example.com', 'password')).rejects.toThrow(
      'FIRESTORE_EMULATOR_HOST',
    );
    expect(getApps()).toEqual(existingApps);
  });
});
