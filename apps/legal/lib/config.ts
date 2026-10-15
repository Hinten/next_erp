export const LEGAL_FIELDS = [
  { key: 'LEGAL_CONTROLLER_NAME', label: 'Controlador' },
  { key: 'LEGAL_CONTROLLER_CNPJ', label: 'CNPJ' },
  { key: 'LEGAL_PRIVACY_EMAIL', label: 'Contato para privacidade' },
] as const;

export type LegalFieldKey = (typeof LEGAL_FIELDS)[number]['key'];

export interface LegalConfig {
  values: Record<LegalFieldKey, string | null>;
  showMissing: boolean;
}

/** Called during the request, after connection(); values are never cached. */
export function readLegalConfig(
  env: Partial<Record<LegalFieldKey | 'NODE_ENV', string>> = process.env,
): LegalConfig {
  return {
    values: {
      LEGAL_CONTROLLER_NAME: env.LEGAL_CONTROLLER_NAME?.trim() || null,
      LEGAL_CONTROLLER_CNPJ: env.LEGAL_CONTROLLER_CNPJ?.trim() || null,
      LEGAL_PRIVACY_EMAIL: env.LEGAL_PRIVACY_EMAIL?.trim() || null,
    },
    showMissing: env.NODE_ENV === 'development',
  };
}
