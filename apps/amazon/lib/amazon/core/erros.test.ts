import { describe, expect, it } from 'vitest';
import { AmazonError } from '@delfrance/integrations-amazon-sp-api';

import * as erros from './erros';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
  ErroAppAmazon,
  EstacionamentoAmazonEmConflitoError,
} from './erros';

const ID = 'conta-1';

const INSTANCIAS: readonly ErroAppAmazon[] = [
  new ContaAmazonNaoEncontradaError(ID),
  new ContaAmazonInativaError(ID),
  new ContaAmazonNaoConectadaError(ID),
  new CredencialAmazonAusenteError(ID),
  new CredencialAmazonInvalidaError(ID, ['reconexaoPendente.status', '(raiz)']),
  new ContaAmazonParadaError(ID, 400, 1_800_000_000_000),
  new EstacionamentoAmazonEmConflitoError(ID, 3),
  new ChamadasAmazonDesligadasError(ID),
  new ChamadasAmazonDesligadasError(null),
  new ConfigAmazonAusenteError(['AMAZON_LWA_CLIENT_SECRET']),
];

describe('the app errors', () => {
  it('cover every exported subclass (the list below is total)', () => {
    const exportadas: unknown[] = Object.values(erros).filter(
      (v) =>
        typeof v === 'function' && (v as { prototype: unknown }).prototype instanceof ErroAppAmazon,
    );
    const instanciadas = new Set<unknown>(INSTANCIAS.map((e) => e.constructor));
    for (const classe of exportadas) {
      expect(instanciadas.has(classe), (classe as { name: string }).name).toBe(true);
    }
    expect(exportadas.length).toBe(9);
  });

  it('none is an AmazonError, so a step-3 `instanceof AmazonError` arm can never swallow one', () => {
    for (const e of INSTANCIAS) {
      expect(e, e.name).toBeInstanceOf(ErroAppAmazon);
      expect(e, e.name).not.toBeInstanceOf(AmazonError);
      expect(e.name).not.toBe('ErroAppAmazon');
    }
  });

  it('carry their structured fields; the corrupt one names PATHS only', () => {
    const inv = new CredencialAmazonInvalidaError(ID, ['acessoRef']);
    expect(inv.campos).toEqual(['acessoRef']);
    expect(inv.message).toContain('acessoRef');
    const parada = new ContaAmazonParadaError(ID, 401, 123);
    expect([parada.status, parada.desdeMs]).toEqual([401, 123]);
    expect(new ConfigAmazonAusenteError(['A', 'B']).message).toContain('A, B');
    expect(new ChamadasAmazonDesligadasError(null).integracaoId).toBeNull();
  });
});
