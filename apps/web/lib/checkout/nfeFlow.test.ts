import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_NFE } from '@delfrance/schemas';
import { NFeRejectedError, type NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';

const { getDocsMock } = vi.hoisted(() => ({ getDocsMock: vi.fn() }));
vi.mock('firebase/firestore', () => ({ getDocs: getDocsMock }));
vi.mock('@delfrance/data', () => ({
  defineCollection: () => ({
    ref: () => ({}),
    docRef: () => ({}),
    converter: {},
    resolvePath: () => '',
  }),
}));
vi.mock('../nfe/saveBlob', () => ({ saveBlob: vi.fn() }));

import { ensureNfeAprovada, printDanfeForCheckout, resolveAprovadaNfe } from './nfeFlow';

const db = {} as never;
const asClient = (o: object) => o as unknown as NFeHttpClient;
const nfeDoc = (id: string, estado: string, chave: string | null, mod: number) => ({
  id,
  data: () => ({ estado, chave, ultima_modificacao: mod }),
});
const setDocs = (docs: unknown[]) => getDocsMock.mockResolvedValue({ docs });
const emitResult = (over: Record<string, unknown>) => ({
  nfeId: 'nfe-1',
  pedidoId: 'p1',
  chave: 'CHV',
  nRec: null,
  cStat: '100',
  xMotivo: 'Autorizado o uso da NF-e',
  ...over,
});

describe('resolveAprovadaNfe', () => {
  beforeEach(() => getDocsMock.mockReset());
  it('picks the latest aprovada doc carrying a chave', async () => {
    setDocs([
      nfeDoc('r', ESTADO_NFE.rejeitada, 'X', 99),
      nfeDoc('old', ESTADO_NFE.aprovada, 'A-OLD', 10),
      nfeDoc('new', ESTADO_NFE.aprovada, 'A-NEW', 20),
    ]);
    expect(await resolveAprovadaNfe(db, 'p1')).toEqual({ nfeId: 'new', chave: 'A-NEW' });
  });
  it('returns null with no authorized doc / no chave', async () => {
    setDocs([nfeDoc('a', ESTADO_NFE.aprovada, null, 1)]);
    expect(await resolveAprovadaNfe(db, 'p1')).toBeNull();
    setDocs([]);
    expect(await resolveAprovadaNfe(db, 'p1')).toBeNull();
  });
});

describe('ensureNfeAprovada', () => {
  let client: { emitir: ReturnType<typeof vi.fn>; danfe: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    getDocsMock.mockReset();
    client = { emitir: vi.fn(), danfe: vi.fn() };
  });

  it('reuses an existing aprovada without emitting', async () => {
    setDocs([nfeDoc('n', ESTADO_NFE.aprovada, 'CHV', 5)]);
    expect(await ensureNfeAprovada(db, asClient(client), 'p1')).toEqual({
      ok: true,
      nfeId: 'n',
      chave: 'CHV',
      reused: true,
    });
    expect(client.emitir).not.toHaveBeenCalled();
  });

  it('emits and returns ok on aprovada', async () => {
    setDocs([]);
    client.emitir.mockResolvedValue(emitResult({ estado: ESTADO_NFE.aprovada, reused: false }));
    expect(await ensureNfeAprovada(db, asClient(client), 'p1')).toEqual({
      ok: true,
      nfeId: 'nfe-1',
      chave: 'CHV',
      reused: false,
    });
  });

  it('returns pending on an async estado (enviando)', async () => {
    setDocs([]);
    client.emitir.mockResolvedValue(emitResult({ estado: ESTADO_NFE.enviando }));
    expect(await ensureNfeAprovada(db, asClient(client), 'p1')).toEqual({
      ok: false,
      pending: true,
    });
  });

  it('returns a red notification on rejeitada', async () => {
    setDocs([]);
    client.emitir.mockResolvedValue(
      emitResult({ estado: ESTADO_NFE.rejeitada, cStat: '999', xMotivo: 'Rejeitado' }),
    );
    const r = await ensureNfeAprovada(db, asClient(client), 'p1');
    expect(r.ok).toBe(false);
    if (!r.ok && !r.pending) expect(r.notification.color).toBe('red');
  });

  it('maps a thrown NFeRejectedError to a notification', async () => {
    setDocs([]);
    client.emitir.mockRejectedValue(new NFeRejectedError('999', 'Rejeitado', {}));
    const r = await ensureNfeAprovada(db, asClient(client), 'p1');
    expect(r).toMatchObject({ ok: false, pending: false });
  });

  it('rethrows an unexpected (non-NFe) error', async () => {
    setDocs([]);
    const boom = new RangeError('boom');
    client.emitir.mockRejectedValue(boom);
    await expect(ensureNfeAprovada(db, asClient(client), 'p1')).rejects.toBe(boom);
  });
});

describe('printDanfeForCheckout', () => {
  const artifact = { blob: new Blob(['x']), filename: 'd.pdf', contentType: 'application/pdf' };

  it('maps each PDF format to the right danfe format + paper size', async () => {
    const printJobFn = vi.fn(
      async (
        _blob: Blob,
        _opts: { fileName: string; contentType: string; tamanho: 'a4' | 'etq' },
      ) => 'printed' as const,
    );
    const danfe = vi.fn(async () => artifact);
    const client = asClient({ danfe });

    await printDanfeForCheckout(client, 'p1', 'n1', 'simplificadoPdf', printJobFn);
    expect(danfe.mock.calls[0]).toEqual(['p1', 'n1', 'simplificado']);
    expect(printJobFn.mock.calls[0]![1]).toMatchObject({ tamanho: 'etq' });

    danfe.mockClear();
    printJobFn.mockClear();
    await printDanfeForCheckout(client, 'p1', 'n1', 'paisagem', printJobFn);
    expect(danfe.mock.calls[0]).toEqual(['p1', 'n1', 'paisagem']);
    expect(printJobFn.mock.calls[0]![1]).toMatchObject({ tamanho: 'a4' });
  });

  it('downloads (not prints) for zpl2', async () => {
    const danfe = vi.fn(async () => ({
      ...artifact,
      filename: 'd.zpl',
      contentType: 'text/plain',
    }));
    const result = await printDanfeForCheckout(asClient({ danfe }), 'p1', 'n1', 'simplificadoZpl2');
    expect(result).toBe('downloaded');
    expect(danfe.mock.calls[0]).toEqual(['p1', 'n1', 'zpl2']);
  });
});
