'use client';

import { ColorInput, Group, Stack, Switch, Text } from '@mantine/core';
import { TimeInput } from '@mantine/dates';
import type { HorarioWhatsapp, PeriodoWhatsapp } from '@delfrance/schemas';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { depositoCollection } from '@/lib/data/depositoCollection';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { refRenderInput } from '@/components/collection-select/refRenderInput';
import { filialRefRenderInput } from '@/components/pickers/FilialPicker';
import { TelefoneField, prepareForSaveTelefone } from '@/components/inputs/TelefoneInput';
import { applyWeekdayEdit, defaultHorario, hhmmToMs, msToHHMM } from './horarioFuncionamento';

/**
 * RGB int (`0xRRGGBB`) → `#rrggbb`. Duplicated from `balcaoFieldOverrides`
 * (no shared home yet for this two-consumer helper — Mercado Livre opts out
 * of `cor` entirely, so extracting a shared module isn't worth it for one
 * more consumer).
 */
function intToHex(value: number): string {
  const clamped = Math.max(0, Math.min(0xffffff, Math.trunc(value)));
  return `#${clamped.toString(16).padStart(6, '0')}`;
}

/** `#rrggbb` (or `#rgb`) → RGB int. Anything else → null. */
function hexToInt(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return null;
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return Number.parseInt(full, 16);
}

function CorInput({ value, onChange, onBlur, label, hint, disabled, error }: FieldRenderProps) {
  const hex = typeof value === 'number' ? intToHex(value) : '';
  return (
    <ColorInput
      label={label}
      description={hint ?? 'Cor de destaque para identificar o canal.'}
      value={hex}
      onChange={(next) => {
        if (!next) {
          onChange(null);
          return;
        }
        onChange(hexToInt(next));
      }}
      onBlur={onBlur}
      disabled={disabled}
      error={error}
      format="hex"
    />
  );
}

/* -------------------------------------------------------------------------- */
/*                horario_funcionamento — business-hours editor               */
/* -------------------------------------------------------------------------- */

const WEEKDAYS: ReadonlyArray<{ key: keyof PeriodoWhatsapp; label: string }> = [
  { key: 'domingo', label: 'Domingo' },
  { key: 'segunda', label: 'Segunda-feira' },
  { key: 'terca', label: 'Terça-feira' },
  { key: 'quarta', label: 'Quarta-feira' },
  { key: 'quinta', label: 'Quinta-feira' },
  { key: 'sexta', label: 'Sexta-feira' },
  { key: 'sabado', label: 'Sábado' },
];

/**
 * Custom `renderInput` for `horario_funcionamento` (`PeriodoWhatsapp[] | null`
 * on the wire). Legacy supports multiple stacked "Períodos"; this editor
 * surfaces only the FIRST — the common case and the one the acceptance criteria
 * (#528) exercises — but PRESERVES every additional período verbatim on save
 * (`applyWeekdayEdit`), never wiping them, and shows a dimmed note when extras
 * exist. Each weekday toggles independently: off → that day's `Horario_Whatsapp`
 * entry is `null` (absent from the schedule); on → abertura/fechamento time
 * inputs appear, defaulting to 08:00–18:00 until edited.
 *
 * The abertura/fechamento wire values are read/written ONLY through the
 * legacy-exact codec (`msToHHMM`/`hhmmToMs` → `encodeHorarioMs`/`decodeHorarioMs`
 * in `@delfrance/schemas`) so they stay byte-compatible with the values the
 * migrated corpus already stores — see that codec's doc comment for the
 * year-0/local anchor.
 */
