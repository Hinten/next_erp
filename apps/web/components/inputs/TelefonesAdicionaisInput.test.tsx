import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  TelefonesAdicionaisInput,
  prepareForSaveTelefonesAdicionais,
} from './TelefonesAdicionaisInput';
import { DELETE_MARK } from '@delfrance/ui';
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form';
import { ClienteTelefoneField, TelefoneTextInput, prepareForSaveTelefone } from './TelefoneInput';

afterEach(cleanup);

function Editor() {
  const [value, setValue] = useState<unknown>(['14155552671', '5511999998888']);
  return (
    <>
      <TelefonesAdicionaisInput value={value} onChange={setValue} />
      <output>{JSON.stringify(prepareForSaveTelefonesAdicionais(value))}</output>
    </>
  );
}

describe('telefones adicionais', () => {
  it('stages removal, preserves the row, and can undo before the parent save', () => {
    render(
      <MantineTestProvider>
        <Editor />
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Remover' })[0]!);
    expect(screen.getByText('Será excluído ao salvar')).toBeTruthy();
    expect(screen.getByLabelText('Telefone adicional 1')).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('["5511999998888"]');
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    expect(screen.getByRole('status').textContent).toBe('["14155552671","5511999998888"]');
  });
  it('normalizes a new BR input without changing an untouched international phone', () => {
    render(
      <MantineTestProvider>
        <Editor />
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar telefone' }));
    fireEvent.change(screen.getByLabelText('Telefone adicional 3'), {
      target: { value: '21999998888' },
    });
    expect(screen.getByRole('status').textContent).toBe(
      '["14155552671","5511999998888","5521999998888"]',
    );
  });
  it('keeps the explicit international prefix while typing', () => {
    function Phone() {
      const [value, setValue] = useState('');
      return <TelefoneTextInput label="Telefone" value={value} onChange={setValue} />;
    }
    render(
      <MantineTestProvider>
        <Phone />
      </MantineTestProvider>,
    );
    fireEvent.change(screen.getByLabelText('Telefone'), { target: { value: '+1 (415) 555-2671' } });
    expect(screen.getByLabelText('Telefone')).toHaveProperty('value', '+14155552671');
  });
  it('places validation errors on retained rows after staged removals are stripped', () => {
    render(
      <MantineTestProvider>
        <TelefonesAdicionaisInput
          value={[
            { telefone: '14155552671', [DELETE_MARK]: true },
            { telefone: '12', edited: true },
          ]}
          onChange={() => undefined}
          errorTree={[{ message: 'Número inválido' }]}
        />
      </MantineTestProvider>,
    );
    expect(screen.getByLabelText('Telefone adicional 1').getAttribute('aria-invalid')).not.toBe(
      'true',
    );
    expect(screen.getByLabelText('Telefone adicional 2').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Número inválido')).toBeTruthy();
  });
  it('displays an unmanaged imported US principal with + and preserves it through an edit', () => {
    function Principal() {
      const form = useForm({
        defaultValues: { telefone: '14155552671', telefoneGerenciado: false },
      });
      const telefone = useWatch({ control: form.control, name: 'telefone' });
      return (
        <FormProvider {...form}>
          <Controller
            control={form.control}
            name="telefone"
            render={({ field }) => (
              <ClienteTelefoneField
                {...field}
                label="Telefone principal"
                descriptor={{} as never}
              />
            )}
          />
          <output>{String(prepareForSaveTelefone(telefone))}</output>
        </FormProvider>
      );
    }
    render(
      <MantineTestProvider>
        <Principal />
      </MantineTestProvider>,
    );
    expect(screen.getByLabelText('Telefone principal')).toHaveProperty('value', '+14155552671');
    fireEvent.change(screen.getByLabelText('Telefone principal'), {
      target: { value: '+1 (415) 555-2672' },
    });
    expect(screen.getByLabelText('Telefone principal')).toHaveProperty('value', '+14155552672');
    expect(screen.getByRole('status').textContent).toBe('14155552672');
  });
});
