/**
 * The app's ONE binding of the shared `int_frete` ⇆ conta core: the Amazon row, and no option.
 * The core's behaviour is the core's suite (`intFreteContaSync.test.ts`, which runs every row,
 * Amazon's included); this pins only what the binding chose, with Amazon's near-misses.
 */
import { describe, expect, it } from 'vitest';
import { INTEGRACAO_FRETE, INTEGRACAO_TIPO, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

import { syncIntFreteAmazon } from './intFrete';

const CONTA = 'conta-amz-x';
const CANONICA = `documents/integracao/${CONTA}`;
/** An obviously fake id in the legacy shape (64 hex digits). */
const ID_LEGADO = 'ab'.repeat(32);

describe('syncIntFreteAmazon', () => {
  it('binds the amazon row — the very object, not a copy', () => {
    expect(syncIntFreteAmazon.vinculo).toBe(VINCULO_INT_FRETE_CONTA.amazon);
    expect(syncIntFreteAmazon.refCanonicalDaConta(CONTA)).toBe(CANONICA);
  });

  it('takes no tolerant scan: a doc with the BARE back-ref is not this conta’s (near-miss: the canonical one is)', () => {
    const base = { tipo: INTEGRACAO_FRETE.amazon, dataCadastro: 1 };
    const nua = {
      id: ID_LEGADO,
      data: { ...base, contaAmazonContaFreteAmazonOuterRef: `integracao/${CONTA}` },
    };
    const canonica = {
      id: ID_LEGADO,
      data: { ...base, contaAmazonContaFreteAmazonOuterRef: CANONICA },
    };
    expect(syncIntFreteAmazon.escolherIntFreteDaConta([nua], CONTA)).toBeNull();
    expect(syncIntFreteAmazon.escolherIntFreteDaConta([canonica], CONTA)).toBe(canonica);
  });

  it('creates at the deterministic `amz-<id>`, and falls back to it (near-misses: `amazon-` and `AMZ-` are other ids)', () => {
    const conta = {
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste',
      filialIntegracaoPedidoOuterRef: 'documents/filiais/f1',
      dataCadastro: 1,
    };
    expect(syncIntFreteAmazon.planejarIntFreteDaConta(CONTA, conta, null)).toMatchObject({
      acao: 'criar',
      id: `amz-${CONTA}`,
    });
    // A doc AT the deterministic id with a blank ref is still this conta's (a back-ref altered
    // by hand); the same body at either near-miss id is nobody's.
    const corpo = { tipo: INTEGRACAO_FRETE.amazon, contaAmazonContaFreteAmazonOuterRef: null };
    const deterministica = { id: `amz-${CONTA}`, data: corpo };
    const doTipoConta = { id: `amazon-${CONTA}`, data: corpo };
    const maiuscula = { id: `AMZ-${CONTA}`, data: corpo };
    expect(syncIntFreteAmazon.escolherIntFreteDaConta([doTipoConta, maiuscula], CONTA)).toBeNull();
    expect(
      syncIntFreteAmazon.escolherIntFreteDaConta([doTipoConta, maiuscula, deterministica], CONTA),
    ).toBe(deterministica);
  });

  it('ehConta: the INT 8 only (near-misses: the STRING `8`, Loja Integrada, Shopee, nothing)', () => {
    expect(syncIntFreteAmazon.ehConta({ tipo: INTEGRACAO_TIPO.amazon })).toBe(true);
    expect(syncIntFreteAmazon.ehConta({ tipo: 8 })).toBe(true);
    expect(syncIntFreteAmazon.ehConta({ tipo: '8' })).toBe(false);
    expect(syncIntFreteAmazon.ehConta({ tipo: INTEGRACAO_TIPO.lojaIntegrada })).toBe(false);
    expect(syncIntFreteAmazon.ehConta({ tipo: INTEGRACAO_TIPO.shopee })).toBe(false);
    expect(syncIntFreteAmazon.ehConta(null)).toBe(false);
    expect(syncIntFreteAmazon.ehConta(undefined)).toBe(false);
  });

  it('ehDocDaConta: tipo `amz` AND this conta’s canonical ref (near-misses: tipo `amazon`, tipo `shopee`, another conta)', () => {
    expect(
      syncIntFreteAmazon.ehDocDaConta(
        { tipo: 'amz', contaAmazonContaFreteAmazonOuterRef: CANONICA },
        CONTA,
      ),
    ).toBe(true);
    // The conta-tipo KEY's spelling is not the on-disk freight tipo.
    expect(
      syncIntFreteAmazon.ehDocDaConta(
        { tipo: 'amazon', contaAmazonContaFreteAmazonOuterRef: CANONICA },
        CONTA,
      ),
    ).toBe(false);
    expect(
      syncIntFreteAmazon.ehDocDaConta(
        { tipo: INTEGRACAO_FRETE.shopee, contaAmazonContaFreteAmazonOuterRef: CANONICA },
        CONTA,
      ),
    ).toBe(false);
    expect(
      syncIntFreteAmazon.ehDocDaConta(
        { tipo: 'amz', contaAmazonContaFreteAmazonOuterRef: 'documents/integracao/outra-conta' },
        CONTA,
      ),
    ).toBe(false);
  });
});
