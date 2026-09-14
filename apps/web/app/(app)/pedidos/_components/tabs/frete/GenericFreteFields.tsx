'use client';

import { Group, Select, Stack } from '@mantine/core';
import { Controller } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import {
  INTEGRACAO_FRETE_LABELS,
  integracoesFreteSchema,
  isFreteMarketplaceOwned,
} from '@delfrance/schemas';
import {
  FreteDateTimeField,
  FreteNumberField,
  FreteSwitchField,
  FreteTextField,
  fretePath,
  type PedidoFormHandle,
} from './fields';
import { TransportadoraFields } from './TransportadoraFields';
import { VolumesEditor } from './VolumesEditor';

/**
 * The tipos this Select offers — every freight tipo EXCEPT the
 * marketplace-owned ones.
 *
 * ⚠️ The five marketplace values are deliberately absent, and their absence is
 * load-bearing rather than cosmetic. `externalOptionIntegracao` is read as
 * "an IMPORTER owns this block" in two places — `FreteTab` locks the whole tab
 * read-only on it (#1515) and `pedidoReconcile` refuses to authorize dispatch on
 * it (#702) — so an operator picking one here would be asserting ownership on
 * the importer's behalf, and the lock it triggers REMOVES this Select from the
 * screen: there would be no gesture left to undo it, on the tab or off it. The
 * importer writes the value directly (`orderFreteMapping.ts` for Shopee), never
 * through an editor.
 *
 * ⚠️ Nothing is hidden by this: a block already naming a marketplace never
 * reaches `GenericFreteFields` at all — `FreteTab.renderTipoFields` hoists it to
 * `MarketplaceReadOnly` before the generic body is considered — so the current
 * value is always one of the options below, or null.
 */
const OPCOES_INTEGRACAO_OPCAO_EXTERNA = integracoesFreteSchema.options
  .filter((value) => !isFreteMarketplaceOwned(value))
  .map((value) => ({ value, label: INTEGRACAO_FRETE_LABELS[value] }));

/**
 * Catch-all frete editor — port of `WidgetDeFreteGenerica`
 * (`.old/lib/pedido/widgets/frete_inicial_widget.dart:530-652`). Renders
 * for `tipo='outros'` and when no integração is selected.
 */
export function GenericFreteFields({
  form,
  db,
  disabled,
}: {
  form: PedidoFormHandle;
  db: Firestore;
  disabled?: boolean;
}) {
  return (
    <Stack gap="sm">
      <Group gap="xs" grow align="end">
        <FreteTextField form={form} name="externalId" label="ID externo" disabled={disabled} />
        <FreteTextField
          form={form}
          name="externalOptionId"
          label="Opção externa (ID)"
          disabled={disabled}
        />
        <Controller
          control={form.control}
          name={fretePath('externalOptionIntegracao')}
          render={({ field }) => (
            <Select
              label="Integração da opção externa"
              data={OPCOES_INTEGRACAO_OPCAO_EXTERNA}
              value={(field.value as string | null) ?? null}
              onChange={(v) => field.onChange(v)}
              clearable
              disabled={disabled}
            />
          )}
        />
      </Group>

      <TransportadoraFields form={form} disabled={disabled} />

      <Group gap="xs" grow align="end">
        <FreteTextField form={form} name="vagao" label="Vagão" maxLength={20} disabled={disabled} />
        <FreteTextField form={form} name="balsa" label="Balsa" maxLength={20} disabled={disabled} />
        <FreteTextField
          form={form}
          name="codRastreio"
          label="Código de rastreio"
          maxLength={200}
          disabled={disabled}
        />
      </Group>

      <VolumesEditor form={form} db={db} disabled={disabled} />

      <Group gap="xs" grow align="end">
        <FreteNumberField
          form={form}
          name="valorCobrado"
          label="Valor cobrado"
          description="Valor cobrado do cliente"
          disabled={disabled}
        />
        <FreteNumberField
          form={form}
          name="custoCalculado"
          label="Custo calculado"
          disabled={disabled}
        />
        <FreteNumberField form={form} name="custoFinal" label="Custo final" disabled={disabled} />
        <FreteNumberField
          form={form}
          name="valor_assegurado"
          label="Valor assegurado"
          disabled={disabled}
        />
      </Group>

      <Group gap="xs" grow align="end">
        <FreteNumberField
          form={form}
          name="prazoExtra"
          label="Prazo extra (dias)"
          decimalScale={0}
          disabled={disabled}
        />
        <FreteDateTimeField
          form={form}
          name="prazoDespacho"
          label="Data máxima para despacho"
          disabled={disabled}
        />
        <FreteDateTimeField
          form={form}
          name="dataPrevisaoEntrega"
          label="Previsão de entrega"
          disabled={disabled}
        />
        <FreteDateTimeField
          form={form}
          name="dataEntrega"
          label="Data de entrega"
          disabled={disabled}
        />
      </Group>

      <Group gap="lg">
        <FreteSwitchField form={form} name="ehReverso" label="Frete reverso" disabled={disabled} />
        <FreteSwitchField form={form} name="maoPropria" label="Mão própria" disabled={disabled} />
        <FreteSwitchField
          form={form}
          name="avisoRecebimento"
          label="Aviso de recebimento"
          disabled={disabled}
        />
      </Group>
    </Stack>
  );
}
