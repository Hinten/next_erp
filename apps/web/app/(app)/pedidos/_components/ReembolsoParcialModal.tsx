'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { centavosDeReais, formatReais, roundReais } from '@delfrance/core/money';

import type {
  MercadoLivreConselhoParcial,
  MercadoLivreOfertaParcial,
} from '@/lib/mercado-livre/client';

/**
 * The partial-refund picker (#364).
 *
 * ---- ⚠️⚠️ **Mercado Livre treats a MISSING percentage as 50%.** Not an error,
 * not a rejection — it refunds half the order. Everything in this component is
 * arranged so that "the operator did not choose" is **unrepresentable** rather
 * than merely validated:
 *
 *  1. **No free numeric input exists here at all.** No `NumberInput`, no
 *     `Slider`, no `CurrencyInput`, no "outro valor". The options are built by
 *     mapping ML's own `available_offers` and nothing else, so a percentage ML
 *     does not offer cannot be expressed.
 *  2. **Nothing is preselected.** `escolha` starts `null` and confirm is
 *     disabled until it is not. There is no state in which pressing confirm
 *     sends a value the operator never clicked.
 *  3. **An explicit acknowledgement**, echoing the amount in words the operator
 *     just read. The `EtiquetaComprarModal` pattern, for the same reason.
 *  4. **The payload cannot be stale at commit** — confirm is blocked while the
 *     offers query is refetching, and if a refetch drops the chosen offer the
 *     selection resets rather than committing against a list that no longer
 *     contains it.
 *  5. **100% is filtered out.** ML rejects it on this endpoint; full refund is
 *     its own action with its own confirmation.
 *  6. **Options read amount-first.** Percentages are what get misread — the
 *     operator is choosing money.
 *  7. **`restrictions` disable the rows they exclude.** The difference between
 *     ML answering `400 below minimum` after the commit and the row simply not
 *     being clickable.
 *
 * ---- ⚠️ The AMOUNT is the authority sent to the backend, not the percentage.
 * `percentualParaValor` matches on the amount and re-derives the percentage from
 * ML's own list; sending the percentage and letting it re-resolve an amount would
 * commit the same LABEL against a different sum. `percentualExibido` rides along
 * so the backend can refuse a request where the operator saw nothing.
 */
export interface ReembolsoParcialModalProps {
  opened: boolean;
  onClose: () => void;
  ofertas: MercadoLivreOfertaParcial[];
  recomendacoes: MercadoLivreConselhoParcial[];
  restricoes: MercadoLivreConselhoParcial[];
  /** True while the offers are being refetched — blocks the commit. */
  carregando: boolean;
  enviando: boolean;
  erro: string | null;
  onConfirm: (escolha: { valorReembolsoMinor: number; percentualExibido: number }) => void;
}

/** The lowest percentage any `type: "minimum"` restriction imposes. */
function minimoExigido(restricoes: MercadoLivreConselhoParcial[]): number | null {
  const mins = restricoes
    .filter((r) => r.type === 'minimum' && typeof r.percentage === 'number')
    .map((r) => r.percentage as number);
  return mins.length > 0 ? Math.max(...mins) : null;
}

function recomendado(
  recomendacoes: MercadoLivreConselhoParcial[],
  percentage: number | null,
): boolean {
  return recomendacoes.some((r) => r.percentage != null && r.percentage === percentage);
}

