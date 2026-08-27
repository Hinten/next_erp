import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ESTADO_ENVIO,
  ORIGEM_CONVERSA,
  TIPO_MENSAGEM,
  type Mensagem,
  type OrigemConversa,
} from '@delfrance/schemas';
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
    tipo: TIPO_MENSAGEM.comum,
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
    origem?: OrigemConversa;
    searchRegex?: RegExp | null;
    searchActive?: boolean;
  },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MantineTestProvider>
        <MensagemBubble
          mensagem={m}
          myUid={opts?.myUid ?? 'me'}
          customerUid={opts?.customerUid ?? 'cust'}
          origem={opts?.origem ?? ORIGEM_CONVERSA.mercadoLivrePedido}
          isHtml={false}
          searchRegex={opts?.searchRegex ?? null}
          searchActive={opts?.searchActive ?? false}
          registerRef={() => {}}
        />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}

/** Which side the bubble landed on. `null` for the centered event/error lines. */
function side(container: HTMLElement): string | null {
  return container.querySelector('[data-side]')?.getAttribute('data-side') ?? null;
}

describe('MensagemBubble — which side the bubble lands on', () => {
  // ⚠️ This block exists because there was NO alignment assertion in this file,
  // and every case supplied an explicit `user_id`. The shape every marketplace
  // message actually has — `user_id: null` — was untested, and `mine` was
  // computed from `user_id` alone, so every ML reply we sent rendered on the
  // customer's side, grey and without a tick. See #1320 / conversa.ts.

  it('AUTHORLESS + enviado is OURS — the ML reply shape', () => {
    const { container } = renderBubble(
      base('ml1', { user_id: null, estadoEnvio: ESTADO_ENVIO.enviado, conteudo: 'oi' }),
      { myUid: 'me', customerUid: null },
    );
    expect(side(container)).toBe('saida');
    // The tick rides the same flag, so a wrong side also loses the receipt.
    expect(screen.getByLabelText('Enviado')).toBeTruthy();
  });

  it.each([
    ['salva (the provisional bubble / a WhatsApp auto-reply)', ESTADO_ENVIO.salva],
    ['enviando', ESTADO_ENVIO.enviando],
    ['erro (a reply ML rejected — ours, never delivered)', ESTADO_ENVIO.erro],
  ])('AUTHORLESS + %s is OURS too', (_label, estadoEnvio) => {
    const { container } = renderBubble(base('ml2', { user_id: null, estadoEnvio }), {
      myUid: 'me',
      customerUid: null,
    });
    expect(side(container)).toBe('saida');
  });

  it('AUTHORLESS + recebido is the CONTACT — the buyer message shape', () => {
    const { container } = renderBubble(
      base('ml3', { user_id: null, estadoEnvio: ESTADO_ENVIO.recebido, conteudo: 'oi' }),
      { myUid: 'me', customerUid: null },
    );
    expect(side(container)).toBe('entrada');
    expect(screen.queryByLabelText('Enviado')).toBeNull();
  });

  it.each([
    ['excluido', ESTADO_ENVIO.excluido],
    ['banida', ESTADO_ENVIO.banida],
    ['desconhecido', ESTADO_ENVIO.desconhecido],
  ])(
    'AUTHORLESS + %s stays on the contact side — ambiguous, so the safe way',
    (_l, estadoEnvio) => {
      // Showing someone else's message as ours is a misattribution an operator
      // cannot detect; the reverse is obvious.
      const { container } = renderBubble(base('ml4', { user_id: null, estadoEnvio }), {
        myUid: 'me',
        customerUid: null,
      });
      expect(side(container)).toBe('entrada');
    },
  );

  it('an AUTHOR still wins — my own uid is ours', () => {
    const { container } = renderBubble(
      base('w1', { user_id: 'me', estadoEnvio: ESTADO_ENVIO.salva }),
      { myUid: 'me' },
    );
    expect(side(container)).toBe('saida');
  });

  it('⚠️ another attendant stays on the LEFT with their name — WhatsApp is untouched', () => {
    // The mutation pair for the first case: an implementation that ignores the
    // "no author" guard and keys on the state alone moves this to the right.
    const { container } = renderBubble(
      base('w2', { user_id: 'other-agent', estadoEnvio: ESTADO_ENVIO.enviado }),
      { myUid: 'me', customerUid: 'cust' },
    );
    expect(side(container)).toBe('entrada');
    expect(screen.getByText('Fulano')).toBeTruthy();
  });

  it('the customer usuario is the contact side', () => {
    const { container } = renderBubble(
      base('w3', { user_id: 'cust', estadoEnvio: ESTADO_ENVIO.recebido }),
      { myUid: 'me', customerUid: 'cust' },
    );
    expect(side(container)).toBe('entrada');
  });

  it.each([
    ['READ — processStatus writes estadoEnvio: recebido', ESTADO_ENVIO.recebido],
    ['DELETED — processStatus writes estadoEnvio: excluido', ESTADO_ENVIO.excluido],
  ])(
    '⚠️ a WhatsApp auto-reply stays OURS after %s',
    (_label, estadoEnvio: (typeof ESTADO_ENVIO)[keyof typeof ESTADO_ENVIO]) => {
      // `recebido` is overloaded: on a marketplace thread it means the contact
      // sent this, but WhatsApp's status pipeline writes it onto OUR OWN message
      // when the customer reads it. A state-only rule made the authorless
      // auto-reply jump to the customer's side the instant the receipt landed.
      const { container } = renderBubble(
        base('wa1', { user_id: null, estadoEnvio, visualizado: Date.now() }),
        { myUid: 'me', customerUid: null, origem: ORIGEM_CONVERSA.whatsapp },
      );
      expect(side(container)).toBe('saida');
    },
  );

  it('an optimistic row is ours before anything is written', () => {
    const otimista = {
      ...base('o1', { user_id: null, estadoEnvio: ESTADO_ENVIO.enviando }),
      _optimistic: true,
    } as unknown as ServerMensagem;
    const { container } = renderBubble(otimista, { myUid: 'me', customerUid: null });
    expect(side(container)).toBe('saida');
  });
});

describe('MensagemBubble', () => {
  it('renders an event (tipo e) as a centered line without a status icon', () => {
    renderBubble(base('e1', { tipo: TIPO_MENSAGEM.evento, conteudo: 'Nova conversa iniciada' }));
    expect(screen.getByText(/Nova conversa iniciada/)).toBeTruthy();
    expect(screen.queryByLabelText('Salva')).toBeNull();
  });

  it('renders an error (tipo !) line', () => {
    renderBubble(base('x1', { tipo: TIPO_MENSAGEM.erro, conteudo: 'Falha no envio' }));
    expect(screen.getByText(/Falha no envio/)).toBeTruthy();
  });

  it('highlights a search match inside a tipo ! error line', () => {
    renderBubble(base('x2', { tipo: TIPO_MENSAGEM.erro, conteudo: 'Falha no envio' }), {
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
