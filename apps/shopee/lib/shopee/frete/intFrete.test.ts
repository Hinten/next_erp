/**
 * The app's ONE binding of the shared `int_frete` ⇆ conta core: the Shopee row, and no option.
 * The core's behaviour is the core's suite (`intFreteContaSync.test.ts`, which runs every row,
 * Shopee's included); this pins only what the binding chose, with Shopee's near-misses.
 *
 * The core factory is wrapped — not replaced — so every behaviour below is the REAL binding's,
 * while the argument list the module built it with is recorded: an options object (Mercado
 * Livre's `refTolerante`) would turn on the tolerant scan the Shopee path must never run, and
 * would diverge from the window pass, which binds the same row with the same zero options.
 */
import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_FRETE, INTEGRACAO_TIPO, VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

const nucleo = vi.hoisted(() => ({ chamadas: [] as unknown[][] }));
vi.mock('@delfrance/data/admin/frete', async (importOriginal) => {
  const real = await importOriginal<typeof import('@delfrance/data/admin/frete')>();
  return {
    ...real,
    intFreteContaSync: (...args: Parameters<typeof real.intFreteContaSync>) => {
      nucleo.chamadas.push(args);
      return real.intFreteContaSync(...args);
    },
  };
});

const { syncIntFreteShopee } = await import('./intFrete');

const CONTA = 'int-1';
const CANONICA = `documents/integracao/${CONTA}`;
/** An obviously fake id in the legacy shape (an auto id). */
const ID_LEGADO = 'LegacyAutoId0000001';

describe('syncIntFreteShopee', () => {
  it('amarra a linha shopee com ZERO opções — o próprio objeto, uma vez', () => {
    // Exactly ONE argument list with exactly ONE argument: `[row, {}]` or
    // `[row, { refTolerante }]` both fail here.
    expect(nucleo.chamadas).toEqual([[VINCULO_INT_FRETE_CONTA.shopee]]);
    expect(nucleo.chamadas[0]).toHaveLength(1);
    expect(nucleo.chamadas[0]![0]).toBe(VINCULO_INT_FRETE_CONTA.shopee);
    expect(syncIntFreteShopee.vinculo).toBe(VINCULO_INT_FRETE_CONTA.shopee);
    expect(syncIntFreteShopee.refCanonicalDaConta(CONTA)).toBe(CANONICA);
  });

  it('sem varredura tolerante: um doc com a back-ref NUA não é desta conta (quase-erro: a canônica é)', () => {
    const base = { tipo: INTEGRACAO_FRETE.shopee, ativo: true, dataCadastro: 1 };
    const nua = {
      id: ID_LEGADO,
      data: { ...base, contaShopeeFreteOuterRef: `integracao/${CONTA}` },
    };
    const canonica = { id: ID_LEGADO, data: { ...base, contaShopeeFreteOuterRef: CANONICA } };
    expect(syncIntFreteShopee.escolherIntFreteDaConta([nua], CONTA)).toBeNull();
    expect(syncIntFreteShopee.escolherIntFreteDaConta([canonica], CONTA)).toBe(canonica);
  });

  it('cria no id determinístico `shopee-<id>` (quase-erros: `Shopee-` e `shp-` são outros ids)', () => {
    const conta = {
      tipo: INTEGRACAO_TIPO.shopee,
      nome: 'Conta de teste',
      filialIntegracaoPedidoOuterRef: 'documents/filiais/f1',
      dataCadastro: 1,
    };
    expect(syncIntFreteShopee.planejarIntFreteDaConta(CONTA, conta, null)).toMatchObject({
      acao: 'criar',
      id: `shopee-${CONTA}`,
    });
    const corpo = { tipo: INTEGRACAO_FRETE.shopee, contaShopeeFreteOuterRef: null };
    const deterministica = { id: `shopee-${CONTA}`, data: corpo };
    const maiuscula = { id: `Shopee-${CONTA}`, data: corpo };
    const abreviada = { id: `shp-${CONTA}`, data: corpo };
    expect(syncIntFreteShopee.escolherIntFreteDaConta([maiuscula, abreviada], CONTA)).toBeNull();
    expect(
      syncIntFreteShopee.escolherIntFreteDaConta([maiuscula, abreviada, deterministica], CONTA),
    ).toBe(deterministica);
  });

  it('ehConta: só o INT 5 (quase-erros: a STRING `5`, Mercado Livre, Amazon, nada)', () => {
    expect(syncIntFreteShopee.ehConta({ tipo: INTEGRACAO_TIPO.shopee })).toBe(true);
    expect(syncIntFreteShopee.ehConta({ tipo: String(INTEGRACAO_TIPO.shopee) })).toBe(false);
    expect(syncIntFreteShopee.ehConta({ tipo: INTEGRACAO_TIPO.mercadoLivre })).toBe(false);
    expect(syncIntFreteShopee.ehConta({ tipo: INTEGRACAO_TIPO.amazon })).toBe(false);
    expect(syncIntFreteShopee.ehConta(null)).toBe(false);
  });
});