export function ReembolsoParcialModal({
  opened,
  onClose,
  ofertas,
  recomendacoes,
  restricoes,
  carregando,
  enviando,
  erro,
  onConfirm,
}: ReembolsoParcialModalProps) {
  const [escolhaBruta, setEscolha] = useState<string | null>(null);
  /**
   * ⚠️ **Which option was acknowledged, not whether one was.** A boolean would
   * survive a change of selection, so the operator could tick "Estou ciente:
   * R$ 149,00" and then confirm R$ 268,20 under it. Storing the option means the
   * acknowledgement is only ever true FOR the amount it was given for.
   */
  const [cienteDe, setCienteDe] = useState<string | null>(null);

  // ⚠️ 100% is not a partial refund. ML rejects it on this endpoint, and the
  // full-refund action has its own confirmation with its own copy.
  const opcoes = ofertas.filter(
    (o) => o.amount != null && o.percentage != null && o.percentage > 0 && o.percentage < 100,
  );
  const minimo = minimoExigido(restricoes);

  /**
   * ⚠️ **The staleness guard is DERIVED, never an effect.** A refetch that drops
   * the chosen offer must not leave a selection behind, and looking the value up
   * in the CURRENT list each render makes that automatic — there is no window in
   * which stale state is renderable, and no `setState` in an effect for the
   * React compiler to give up on.
   */
  const escolha = opcoes.some((o) => String(o.percentage) === escolhaBruta) ? escolhaBruta : null;
  const ciente = cienteDe !== null && cienteDe === escolha;

  const selecionada = opcoes.find((o) => String(o.percentage) === escolha) ?? null;
  const valorMinor = selecionada?.amount != null ? centavosDeReais(selecionada.amount) : null;

  /**
   * ⚠️ Eligibility is re-checked at COMMIT time, not only at click time.
   * `escolha` is re-validated against `opcoes` every render but was not checked
   * against `restricoes`, so a refetch that adds `{ type: 'minimum' }` greyed out
   * the row while `selecionada` still resolved to it and `ciente` stayed true —
   * confirm armed on an offer the operator can no longer take. Same shape as the
   * bug the `cienteDe` mutation caught: the guard covered the offer's PRESENCE
   * but not its ELIGIBILITY. ML answers 400 rather than refunding the wrong sum,
   * so the cost is a confusing refusal rather than lost money — but layer 7 only
   * held at click time until this.
   */
  const escolhaInelegivel =
    selecionada?.percentage != null && minimo != null && selecionada.percentage < minimo;

  const bloqueado =
    selecionada == null ||
    valorMinor == null ||
    escolhaInelegivel ||
    !ciente ||
    carregando ||
    enviando;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Oferecer reembolso parcial"
      centered
      closeOnClickOutside={false}
      closeOnEscape={!enviando}
      // ⚠️ The header X too. Escape and Cancelar were locked while sending and
      // this one was not, so the likeliest mid-flight exit was the one left open
      // — and closing during the request means the `catch` writes ML's refusal
      // into a modal nobody is looking at, which is precisely what the
      // "stays open on a refusal" design exists to prevent.
      closeButtonProps={{ disabled: enviando }}
    >
      <Stack gap="sm">
        {opcoes.length === 0 ? (
          // ⚠️ No offers means no confirm path at all — not a disabled button
          // over an empty list, which would look like a UI fault.
          <Alert color="gray" variant="light">
            O Mercado Livre não oferece reembolso parcial nesta reclamação.
          </Alert>
        ) : (
          <>
            <Text size="sm">
              Escolha um dos valores que o Mercado Livre oferece. O comprador recebe a oferta e pode
              aceitar ou recusar.
            </Text>

            <Radio.Group value={escolha} onChange={setEscolha}>
              <Stack gap={6}>
                {opcoes.map((o) => {
                  const pct = o.percentage as number;
                  const abaixoDoMinimo = minimo != null && pct < minimo;
                  return (
                    <Radio
                      key={pct}
                      value={String(pct)}
                      disabled={abaixoDoMinimo || enviando}
                      label={
                        <Group gap={6}>
                          {/* ⚠️ Amount first. The operator is choosing money; the
                              percentage is the footnote. */}
                          <Text size="sm" fw={500}>
                            {formatReais(roundReais(o.amount as number))}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {pct}% do pedido
                          </Text>
                          {recomendado(recomendacoes, pct) && (
                            <Badge size="xs" color="teal" variant="light">
                              Recomendado pelo ML
                            </Badge>
                          )}
                        </Group>
                      }
                      description={
                        abaixoDoMinimo
                          ? `O Mercado Livre exige no mínimo ${String(minimo)}% nesta reclamação.`
                          : undefined
                      }
                    />
                  );
                })}
              </Stack>
            </Radio.Group>

            {selecionada && (
              <Checkbox
                checked={ciente}
                onChange={(e) => setCienteDe(e.currentTarget.checked ? escolha : null)}
                disabled={enviando}
                label={`Estou ciente: ${formatReais(
                  roundReais(selecionada.amount as number),
                )} (${String(selecionada.percentage)}%) voltam para o comprador e não é possível desfazer pelo ERP.`}
              />
            )}

            {carregando && (
              <Text size="xs" c="dimmed">
                Atualizando as ofertas do Mercado Livre…
              </Text>
            )}
          </>
        )}

        {erro !== null && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
            {/* Verbatim — a refusal here names the percentages ML DOES offer. */}
            {erro}
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose} disabled={enviando}>
            Cancelar
          </Button>
          {opcoes.length > 0 && (
            <Button
              color="red"
              disabled={bloqueado}
              loading={enviando}
              onClick={() => {
                if (valorMinor == null || selecionada?.percentage == null) return;
                onConfirm({
                  valorReembolsoMinor: valorMinor,
                  percentualExibido: selecionada.percentage,
                });
              }}
            >
              Confirmar reembolso parcial
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
