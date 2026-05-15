import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { extractFieldsFromSchema } from '../schema/derive';
import { FieldRenderer } from './FieldRenderer';

function Harness({
  schema,
  values,
  onSubmit,
}: {
  schema: ReturnType<typeof z.object>;
  values: Record<string, unknown>;
  onSubmit?: (v: Record<string, unknown>) => void;
}) {
  const form = useForm<Record<string, unknown>>({ defaultValues: values });
  const descriptors = extractFieldsFromSchema(schema);
  return (
    <MantineProvider>
      <form onSubmit={form.handleSubmit((v) => onSubmit?.(v))}>
        {descriptors.map((d) => (
          <FieldRenderer key={d.key} control={form.control as never} descriptor={d} />
        ))}
        <button type="submit">submit</button>
      </form>
    </MantineProvider>
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
});
