'use client';

import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { centavosDeReais, formatReais } from '@delfrance/core/money';

import { CurrencyInput } from '@/app/(app)/produtos/_components/CurrencyInput';
import { rotuloSolucaoDevolucao } from '@/lib/shopee/reclamacaoLabels';
import type { ShopeeSolucaoOfertavel, SolucaoDevolucaoShopee } from '@/lib/shopee/wire';

/**
 * The Shopee `offer` picker (#1525, step 17): the seller proposes a solução —
 * and, where Shopee lets the amount be adjusted, a refund — to the buyer.
 *
 * ⚠️ **UNMOUNTED when closed, never merely hidden** — the panel renders it only
 * while open, so there is no `opened` prop. A mounted modal keeps its
 * `useState`, and reopening would restore a selection AND an acknowledgement
 * given in an earlier session of the dialog (the `ReembolsoParcialModal` scar).
 *
 * What makes a proposal the operator did not mean unrepresentable:
 *
 *  1. **Nothing is preselected.** `escolha` starts `null`, so confirm cannot send
 *     a solução nobody clicked — not even when only one is offered.
 *  2. **The amount input exists only for an ADJUSTABLE solução, and starts
 *     empty.** It is never prefilled — not with the bounds, not with the buyer's
 *     request, not with what was typed under another solução.
 *  3. **Out of range is REFUSED, never clamped.** The bounds are stated and
 *     confirm stays disabled; a clamp would send an amount nobody typed
 *     (`IncidentAction.refundAmount`'s refuse-don't-round rule). They are
 *     compared in CENTAVOS (R-14), the same `centavosDeReais` the backend uses,
 *     so the browser and the route cannot disagree on a boundary value.
 *  4. **An acknowledgement keyed on what it acknowledges** — the solução AND the
 *     centavos, never a boolean — so changing either one clears it.
 *  5. **The payload cannot be stale at commit**: confirm is blocked while the
 *     solutions are refetching, and a refetch that drops the chosen solução drops
 *     the selection (derived each render, never an effect).
 *
 * ⚠️ **The amount leaves the browser as INTEGER centavos** (`valorReembolsoMinor`)
 * — the route converts once. And a NON-adjustable solução sends **no
 * `valorReembolsoMinor` key at all**: Shopee refuses an amount there ("The
 * proposed solution cannot have adjusted refund amount"), and a `0` would be an
 * amount.
 *
 * A refusal (409) is the panel's to catch: it passes the verbatim sentence back
 * as `erro`, and this modal stays open with the operator's choice intact.
 */
export interface OfertaDevolucaoShopeeModalProps {
  /** The ELIGIBLE solutions, from the estado (`get_available_solutions`). Bounds in REAIS. */
  solucoes: ShopeeSolucaoOfertavel[];
  /** True while the estado is being refetched — blocks the commit. */
  carregando: boolean;
  enviando: boolean;
  erro: string | null;
  onConfirm: (p: { solucao: SolucaoDevolucaoShopee; valorReembolsoMinor?: number }) => void;
  onClose: () => void;
}

/** The range a solução accepts, in words — `null` when Shopee sent no bound. */
function faixaDe(s: ShopeeSolucaoOfertavel): string | null {
  if (s.minimo != null && s.maximo != null) {
    return `entre ${formatReais(s.minimo)} e ${formatReais(s.maximo)}`;
  }
  if (s.maximo != null) return `até ${formatReais(s.maximo)}`;
  if (s.minimo != null) return `a partir de ${formatReais(s.minimo)}`;
  return null;
}

/** What the typed amount means for an adjustable solução. */
type AvaliacaoDoValor =
  | { readonly tipo: 'vazio' }
  | { readonly tipo: 'invalido'; readonly erro: string }
  | { readonly tipo: 'valido'; readonly minor: number };

/**
 * Judge the typed amount against the solução's bounds — in centavos, inclusive
 * at both ends (R-14: `centavosDeReais(min) ≤ v ≤ centavosDeReais(max)`).
 *
 * ⚠️ It never CORRECTS a value: an amount outside the range comes back
 * `invalido` with the range stated, and stays exactly as typed in the field.
 * A missing bound checks nothing on that side — Shopee's own refusal stays the
 * arbiter.
 */
function avaliarValor(valor: number | null, s: ShopeeSolucaoOfertavel): AvaliacaoDoValor {
  if (valor == null) return { tipo: 'vazio' };
  const minor = centavosDeReais(valor);
  if (minor <= 0) return { tipo: 'invalido', erro: 'Informe um valor maior que zero.' };
  // The route takes a safe integer; anything past it is no amount at all.
  if (!Number.isSafeInteger(minor)) return { tipo: 'invalido', erro: 'Valor inválido.' };
  const abaixo = s.minimo != null && minor < centavosDeReais(s.minimo);
  const acima = s.maximo != null && minor > centavosDeReais(s.maximo);
  if (abaixo || acima) {
    return {
      tipo: 'invalido',
      erro: `Fora da faixa que a Shopee permite: ${faixaDe(s) ?? ''}.`,
    };
  }
  return { tipo: 'valido', minor };
}

