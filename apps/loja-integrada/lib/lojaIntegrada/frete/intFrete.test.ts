/**
 * The app's ONE binding of the shared `int_frete` ⇆ conta core: the Loja Integrada row, and no
 * option. The core's behaviour is the core's suite (`intFreteContaSync.test.ts`, which runs every
 * row); this pins only what the binding chose.
 */
import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { syncIntFreteLi } from './intFrete';

const CONTA = 'conta-li-x';

describe('syncIntFreteLi', () => {
  it('binds the lojaIntegrada row', () => {
    expect(syncIntFreteLi.vinculo).toBe(VINCULO_INT_FRETE_CONTA.lojaIntegrada);
    expect(syncIntFreteLi.refCanonicalDaConta(CONTA)).toBe(`documents/integracao/${CONTA}`);
  });

  it('takes no tolerant scan: a doc with the BARE back-ref is not this conta’s (near-miss: the canonical one is)', () => {
    const base = { tipo: 'lojaIntegrada', dataCadastro: 1 };
    const nua = {
      id: 'auto-1',
      data: { ...base, contaLojaIntegradaEnviosOuterRef: `integracao/${CONTA}` },
    };
    const canonica = {
      id: 'auto-2',
      data: { ...base, contaLojaIntegradaEnviosOuterRef: `documents/integracao/${CONTA}` },
    };
    expect(syncIntFreteLi.escolherIntFreteDaConta([nua], CONTA)).toBeNull();
    expect(syncIntFreteLi.escolherIntFreteDaConta([nua, canonica], CONTA)).toBe(canonica);
  });

  it('creates at the deterministic `lojaIntegrada-<id>`, and falls back to it (near-miss: `lojaintegrada-` is another id)', () => {
    const conta = {
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      nome: 'Loja de teste',
      filialIntegracaoPedidoOuterRef: 'documents/filiais/f1',
      dataCadastro: 1,
    };
    expect(syncIntFreteLi.planejarIntFreteDaConta(CONTA, conta, null)).toMatchObject({
      acao: 'criar',
      id: `lojaIntegrada-${CONTA}`,
    });
    const outra = { id: `lojaintegrada-${CONTA}`, data: { tipo: 'lojaIntegrada' } };
    const deterministica = { id: `lojaIntegrada-${CONTA}`, data: { tipo: 'lojaIntegrada' } };
    expect(syncIntFreteLi.escolherIntFreteDaConta([outra], CONTA)).toBeNull();
    expect(syncIntFreteLi.escolherIntFreteDaConta([outra, deterministica], CONTA)).toBe(
      deterministica,
    );
  });
});
