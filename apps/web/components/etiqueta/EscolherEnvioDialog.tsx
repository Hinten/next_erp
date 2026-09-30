'use client';

/**
 * The Shopee "how does this package ship?" question (#1523, step 15) — the
 * awaitable bridge behind `EtiquetaProviderUi.escolherEnvio`, in the
 * `useConfirmDialog` shape: `useEscolherEnvio()` returns a promise-returning
 * `escolherEnvio(pergunta)` plus the `element` to render ONCE per view.
 *
 * The options are the backend's 202 `escolher-envio` body, verbatim: the pickup
 * addresses (each with its slots) and, when `permiteDropoff`, the drop-off at
 * the agency. The answer is what the provider sends back on the NEXT call —
 * `{ modo: 'pickup', enderecoId, horarioId }` or `{ modo: 'dropoff' }` — and
 * `null` when the operator cancels (the provider then ends the click as
 * `skipped`).
 *
 * Rules the backend holds us to (`apps/shopee/lib/shopee/etiqueta/modoDeEnvio.ts`
 * matches the answer EXACTLY against a fresh read, and re-asks on a mismatch):
 *   - `horarioId: null` is valid ONLY for an address with no slot on offer —
 *     there Shopee schedules the pickup itself ("Sem horário — a Shopee
 *     agenda"). An address WITH slots needs one picked, so Confirmar stays off
 *     until it is.
 *   - Ids are opaque strings, echoed back untouched.
 *
 * ⚠️ Pre-selection never GUESSES between two options: the `principal` address
 * and its `recomendado` slot are what Shopee itself marks, and an option is
 * otherwise pre-selected only when it is the only one there is.
 *
 * ⚠️ It closes ONLY by its buttons (no ×, no Esc, no click outside), like the
 * legacy modal pickers: a stray dismissal would silently cancel a label the
 * operator is waiting on.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Group, Modal, Radio, Stack, Text } from '@mantine/core';

import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';
import type { EnderecoDeColeta } from '@/lib/shopee/wire';

/** The question — `EtiquetaProviderUi.escolherEnvio`'s input. */
export type PerguntaDeEnvio = Parameters<EtiquetaProviderUi['escolherEnvio']>[0];
/** The operator's answer, or `null` = cancelled. */
export type RespostaDeEnvio = Awaited<ReturnType<EtiquetaProviderUi['escolherEnvio']>>;

export interface UseEscolherEnvioResult {
  /** Open the dialog and resolve with the operator's answer (`null` = cancelled). Stable. */
  escolherEnvio: EtiquetaProviderUi['escolherEnvio'];
  /** Render once in the view that owns the hook. */
  element: ReactNode;
}

/** The mode radio's value for the drop-off; an address is `endereco:<id>`. */
const DROPOFF = 'dropoff';
const PREFIXO_ENDERECO = 'endereco:';
/** The one slot option a zero-slot address offers. */
const SEM_HORARIO = 'sem-horario';

export const ROTULO_DROPOFF = 'Levar à agência (dropoff)';
export const ROTULO_SEM_HORARIO = 'Sem horário — a Shopee agenda';

/** The slot pre-selected for an address: Shopee's `recomendado`, else the only one, else none. */
function horarioInicial(endereco: EnderecoDeColeta | undefined): string | null {
  if (endereco === undefined) return null;
  const recomendado = endereco.horarios.find((h) => h.recomendado);
  if (recomendado !== undefined) return recomendado.id;
  const [unico, ...outros] = endereco.horarios;
  return unico !== undefined && outros.length === 0 ? unico.id : null;
}

/** The mode pre-selected: the `principal` address, else the ONLY option there is, else none. */
function modoInicial(p: PerguntaDeEnvio): string | null {
  const principal = p.enderecos.find((e) => e.principal);
  if (principal !== undefined) return `${PREFIXO_ENDERECO}${principal.id}`;
  const [unico, ...outros] = p.enderecos;
  if (unico !== undefined) {
    return outros.length === 0 && !p.permiteDropoff ? `${PREFIXO_ENDERECO}${unico.id}` : null;
  }
  return p.permiteDropoff ? DROPOFF : null;
}

