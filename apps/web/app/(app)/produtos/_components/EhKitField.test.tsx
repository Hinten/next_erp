import { useState } from 'react';
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

/** The pt-BR notice, VERBATIM from the step-19 seam (reconcile §2.10). */
const TITULO_KIT_NATIVO = 'Este kit é um kit nativo da Shopee';
const TEXTO_KIT_NATIVO =
  'A Shopee não permite alterar os componentes nem as quantidades de um kit já criado. Se você ' +
  'mudar a composição aqui, o kit na Shopee continua com a receita antiga e o estoque que ela ' +
  'calcula pode ficar errado. Depois de salvar, um aviso fica aberto até o kit ser recriado ou a ' +
  'composição voltar à que está na Shopee.';

describe('EhKitField — Shopee native-kit notice (step 19, #1527, L4(1))', () => {
  const aviso = () => screen.queryByTestId('aviso-kit-nativo-shopee');

  it('shows the verbatim notice while the produto is a kit with an active native Shopee kit', () => {
    renderField({ value: true, kitNativoShopee: true });
    const alerta = aviso();
    expect(alerta).not.toBeNull();
    expect(alerta!.textContent).toContain(TITULO_KIT_NATIVO);
    // JSX folds the source line breaks into single spaces — the rendered text is the sentence.
    expect(alerta!.textContent!.replace(TITULO_KIT_NATIVO, '').replace(/\s+/g, ' ').trim()).toBe(
      TEXTO_KIT_NATIVO,
    );
  });

  it.each([true, false])(
    'is hidden without an active native kit, whatever «É kit» says (switch %s)',
    (value) => {
      renderField({ value, kitNativoShopee: false });
      expect(aviso()).toBeNull();
    },
  );

  it('is hidden when the prop is absent (the novo page never passes it)', () => {
    renderField({ value: true });
    expect(aviso()).toBeNull();
  });

  it('shows while the switch reads NOT a kit — the link is the authority, not the form', () => {
    renderField({ value: false, kitNativoShopee: true });
    expect(aviso()).not.toBeNull();
  });

  /**
   * The form owns `value`; this harness feeds `onChange` back into it the way
   * ObjectView's controller does, so a click really flips the switch.
   */
  function ToggleHarness({ kitNativoShopee }: { kitNativoShopee: boolean }) {
    const [value, setValue] = useState(true);
    return (
      <EhKitField
        label="É kit"
        value={value}
        onChange={setValue}
        referencedByKits={[]}
        kitNativoShopee={kitNativoShopee}
      />
    );
  }

  const renderToggle = (kitNativoShopee: boolean) =>
    render(
      <MantineTestProvider>
        <ToggleHarness kitNativoShopee={kitNativoShopee} />
      </MantineTestProvider>,
    );

  it('STAYS up when the operator toggles «É kit» OFF on a native kit (R2-F4)', () => {
    // Un-kitting saves `componentesKit: null` — the most destructive recipe
    // change — so this is exactly when the pre-save notice must not vanish.
    renderToggle(true);
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(aviso()).not.toBeNull();
    fireEvent.click(toggle);
    // Non-vacuous: the switch really went off before we look at the notice.
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    expect(aviso()).not.toBeNull();
  });

  it('near-miss: toggling «É kit» OFF without a native kit shows no notice', () => {
    renderToggle(false);
    fireEvent.click(screen.getByRole('switch'));
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    expect(aviso()).toBeNull();
  });

  it('is NON-BLOCKING: the toggle stays enabled and turning the kit off applies at once', () => {
    const { onChange } = renderField({ value: true, kitNativoShopee: true });
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText('Tornar este produto um kit?')).toBeNull();
  });

  it('coexists with the kit-of-kit alert (two independent warnings)', () => {
    renderField({ value: true, kitNativoShopee: true, referencedByKits: kits });
    expect(aviso()).not.toBeNull();
    expect(screen.getByText('Este produto é componente de outros kits')).toBeTruthy();
  });
});
