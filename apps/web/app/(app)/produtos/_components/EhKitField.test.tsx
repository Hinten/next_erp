import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { EhKitField, type EhKitFieldProps, type ReferencingKit } from './EhKitField';

const kits: ReferencingKit[] = [{ id: 'k1', nome: 'Kit Verão' }];

function renderField(over: Partial<EhKitFieldProps> = {}) {
  const onChange = vi.fn();
  render(
    <MantineTestProvider>
      <EhKitField label="É kit" value={false} onChange={onChange} referencedByKits={[]} {...over} />
    </MantineTestProvider>,
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

  it('disables the toggle while the referenced-by query is still loading', () => {
    // A disabled input can't be clicked in a real browser, so it can't bypass the
    // warning during the initial load (jsdom still dispatches synthetic events on
    // disabled inputs, so we assert the disabled state rather than the click).
    renderField({ referencedByKits: [], loading: true });
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
  });

  it('flags overflow (+ outros kits) when more kits reference it than are shown', () => {
    renderField({ value: true, referencedByKits: kits, hasMore: true });
    expect(screen.getByText('… e outros kits')).toBeTruthy();
  });
});
