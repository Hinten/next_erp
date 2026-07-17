'use client';

/**
 * Read-only detail of one enviNfe audit msg (`filiais/{filialId}/enviNfe/{id}`).
 * The collection is append-only — nothing here is editable; the big XML/JSON
 * payloads render through `XmlBlock` and every chave is copyable.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Anchor, Code, Group, Stack, Text, Title } from '@mantine/core';
import { enviNfeMsgSchema } from '@delfrance/schemas';
import { ObjectView, type FieldConfig } from '@delfrance/ui';

import { enviNfeCollection } from '@/lib/data/enviNfeCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { CopyIconButton } from '@/components/CopyIconButton';
import { xmlBlockRenderInput } from '@/components/XmlBlock';

function TargetsChnfeList({ label, value }: { label: string; value: unknown }) {
  const chaves = Array.isArray(value) ? (value as string[]) : [];
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      {chaves.length === 0 && (
        <Text size="sm" c="dimmed">
          —
        </Text>
      )}
      {chaves.map((chave) => (
        <Group key={chave} gap={4} wrap="nowrap">
          <Code fz={11}>{chave}</Code>
          <CopyIconButton value={chave} label="Copiar chave" ariaLabel={`Copiar chave ${chave}`} />
        </Group>
      ))}
    </Stack>
  );
}

const OBJECT_FIELDS: Record<string, FieldConfig> = {
  targetsChnfe: {
    renderInput: (props) => <TargetsChnfeList label={props.label} value={props.value} />,
  },
  xml_enviado: { renderInput: xmlBlockRenderInput() },
  // Phase A persists xml_retorno as a JSON-stringified parsed object —
  // pretty-print when it parses, raw otherwise.
  xml_retorno: { renderInput: xmlBlockRenderInput({ prettyJson: true }) },
};

export default function ComunicacaoNfePage() {
  const params = useParams<{ filialId: string; id: string }>();
  const { user } = useAuth();
  const db = getFirebaseFirestore();

  // The data layer identity-tracks pathContext — keep the object stable.
  const pathContext = useMemo(() => ({ filialId: params.filialId }), [params.filialId]);

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Comunicação NF-e</Title>
        <Anchor component={Link} href="/nfe/comunicacoes" size="sm">
          ← Voltar à lista
        </Anchor>
      </Group>

      <ObjectView
        schema={enviNfeMsgSchema}
        collection={enviNfeCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        recordId={params.id}
        pathContext={pathContext}
        fields={OBJECT_FIELDS}
        readOnly
        canEdit={false}
      />
    </Stack>
  );
}
