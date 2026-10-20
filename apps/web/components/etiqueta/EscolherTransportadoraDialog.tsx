'use client';

/**
 * The Loja Integrada "Escolher transportadora…" question (master plan step 15,
 * D6/A6): which label target ONE pedido is routed through, chosen by hand — in
 * the `useEscolherEnvio` shape: `useEscolherTransportadora()` returns a
 * promise-returning `escolherTransportadora(pergunta)` plus the `element` to
 * render ONCE per view. The answer is an `int_frete` doc id, or `null` when the
 * operator cancels.
 *
 * Only an ACTIVE target of a supported tipo is offered (`AlvoFreteLi.ativo` and
 * `.suportado`, from the shared targets query): the route refuses anything
 * else, so offering it would only buy a refusal. The conta mapa's own target is
 * preselected when it is among them; otherwise nothing is — the dialog never
 * guesses.
 *
 * ⚠️ It closes ONLY by its buttons (no ×, no Esc, no click outside), like the
 * pickup question: a stray dismissal would silently cancel the choice.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';

import { rotuloAlvoFreteLi, type AlvoFreteLi } from '@/lib/loja-integrada/useAlvosMapaFreteLi';

/** The question. */
export interface PerguntaDeTransportadora {
  /** The pedido's número (`null` when it has none) — the title names it. */
  readonly pedidoRotulo: string | null;
  /** The targets the shared query read (active and inactive alike). */
  readonly alvos: readonly AlvoFreteLi[];
  /** The target the conta's mapa names for the pedido's method, or `null`. */
  readonly preselecionado: string | null;
}

/** The chosen `int_frete` doc id, or `null` = cancelled. */
export type RespostaDeTransportadora = string | null;

export interface UseEscolherTransportadoraResult {
  /** Open the dialog and resolve with the operator's answer (`null` = cancelled). Stable. */
  escolherTransportadora: (p: PerguntaDeTransportadora) => Promise<RespostaDeTransportadora>;
  /** Render once in the view that owns the hook. */
  element: ReactNode;
}

/** The targets the question may offer: active, and of a tipo the route routes to. */
export function alvosOferecidos(alvos: readonly AlvoFreteLi[]): readonly AlvoFreteLi[] {
  return alvos.filter((a) => a.ativo && a.suportado);
}

function tituloDaPergunta(p: PerguntaDeTransportadora): string {
  const pedido = p.pedidoRotulo?.trim() ?? '';
  return pedido !== '' ? `Pedido ${pedido} — Escolher transportadora` : 'Escolher transportadora';
}

function FormularioDeTransportadora({
  pergunta,
  onResponder,
}: {
  pergunta: PerguntaDeTransportadora;
  onResponder: (r: RespostaDeTransportadora) => void;
}) {
  const opcoes = useMemo(() => alvosOferecidos(pergunta.alvos), [pergunta.alvos]);
  const [valor, setValor] = useState<string | null>(() =>
    opcoes.some((a) => a.id === pergunta.preselecionado) ? pergunta.preselecionado : null,
  );
  const escolhido = opcoes.some((a) => a.id === valor) ? valor : null;

  return (
    <Stack>
      <Text>A transportadora escolhida vale só para este pedido.</Text>
      {opcoes.length === 0 ? (
        <Alert color="yellow">
          Nenhuma transportadora ativa que emita etiqueta para pedidos da Loja Integrada.
        </Alert>
      ) : (
        <Select
          label="Transportadora"
          data={opcoes.map((a) => ({ value: a.id, label: rotuloAlvoFreteLi(a) }))}
          value={escolhido}
          onChange={setValor}
          allowDeselect={false}
          comboboxProps={{ withinPortal: false }}
        />
      )}
      <Group justify="flex-end">
        <Button variant="subtle" onClick={() => onResponder(null)}>
          Cancelar
        </Button>
        <Button disabled={escolhido === null} onClick={() => onResponder(escolhido)}>
          Confirmar
        </Button>
      </Group>
    </Stack>
  );
}

export function useEscolherTransportadora(): UseEscolherTransportadoraResult {
  // `seq` remounts the form per question, so its selection is initialised from
  // THAT question and never inherits the previous pedido's.
  const [aberta, setAberta] = useState<{
    pergunta: PerguntaDeTransportadora;
    seq: number;
  } | null>(null);
  const resolveRef = useRef<((r: RespostaDeTransportadora) => void) | null>(null);
  const seqRef = useRef(0);

  const escolherTransportadora = useCallback(
    (pergunta: PerguntaDeTransportadora) =>
      new Promise<RespostaDeTransportadora>((resolve) => {
        // A dangling previous question resolves as cancelled, so no caller
        // hangs forever. The page host queues every question FIFO, so this is
        // a last resort, never a way to share the dialog.
        resolveRef.current?.(null);
        resolveRef.current = resolve;
        seqRef.current += 1;
        setAberta({ pergunta, seq: seqRef.current });
      }),
    [],
  );

  // The owner unmounting with a question open answers it as cancelled.
  useEffect(
    () => () => {
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(null);
    },
    [],
  );

  function settle(r: RespostaDeTransportadora) {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setAberta(null);
    resolve?.(r);
  }

  const element = (
    <Modal
      opened={aberta !== null}
      onClose={() => settle(null)}
      title={aberta !== null ? tituloDaPergunta(aberta.pergunta) : ''}
      centered
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      {aberta !== null && (
        <FormularioDeTransportadora
          key={aberta.seq}
          pergunta={aberta.pergunta}
          onResponder={settle}
        />
      )}
    </Modal>
  );

  return { escolherTransportadora, element };
}
