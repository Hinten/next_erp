import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOKEN_SHOPEE_PARA_LOG, tokenParaLog } from './tokenParaLog';

const MARCADOR = '<nao-token>';

describe('tokenParaLog — o que é token (verbatim) e o que vira marcador', () => {
  it.each([
    ['NOT_RECEIPT'],
    ['ACCEPTED'],
    ['return_status'],
    ['LOGISTICS_PENDING_ARRANGE'],
    ['a'],
    ['0'],
    ['Z'.repeat(64)],
  ])('IGUAL: o token %j passa VERBATIM (nem aparado, nem dobrado de caixa)', (token) => {
    expect(tokenParaLog(token)).toBe(token);
  });

  it('a caixa é MANTIDA: `Accepted` e `ACCEPTED` são dois tokens distintos no log', () => {
    expect(tokenParaLog('Accepted')).toBe('Accepted');
    expect(tokenParaLog('Accepted')).not.toBe(tokenParaLog('ACCEPTED'));
  });

  it.each([
    ['vazio', ''],
    ['espaço à esquerda', ' NOT_RECEIPT'],
    ['espaço à direita', 'NOT_RECEIPT '],
    ['tab', 'NOT_RECEIPT\t'],
    ['espaço no meio (o token documentado do trânsito)', 'Delivery Failed'],
    ['um código pontuado', 'returns.error_data'],
    ['hífen', 'NOT-RECEIPT'],
    ['a sentinela `-`', '-'],
    ['acentuado', 'DEVOLUÇÃO'],
    ['65 caracteres', 'Z'.repeat(65)],
    ['texto livre', 'O comprador disse que a caixa chegou amassada'],
    ['quebra de linha', 'NOT_RECEIPT\n'],
  ])('QUASE-IGUAL: %s ⇒ o marcador, nunca o valor', (_r, valor) => {
    const r = tokenParaLog(valor);
    expect(r).toBe(MARCADOR);
    // (`-` is one character of the marker itself, so only a longer value can be echoed.)
    if (valor.trim().length > 1) expect(r).not.toContain(valor.trim());
  });

  it('null e undefined ⇒ null (ausência, não um marcador)', () => {
    expect(tokenParaLog(null)).toBeNull();
    expect(tokenParaLog(undefined)).toBeNull();
  });

  it('a regex não tem flags — `.test` repetido responde igual (um `g` alternaria)', () => {
    expect(TOKEN_SHOPEE_PARA_LOG.flags).toBe('');
    expect(TOKEN_SHOPEE_PARA_LOG.source).toBe('^[A-Za-z0-9_]{1,64}$');
    expect([1, 2, 3].map(() => tokenParaLog('NOT_RECEIPT'))).toEqual([
      'NOT_RECEIPT',
      'NOT_RECEIPT',
      'NOT_RECEIPT',
    ]);
  });
});

describe('UMA cópia — nenhum outro módulo de `devolucoes/` reescreve a regex', () => {
  const PASTA = fileURLToPath(new URL('.', import.meta.url));
  const fontes = readdirSync(PASTA).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'tokenParaLog.ts',
  );

  it('a pasta tem fontes para varrer (o scan não é vácuo)', () => {
    expect(fontes).toContain('importarDevolucao.ts');
    expect(fontes).toContain('pushDevolucao.ts');
  });

  it.each(['[A-Za-z0-9_]{1,64}', "'<nao-token>'"])(
    'nenhuma fonte além de tokenParaLog.ts contém %s',
    (copia) => {
      for (const f of fontes) {
        expect(readFileSync(`${PASTA}${f}`, 'utf8'), f).not.toContain(copia);
      }
    },
  );

  it('o importador e o parser do push IMPORTAM a regra única', () => {
    for (const f of ['importarDevolucao.ts', 'pushDevolucao.ts']) {
      expect(readFileSync(`${PASTA}${f}`, 'utf8'), f).toContain("from './tokenParaLog'");
    }
  });
});
