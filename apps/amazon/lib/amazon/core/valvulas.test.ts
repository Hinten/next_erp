import { describe, expect, it } from 'vitest';

import { loggerEspiao } from '../testing/fixtures';
import {
  CHAMADAS_ENV_AMAZON,
  classificarValorDeChamadas,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from './valvulas';

describe('lerChaveDeChamadasAmazon', () => {
  it('pins the variable name', () => {
    expect(CHAMADAS_ENV_AMAZON).toBe('AMAZON_CHAMADAS');
  });

  it('passes ONLY the exact `on`', () => {
    expect(lerChaveDeChamadasAmazon({ AMAZON_CHAMADAS: 'on' })).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['off', 'off'],
    // Near-misses: each LOOKS right, and must still not call Amazon.
    ['ON', 'ON'],
    ['On', 'On'],
    ['leading space', ' on'],
    ['trailing space', 'on '],
    ['trailing newline', 'on\n'],
    ['true', 'true'],
    ['1', '1'],
  ])('%s → off', (_c, valor) => {
    expect(lerChaveDeChamadasAmazon({ AMAZON_CHAMADAS: valor })).toBe(false);
  });
});

describe('classificarValorDeChamadas', () => {
  it.each([
    [undefined, 'ausente'],
    ['', 'ausente'],
    ['off', 'off'],
    ['OFF', 'outro'],
    [' ', 'outro'],
    ['ON', 'outro'],
    ['on', 'outro'],
  ] as const)('%j → %s', (valor, classe) => {
    expect(classificarValorDeChamadas(valor)).toBe(classe);
  });
});

describe('registrarChamadaBloqueadaAmazon', () => {
  it('writes ONE INFO line while simply off, naming the route and the class', () => {
    const { logger, linhas } = loggerEspiao();
    registrarChamadaBloqueadaAmazon(logger, { rota: 'oauth-start', valor: undefined });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('info');
    expect(linhas[0]?.meta).toEqual({
      evento: 'chamada-bloqueada',
      rota: 'oauth-start',
      chave: 'AMAZON_CHAMADAS',
      valor: 'ausente',
    });
  });

  it('writes a WARNING for a mis-set value, and never echoes the raw text', () => {
    const { logger, linhas } = loggerEspiao();
    const cru = 'ON-colado-por-engano';
    registrarChamadaBloqueadaAmazon(logger, { rota: 'contexto', valor: cru });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.meta?.valor).toBe('outro');
    expect(JSON.stringify(linhas)).not.toContain(cru);
  });

  it('`off` is INFO too', () => {
    const { logger, linhas } = loggerEspiao();
    registrarChamadaBloqueadaAmazon(logger, { rota: 'oauth-callback', valor: 'off' });
    expect(linhas[0]?.nivel).toBe('info');
  });
});

// The stdout sink moved to `log.ts`; its tests are `log.test.ts`.
