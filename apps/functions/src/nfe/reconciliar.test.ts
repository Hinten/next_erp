import { describe, expect, it, vi } from 'vitest';

vi.mock('./call-nfe', () => ({ postNfe: vi.fn() }));

import { postNfe } from './call-nfe';
import { handleReconcileTask } from './reconciliar';

describe('handleReconcileTask', () => {
  it('forwards the task payload verbatim and resolves on a 2xx response', async () => {
    vi.mocked(postNfe).mockResolvedValue({ status: 200, ok: true });
    const payload = { kind: 'consulta-lote', filialId: 'F1', nRec: 'R1', tpEmis: 1, attempt: 0 };
    await expect(handleReconcileTask(payload)).resolves.toBeUndefined();
    expect(postNfe).toHaveBeenCalledWith('/api/nfe/reconciliar', payload);
  });

  it('throws on a non-2xx response so the queue retries within retryConfig', async () => {
    vi.mocked(postNfe).mockResolvedValue({ status: 503, ok: false });
    await expect(handleReconcileTask({ kind: 'consulta-lote' })).rejects.toThrow(/HTTP 503/);
  });
});
