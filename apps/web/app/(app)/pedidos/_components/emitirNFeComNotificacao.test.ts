/**
 * `emitirNFeComNotificacao` — the post-commit emit toasts shared by
 * EditarPedidoView, the NovoPedidoView devolução and the entrada prompt. Pins
 * the #852 wiring: the error path goes through the context-aware mapping with
 * the Firestore-backed loader bound to the app's db, and only cStat 805 reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NFeRejectedError,
  type NFeEmitResult,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE, IE_SENTINELA, TIPO_CLIENTE } from '@delfrance/schemas';

import { ID_DEST, IND_IE_DEST } from '@/lib/nfe/destinatarioNFe';
import type { CarregarContextoRejeicao, ContextoRejeicaoNFe } from '@/lib/nfe/errors';

const h = vi.hoisted(() => {
  const loader = vi.fn<CarregarContextoRejeicao>();
  return {
    db: { sentinel: 'firestore' },
    loader,
    carregador: vi.fn((_db: unknown) => loader),
    showError: vi.fn(),
    showCopyable: vi.fn(),
  };
});

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => h.db }));
vi.mock('@/lib/nfe/contextoRejeicao', () => ({ carregadorContextoRejeicao: h.carregador }));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: h.showError,
  showCopyableNotification: h.showCopyable,
}));

import { emitirNFeComNotificacao } from './emitirNFeComNotificacao';

const XMOTIVO_805 =
  'Rejeição: A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição Estadual';

const CONTEXTO_805_INTERNA: ContextoRejeicaoNFe = {
  destinatario: { idDest: ID_DEST.interna, indIEDest: IND_IE_DEST.isento, uf: 'SP' },
  cliente: {
    id: 'cli-805',
    cadastro: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: IE_SENTINELA.isento },
  },
};

function clientWith(emitir: NFeHttpClient['emitir']): NFeHttpClient {
  return { emitir } as unknown as NFeHttpClient;
}

beforeEach(() => {
  h.loader.mockReset();
  h.carregador.mockClear();
  h.showError.mockClear();
  h.showCopyable.mockClear();
});

describe('emitirNFeComNotificacao', () => {
  it('no client → the "não está logado" toast, no emission and no read', async () => {
    await emitirNFeComNotificacao(null, 'ped-1');
    expect(h.showError).toHaveBeenCalledWith({
      title: 'Você não está logado',
      message: 'Faça login para emitir NF-e.',
    });
    expect(h.loader).not.toHaveBeenCalled();
  });

  it('success → the copyable result toast, and the loader never runs', async () => {
    const result: NFeEmitResult = {
      nfeId: 'nfev4-1',
      pedidoId: 'ped-1',
      estado: ESTADO_NFE.aprovada,
      chave: '35260514200166000187550010000000071000000018',
      nRec: '12345',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
    };
    await emitirNFeComNotificacao(clientWith(vi.fn().mockResolvedValue(result)), 'ped-1');
    expect(h.showCopyable).toHaveBeenCalledOnce();
    expect(h.showCopyable.mock.calls[0]![0]).toMatchObject({ title: 'NF-e autorizada' });
    expect(h.loader).not.toHaveBeenCalled();
    expect(h.showError).not.toHaveBeenCalled();
  });

  it('a thrown 226 → the generic rejection toast, no read', async () => {
    const emitir = vi
      .fn()
      .mockRejectedValue(
        new NFeRejectedError('226', 'UF inválida', { pedidoId: 'ped-1', nfeId: 'nfev4-1' }),
      );
    await emitirNFeComNotificacao(clientWith(emitir), 'ped-1');
    expect(h.showError).toHaveBeenCalledWith({
      title: 'SEFAZ rejeitou a NF-e',
      message: 'cStat=226: UF inválida',
      color: 'red',
    });
    expect(h.loader).not.toHaveBeenCalled();
  });

  it('a thrown 805 → the loader bound to the app db runs; the toast carries the guidance + cadastro link', async () => {
    h.loader.mockResolvedValue(CONTEXTO_805_INTERNA);
    const emitir = vi.fn().mockRejectedValue(
      new NFeRejectedError('805', XMOTIVO_805, {
        pedidoId: 'ped-1',
        nfeId: 'nfev4-805',
        estado: ESTADO_NFE.rejeitada,
      }),
    );

    await emitirNFeComNotificacao(clientWith(emitir), 'ped-1');

    expect(h.carregador).toHaveBeenCalledOnce();
    expect(h.carregador.mock.calls[0]![0]).toBe(h.db);
    expect(h.loader).toHaveBeenCalledOnce();
    expect(h.loader).toHaveBeenCalledWith({ pedidoId: 'ped-1', nfeId: 'nfev4-805' });
    expect(h.showError).toHaveBeenCalledOnce();
    expect(h.showError.mock.calls[0]![0]).toMatchObject({
      title: 'Inscrição estadual do cliente recusada pela SEFAZ',
      color: 'red',
      link: { href: '/clientes/cli-805', label: 'Abrir cadastro de ACME LTDA' },
    });
  });

  it('a non-Error throw is rethrown, with no toast and no read', async () => {
    const emitir = vi.fn().mockRejectedValue('not an Error');
    await expect(emitirNFeComNotificacao(clientWith(emitir), 'ped-1')).rejects.toBe('not an Error');
    expect(h.showError).not.toHaveBeenCalled();
    expect(h.loader).not.toHaveBeenCalled();
  });
});
