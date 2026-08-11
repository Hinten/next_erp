'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  List,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import {
  type EnviarEstoqueAlvo,
  enviarEstoqueParaMarketplaces,
} from '@/lib/marketplace/estoque/enviarEstoqueRun';
import type { StockPushRow } from '@/lib/marketplace/estoque/types';

/**
 * The bulk stock-push dialog — the port of the legacy `EnviarEstoqueDialog`
 * (`.old/lib/produtos/pages/enviarEstoqueDialog.dart`), which was a
 * non-dismissible `SimpleDialog` titled "Enviando estoque para os marketplaces"
 * rendering one live row per (produto × marketplace).
 *
 * Kept from the legacy: the title, the per-row icon/colour progression, the
 * `erro ?? message ?? "Enviado com sucesso"` title expression, the
 * "produto - integração" subtitle, and the Cancelar → Fechar button flip.
 *
 * Deliberately NOT kept: closing the dialog mid-run used to pop it and leave the
 * streams running detached, with no user-visible record. Here Cancelar aborts,
 * and the dialog stays open to say what did and did not happen.
 */

export interface EnviarEstoqueDialogProps {
  opened: boolean;
  alvos: readonly EnviarEstoqueAlvo[];
  onClose: () => void;
}

type Fase = 'confirmar' | 'enviando' | 'terminado';

const COR: Record<StockPushRow['outcome'], string> = {
  enviado: 'green',
  pulado: 'yellow',
  falha: 'red',
  'nao-tentado': 'gray',
};

const ROTULO: Record<StockPushRow['outcome'], string> = {
  enviado: 'Enviado',
  pulado: 'Pulado',
  falha: 'Erro',
  'nao-tentado': 'Não tentado',
};

export function EnviarEstoqueDialog({ opened, alvos, onClose }: EnviarEstoqueDialogProps) {
  const mercadoLivre = useMercadoLivreClient();
  const [fase, setFase] = useState<Fase>('confirmar');
  const [rows, setRows] = useState<StockPushRow[]>([]);
  const [cancelado, setCancelado] = useState(false);
  /**
   * RE-ARMED OFF on every open, never remembered. Re-sending to a listing
   * latched by #781 costs an extra ML `GET` per anúncio and, if our payload
   * really was the problem, just re-earns the rejection — so it must be a
   * deliberate choice each time, not a sticky preference.
   */
  const [reenviarComErro, setReenviarComErro] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // No reset effect: the page mounts this component fresh per run (see its
  // `key`), so the initial state above IS the reset — including
  // `reenviarComErro`, which must be re-armed OFF every time rather than
  // remembered. All this effect owns is the abort on unmount, so a route change
  // mid-run can never leave a run writing state into a dead component.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  const terminal = fase === 'terminado';

  async function iniciar() {
    const controller = new AbortController();
    abortRef.current = controller;
    setFase('enviando');
    try {
      const res = await enviarEstoqueParaMarketplaces(
        alvos,
        reenviarComErro,
        {
          db: getFirebaseFirestore(),
          deps: { mercadoLivre },
          signal: controller.signal,
        },
        setRows,
      );
      setRows(res.rows);
      setCancelado(res.cancelado);
    } finally {
      setFase('terminado');
      abortRef.current = null;
    }
  }

  const resumo = {
    enviados: rows.filter((r) => r.outcome === 'enviado').length,
    pulados: rows.filter((r) => r.outcome === 'pulado').length,
    falhas: rows.filter((r) => r.outcome === 'falha').length,
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Enviando estoque para os marketplaces"
      size="lg"
      // Non-dismissible while running — the legacy `barrierDismissible: false`.
      closeOnEscape={terminal || fase === 'confirmar'}
      closeOnClickOutside={terminal || fase === 'confirmar'}
      withCloseButton={terminal || fase === 'confirmar'}
    >
      <Stack gap="sm">
        {fase === 'confirmar' && (
          <>
            <Text size="sm">
              O estoque atual de {alvos.length} produto(s) será enviado para os canais em que eles
              estão anunciados.
            </Text>
            <Checkbox
              label="Reenviar anúncios com erro"
              description={
                'Anúncios marcados com erro ficam de fora por padrão: o Mercado Livre já ' +
                'confirmou que eles estão saudáveis, então foi o envio anterior que ele recusou. ' +
                'Marque para reverificar cada um e tentar de novo.'
              }
              checked={reenviarComErro}
              onChange={(e) => setReenviarComErro(e.currentTarget.checked)}
            />
          </>
        )}

        {fase !== 'confirmar' && (
          <Group gap="sm">
            {!terminal && <Loader size="xs" />}
            <Text size="sm" fw={500}>
              Enviados {resumo.enviados} · Pulados {resumo.pulados} · Falhas {resumo.falhas}
            </Text>
          </Group>
        )}

        {cancelado && (
          <Alert color="yellow" variant="light">
            Envio cancelado — os itens já enviados foram concluídos.
          </Alert>
        )}

        {rows.length > 0 && (
          <ScrollArea.Autosize mah={360}>
            <List spacing="xs" size="sm" listStyleType="none">
              {rows.map((row) => (
                // The test id keys off `row.key`, not `produtoId`: rows are
                // LISTING-scoped, so one produto can legitimately produce
                // several, and a produto-scoped id would make every Playwright
                // locator ambiguous exactly when the output matters most.
                <List.Item key={row.key} data-testid={`envio-estoque-row-${row.key}`}>
                  <Group gap="xs" align="flex-start" wrap="nowrap">
                    <Badge color={COR[row.outcome]} variant="light" miw={96}>
                      {ROTULO[row.outcome]}
                    </Badge>
                    <Stack gap={0}>
                      {/* Legacy: `erro ?? message ?? "Enviado com sucesso"`. */}
                      <Text size="sm" style={{ userSelect: 'text' }}>
                        {row.mensagem || 'Enviado com sucesso'}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {`${row.produtoNome ?? 'Produto desconhecido'} - ${
                          row.integracaoNome ?? 'Integração desconhecida'
                        }`}
                        {row.anuncioId != null && ` · ${row.anuncioId}`}
                      </Text>
                    </Stack>
                  </Group>
                </List.Item>
              ))}
            </List>
          </ScrollArea.Autosize>
        )}

        <Group justify="flex-end">
          {fase === 'confirmar' && (
            <>
              <Button variant="default" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={() => void iniciar()} disabled={alvos.length === 0}>
                Enviar estoque
              </Button>
            </>
          )}
          {fase === 'enviando' && (
            <Button
              variant="default"
              onClick={() => {
                abortRef.current?.abort();
                setCancelado(true);
              }}
            >
              Cancelar
            </Button>
          )}
          {terminal && <Button onClick={onClose}>Fechar</Button>}
        </Group>
      </Stack>
    </Modal>
  );
}
