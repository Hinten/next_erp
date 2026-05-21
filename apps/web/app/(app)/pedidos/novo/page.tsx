'use client';

/**
 * Minimal "create new Pedido" form. Lets the user pick the five
 * outer-ref docs the NF-e orchestrator reads — filial, cliente,
 * operação, endereço fiscal, integração — plus the initial estado.
 * Everything else on the schema is hidden via `excludedFields` to
 * keep the form focused on what's needed to issue a test NF-e.
 *
 * Workflow:
 *   1. User picks the 5 refs + estado, clicks "Criar".
 *   2. ObjectView writes the Pedido doc and `onSaved` fires with the
 *      new id.
 *   3. We redirect to `/pedidos/<id>`, where a "Seed test item"
 *      button on the detail page adds a hardcoded CSOSN-102 item to
 *      `pedido.itens` so the orchestrator has something to emit.
 *   4. Click the Pedidos list "Emitir NF-e" bulk action with that
 *      pedido selected to fire `apps/nfe` end-to-end.
 *
 * Endereço is a subcollection (`clientes/{id}/enderecos/{id}`), not
 * a top-level collection, so the picker takes a plain text path for
 * now. Cascaded picker (filter by chosen cliente) is a follow-up.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, TextInput, Title } from '@mantine/core';
import { pedidoSchema } from '@delfrance/schemas';
import { ObjectView, type FieldRenderProps } from '@delfrance/ui';

import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { clienteCollection } from '@/lib/data/clienteCollection';
import { filialCollection } from '@/lib/data/filialCollection';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

import { OuterRefPicker } from '../_components/OuterRefPicker';

interface OpaqueRef {
  readonly path: string;
}

/**
 * Helper to render an `OuterRefPicker` as an ObjectView field input.
 * Bridges the FieldRenderProps (value: unknown) to the picker's
 * typed `OpaqueRef | null` API.
 */
function pickerRenderInput<S extends Parameters<typeof OuterRefPicker>[0]['collection']>(args: {
  collection: S;
  labelKey: string;
  required?: boolean;
  maxOptions?: number;
}) {
  function Renderer({ value, onChange, label, error }: FieldRenderProps) {
    return (
      <OuterRefPicker
        collection={args.collection}
        labelKey={args.labelKey}
        value={value as OpaqueRef | null | undefined}
        onChange={(next) => onChange(next)}
        label={label}
        required={args.required}
        error={error}
        maxOptions={args.maxOptions}
      />
    );
  }
  return Renderer;
}

/**
 * Endereço fiscal lives in a subcollection of its cliente, so a top-
 * level OuterRefPicker can't enumerate them. Plain text input where
 * the user pastes the doc path; defensive-validated by
 * `dereferenceOuterRef` at emission time.
 */
function EnderecoPathInput({ value, onChange, label, error }: FieldRenderProps) {
  const v = value as { path?: string } | string | null | undefined;
  const text = typeof v === 'string' ? v : v?.path ?? '';
  return (
    <TextInput
      label={label}
      description="Cole o caminho completo do endereço (ex.: clientes/abc123/enderecos/xyz789)."
      value={text}
      onChange={(e) => {
        const next = e.currentTarget.value;
        onChange(next.length === 0 ? null : { path: next });
      }}
      error={error}
      placeholder="clientes/<clienteId>/enderecos/<enderecoId>"
    />
  );
}

// Form scope: hide everything except the 6 fields below.
const VISIBLE_FIELDS = new Set([
  'estado',
  'filialPedidoOuterRef',
  'clientePedidoOuterRef',
  'enderecoFiscalOuterRef',
  'operacaoPedidoOuterRef',
  'integracaoPedidoOuterRef',
]);

const EXCLUDED_FIELDS = Object.keys(pedidoSchema.shape).filter(
  (key) => !VISIBLE_FIELDS.has(key),
);

export default function NovoPedidoPage() {
  const router = useRouter();
  const { user } = useAuth();

  // `Date.now()` is impure; `useState` initializer runs exactly once
  // and isn't flagged as render-time code by the React Compiler rule.
  const [defaultValues] = useState(() => ({
    estado: 'pago' as const,
    timestamp: Date.now(),
    ehSaida: true,
  }));

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo pedido (mínimo para NF-e de teste)</Title>
        <Anchor component={Link} href="/pedidos" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={pedidoSchema}
        collection={pedidoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        defaultValues={defaultValues}
        excludedFields={EXCLUDED_FIELDS}
        fields={{
          filialPedidoOuterRef: {
            label: 'Filial',
            renderInput: pickerRenderInput({
              collection: filialCollection,
              labelKey: 'razaoSocial',
              required: true,
            }),
          },
          clientePedidoOuterRef: {
            label: 'Cliente',
            renderInput: pickerRenderInput({
              collection: clienteCollection,
              labelKey: 'nome',
              required: true,
              maxOptions: 500,
            }),
          },
          operacaoPedidoOuterRef: {
            label: 'Operação fiscal',
            renderInput: pickerRenderInput({
              collection: operacaoCollection,
              labelKey: 'nome',
              required: true,
            }),
          },
          integracaoPedidoOuterRef: {
            label: 'Integração',
            renderInput: pickerRenderInput({
              collection: integracaoCollection,
              labelKey: 'nome',
              required: true,
            }),
          },
          enderecoFiscalOuterRef: {
            label: 'Endereço fiscal (caminho do doc)',
            renderInput: EnderecoPathInput,
          },
        }}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/pedidos/${id}`)}
      />
    </Stack>
  );
}
