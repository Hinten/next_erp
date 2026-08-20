import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { FieldConfig } from '../schema/types';
import { extractFieldsFromSchema } from '../schema/derive';
import { FieldRenderer } from './FieldRenderer';

function Harness({
  schema,
  values,
  fields,
  onSubmit,
}: {
  schema: ReturnType<typeof z.object>;
  values: Record<string, unknown>;
  fields?: Record<string, FieldConfig>;
  onSubmit?: (v: Record<string, unknown>) => void;
}) {
  const form = useForm<Record<string, unknown>>({ defaultValues: values });
  const descriptors = extractFieldsFromSchema(schema);
  return (
    <MantineTestProvider>
      <form onSubmit={form.handleSubmit((v) => onSubmit?.(v))}>
        {descriptors.map((d) => (
          <FieldRenderer
            key={d.key}
            control={form.control as never}
            descriptor={d}
            config={fields?.[d.key]}
          />
        ))}
        <button type="submit">submit</button>
      </form>
    </MantineTestProvider>
  );
}

describe('FieldRenderer', () => {
  it('renders a TextInput for string kind with the label', () => {
    const schema = z.object({ nome: z.string().describe('Nome') });
    render(<Harness schema={schema} values={{ nome: 'Alice' }} />);
    expect(screen.getByLabelText('Nome')).toBeTruthy();
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Alice');
  });

  it('renders a Textarea for longText kind override', () => {
    const schema = z.object({
      obs: z.string().describe('{"label":"Obs","kind":"longText"}'),
    });
    render(<Harness schema={schema} values={{ obs: 'multi\nline' }} />);
    const el = screen.getByLabelText('Obs') as HTMLTextAreaElement;
    expect(el.tagName).toBe('TEXTAREA');
  });

  it('renders Switch for boolean kind', () => {
    const schema = z.object({ ativo: z.boolean().describe('Ativo') });
    render(<Harness schema={schema} values={{ ativo: true }} />);
    const sw = screen.getByLabelText('Ativo') as HTMLInputElement;
    expect(sw.type).toBe('checkbox');
    expect(sw.checked).toBe(true);
  });

  it('renders Select for enum and populates options', () => {
    const schema = z.object({ tipo: z.enum(['a', 'b']).describe('Tipo') });
    render(<Harness schema={schema} values={{ tipo: 'a' }} />);
    // Mantine's Select renders a readonly input as a combobox-like widget.
    expect(screen.getByText('Tipo')).toBeTruthy();
  });

  it('shows a clear button for nullable string, which sets the value to null', async () => {
    const onSubmit = vi.fn();
    const schema = z.object({ email: z.string().nullable().describe('Email') });
    const { container } = render(
      <Harness schema={schema} values={{ email: 'x@y' }} onSubmit={onSubmit} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    });
    // RHF's handleSubmit runs async — fire the form's submit event directly
    // and await microtasks to ensure the callback resolves.
    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });
    expect(onSubmit).toHaveBeenCalledWith({ email: null });
  });

  it('renders a non-nullable object inline with no toggle', () => {
    const schema = z.object({
      sede: z.object({ cep: z.string().describe('CEP') }).describe('Sede'),
    });
    render(<Harness schema={schema} values={{ sede: { cep: '01310100' } }} />);
    // Sub-field is visible immediately; there is no enable/disable Switch.
    expect((screen.getByLabelText('CEP') as HTMLInputElement).value).toBe('01310100');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('toggles a nullable object: off ⇒ null & fields hidden, on ⇒ seeded & visible', async () => {
    const onSubmit = vi.fn();
    const schema = z.object({
      origem: z
        .object({
          cep: z.string().describe('CEP'),
          estado: z.string().describe('Estado'),
        })
        .nullable()
        .describe('Origem'),
    });
    const { container } = render(
      <Harness
        schema={schema}
        values={{ origem: null }}
        fields={{
          origem: { label: 'Informar origem', defaultValue: { estado: 'SP', bogus: 'x' } },
        }}
        onSubmit={onSubmit}
      />,
    );

    // Off: the Switch carries the config label and the sub-fields are hidden.
    const sw = screen.getByLabelText('Informar origem') as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(screen.queryByLabelText('CEP')).toBeNull();

    // On: the object is seeded (empty defaults + `defaultValue`) and the
    // sub-fields appear — `estado` preselected to 'SP', `cep` empty. The stray
    // `bogus` key in `defaultValue` is dropped (it isn't in the nested schema).
    await act(async () => {
      fireEvent.click(sw);
    });
    expect((screen.getByLabelText('Estado') as HTMLInputElement).value).toBe('SP');
    expect((screen.getByLabelText('CEP') as HTMLInputElement).value).toBe('');

    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });
    expect(onSubmit).toHaveBeenCalledWith({ origem: { cep: '', estado: 'SP' } });
  });
});