export function OfertaDevolucaoShopeeModal({
  solucoes,
  carregando,
  enviando,
  erro,
  onConfirm,
  onClose,
}: OfertaDevolucaoShopeeModalProps) {
  const [escolhaBruta, setEscolha] = useState<string | null>(null);
  /** Reais, as typed; `null` while empty. Cleared whenever the solução changes. */
  const [valor, setValor] = useState<number | null>(null);
  /**
   * ⚠️ **WHAT was acknowledged, not whether something was** — the key of the
   * (solução, centavos) pair the box was ticked for. A boolean would survive a
   * change of either, so the operator could tick "R$ 10,00" and send R$ 100,00.
   */
  const [cienteDe, setCienteDe] = useState<string | null>(null);

  /**
   * ⚠️ The staleness guard is DERIVED, never an effect: a refetch that drops
   * the chosen solução leaves no selection behind, because the value is looked
   * up in the CURRENT list every render.
   */
  const selecionada = solucoes.find((s) => s.solucao === escolhaBruta) ?? null;
  const avaliacao: AvaliacaoDoValor | null =
    selecionada == null ? null : selecionada.ajustavel ? avaliarValor(valor, selecionada) : null;

  /** The amount this proposal carries: a number, `null` for none, or `undefined` while incomplete. */
  const valorMinor: number | null | undefined =
    selecionada == null
      ? undefined
      : !selecionada.ajustavel
        ? null
        : avaliacao?.tipo === 'valido'
          ? avaliacao.minor
          : undefined;
  const completa = selecionada != null && valorMinor !== undefined;
  const chave = completa ? `${selecionada.solucao}|${valorMinor ?? 'sem-valor'}` : null;
  const ciente = chave !== null && cienteDe === chave;

  const bloqueado = !completa || !ciente || carregando || enviando;

  function escolher(v: string) {
    setEscolha(v);
    // ⚠️ Never carry an amount typed under one solução into another: the
    // bounds differ, and an amount the operator did not type for THIS solução
    // is a prefill.
    setValor(null);
  }

  function confirmar() {
    if (bloqueado || selecionada == null) return;
    if (valorMinor == null) {
      onConfirm({ solucao: selecionada.solucao });
      return;
    }
    onConfirm({ solucao: selecionada.solucao, valorReembolsoMinor: valorMinor });
  }

  const rotulo = selecionada ? rotuloSolucaoDevolucao(selecionada.solucao) : '';
  const faixa = selecionada?.ajustavel ? faixaDe(selecionada) : null;

  return (
    <Modal
      opened
      onClose={onClose}
      title="Fazer proposta ao comprador"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!enviando}
      // ⚠️ The header X too: closing mid-request would write Shopee's refusal
      // into a modal nobody is looking at.
      closeButtonProps={{ disabled: enviando }}
    >
      <Stack gap="sm">
        {solucoes.length === 0 ? (
          // ⚠️ No solutions means no confirm path at all — not a disabled
          // button over an empty list, which reads as a UI fault.
          <Alert color="gray" variant="light">
            A Shopee não oferece nenhuma solução para propor nesta devolução agora.
          </Alert>
        ) : (
          <>
            <Text size="sm">
              Escolha a solução a propor. O comprador recebe a proposta e pode aceitar ou recusar.
            </Text>

            <Radio.Group value={selecionada?.solucao ?? null} onChange={escolher}>
              <Stack gap={6}>
                {solucoes.map((s) => {
                  const faixaDaLinha = s.ajustavel ? faixaDe(s) : null;
                  return (
                    <Radio
                      key={s.solucao}
                      value={s.solucao}
                      disabled={enviando}
                      label={rotuloSolucaoDevolucao(s.solucao)}
                      description={
                        s.ajustavel
                          ? `Valor do reembolso ajustável${faixaDaLinha ? ` — ${faixaDaLinha}` : ''}.`
                          : 'Valor não ajustável — a proposta vai sem valor.'
                      }
                    />
                  );
                })}
              </Stack>
            </Radio.Group>

            {selecionada?.ajustavel && (
              <CurrencyInput
                label="Valor do reembolso proposto"
                description={faixa ? `Informe um valor ${faixa}.` : undefined}
                value={valor}
                onChange={setValor}
                disabled={enviando}
                error={avaliacao?.tipo === 'invalido' ? avaliacao.erro : undefined}
              />
            )}

            {completa && (
              <Checkbox
                checked={ciente}
                onChange={(e) => setCienteDe(e.currentTarget.checked ? chave : null)}
                disabled={enviando}
                label={`Entendo que a proposta (${rotulo}${
                  valor != null && valorMinor != null
                    ? ` com reembolso de ${formatReais(valor)}`
                    : ''
                }) vai ao comprador e não pode ser retirada pelo ERP.`}
              />
            )}

            {carregando && (
              <Text size="xs" c="dimmed">
                Atualizando as soluções da Shopee…
              </Text>
            )}
          </>
        )}

        {erro !== null && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            {/* Verbatim — a refusal here names what to do next. */}
            {erro}
          </Alert>
        )}

        <Group justify="flex-end">
          <Button type="button" variant="subtle" onClick={onClose} disabled={enviando}>
            Cancelar
          </Button>
          {solucoes.length > 0 && (
            <Button
              type="button"
              color="grape"
              disabled={bloqueado}
              loading={enviando}
              onClick={confirmar}
            >
              Enviar proposta
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
