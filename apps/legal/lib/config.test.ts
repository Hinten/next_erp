import { describe, expect, it } from 'vitest';
import { readLegalConfig } from './config';

describe('request-time legal identity', () => {
  it('reads configured values and trims surrounding whitespace', () => {
    expect(
      readLegalConfig({
        NODE_ENV: 'production',
        LEGAL_CONTROLLER_NAME: '  Empresa Exemplo  ',
        LEGAL_CONTROLLER_CNPJ: '  00.000.000/0001-00 ',
        LEGAL_PRIVACY_EMAIL: ' privacidade@example.com ',
      }),
    ).toEqual({
      values: {
        LEGAL_CONTROLLER_NAME: 'Empresa Exemplo',
        LEGAL_CONTROLLER_CNPJ: '00.000.000/0001-00',
        LEGAL_PRIVACY_EMAIL: 'privacidade@example.com',
      },
      showMissing: false,
    });
  });

  it.each([undefined, '', ' \t\n '])('treats %s as missing without a legacy fallback', (value) => {
    const config = readLegalConfig({
      NODE_ENV: 'development',
      LEGAL_CONTROLLER_NAME: value,
      LEGAL_CONTROLLER_CNPJ: value,
      LEGAL_PRIVACY_EMAIL: value,
    });
    expect(Object.values(config.values)).toEqual([null, null, null]);
    expect(config.showMissing).toBe(true);
  });

  it('keeps provided fields when other fields are missing', () => {
    const config = readLegalConfig({
      NODE_ENV: 'production',
      LEGAL_PRIVACY_EMAIL: 'privacy@example.com',
    });
    expect(config.values).toEqual({
      LEGAL_CONTROLLER_NAME: null,
      LEGAL_CONTROLLER_CNPJ: null,
      LEGAL_PRIVACY_EMAIL: 'privacy@example.com',
    });
  });

  it.each(['production', 'test', undefined])(
    'does not expose debug notices in %s',
    (environment) => {
      expect(readLegalConfig({ NODE_ENV: environment }).showMissing).toBe(false);
    },
  );
});
