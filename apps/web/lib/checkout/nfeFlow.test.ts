import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_NFE, IE_SENTINELA, TIPO_CLIENTE } from '@delfrance/schemas';
import { NFeRejectedError, type NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';

import { ID_DEST, IND_IE_DEST } from '../nfe/destinatarioNFe';
import type { CarregarContextoRejeicao, ContextoRejeicaoNFe } from '../nfe/errors';

const { getDocsMock, loaderMock, carregadorMock } = vi.hoisted(() => {
  const loaderMock = vi.fn<CarregarContextoRejeicao>();
  return { getDocsMock: vi.fn(), loaderMock, carregadorMock: vi.fn((_db: unknown) => loaderMock) };
});
vi.mock('firebase/firestore', () => ({ getDocs: getDocsMock }));
// The Firestore-backed rejection-context loader (#852) — its own reads are
// pinned in `contextoRejeicao.test.ts`; here only the wiring matters.
vi.mock('../nfe/contextoRejeicao', () => ({ carregadorContextoRejeicao: carregadorMock }));
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

const XMOTIVO_805 =
  'Rejeição: A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição Estadual';

/** An internal (idDest=1) NF-e sent with indIEDest=2 for a cadastro still ISENTO. */
const CONTEXTO_805_INTERNA: ContextoRejeicaoNFe = {
  destinatario: { idDest: ID_DEST.interna, indIEDest: IND_IE_DEST.isento, uf: 'SP' },
  cliente: {
    id: 'cli-805',
    cadastro: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: IE_SENTINELA.isento },
  },
};

describe('ensureNfeAprovada', () => {
  let client: { emitir: ReturnType<typeof vi.fn>; danfe: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    getDocsMock.mockReset();
    loaderMock.mockReset();
    carregadorMock.mockClear();
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
    // Only a cStat that needs context (805) pays for the extra reads.
    expect(loaderMock).not.toHaveBeenCalled();
  });

  it('a thrown 226 keeps the generic notification and never calls the loader', async () => {
    setDocs([]);
    client.emitir.mockRejectedValue(
      new NFeRejectedError('226', 'UF inválida', { pedidoId: 'p1', nfeId: 'nfe-1' }),
    );
    const r = await ensureNfeAprovada(db, asClient(client), 'p1');
    expect(r).toStrictEqual({
      ok: false,
      pending: false,
      notification: {
        title: 'SEFAZ rejeitou a NF-e',
        message: 'cStat=226: UF inválida',
        color: 'red',
      },
    });
    expect(loaderMock).not.toHaveBeenCalled();
  });

  it('a thrown 805 reads the context through the db-bound loader → guidance + cadastro link', async () => {
    setDocs([]);
    loaderMock.mockResolvedValue(CONTEXTO_805_INTERNA);
    client.emitir.mockRejectedValue(
      new NFeRejectedError('805', XMOTIVO_805, {
        pedidoId: 'p1',
        nfeId: 'nfe-805',
        estado: ESTADO_NFE.rejeitada,
      }),
    );

    const r = await ensureNfeAprovada(db, asClient(client), 'p1');

    // Bound to the SAME db handle the caller passed (identity — `db` is `{}` here).
    expect(carregadorMock).toHaveBeenCalledOnce();
    expect(carregadorMock.mock.calls[0]![0]).toBe(db);
    expect(loaderMock).toHaveBeenCalledOnce();
    expect(loaderMock).toHaveBeenCalledWith({ pedidoId: 'p1', nfeId: 'nfe-805' });
    expect(r).toMatchObject({
      ok: false,
      pending: false,
      notification: {
        title: 'Inscrição estadual do cliente recusada pela SEFAZ',
        color: 'red',
        link: { href: '/clientes/cli-805', label: 'Abrir cadastro de ACME LTDA' },
      },
    });
    if (!r.ok && !r.pending) {
      expect(r.notification.message.startsWith(`cStat=805: ${XMOTIVO_805} — `)).toBe(true);
    }
  });

  it('a loader rejection on 805 propagates out of ensureNfeAprovada (a bug, not a toast)', async () => {
    setDocs([]);
    const boom = new TypeError('bug no carregador');
    loaderMock.mockRejectedValue(boom);
    client.emitir.mockRejectedValue(
      new NFeRejectedError('805', XMOTIVO_805, { pedidoId: 'p1', nfeId: 'nfe-805' }),
    );
    await expect(ensureNfeAprovada(db, asClient(client), 'p1')).rejects.toBe(boom);
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
