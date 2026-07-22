import { useEffect, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider, Tabs } from '@mantine/core';
import { useForm, type UseFormReturn } from 'react-hook-form';
import type { Pedido } from '@delfrance/schemas';
import type { CalculateOption } from '@delfrance/integrations-freight-br/http-client';
import { FobFields } from './frete/FobFields';
import { MelhorEnvioFields } from './frete/MelhorEnvioFields';
import { seedFreteInicial } from './frete/seedFreteInicial';
import type { FreteInicialFormState, PedidoFormState } from '../types';
import type { PedidoFormHandle } from './frete/fields';

// Regression guard for #472 (parent #227): PedidoForm Tabs use
// `keepMounted={false}`, so Frete unmounts on switch. MelhorEnvio quote list
// was fixed in PR #210 by seeding from externalOptionData; Motoboy/Retirada/
// FOB/Generic/Volumes are already RHF-backed. These tests unmount the panel
// for real so a future local-state regression fails in CI (same harness as
// FiscalTab #471 / PrincipalTab #470).

vi.mock('@/lib/freight/client', () => ({
  useFreightClient: () => null,
}));
// Etiqueta panel is session UX (busy/rastreio) — not form-data under test.
vi.mock('./frete/EtiquetaMelhorEnvioPanel', () => ({
  EtiquetaMelhorEnvioPanel: () => null,
}));

const SAVED_QUOTE: CalculateOption = {
  id: 1,
  name: 'PAC',
  price: '22.50',
  custom_price: '22.50',
  company: { id: 1, name: 'Correios', picture: null },
  delivery_time: 5,
};

function freteWith(overrides: Partial<FreteInicialFormState> = {}): FreteInicialFormState {
  return {
    ...(seedFreteInicial('1', true) as unknown as FreteInicialFormState),
    ...overrides,
  };
}

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function FreteHost({
  frete,
  children,
}: {
  frete: FreteInicialFormState;
  children: (form: PedidoFormHandle) => ReactNode;
}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: { freteInicial: frete, ehSaida: true },
  });
  useEffect(() => {
    formRef = form;
  }, [form]);
  const [tab, setTab] = useState<string | null>('frete');
  return (
    <MantineProvider>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="frete">Frete</Tabs.Tab>
          <Tabs.Tab value="outra">Outra</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="frete" pt="md">
          {children(form)}
        </Tabs.Panel>
        <Tabs.Panel value="outra" pt="md">
          Outra aba
        </Tabs.Panel>
      </Tabs>
    </MantineProvider>
  );
}

function switchTo(value: 'frete' | 'outra') {
  act(() => {
    fireEvent.click(screen.getByRole('tab', { name: value === 'outra' ? 'Outra' : 'Frete' }));
  });
}

describe('FobFields — state survives a tab switch (#472)', () => {
  it('keeps valorCobrado and codRastreio after unmount/remount', () => {
    render(<FreteHost frete={freteWith()}>{(form) => <FobFields form={form} />}</FreteHost>);

    const rastreio = () => screen.getByLabelText(/Código de rastreio/) as HTMLInputElement;
    const valor = () => screen.getByLabelText(/^Valor cobrado/) as HTMLInputElement;

    // Text field goes through onChange(string); money uses setValue so we
    // don't fight Mantine NumberInput's fireEvent parsing in jsdom.
    fireEvent.change(rastreio(), { target: { value: 'BR123456789BR' } });
    act(() => {
      formRef.setValue('freteInicial.valorCobrado', 15.9, { shouldDirty: true });
    });

    expect(formRef.getValues('freteInicial.codRastreio')).toBe('BR123456789BR');
    expect(formRef.getValues('freteInicial.valorCobrado')).toBe(15.9);

    switchTo('outra');
    expect(screen.getByText('Outra aba')).toBeTruthy();
    expect(screen.queryByLabelText(/Código de rastreio/)).toBeNull();

    switchTo('frete');
    expect(formRef.getValues('freteInicial.codRastreio')).toBe('BR123456789BR');
    expect(formRef.getValues('freteInicial.valorCobrado')).toBe(15.9);
    expect(rastreio().value).toBe('BR123456789BR');
    expect(valor().value).toMatch(/15[,.]9/);
  });

  it('re-hydrates a frete write made while the tab is unmounted', () => {
    render(<FreteHost frete={freteWith()}>{(form) => <FobFields form={form} />}</FreteHost>);

    switchTo('outra');
    act(() => {
      formRef.setValue('freteInicial.codRastreio', 'XX999');
      formRef.setValue('freteInicial.valorCobrado', 42);
    });

    switchTo('frete');
    expect((screen.getByLabelText(/Código de rastreio/) as HTMLInputElement).value).toBe('XX999');
    expect((screen.getByLabelText(/^Valor cobrado/) as HTMLInputElement).value).toMatch(/42/);
  });
});

describe('MelhorEnvioFields — quote Select re-seeds from form (#472 / PR #210)', () => {
  const integracao = {
    tipo: 'melhorEnvios',
    enderecoDeOrigem: { cep: '01310100' },
  } as Parameters<typeof MelhorEnvioFields>[0]['integracao'];

  it('shows the previously selected quote after unmount/remount', () => {
    render(
      <FreteHost
        frete={freteWith({
          externalOptionId: '1',
          externalOptionData: SAVED_QUOTE as unknown as Record<string, unknown>,
          valorCobrado: 22.5,
        })}
      >
        {(form) => (
          <MelhorEnvioFields
            form={form}
            integracao={integracao}
            cepDestino="04567890"
            intFreteId="int-me-1"
          />
        )}
      </FreteHost>,
    );

    // Seeded from externalOptionData on mount — Select is present with the option.
    // Prefer role=combobox: getByLabelText also matches the hidden listbox.
    const optionSelect = () =>
      screen.getByRole('combobox', { name: /Opção de frete/ }) as HTMLInputElement;
    expect(optionSelect()).toBeTruthy();
    expect(optionSelect().value).toMatch(/Correios PAC/);

    switchTo('outra');
    expect(screen.queryByRole('combobox', { name: /Opção de frete/ })).toBeNull();

    switchTo('frete');
    // Without the seed-from-form lazy initializer, `quotes` would be null and
    // the Select would not render at all (the original MelhorEnvio bug).
    expect(optionSelect()).toBeTruthy();
    expect(optionSelect().value).toMatch(/Correios PAC/);
    expect(formRef.getValues('freteInicial.externalOptionId')).toBe('1');
    expect(formRef.getValues('freteInicial.valorCobrado')).toBe(22.5);
  });
});
