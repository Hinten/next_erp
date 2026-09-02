'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import {
  Alert,
  Badge,
  Button,
  Group,
  List,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';

import type { PushOutcome, PushRowBase } from './types';

/**
 * The shared produto-push progress dialog — the port of the legacy
 * `EnviarEstoqueDialog` (`.old/lib/produtos/pages/enviarEstoqueDialog.dart`)
 * and `EnviarPrecoDialog` (`.old/lib/produtos/pages/produtoTableView.dart:466-1136`),
 * which were the same non-dismissible dialog rendering one live row per
 * (produto × marketplace) with a different verb in the title.
 *
 * Kept from the legacy: the per-row colour progression, the
 * `erro ?? message ?? "Enviado com sucesso"` title expression, the
 * "produto - integração" subtitle with its two fallbacks, the non-dismissible-
 * while-running behaviour, and the Cancelar → Fechar button flip.
 *
 * Deliberately NOT kept: closing mid-run used to pop the dialog and leave the
 * streams running detached, with no user-visible record. Here Cancelar aborts,
 * and the dialog stays open to say what did and did not happen — already
 * dispatched work may have reached the channel, and pretending otherwise would
 * be worse than the wait.
 *
 * ⚠️ The caller mounts this fresh per run (a `key` on the parent). That is what
 * re-arms `opcao` — the operator's per-run tick — to its safe default every
 * time instead of remembering the last choice. There is no reset effect, on
 * purpose: an effect can be skipped, a remount cannot.
 */

const COR: Record<PushOutcome, string> = {
  enviado: 'green',
  pulado: 'yellow',
  falha: 'red',
  'nao-tentado': 'gray',
};

const ROTULO: Record<PushOutcome, string> = {
  enviado: 'Enviado',
  pulado: 'Pulado',
  falha: 'Erro',
  'nao-tentado': 'Não tentado',
};

type Fase = 'confirmar' | 'enviando' | 'terminado';

export interface PushProgressDialogProps<Row extends PushRowBase, Opcao> {
  opened: boolean;
  onClose: () => void;
  /** Modal title, e.g. "Enviando estoque para os marketplaces". */
  titulo: string;
  /** Confirm-button label, e.g. "Enviar estoque". Also the e2e handle. */
  rotuloAcao: string;
  /** `data-testid` prefix for the result rows, e.g. `envio-estoque-row-`. */
  testIdPrefix: string;
  /** Sentence shown before the run starts. */
  descricao: ReactNode;
  /**
   * Pre-run warnings, rendered under {@link descricao} on the confirm step —
   * today the channels in this selection that will be skipped, and why (#1430).
   *
   * ⚠️ A sibling rather than part of `descricao`, which is rendered inside a
   * Mantine `<Text>` (a `<p>`): an `<Alert>` in there is invalid nesting.
   */
  avisos?: ReactNode;
  /** How many produtos the run covers — gates the confirm button. */
  totalAlvos: number;
  /** The per-run option's SAFE default. A remount is what re-arms it. */
  opcaoInicial: Opcao;
  /** The option widget (a Checkbox today), wired to the dialog's own state. */
  renderOpcao: (valor: Opcao, definir: (proximo: Opcao) => void) => ReactNode;
  /** Run it. Reports incrementally through `onProgress`. */
  executar: (
    opcao: Opcao,
    signal: AbortSignal,
    onProgress: (rows: Row[]) => void,
  ) => Promise<{ rows: Row[]; cancelado: boolean }>;
  /** Extra trailing detail on a row's subtitle (e.g. the price actually sent). */
  detalheLinha?: (row: Row) => ReactNode;
  /**
   * Wording for the SUCCESS outcome, singular and plural — "Enviado"/"Enviados"
   * by default.
   *
   * ⚠️ Only the wording is overridable, never the outcome vocabulary itself:
   * every channel backend answers in the same four `PushOutcome` values, and the
   * badge colours carry the same meaning whatever the operation. A pause run
   * reading "Enviado" would be the one place this shared dialog lies about what
   * it just did.
   */
  rotuloSucesso?: { singular: string; plural: string };
}

