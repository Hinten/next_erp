import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider, Tabs } from '@mantine/core';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { FiscalTab } from './FiscalTab';
import type { PedidoFormState } from '../types';

// FiscalTab resolves the cliente doc (to name the fiscal-address fallback) via
// useDocSnapshot and dereferences the cliente/endereço outer refs. None of that
// is the subject under test — form-backed state persistence across a tab switch
// — so stub the Firestore-touching bits out.
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: () => null,
}));
vi.mock('@/lib/data/clienteCollection', () => ({
  clienteCollection: { docRef: () => ({}) },
}));
// EnderecoPicker brings its own Firestore-backed picker; its selection is stored
// on the form via onChange (form-backed like everything else here). Stub it to a
// minimal control that both renders the current value AND can trigger onChange,
// so the test also exercises the enderecoFiscalOuterRef update path.
const FISCAL_ENDERECO_REF = 'documents/enderecos/end-1';
vi.mock('@/components/pickers/EnderecoPicker', () => ({
  EnderecoPicker: ({
    value,
    onChange,
  }: {
    value: unknown;
    onChange: (docPath: string | null) => void;
  }) => (
    <div>
      <div data-testid="endereco-picker">{String(value ?? '')}</div>
      <button type="button" onClick={() => onChange(FISCAL_ENDERECO_REF)}>
        Definir endereço fiscal
      </button>
    </div>
  ),
}));

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host() {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      infCpl: null,
      bloquearEmissaoNFe: false,
      chNFeReferenciadas: null,
      clientePedidoOuterRef: null,
      enderecoFiscalOuterRef: null,
    },
  });
  // Expose the (stable) form to the test in an effect, not during render.
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineProvider>
      {/* Mirror PedidoForm: keepMounted={false} unmounts the inactive panel,
          the exact condition that resets any non-form-backed local state. */}
      <Tabs keepMounted={false} defaultValue="fiscal">
        <Tabs.List>
          <Tabs.Tab value="fiscal">Fiscal</Tabs.Tab>
          <Tabs.Tab value="outra">Outra</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="fiscal">
          <FiscalTab form={form} db={{} as Firestore} />
        </Tabs.Panel>
        <Tabs.Panel value="outra">Conteúdo da outra aba</Tabs.Panel>
      </Tabs>
    </MantineProvider>
  );
}

const infCplField = () =>
  screen.getByLabelText(/Informações complementares/) as HTMLTextAreaElement;
const chaveField = () => screen.getByLabelText(/Chave de acesso/) as HTMLInputElement;

function switchToOtherTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'Outra' }));
}
function switchBackToFiscal() {
  fireEvent.click(screen.getByRole('tab', { name: 'Fiscal' }));
}

describe('FiscalTab — state survives a tab switch (#471)', () => {
  it('keeps infCpl, bloquearEmissaoNFe and chNFeReferenciadas after unmount/remount', () => {
    render(<Host />);

    // Edit every field the operator can touch in this tab, including the fiscal
    // address ref (set through EnderecoPicker's onChange).
    fireEvent.change(infCplField(), { target: { value: 'Nota de teste' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Bloquear emissão de NF-e/ }));
    fireEvent.click(screen.getByRole('button', { name: '+ Adicionar' }));
    fireEvent.change(chaveField(), {
      target: { value: '12345678901234567890123456789012345678901234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Definir endereço fiscal' }));

    // The values are reflected in the form (source of truth).
    expect(formRef.getValues('infCpl')).toBe('Nota de teste');
    expect(formRef.getValues('bloquearEmissaoNFe')).toBe(true);
    expect(formRef.getValues('chNFeReferenciadas')).toEqual([
      '12345678901234567890123456789012345678901234',
    ]);
    expect(formRef.getValues('enderecoFiscalOuterRef')).toBe(FISCAL_ENDERECO_REF);

    // Switch away — keepMounted={false} unmounts FiscalTab entirely. If any of
    // these fields were local useState, the value would be lost right here.
    switchToOtherTab();
    expect(screen.queryByLabelText(/Informações complementares/)).toBeNull();

    // Switch back — FiscalTab remounts and must re-hydrate from the form.
    switchBackToFiscal();
    expect(infCplField().value).toBe('Nota de teste');
    expect(
      (screen.getByRole('checkbox', { name: /Bloquear emissão de NF-e/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(chaveField().value).toBe('12345678901234567890123456789012345678901234');
    // EnderecoPicker is remounted with value={enderecoFiscalOuterRef} from the
    // form, so the previously-selected ref is still shown.
    expect(screen.getByTestId('endereco-picker').textContent).toBe(FISCAL_ENDERECO_REF);
  });

  it('re-hydrates a chNFe key set on the form while the tab was unmounted', () => {
    render(<Host />);

    switchToOtherTab();
    // A value can be written to the form (e.g. by another tab / programmatic
    // save flow) while FiscalTab is not mounted.
    act(() => {
      formRef.setValue('chNFeReferenciadas', ['99999999999999999999999999999999999999999999']);
    });

    switchBackToFiscal();
    expect(chaveField().value).toBe('99999999999999999999999999999999999999999999');
  });
});
