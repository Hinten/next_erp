import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { idProdutoFilhoShopee, idProdutoPaiShopee } from './produtoIds';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ITEM_ID = 2_500_139_861;
const MODEL_ID = 2_000_458_802;
/** O `shop_id` de fixture, usado só para exibir a grafia RECUSADA (escopo loja). */
const LOJA = 987_654;

/**
 * O mesmo digest que o módulo calcula, escrito aqui para que o teste compare
 * PREIMAGES em vez de reafirmar o módulo contra ele mesmo.
 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('idProdutoPaiShopee', () => {
  it('1. é sha256("shopee|<integracaoId>|<item_id>"), fixado byte a byte', () => {
    // ⚠️ O digest é fixado de propósito. O id legado era NÃO determinístico
    // (`sha256(µs + 20 chars aleatórios)`), então não há corpus a colidir — mas
    // a partir da primeira importação é o NOSSO corpus que carrega este id, e
    // trocar o preimage passa a forkar cada anúncio já importado.
    expect(idProdutoPaiShopee(CONTA, ITEM_ID)).toBe(
      '51eecf4c31ae3d612721726c7cfb5e12269b55eebf306dd53463f1695d16488c',
    );
    expect(idProdutoPaiShopee(CONTA, ITEM_ID)).toBe(sha256Hex(`shopee|${CONTA}|${ITEM_ID}`));
  });

  it('2. ⛔ NEAR-MISS: hífens no lugar dos pipes dão OUTRO id', () => {
    expect(idProdutoPaiShopee(CONTA, ITEM_ID)).not.toBe(sha256Hex(`shopee-${CONTA}-${ITEM_ID}`));
  });

  it('3. ⛔ NEAR-MISS: sem o prefixo do canal dá OUTRO id', () => {
    expect(idProdutoPaiShopee(CONTA, ITEM_ID)).not.toBe(sha256Hex(`${CONTA}|${ITEM_ID}`));
  });

  it('4. ⛔ NEAR-MISS: um pipe no fim dá OUTRO id', () => {
    expect(idProdutoPaiShopee(CONTA, ITEM_ID)).not.toBe(sha256Hex(`shopee|${CONTA}|${ITEM_ID}|`));
  });

  it('5. ⛔ NEAR-MISS: o separador é o que separa — ("int-1", 2500139861) e ("int-12", 500139861)', () => {
    // Sem os pipes os dois preimages viram a MESMA string
    // (`shopeeint-12500139861`) e dois anúncios diferentes cairiam num produto
    // só. É esta asserção que uma reformatação "inofensiva" do template quebra.
    expect(idProdutoPaiShopee('int-1', 2_500_139_861)).not.toBe(
      idProdutoPaiShopee('int-12', 500_139_861),
    );
    expect(idProdutoPaiShopee('int-12', 500_139_861)).toBe(
      '880d82b8fff5386a0e568ee29865dd0ff278c682d493a83efc2dd2d98f7d40f6',
    );
  });

  it('9. ⛔ NEAR-MISS: a grafia por LOJA (shop_id) é um id diferente da grafia por CONTA', () => {
    // A decisão O1 do plano, tornada visível: o escopo é a integração, não o
    // `shop_id`. Não existe constante que alterne os dois — a diferença fica
    // pinada aqui para que a escolha seja legível e não chaveável.
    expect(idProdutoPaiShopee(CONTA, ITEM_ID)).not.toBe(sha256Hex(`shopee|${LOJA}|${ITEM_ID}`));
    expect(sha256Hex(`shopee|${LOJA}|${ITEM_ID}`)).toBe(
      'e61062352acc21f52a34bd8d99162a661058cda769717cfa8cff6391711b76ef',
    );
  });

  it('10. String(item_id) é decimal em toda a faixa do wire — nunca exponencial', () => {
    const maximo = Number.MAX_SAFE_INTEGER;
    expect(`shopee|${CONTA}|${maximo}`).toBe('shopee|int-1|9007199254740991');
    expect(`shopee|${CONTA}|${maximo}`).not.toContain('e+');
    expect(idProdutoPaiShopee(CONTA, maximo)).toBe(
      '1142b52a7f86f430a73a912fceafcb9400432d2a853379b99b2e68bb182b9a82',
    );
    expect(idProdutoPaiShopee(CONTA, maximo)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('idProdutoFilhoShopee', () => {
  it('6. é sha256("<paiId>|<model_id>"), fixado byte a byte', () => {
    const pai = idProdutoPaiShopee(CONTA, ITEM_ID);
    expect(idProdutoFilhoShopee(pai, MODEL_ID)).toBe(
      'be6f172c10fd4632f5986c81ab479d7c41c7d8477b9e5ffaba74819b8b70f933',
    );
    expect(idProdutoFilhoShopee(pai, MODEL_ID)).toBe(sha256Hex(`${pai}|${MODEL_ID}`));
  });

  it('7. ⛔ NEAR-MISS: ("a", 12) e ("a1", 2) não colidem', () => {
    expect(idProdutoFilhoShopee('a', 12)).not.toBe(idProdutoFilhoShopee('a1', 2));
  });

  it('8. ⛔ NEAR-MISS: o id de FILHO e o de PAI sobre os mesmos argumentos são diferentes', () => {
    const pai = idProdutoPaiShopee(CONTA, ITEM_ID);
    // O pai leva o prefixo `shopee|`; o filho, não. Sem essa diferença um
    // model_id que por acaso valesse um item_id colidiria entre os dois níveis.
    expect(idProdutoFilhoShopee(pai, MODEL_ID)).not.toBe(idProdutoPaiShopee(pai, MODEL_ID));
  });

  it('é estável entre duas leituras e muda com o pai e com o model', () => {
    const pai = idProdutoPaiShopee(CONTA, ITEM_ID);
    const outroPai = idProdutoPaiShopee('int-2', ITEM_ID);
    expect(idProdutoFilhoShopee(pai, MODEL_ID)).toBe(idProdutoFilhoShopee(pai, MODEL_ID));
    expect(idProdutoFilhoShopee(outroPai, MODEL_ID)).not.toBe(idProdutoFilhoShopee(pai, MODEL_ID));
    expect(idProdutoFilhoShopee(pai, MODEL_ID + 1)).not.toBe(idProdutoFilhoShopee(pai, MODEL_ID));
  });
});
