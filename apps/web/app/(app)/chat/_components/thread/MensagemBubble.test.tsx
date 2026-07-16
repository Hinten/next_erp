import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ESTADO_ENVIO, type Mensagem } from '@delfrance/schemas';
import type { ServerMensagem } from '../../_hooks/useMensagensWindow';

// Author-name lookup is a network hook — stub it so bubbles render synchronously.
vi.mock('../../_hooks/useAutorNome', () => ({ useAutorNome: () => 'Fulano' }));
// Media resolves an arquivo over the network — not under test here.
vi.mock('../../_hooks/useArquivo', () => ({
  useArquivo: () => ({ arquivo: undefined, loading: false }),
}));

import { MensagemBubble } from './MensagemBubble';

function base(id: string, partial: Partial<Mensagem>): ServerMensagem {
  return {
    _id: id,
    estadoEnvio: ESTADO_ENVIO.recebido,
    tipo: 'c',
    conteudo: 'corpo',
    resposta: null,
    canal: 0,
    usarioMensagemOuterRef: null,
    user_id: null,
    urlAvatar: null,
    mid: null,
    midGroup: null,
    error: null,
    visualizado: null,
    transcription: null,
    anexo: null,
    anexo_url: null,
    timestamp: Date.parse('2026-07-16T12:00:00.000Z'),
    ...partial,
  } as ServerMensagem;
}

function renderBubble(
  m: ServerMensagem,
  opts?: {
    myUid?: string;
    customerUid?: string | null;
    searchRegex?: RegExp | null;
    searchActive?: boolean;
  },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">
        <MensagemBubble
          mensagem={m}
          myUid={opts?.myUid ?? 'me'}
          customerUid={opts?.customerUid ?? 'cust'}
          isHtml={false}
          searchRegex={opts?.searchRegex ?? null}
          searchActive={opts?.searchActive ?? false}
          registerRef={() => {}}
        />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe('MensagemBubble', () => {
  it('renders an event (tipo e) as a centered line without a status icon', () => {
    renderBubble(base('e1', { tipo: 'e', conteudo: 'Nova conversa iniciada' }));
    expect(screen.getByText(/Nova conversa iniciada/)).toBeTruthy();
    expect(screen.queryByLabelText('Salva')).toBeNull();
  });

  it('renders an error (tipo !) line', () => {
    renderBubble(base('x1', { tipo: '!', conteudo: 'Falha no envio' }));
    expect(screen.getByText(/Falha no envio/)).toBeTruthy();
  });

  it('highlights a search match inside a tipo ! error line', () => {
    renderBubble(base('x2', { tipo: '!', conteudo: 'Falha no envio' }), {
      searchRegex: /Falha/giu,
      searchActive: true,
    });
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.textContent).toBe('Falha');
  });

  it('shows a status icon for my own (outbound) message', () => {
    renderBubble(base('m1', { user_id: 'me', estadoEnvio: ESTADO_ENVIO.enviado, conteudo: 'oi' }), {
      myUid: 'me',
    });
    expect(screen.getByLabelText('Enviado')).toBeTruthy();
  });

  it('does not show a status icon for a customer (inbound) message', () => {
    renderBubble(
      base('m2', { user_id: 'cust', estadoEnvio: ESTADO_ENVIO.recebido, conteudo: 'oi' }),
      { myUid: 'me', customerUid: 'cust' },
    );
    // Inbound bubbles carry no delivery ticks.
    expect(screen.queryByLabelText('Recebido')).toBeNull();
    expect(screen.queryByLabelText('Enviado')).toBeNull();
  });

  it('shows the author label for another attendant', () => {
    renderBubble(base('m3', { user_id: 'other-agent', estadoEnvio: ESTADO_ENVIO.enviado }), {
      myUid: 'me',
      customerUid: 'cust',
    });
    expect(screen.getByText('Fulano')).toBeTruthy();
  });

  it('renders the erro status icon with the error tooltip source', () => {
    renderBubble(
      base('m4', {
        user_id: 'me',
        estadoEnvio: ESTADO_ENVIO.erro,
        error: 'Token inválido',
        conteudo: 'oi',
      }),
      { myUid: 'me' },
    );
    expect(screen.getByLabelText('Erro no envio')).toBeTruthy();
  });

  it('shows a read-receipt (visualizado) second check', () => {
    renderBubble(
      base('m5', {
        user_id: 'me',
        estadoEnvio: ESTADO_ENVIO.enviado,
        visualizado: Date.parse('2026-07-16T09:00:00.000Z'),
      }),
      { myUid: 'me' },
    );
    expect(screen.getByLabelText('Visualizado')).toBeTruthy();
  });

  it('renders a forwarded indicator', () => {
    renderBubble(
      base('m6', { user_id: 'cust', context: { forwarded: true }, conteudo: 'encaminhei' }),
      { myUid: 'me', customerUid: 'cust' },
    );
    expect(screen.getByText('Encaminhada')).toBeTruthy();
  });
});