function HorarioFuncionamentoInput({ value, onChange, disabled, label, hint }: FieldRenderProps) {
  const periods = (value as PeriodoWhatsapp[] | null) ?? [];
  const period: PeriodoWhatsapp = periods[0] ?? {};
  const extraPeriodos = Math.max(0, periods.length - 1);

  function updateDay(day: keyof PeriodoWhatsapp, next: HorarioWhatsapp | null): void {
    onChange(applyWeekdayEdit(periods, day, next));
  }

  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        {label}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
      {extraPeriodos > 0 && (
        <Text size="xs" c="dimmed" fs="italic">
          {extraPeriodos > 1
            ? `+${extraPeriodos} períodos adicionais preservados`
            : '+1 período adicional preservado'}{' '}
          — edição múltipla em breve
        </Text>
      )}
      {WEEKDAYS.map(({ key, label: dayLabel }) => {
        const horario = period[key] ?? null;
        const active = horario != null;
        return (
          <Group key={key} align="flex-end" gap="sm" wrap="wrap">
            <Switch
              label={dayLabel}
              checked={active}
              disabled={disabled}
              onChange={(e) => {
                updateDay(key, e.currentTarget.checked ? defaultHorario() : null);
              }}
            />
            <TimeInput
              label={`${dayLabel} — Abertura`}
              value={msToHHMM(horario?.abertura)}
              disabled={disabled || !active}
              onChange={(e) => {
                if (!horario) return;
                const ms = hhmmToMs(e.currentTarget.value);
                if (ms != null) updateDay(key, { ...horario, abertura: ms });
              }}
            />
            <TimeInput
              label={`${dayLabel} — Fechamento`}
              value={msToHHMM(horario?.fechamento)}
              disabled={disabled || !active}
              onChange={(e) => {
                if (!horario) return;
                const ms = hhmmToMs(e.currentTarget.value);
                if (ms != null) updateDay(key, { ...horario, fechamento: ms });
              }}
            />
          </Group>
        );
      })}
    </Stack>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Tab (section) layout                            */
/* -------------------------------------------------------------------------- */

/**
 * Tab order for the WhatsApp create/edit screens. The flat form (#528) mixed
 * identity, Cloud API ids and auto-reply messaging into a single wall of
 * inputs; grouping them by subject keeps the screen scannable. Consumed by
 * `ObjectView`'s `sections` prop; per-field assignment lives on each
 * `FieldConfig.section` below. Order = relevance for an operator: identity and
 * the sales/fiscal defaults orders inherit first, then the Meta connection
 * that makes the number work, then the attendance behaviour.
 */
export const WHATSAPP_SECTIONS: string[] = ['Geral', 'Conexão (Cloud API)', 'Atendimento'];

/**
 * Field config shared by the WhatsApp create and edit screens — mirrors
 * `balcaoFields`/`mercadoLivreFields` (the outer-ref selectors + `cor`), plus
 * the WhatsApp-only identity/messaging fields (#528). Each field carries a
 * `section` so the form renders as subject-grouped tabs (`WHATSAPP_SECTIONS`).
 */
export const whatsappFields: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Geral' },
  numero: {
    label: 'Número',
    section: 'Geral',
    hint: 'Número de telefone conectado (com DDI/DDD, somente dígitos).',
    renderInput: TelefoneField,
    prepareForSave: prepareForSaveTelefone,
  },
  ativo: { label: 'Ativo', section: 'Geral' },
  padrao: { label: 'Padrão', section: 'Geral' },
  cor: { section: 'Geral', renderInput: CorInput },
  phoneNumberId: {
    label: 'ID do Número de Telefone',
    section: 'Conexão (Cloud API)',
    hint: 'ID do número de telefone associado à conta do WhatsApp Business Cloud (Meta Graph API).',
  },
  // NOTE: despite the name, `wa_id` is NOT the WhatsApp Business Account ID —
  // the inbound webhook pipeline (#527) resolves an account by comparing
  // `wa_id` against the webhook payload's `metadata.phone_number_id`, so this
  // must carry the SAME value as `phoneNumberId` above. Surfaced as a plain
  // text field (not a custom widget) with the quirk documented here per the
  // field's own hint, rather than excluded — an operator registering a new
  // number needs to set it explicitly.
  wa_id: {
    label: 'WA ID',
    section: 'Conexão (Cloud API)',
    hint:
      'Historicamente recebe o MESMO valor do "ID do Número de Telefone" acima — o webhook ' +
      'de entrada resolve a conta comparando este campo com o phone_number_id recebido do ' +
      'WhatsApp Cloud API (não é o WhatsApp Business Account ID). Preencha com o mesmo valor.',
  },
  waba_id: {
    label: 'WABA ID (conta comercial)',
    section: 'Conexão (Cloud API)',
    hint:
      'ID real da WhatsApp Business Account (diferente do "WA ID" acima, que é o phone_number_id). ' +
      'Usado nas chamadas de nível de conta do Graph — por ex. a verificação de inscrição do ' +
      'webhook (subscribed_apps) na checagem de saúde da conta.',
  },
  mensagem_automatica: {
    label: 'Mensagem automática (dentro do horário de atendimento)',
    section: 'Atendimento',
    kind: 'longText',
  },
  mensagem_inatividade: {
    label: 'Mensagem de inatividade (fora do horário de atendimento)',
    section: 'Atendimento',
    kind: 'longText',
  },
  horario_funcionamento: {
    label: 'Horário de funcionamento',
    section: 'Atendimento',
    hint: 'Ative os dias em que a conta atende e defina o horário de abertura/fechamento de cada um.',
    renderInput: HorarioFuncionamentoInput,
  },
  filialIntegracaoPedidoOuterRef: {
    label: 'Filial',
    section: 'Geral',
    renderInput: filialRefRenderInput(true),
  },
  tabelaNormalOuterRef: {
    label: 'Tabela de preços',
    section: 'Geral',
    renderInput: refRenderInput(listaDePrecosCollection, true),
  },
  tabelaPromocionalOuterRef: {
    label: 'Tabela promocional',
    section: 'Geral',
    renderInput: refRenderInput(listaDePrecosCollection, false),
  },
  operacaoOuterRef: {
    label: 'Operação fiscal',
    section: 'Geral',
    renderInput: refRenderInput(operacaoCollection, false),
  },
  operacaoDevolucaoOuterRef: {
    label: 'Operação de devolução',
    section: 'Geral',
    renderInput: refRenderInput(operacaoCollection, false),
  },
  depositoOuterRef: {
    label: 'Depósito',
    section: 'Geral',
    renderInput: refRenderInput(depositoCollection, true),
  },
};

/**
 * Fields hidden from the WhatsApp form:
 *  - `tipo` is pinned to 6 (whatsapp) in defaultValues — never user-pickable.
 *  - `cpf_cnpj`, `idCadIntTran`, `modalidadeFreteImportacao` are marketplace-
 *    oriented and irrelevant here, mirroring Balcão.
 *  - `dataCadastro` is stamped automatically on create.
 *  - `verificado` is set server-side once the number completes the Cloud API
 *    verification flow (#527/#529) — not hand-edited here, mirroring how the
 *    OAuth channels never expose their own connection-status flags as inputs.
 *  - the per-OTHER-channel account fields below (#289) are irrelevant to a
 *    WhatsApp account — see each field's own comment.
 */
export const whatsappExcludedFields = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'dataCadastro',
  'ultimaModificacao',
  'verificado',
  'user_id', // latent leak (rendered as a raw number input) — per-channel field, hidden here, surfaced by their own channel screens/flows
  'shop_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'main_account_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'tabelasAtacado', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'selling_partner_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
  'tenant_id', // per-channel fields — hidden here, surfaced by their own channel screens/flows
];
