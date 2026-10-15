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

  it.each(['127.0.0.0', '127.0.0.2', '127.1.2.3', '127.255.255.255'])(
    'accepts validated IPv4 loopback %s for isolated emulator processes',
    (host) => {
      expect(
        readEmulatorAccessConfig({
          ...validEnv,
          NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: host,
          FIREBASE_AUTH_EMULATOR_HOST: `${host}:9099`,
          FIRESTORE_EMULATOR_HOST: `${host}:8080`,
        }),
      ).toMatchObject({ projectId: 'demo-erp', authHost: host, firestoreHost: host });
    },
  );

  it.each([
    '126.255.255.255',
    '128.0.0.0',
    '192.168.0.1',
    '127.0.0.256',
    '127.000.0.1',
    '127.0.0',
    '127.1',
    '2130706433',
    '0x7f000001',
    '127.0.0.2.example.com',
    '127.0.0.2@external.example',
    '[::1]',
    '::1',
  ])('rejects external or malformed host %s on every emulator surface', (host) => {
    for (const [key, value] of [
      ['NEXT_PUBLIC_FIREBASE_EMULATOR_HOST', host],
      ['FIREBASE_AUTH_EMULATOR_HOST', `${host}:9099`],
      ['FIRESTORE_EMULATOR_HOST', `${host}:8080`],
    ] as const) {
      expect(() => readEmulatorAccessConfig({ ...validEnv, [key]: value })).toThrow(key);
    }
  });

  it.each([
    ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.2:8080'],
    ['FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.2:09099'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.2:9099'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.2:08080'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.2:8080.0'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.2:8080/path'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.2:8080:9099'],
    ['FIRESTORE_EMULATOR_HOST', 'http://127.0.0.2:8080'],
  ] as const)('keeps exact service-port syntax for %s = %s', (key, value) => {
    expect(() => readEmulatorAccessConfig({ ...validEnv, [key]: value })).toThrow(key);
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
