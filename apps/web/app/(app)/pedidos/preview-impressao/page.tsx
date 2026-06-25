'use client';

/**
 * Dev-only print preview — renders the orçamento and comum sheets from the
 * built-in fixture scenarios (few items, many items for pagination, kit,
 * no-photo, overdue dispatch) so the layouts and pagination can be eyeballed
 * locally without seeding Firestore. Pick a scenario, then download the
 * orçamento (JPEG + PDF) or print the comum sheet (Ctrl+P / the button).
 *
 * Not a product feature: it short-circuits in production builds.
 */
import { useRef, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { useReactToPrint } from 'react-to-print';

import { PREVIEW_MODELS } from '@/lib/pedido-print/fixtures';

import { ComumSheet } from '../_components/print/ComumSheet';
import { OrcamentoSheet } from '../_components/print/OrcamentoSheet';
import { useOrcamentoExport } from '../_components/print/useOrcamentoExport';

export default function PreviewImpressaoPage() {
  const [idx, setIdx] = useState(0);
  const entry = PREVIEW_MODELS[idx] ?? PREVIEW_MODELS[0]!;
  const model = entry.model;

  const { ref: orcRef, exporting, error, run } = useOrcamentoExport(model);
  const comumRef = useRef<HTMLDivElement>(null);
  const printComum = useReactToPrint({
    contentRef: comumRef,
    documentTitle: `pedido-${model.numero ?? ''}`,
    pageStyle: '@page { size: A4; margin: 10mm; }',
  });

  if (process.env.NODE_ENV === 'production') {
    return <Text>Pré-visualização de impressão disponível apenas em desenvolvimento.</Text>;
  }

  return (
    <Stack>
      <Title order={2}>Pré-visualização de impressão</Title>
      <Text c="dimmed" size="sm">
        Cenários de exemplo para conferir layout e paginação. O orçamento baixa imagem + PDF; o
        comum abre a janela de impressão do navegador.
      </Text>

      <SegmentedControl
        value={String(idx)}
        onChange={(v) => setIdx(Number(v))}
        data={PREVIEW_MODELS.map((m, i) => ({ label: m.label, value: String(i) }))}
      />

      <Tabs defaultValue="orcamento">
        <Tabs.List>
          <Tabs.Tab value="orcamento">Orçamento (imagem + PDF)</Tabs.Tab>
          <Tabs.Tab value="comum">Comum (window.print)</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="orcamento" pt="md">
          <Group mb="sm">
            <Button onClick={() => void run()} loading={exporting}>
              Baixar orçamento (JPEG + PDF)
            </Button>
          </Group>
          {error && (
            <Alert color="red" variant="light" mb="sm">
              {error}
            </Alert>
          )}
          <Paper withBorder style={{ overflow: 'auto', maxWidth: '100%' }}>
            <OrcamentoSheet ref={orcRef} model={model} />
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="comum" pt="md">
          <Group mb="sm">
            <Button onClick={() => printComum()}>Imprimir comum</Button>
          </Group>
          <Paper withBorder style={{ overflow: 'auto', maxWidth: '100%' }}>
            <div ref={comumRef}>
              <ComumSheet model={model} />
            </div>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
