import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@delfrance/test-fixtures', () => ({
  E2E_PROBE_COLLECTION: 'e2e_probe',
  e2eRunId: () => '123',
}));

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

  // `allow read, write` covers delete in Firestore rules, so a 403 here is a real
  // ruleset gap, not a cleanup hiccup — it must fail the run like read and write do.
  it('throws the redeploy hint when the DELETE is denied', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(403, { error: { status: 'PERMISSION_DENIED' } }));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /does not cover e2e namespaces \(delete denied\)/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('throws a distinct message for a non-403 failure — not misread as a rules gap', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: 'internal' } }));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).rejects.toThrow(
      /unexpected 500/,
    );
  });

  it('writes, reads and DELETES a probe keyed by the run id, in a fixed collection', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await expect(verifyE2ENamespaceAccess('e2e@example.com', 'pw')).resolves.toBeUndefined();

    const [signInUrl] = fetchMock.mock.calls[0]!;
    expect(String(signInUrl)).toContain('identitytoolkit.googleapis.com');
    expect(String(signInUrl)).toContain('key=test-api-key');

    // The run id is the DOC id under a fixed collection — not part of the
    // collection name. That is what makes teardown a keyed delete instead of a
    // root `listCollections()` scan.
    const [writeUrl, writeInit] = fetchMock.mock.calls[1]!;
    expect(String(writeUrl)).toBe(
      'https://firestore.googleapis.com/v1/projects/test-project/databases/default' +
        '/documents/e2e_probe/123',
    );
    expect((writeInit as RequestInit).method).toBe('PATCH');
    expect((writeInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });

    // `startedAt` is what the cross-run sweep's age gate reads. Without it every
    // orphaned probe is "unknown age" and therefore never reclaimed.
    const body = JSON.parse(String((writeInit as RequestInit).body)) as {
      fields: { startedAt?: { timestampValue?: string } };
    };
    expect(body.fields.startedAt?.timestampValue).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const [readUrl, readInit] = fetchMock.mock.calls[2]!;
    expect(String(readUrl)).toBe(String(writeUrl));
    expect((readInit as RequestInit).method).toBeUndefined();

    const [deleteUrl, deleteInit] = fetchMock.mock.calls[3]!;
    expect(String(deleteUrl)).toBe(String(writeUrl));
    expect((deleteInit as RequestInit).method).toBe('DELETE');
  });
});

describe('verifyE2ENamespaceAccess — probe URL construction', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // The run id lands in a URL PATH segment. Unencoded, a `../` in it would be
  // normalized by the HTTP layer and could retarget the DELETE at a real staging
  // document — which the e2e user, holding every permission bit, may remove.
  it('percent-encodes the run id so it cannot escape its path segment', async () => {
    vi.resetModules();
    vi.doMock('@delfrance/test-fixtures', () => ({
      E2E_PROBE_COLLECTION: 'e2e_probe',
      e2eRunId: () => '../../clientes/real-doc',
    }));
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'test-api-key');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'test-project');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { idToken: 'tok' }))
      .mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    const { verifyE2ENamespaceAccess: verify } = await import('./verify-e2e-rules');
    await verify('e2e@example.com', 'pw');

    const [writeUrl] = fetchMock.mock.calls[1]!;
    expect(String(writeUrl)).toContain('/documents/e2e_probe/..%2F..%2Fclientes%2Freal-doc');
    expect(String(writeUrl)).not.toContain('/documents/e2e_probe/../');
  });
});
