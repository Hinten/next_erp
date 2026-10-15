import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { CRT, CSOSN, ORIGEM } from '@delfrance/schemas';
import type { FieldRenderProps } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { operacaoStaticFields } from './operacaoFields';

/**
 * The operação's "Impostos (padrão)" tab edits only the `configuracao*` keys,
 * but the engine's tier gate reads the WHOLE operação doc (`origem` lives on
 * the Dados gerais tab). The tab must feed the editor's problems from the whole
 * form, or it would warn about — or stay silent on — the wrong doc (#1655).
 */
/** Called on every render of the whole form (ObjectView's stand-in). */
const renderizouOForm = vi.fn();

/**
 * The form ROOT, as ObjectView holds it (`mode: 'onBlur'`), with two plain
 * inputs standing in for the Dados gerais tab's fields.
 */
function Host({ values, children }: { values: Record<string, unknown>; children: ReactNode }) {
  renderizouOForm();
  const form = useForm({ defaultValues: values, mode: 'onBlur' });
  return (
    <MantineTestProvider>
      <FormProvider {...form}>
        <input aria-label="Nome (Dados gerais)" {...form.register('nome')} />
        <select
          aria-label="Origem padrão (Dados gerais)"
          {...form.register('origem', { setValueAs: (v: string) => (v === '' ? null : v) })}
        >
          <option value="">—</option>
          <option value={ORIGEM.nacional}>Nacional</option>
        </select>
        {children}
      </FormProvider>
    </MantineTestProvider>
  );
}

function renderImpostoTab(values: Record<string, unknown>) {
  const renderInput = operacaoStaticFields.configuracaoICMS?.renderInput;
  if (!renderInput) throw new Error('configuracaoICMS has no renderInput');
  render(<Host values={values}>{renderInput({} as FieldRenderProps)}</Host>);
}

const PARCIAL_500 = {
  crt: CRT.simplesNacional,
  csosn: CSOSN.icmsCobradoAnteriormente,
  csosn500: { pST: 20 },
};
const TITULO = 'A NF-e recusaria esta configuração';

describe('operação Impostos (padrão) tab — the editor problems (#1655)', () => {
  it('shows the Alert when the operação (origem included) is a tier the engine would refuse', () => {
    renderImpostoTab({ nome: 'Venda', origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_500 });
    expect(screen.getByText(TITULO)).toBeTruthy();
    expect(screen.getByLabelText('vBCSTRet (R$)').getAttribute('aria-invalid')).toBe('true');
  });

  it('stays silent when the operação has no Origem padrão (the engine never reads it)', () => {
    renderImpostoTab({ nome: 'Venda', origem: null, configuracaoICMS: PARCIAL_500 });
    expect(screen.queryByText(TITULO)).toBeNull();
  });

  it('follows an Origem padrão edit made on the Dados gerais tab, both ways', () => {
    renderImpostoTab({ nome: 'Venda', origem: null, configuracaoICMS: PARCIAL_500 });
    const origem = screen.getByLabelText('Origem padrão (Dados gerais)');

    fireEvent.change(origem, { target: { value: ORIGEM.nacional } });
    expect(screen.getByText(TITULO)).toBeTruthy();

    fireEvent.change(origem, { target: { value: '' } });
    expect(screen.queryByText(TITULO)).toBeNull();
  });

  it('typing in another operação field re-renders the editor, never the whole form', () => {
    // The editor needs the WHOLE operação, but a bare `watch()` would get it by
    // flipping RHF's form-wide `watchAll`: every keystroke in ANY field would
    // then re-render the form root (ObjectView), not just this editor.
    renderImpostoTab({ nome: 'Venda', origem: ORIGEM.nacional, configuracaoICMS: PARCIAL_500 });
    const nome = screen.getByLabelText('Nome (Dados gerais)');
    fireEvent.change(nome, { target: { value: 'Venda 1' } });
    const antes = renderizouOForm.mock.calls.length;

    fireEvent.change(nome, { target: { value: 'Venda 12' } });
    fireEvent.change(nome, { target: { value: 'Venda 123' } });
    fireEvent.change(nome, { target: { value: 'Venda 1234' } });

    expect(renderizouOForm).toHaveBeenCalledTimes(antes);
    expect(screen.getByText(TITULO)).toBeTruthy();
  });
});
