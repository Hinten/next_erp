import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { conversaSchema, ORIGEM_CONVERSA } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ConversaSidePanel } from './ConversaSidePanel';

vi.mock('../_hooks/useAutorNome', () => ({ useAutorNome: () => 'Atendente' }));
vi.mock('../_hooks/useClienteLink', () => ({
  useClienteLink: () => ({ status: 'found', clienteId: 'c1', nome: 'Cliente' }),
}));
afterEach(cleanup);
const base = conversaSchema.parse({
  origem: ORIGEM_CONVERSA.whatsapp,
  externalLink: 'https://wa.me/5511999998888',
});
const destination = {
  tipo: 'telefone',
  valor: '5511999998888',
  identidadeId: 'i1',
  revision: 1,
  ultimaMensagemEm: 1,
} as const;
function panel(conversa: ReturnType<typeof conversaSchema.parse>) {
  return (
    <MantineTestProvider>
      <ConversaSidePanel conversa={conversa} />
    </MantineTestProvider>
  );
}

describe('WhatsApp external profile follows the resolved destination', () => {
  it('changes the link when the destination changes even if externalLink is stale', () => {
    const { rerender } = render(panel({ ...base, whatsappDestino: destination }));
    expect(screen.getByText('WhatsApp: +55 (11) 99999-8888')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir perfil externo' }).getAttribute('href')).toBe(
      'https://wa.me/5511999998888',
    );
    rerender(
      panel({
        ...base,
        whatsappDestino: { ...destination, valor: '14155552671', identidadeId: 'i2', revision: 2 },
      }),
    );
    expect(screen.getByRole('link', { name: 'Abrir perfil externo' }).getAttribute('href')).toBe(
      'https://wa.me/14155552671',
    );
    expect(screen.getByText('WhatsApp: +14155552671')).toBeTruthy();
  });
  it('removes the phone link after a BSUID-only identity takes over', () => {
    const { rerender } = render(panel({ ...base, whatsappDestino: destination }));
    rerender(
      panel({
        ...base,
        whatsappDestino: {
          ...destination,
          tipo: 'bsuid',
          valor: 'business-scope-id',
          identidadeId: 'i2',
          revision: 2,
        },
      }),
    );
    expect(screen.queryByRole('link', { name: 'Abrir perfil externo' })).toBeNull();
    expect(screen.getByText('WhatsApp com telefone não informado')).toBeTruthy();
  });
  it('does not fall back to a stale legacy link when the destination is absent', () => {
    render(panel(base));
    expect(screen.queryByRole('link', { name: 'Abrir perfil externo' })).toBeNull();
  });
  it('preserves valid external profile links on other channels', () => {
    render(
      panel({
        ...base,
        origem: ORIGEM_CONVERSA.site,
        externalLink: 'https://example.com/customer',
      }),
    );
    expect(screen.getByRole('link', { name: 'Abrir perfil externo' }).getAttribute('href')).toBe(
      'https://example.com/customer',
    );
  });
});
