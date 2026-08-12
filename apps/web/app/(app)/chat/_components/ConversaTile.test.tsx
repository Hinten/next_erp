import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import {
  ORIGEM_CONVERSA,
  TIPO_MENSAGEM,
  ESTADO_ENVIO,
  type Conversa,
  type Mensagem,
} from '@delfrance/schemas';

// Hoisted, mutable refs so each test can set the last message + draft state
// before rendering. Mirrors the MensagemThread.test.tsx hoisted-mock pattern.
const { lastMsgRef, draftRef } = vi.hoisted(() => ({
  lastMsgRef: {
    current: { data: null as Mensagem | null | undefined, loading: false },
  },
  draftRef: { current: false },
}));

// Render next/link as a plain anchor (no App Router context in the test).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../_hooks/useLastMensagem', () => ({
  useLastMensagem: () => lastMsgRef.current,
}));

vi.mock('@/lib/chat/draft', () => ({
  hasDraft: () => draftRef.current,
}));

import { ConversaTile } from './ConversaTile';

function mensagem(partial: Partial<Mensagem>): Mensagem {
  return {
    estadoEnvio: ESTADO_ENVIO.recebido,
    tipo: TIPO_MENSAGEM.comum,
    conteudo: null,
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
    timestamp: Date.parse('2026-07-15T12:00:00.000Z'),
    ...partial,
  } as Mensagem;
}

function conversa(partial: Partial<Conversa> = {}): Conversa {
  return {
    id: null,
    sender_id: null,
    estadoConversa: 1,
    origem: ORIGEM_CONVERSA.whatsapp,
    usarioOuterRef: null,
    integracaoOuterRef: null,
    pedidoOuterRef: null,
    incidenteOuterRef: null,
    produtoOuterRef: null,
    usuarios: null,
    data_cadastro: null,
    ultima_modificacao: Date.parse('2026-07-15T12:00:00.000Z'),
    ultimaModificacaoIntegracao: null,
    prazo_resposta: null,
    recebido_fora_atendimento: null,
    recebido_durante_atendimento: null,
    nome: 'Ana Cliente',
    urlAvatar: '',
    cor_etiqueta: null,
    atendido: false,
    externalLink: null,
    internalLink: null,
    versao: null,
    mensagensIdMap: null,
    mensagensId: null,
    ...partial,
  };
}

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

afterEach(() => {
  lastMsgRef.current = { data: null, loading: false };
  draftRef.current = false;
  vi.clearAllMocks();
});

describe('ConversaTile', () => {
  it('renders the name and the last-message preview', () => {
    lastMsgRef.current = {
      data: mensagem({ conteudo: 'oi da cliente', user_id: 'cli' }),
      loading: false,
    };
    wrap(
      <ConversaTile id="c1" conversa={conversa()} active={false} href="/chat/c1" meuUid="op1" />,
    );
    expect(screen.getByText('Ana Cliente')).toBeTruthy();
    expect(screen.getByText('oi da cliente')).toBeTruthy();
  });

  it('applies the etiqueta tint background to the row', () => {
    wrap(
      <ConversaTile
        id="c1"
        conversa={conversa({ cor_etiqueta: 0xfff44336 })}
        active={false}
        href="/chat/c1"
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('style')).toContain('244, 67, 54');
  });

  it('shows the draft indicator when a saved draft exists', () => {
    draftRef.current = true;
    wrap(<ConversaTile id="c1" conversa={conversa()} active={false} href="/chat/c1" />);
    expect(screen.getByLabelText('Rascunho')).toBeTruthy();
  });

  it('shows a delivery tick for an outbound message, none for an inbound one', () => {
    lastMsgRef.current = {
      data: mensagem({ conteudo: 'ok', user_id: 'op1', estadoEnvio: ESTADO_ENVIO.enviado }),
      loading: false,
    };
    const { rerender } = wrap(
      <ConversaTile id="c1" conversa={conversa()} active={false} href="/chat/c1" meuUid="op1" />,
    );
    expect(screen.getByLabelText('Enviado')).toBeTruthy();

    // A customer inbound (recebido) gets no tick.
    lastMsgRef.current = {
      data: mensagem({ conteudo: 'oi', user_id: 'cli', estadoEnvio: ESTADO_ENVIO.recebido }),
      loading: false,
    };
    rerender(
      <MantineProvider env="test">
        <ConversaTile id="c1" conversa={conversa()} active={false} href="/chat/c1" meuUid="op1" />
      </MantineProvider>,
    );
    expect(screen.queryByLabelText('Enviado')).toBeNull();
    expect(screen.queryByLabelText('Erro no envio')).toBeNull();
  });

  it('marks the active row with aria-current', () => {
    wrap(<ConversaTile id="c1" conversa={conversa()} active href="/chat/c1?tab=todas" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-current')).toBe('true');
    expect(link.getAttribute('href')).toBe('/chat/c1?tab=todas');
  });

  it('exposes a bulk-selection checkbox when selectable', () => {
    const onToggle = vi.fn();
    wrap(
      <ConversaTile
        id="c1"
        conversa={conversa()}
        active={false}
        href="/chat/c1"
        selectable
        selected={false}
        onToggleSelect={onToggle}
      />,
    );
    const checkbox = screen.getByLabelText('Selecionar Ana Cliente');
    checkbox.click();
    expect(onToggle).toHaveBeenCalledWith('c1');
  });
});
