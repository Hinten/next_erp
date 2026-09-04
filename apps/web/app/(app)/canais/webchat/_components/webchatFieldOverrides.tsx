'use client';

import { stripMarkedForDeletion, type FieldConfig } from '@delfrance/ui';
import { HexColorField } from './HexColorField';
import { HorarioFuncionamentoField } from './HorarioFuncionamentoField';
import { IconeField } from './IconeField';
import { MensagensInatividadeField } from './MensagensInatividadeField';
import { MensagensPadraoField } from './MensagensPadraoField';

/**
 * Tab order for the webchat create/edit screens — mirrors the legacy
 * `CadastroWebcharView` tabs (#558): Dados Gerais, Cores, Horário de
 * Funcionamento. Consumed by `ObjectView`'s `sections` prop; per-field
 * assignment lives on each `FieldConfig.section` below.
 */
export const WEBCHAT_SECTIONS: string[] = ['Dados Gerais', 'Cores', 'Horário de Funcionamento'];

/**
 * Field config shared by the webchat create and edit screens.
 */
export const webchatFields: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Dados Gerais' },
  url: { section: 'Dados Gerais' },
  posicionamento: { label: 'Posicionamento', section: 'Dados Gerais' },
  icone: { label: 'Ícone', section: 'Dados Gerais', renderInput: IconeField },
  saudacao: { section: 'Dados Gerais', kind: 'longText' },

  corBorda: { section: 'Cores', renderInput: HexColorField },
  corIcone: { section: 'Cores', renderInput: HexColorField },
  corCabecalho: { section: 'Cores', renderInput: HexColorField },
  corBolhaInatividade: { section: 'Cores', renderInput: HexColorField },
  corCorpoChat: { section: 'Cores', renderInput: HexColorField },
  corTextoChat: { section: 'Cores', renderInput: HexColorField },

  horario_funcionamento: {
    label: 'Horário de funcionamento',
    section: 'Horário de Funcionamento',
    hint: 'Ative os dias em que o widget atende e defina o horário de abertura/fechamento de cada um.',
    renderInput: HorarioFuncionamentoField,
  },
  mensagens_padrao: {
    label: 'Mensagens padrão',
    section: 'Horário de Funcionamento',
    hint: 'Até 3 respostas rápidas oferecidas ao visitante.',
    renderInput: MensagensPadraoField,
  },
  mensagens_inatividade: {
    label: 'Mensagens de inatividade',
    section: 'Horário de Funcionamento',
    hint: 'Até 3 mensagens disparadas após o visitante ficar inativo pelo tempo configurado.',
    renderInput: MensagensInatividadeField,
    prepareForSave: stripMarkedForDeletion,
  },
};

/** Fields hidden from the webchat form: audit stamps only. */
export const webchatExcludedFields: string[] = ['timestamp', 'ultimaModificacao'];
