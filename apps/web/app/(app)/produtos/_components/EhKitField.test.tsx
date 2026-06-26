import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { EhKitField, type EhKitFieldProps, type ReferencingKit } from './EhKitField';

const kits: ReferencingKit[] = [{ id: 'k1', nome: 'Kit Verão' }];

function renderField(over: Partial<EhKitFieldProps> = {}) {
  const onChange = vi.fn();
  render(
    <MantineProvider>
      <EhKitField label="É kit" value={false} onChange={onChange} referencedByKits={[]} {...over} />
    </MantineProvider>,
  );
  return { onChange };
}

describe('EhKitField (#246 kit promotion warning)', () => {
  it('promotes directly when the produto is not referenced by other kits', () => {
    const { onChange } = renderField({ referencedByKits: [] });
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('asks for confirmation (and lists the kits) before promoting a referenced produto', async () => {
    const { onChange } = renderField({ referencedByKits: kits });
    fireEvent.click(screen.getByRole('switch'));
    // Not applied yet — the confirm modal is shown instead.
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByText('Tornar este produto um kit?')).toBeTruthy();
    expect(screen.getByText('Kit Verão')).toBeTruthy();
    fireEvent.click(screen.getByText('Prosseguir mesmo assim'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not promote when the confirmation is cancelled', async () => {
    const { onChange } = renderField({ referencedByKits: kits });
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(await screen.findByText('Cancelar'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a persistent alert while it is a kit AND still referenced', () => {
    renderField({ value: true, referencedByKits: kits });
    expect(screen.getByText('Este produto é componente de outros kits')).toBeTruthy();
  });
});
