import type {
  ConfCOFINS,
  ConfPIS,
  ConfiguracaoIBSCBS,
  ConfiguracaoICMS,
  ConfiguracaoIPI,
  ConfiguracaoISSQN,
  ConfiguracaoPISST,
  Retencao,
} from '@delfrance/schemas';

/**
 * The per-item Imposto blob the {@link ImpostoConfigEditor} edits — the
 * Flutter-shape config carried (typed) by every Imposto-bearing doc: the
 * operação default, `produtos/{}/imposto`, `categorias/{}/impostocategoria` and
 * `operacao/{}/regraimposto`.
 *
 * All fields optional/nullable: a doc may carry only a subset, and the editor
 * **patches** what it touches (never rebuilds), so config sections it doesn't
 * surface interactively — e.g. a legacy Regime Normal ICMS blob — survive a
 * round-trip untouched.
 */
export interface ImpostoConfigValue {
  // Dados Gerais (lenient strings, like the stored Imposto).
  origem?: string | null;
  cfop?: string | null;
  cfopInterestadual?: string | null;
  NCM?: string | null;
  NVE?: string | null;
  CEST?: string | null;
  indEscala?: string | null;
  CNPJFab?: string | null;
  cBenef?: string | null;
  extipi?: string | null;
  unidade?: string | null;
  compoeValorTotalDaNFe?: boolean | null;
  // Deep tribute configs.
  configuracaoICMS?: ConfiguracaoICMS | null;
  configuracaoIPI?: ConfiguracaoIPI | null;
  configuracaoPIS?: ConfPIS | null;
  configuracaoCOFINS?: ConfCOFINS | null;
  configuracaoPISST?: ConfiguracaoPISST | null;
  configuracaoISSQN?: ConfiguracaoISSQN | null;
  retencao?: Retencao | null;
  // RTC (IBS/CBS/IS) — held leniently in storage; the editor parses/writes the
  // typed shape but tolerates a partial blob.
  configuracaoIBSCBS?: ConfiguracaoIBSCBS | null;
  // Tolerate any extra legacy keys (never dropped on patch).
  [key: string]: unknown;
}

/** The `configuracao*` keys the editor manages (everything tax-config). */
export const IMPOSTO_CONFIG_KEYS = [
  'configuracaoICMS',
  'configuracaoIPI',
  'configuracaoPIS',
  'configuracaoCOFINS',
  'configuracaoPISST',
  'configuracaoISSQN',
  'retencao',
  'configuracaoIBSCBS',
] as const;

/** The Dados Gerais (fiscal) keys the editor surfaces when `showDadosGerais`. */
export const IMPOSTO_DADOS_GERAIS_KEYS = [
  'origem',
  'cfop',
  'cfopInterestadual',
  'NCM',
  'NVE',
  'CEST',
  'indEscala',
  'CNPJFab',
  'cBenef',
  'extipi',
  'unidade',
  'compoeValorTotalDaNFe',
] as const;
