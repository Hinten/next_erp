import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import type { MercadoLivreMedidasSugestao } from '@/lib/mercado-livre/client';
import type { ChartColumn } from '@/lib/mercado-livre/chartSpec';
import { SizeChartAiModal } from './SizeChartAiModal';

const columns: ChartColumn[] = [
  {
    key: 'CHEST',
    label: 'Contorno do peito',
    hint: null,
    required: false,
    mainCandidate: false,
    unit: { default: 'cm', options: [] },
    connector: null,
    parts: [{ attributeId: 'CHEST', label: 'de', kind: 'number', values: [] }],
  },
];

function resultado(over: Partial<MercadoLivreMedidasSugestao> = {}): MercadoLivreMedidasSugestao {
  return {
    sugestoes: [],
    celulas: 20,
    contexto: { fotos: 0, anexadas: 0, descricao: false, codigo: false, referencia: false },
    truncado: false,
    ...over,
  };
}

function show(r: MercadoLivreMedidasSugestao) {
  render(
    // ⚠️ `env="test"` disables Mantine's transitions. Without it the `Modal`'s
    // `Transition` leaves a timer running past the test, and the callback fires
    // after jsdom has torn `window` down — an "every test passed, one error"
    // failure that names an innocent bystander file.
    <MantineTestProvider>
      <SizeChartAiModal
        opened
        onClose={vi.fn()}
        resultado={r}
        rows={[]}
        columns={columns}
        mainAttributeId="SIZE"
        onApply={vi.fn()}
      />
    </MantineTestProvider>,
  );
}

describe('SizeChartAiModal — what the model was actually given', () => {
  it('tells an operator with NO photo to upload one', () => {
    show(resultado());
    expect(screen.getByText('Sem foto da tabela')).not.toBeNull();
    expect(screen.getByText(/Envie a foto da tabela/)).not.toBeNull();
  });

  it('tells an operator whose photo is not readable YET to wait, not to re-upload', () => {
    // ⚠️ The bug this pins. A tabela whose photo has no readable copy yet used
    // to get "Envie a foto da tabela… na aba Fotos" — telling the operator to
    // redo the upload they are looking at on screen. Nothing they can do fixes
    // it; the derivative simply has not been generated.
    show(
      resultado({
        contexto: { fotos: 0, anexadas: 1, descricao: true, codigo: false, referencia: false },
      }),
    );
    expect(screen.getByText('Não foi possível ler a foto')).not.toBeNull();
    expect(screen.queryByText('Sem foto da tabela')).toBeNull();
    expect(screen.queryByText(/Envie a foto da tabela/)).toBeNull();
  });

  it('offers a way out for the causes that are PERMANENT, not just "wait"', () => {
    // ⚠️ "Not processed yet" is only one reason a photo that exists cannot be
    // read: a format outside the allowlist, a file over the size ceiling and a
    // batch over the request budget are all permanent. An alert that says only
    // "aguarde" leaves that operator retrying forever.
    show(
      resultado({
        contexto: { fotos: 0, anexadas: 1, descricao: false, codigo: false, referencia: false },
      }),
    );
    const alerta = screen.getByText(/o modelo usou apenas o texto/).textContent ?? '';
    expect(alerta).toMatch(/aguarde/i);
    expect(alerta).toMatch(/menor ou em JPEG/);
  });

  it('raises NEITHER alert once a photo has been read', () => {
    show(
      resultado({
        contexto: { fotos: 2, anexadas: 2, descricao: false, codigo: false, referencia: false },
      }),
    );
    expect(screen.queryByText('Sem foto da tabela')).toBeNull();
    expect(screen.queryByText('A foto ainda não foi processada')).toBeNull();
  });

  it('lists every source that reached the model, so the ANSWER can be judged', () => {
    show(
      resultado({
        contexto: { fotos: 2, anexadas: 3, descricao: true, codigo: true, referencia: true },
      }),
    );
    const fonte = screen.getByTestId('ml-size-chart-ai-fonte').textContent ?? '';
    expect(fonte).toContain('2 fotos');
    expect(fonte).toContain('descrição');
    expect(fonte).toContain('código');
    expect(fonte).toContain('1 guia de referência');
    expect(fonte).toContain('20 células');
  });

  it('says so plainly when the model was given nothing at all', () => {
    show(resultado());
    expect(screen.getByTestId('ml-size-chart-ai-fonte').textContent).toMatch(
      /nenhum contexto disponível/,
    );
  });
});