function FormularioDeEnvio({
  pergunta,
  onResponder,
}: {
  pergunta: PerguntaDeEnvio;
  onResponder: (r: RespostaDeEnvio) => void;
}) {
  const [modo, setModo] = useState<string | null>(() => modoInicial(pergunta));
  const endereco = modo?.startsWith(PREFIXO_ENDERECO)
    ? pergunta.enderecos.find((e) => `${PREFIXO_ENDERECO}${e.id}` === modo)
    : undefined;
  const [horario, setHorario] = useState<string | null>(() => horarioInicial(endereco));

  function escolherModo(proximo: string) {
    setModo(proximo);
    // A slot belongs to ONE address: switching address re-derives it rather
    // than carrying an id the new address does not offer.
    setHorario(
      horarioInicial(pergunta.enderecos.find((e) => `${PREFIXO_ENDERECO}${e.id}` === proximo)),
    );
  }

  let resposta: RespostaDeEnvio = null;
  if (modo === DROPOFF && pergunta.permiteDropoff) {
    resposta = { modo: 'dropoff' };
  } else if (endereco !== undefined) {
    if (endereco.horarios.length === 0) {
      resposta = { modo: 'pickup', enderecoId: endereco.id, horarioId: null };
    } else if (horario !== null && endereco.horarios.some((h) => h.id === horario)) {
      resposta = { modo: 'pickup', enderecoId: endereco.id, horarioId: horario };
    }
  }

  return (
    <Stack>
      {pergunta.escolhaInvalida ? (
        <Alert color="yellow" title="A escolha anterior não vale mais">
          {pergunta.mensagem}
        </Alert>
      ) : (
        <Text>{pergunta.mensagem}</Text>
      )}
      <Radio.Group label="Como enviar" value={modo} onChange={escolherModo}>
        <Stack gap={6} mt={4}>
          {pergunta.enderecos.map((e) => (
            <Radio
              key={e.id}
              value={`${PREFIXO_ENDERECO}${e.id}`}
              label={
                <Group gap={6}>
                  <Text size="sm">Coleta — {e.rotulo}</Text>
                  {e.principal && (
                    <Badge size="xs" variant="light">
                      Principal
                    </Badge>
                  )}
                </Group>
              }
            />
          ))}
          {pergunta.permiteDropoff && <Radio value={DROPOFF} label={ROTULO_DROPOFF} />}
        </Stack>
      </Radio.Group>
      {endereco !== undefined && (
        <Radio.Group
          label="Horário da coleta"
          value={endereco.horarios.length === 0 ? SEM_HORARIO : horario}
          onChange={setHorario}
        >
          <Stack gap={6} mt={4}>
            {endereco.horarios.length === 0 ? (
              <Radio value={SEM_HORARIO} label={ROTULO_SEM_HORARIO} />
            ) : (
              endereco.horarios.map((h) => (
                <Radio
                  key={h.id}
                  value={h.id}
                  label={
                    <Group gap={6}>
                      <Text size="sm">{h.rotulo}</Text>
                      {h.recomendado && (
                        <Badge size="xs" variant="light" color="green">
                          Recomendado
                        </Badge>
                      )}
                    </Group>
                  }
                />
              ))
            )}
          </Stack>
        </Radio.Group>
      )}
      <Group justify="flex-end">
        <Button variant="subtle" onClick={() => onResponder(null)}>
          Cancelar
        </Button>
        <Button disabled={resposta === null} onClick={() => onResponder(resposta)}>
          Confirmar
        </Button>
      </Group>
    </Stack>
  );
}

export function useEscolherEnvio(): UseEscolherEnvioResult {
  // `seq` remounts the form per question, so its selection is initialised from
  // THAT question's options and never inherits the previous package's.
  const [aberta, setAberta] = useState<{ pergunta: PerguntaDeEnvio; seq: number } | null>(null);
  // The pending promise's resolver — a ref, not state: it never affects
  // rendering and must be settled synchronously from the button handlers.
  const resolveRef = useRef<((r: RespostaDeEnvio) => void) | null>(null);
  const seqRef = useRef(0);

  const escolherEnvio = useCallback(
    (pergunta: PerguntaDeEnvio) =>
      new Promise<RespostaDeEnvio>((resolve) => {
        // A dangling previous question (should not happen — the provider asks
        // one at a time) resolves as cancelled, so no caller hangs forever.
        resolveRef.current?.(null);
        resolveRef.current = resolve;
        seqRef.current += 1;
        setAberta({ pergunta, seq: seqRef.current });
      }),
    [],
  );

  // ⚠️ The owner unmounting with a question open (the operator navigated
  // away) would leave the label flow awaiting a promise nobody can settle —
  // answer it as cancelled instead.
  useEffect(
    () => () => {
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(null);
    },
    [],
  );

  function settle(r: RespostaDeEnvio) {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setAberta(null);
    resolve?.(r);
  }

  const pacoteRotulo = aberta?.pergunta.pacoteRotulo ?? null;
  const element = (
    <Modal
      opened={aberta !== null}
      onClose={() => settle(null)}
      title={pacoteRotulo !== null ? `Como enviar — ${pacoteRotulo}` : 'Como enviar o pacote'}
      centered
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      {aberta !== null && (
        <FormularioDeEnvio key={aberta.seq} pergunta={aberta.pergunta} onResponder={settle} />
      )}
    </Modal>
  );

  return { escolherEnvio, element };
}