export function PushProgressDialog<Row extends PushRowBase, Opcao>({
  opened,
  onClose,
  titulo,
  rotuloAcao,
  testIdPrefix,
  descricao,
  avisos,
  totalAlvos,
  opcaoInicial,
  renderOpcao,
  executar,
  detalheLinha,
  rotuloSucesso,
}: PushProgressDialogProps<Row, Opcao>) {
  const rotulos: Record<PushOutcome, string> =
    rotuloSucesso == null ? ROTULO : { ...ROTULO, enviado: rotuloSucesso.singular };
  const [fase, setFase] = useState<Fase>('confirmar');
  const [rows, setRows] = useState<Row[]>([]);
  const [cancelado, setCancelado] = useState(false);
  const [opcao, setOpcao] = useState<Opcao>(opcaoInicial);
  /** Set when the RUN itself broke, as opposed to a listing failing. */
  const [erro, setErro] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // No reset effect — see the module doc: the parent mounts this fresh per run,
  // so the initial state above IS the reset. All this effect owns is the abort
  // on unmount, so a route change mid-run can never leave a run writing state
  // into a dead component.
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
      const res = await executar(opcao, controller.signal, setRows);
      setRows(res.rows);
      setCancelado(res.cancelado);
    } catch (err) {
      // Without this the run ended as an unhandled rejection while the dialog
      // flipped to `terminado` showing "Enviados 0 · Pulados 0 · Falhas 0" and
      // no rows — telling the operator NOTHING happened, when what actually
      // happened is that the run broke. Not hypothetical: the providers
      // deliberately rethrow anything that is not a known channel error, and the
      // integração read is a live Firestore query that can reject with a
      // `FirebaseError` (offline, permission) before a single row exists.
      setErro(err instanceof Error ? err.message : 'Falha inesperada no envio.');
      // A FirebaseError is expected here and is fully reported above. Anything
      // else is a coding bug and still surfaces (repo rule 6) — but now the
      // operator sees it too, instead of a silent all-zeros summary.
      if (!(err instanceof FirebaseError)) throw err;
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
      title={titulo}
      size="lg"
      // Non-dismissible while running — the legacy `barrierDismissible: false`.
      closeOnEscape={terminal || fase === 'confirmar'}
      closeOnClickOutside={terminal || fase === 'confirmar'}
      withCloseButton={terminal || fase === 'confirmar'}
    >
      <Stack gap="sm">
        {fase === 'confirmar' && (
          <>
            <Text size="sm">{descricao}</Text>
            {avisos}
            {renderOpcao(opcao, setOpcao)}
          </>
        )}

        {fase !== 'confirmar' && (
          <Group gap="sm">
            {!terminal && <Loader size="xs" />}
            <Text size="sm" fw={500}>
              {rotuloSucesso?.plural ?? 'Enviados'} {resumo.enviados} · Pulados {resumo.pulados} ·
              Falhas {resumo.falhas}
            </Text>
          </Group>
        )}

        {cancelado && (
          <Alert color="yellow" variant="light">
            Execução cancelada — os itens já processados foram concluídos.
          </Alert>
        )}

        {erro != null && (
          <Alert color="red" variant="light" title="O envio foi interrompido">
            {erro}
            {rows.length > 0 && ' Os itens listados abaixo já haviam sido processados.'}
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
                <List.Item key={row.key} data-testid={`${testIdPrefix}${row.key}`}>
                  <Group gap="xs" align="flex-start" wrap="nowrap">
                    <Badge color={COR[row.outcome]} variant="light" miw={96}>
                      {rotulos[row.outcome]}
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
                        {detalheLinha?.(row)}
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
              <Button onClick={() => void iniciar()} disabled={totalAlvos === 0}>
                {rotuloAcao}
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
