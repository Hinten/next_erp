import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/test-fixtures', () => ({ namespace: () => 'e2e_123' }));

import { verifyE2ENamespaceAccess } from './verify-e2e-rules';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('verifyE2ENamespaceAccess — #172 staging ruleset pre-flight guard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'test-api-key');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'test-project');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_DATABASE_ID', undefined);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws without making any request when the client Firebase env is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', undefined);

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /NEXT_PUBLIC_FIREBASE_API_KEY/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a distinct error when sign-in succeeds but the response carries no idToken', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /returned no idToken/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the ephemeral user sign-in itself fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: 'INVALID_PASSWORD' } }));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /could not sign the ephemeral e2e user in/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the redeploy hint when the write is denied — stale/wrong staging ruleset', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { status: 'PERMISSION_DENIED' } }));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /does not cover e2e namespaces \(write denied\).*gen:rules:e2e/s,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws the redeploy hint when the read is denied even though the write succeeded', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(403, { error: { status: 'PERMISSION_DENIED' } }));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /does not cover e2e namespaces \(read denied\)/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws a distinct message for a non-403 failure — not misread as a rules gap', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: 'internal' } }));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /unexpected 500/,
    );
  });

  it('resolves and hits the run-scoped probe collection when both write and read succeed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).resolves.toBeUndefined();

    const [signInUrl] = fetchMock.mock.calls[0]!;
    expect(String(signInUrl)).toContain('identitytoolkit.googleapis.com');
    expect(String(signInUrl)).toContain('key=test-api-key');

    const [writeUrl, writeInit] = fetchMock.mock.calls[1]!;
    expect(String(writeUrl)).toBe(
      'https://firestore.googleapis.com/v1/projects/test-project/databases/default' +
        '/documents/e2e_123_probe/probe',
    );
    expect((writeInit as RequestInit).method).toBe('PATCH');
    expect((writeInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });

    const [readUrl, readInit] = fetchMock.mock.calls[2]!;
    expect(String(readUrl)).toBe(String(writeUrl));
    expect((readInit as RequestInit).method).toBeUndefined();
  });
});
