import { describe, expect, it } from 'vitest';
import { ShopeeError } from '@delfrance/integrations-shopee';

import { erroContidoPorConta } from '../core/containment';
// ⚠️ `respond.ts` imports `next/server` and is therefore NOT Next-free — which is
// exactly why no MODULE under `produtos/` may import it. A TEST may: it never
// reaches the Cloud Functions bundle, and the property under test is precisely
// that the two sides agree about this class.
import { isShopeeError } from '../core/respond';
import {
  MOTIVO_FALHA_JOB,
  MOTIVO_IMPORT_BLOQUEADO,
  ShopeeImportBlockedError,
} from './errosImportacao';

const ITEM_ID = 2500139861;

describe('MOTIVO_IMPORT_BLOQUEADO', () => {
  it('1 — o vocabulário bloqueado é EXATAMENTE estes oito slugs', () => {
    // A PERSISTED vocabulary (`importacoesShopee.failures[].motivo`). This list
    // is the pin: renaming a member orphans every row already written, and
    // adding one silently is how a UI grows a filter nobody declared.
    expect([...Object.values(MOTIVO_IMPORT_BLOQUEADO)].sort()).toEqual([
      'item-deletado',
      'item-nao-encontrado',
      'item-nao-retornado',
      'kit-componente-nao-vinculado',
      'kit-sem-detalhe',
      'sem-nome',
      'taxonomia-em-conflito',
      'vinculo-inconsistente',
    ]);
  });

  it('2 — ⛔ NEAR-MISS: `kit-nao-importado` NÃO é membro (era o slug do braço K2)', () => {
    // Lucas escolheu K1 — um kit É importado assim que todos os componentes
    // resolvem —, então `kit-nao-importado` nomeia uma decisão que este build
    // nunca toma. Um membro que nada consegue produzir é um filtro vazio na tela.
    const valores: readonly string[] = Object.values(MOTIVO_IMPORT_BLOQUEADO);
    expect(valores).not.toContain('kit-nao-importado');
    const doJob: readonly string[] = Object.values(MOTIVO_FALHA_JOB);
    expect(doJob).not.toContain('kit-nao-importado');
  });

  it('3 — todo slug é kebab-case ASCII minúsculo', () => {
    // O slug viaja em JSON, vira chave de agrupamento e aparece numa URL de
    // filtro: acento, espaço, maiúscula e `_` estão todos fora.
    for (const slug of Object.values(MOTIVO_FALHA_JOB)) {
      expect(slug, slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it('4 — as CHAVES do const casam com os slugs em camelCase', () => {
    // O `as const satisfies` já garante o TIPO dos valores; isto garante que a
    // chave que o código escreve (`MOTIVO_IMPORT_BLOQUEADO.semNome`) e o slug
    // que o Firestore guarda (`sem-nome`) não possam divergir em silêncio.
    for (const [chave, slug] of Object.entries(MOTIVO_IMPORT_BLOQUEADO)) {
      const emCamel = slug.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(chave, slug).toBe(emCamel);
    }
  });
});

describe('MOTIVO_FALHA_JOB', () => {
  it('5 — o vocabulário do job é o bloqueado MAIS `erro-shopee` e `erro-schema`', () => {
    expect([...Object.values(MOTIVO_FALHA_JOB)].sort()).toEqual(
      [...Object.values(MOTIVO_IMPORT_BLOQUEADO), 'erro-shopee', 'erro-schema'].sort(),
    );
    expect(Object.values(MOTIVO_FALHA_JOB)).toHaveLength(10);
  });

  it('6 — ⛔ NEAR-MISS: os dois slugs de JOB não pertencem ao vocabulário BLOQUEADO', () => {
    // O importador nunca lança `erro-shopee`/`erro-schema`: por trás deles já
    // existem classes (`ShopeeApiError`, `ShopeeSchemaError`) que o job traduz.
    // Se escorregassem para o conjunto bloqueado, um `ShopeeImportBlockedError`
    // passaria a poder carregar um motivo que ninguém decidiu ao ler o anúncio.
    const bloqueados: readonly string[] = Object.values(MOTIVO_IMPORT_BLOQUEADO);
    expect(bloqueados).not.toContain('erro-shopee');
    expect(bloqueados).not.toContain('erro-schema');
  });
});

describe('ShopeeImportBlockedError', () => {
  it('7 — é um ShopeeError e um Error, e se anuncia pelo `name`', () => {
    const err = new ShopeeImportBlockedError(MOTIVO_IMPORT_BLOQUEADO.semNome, ITEM_ID);
    expect(err).toBeInstanceOf(ShopeeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ShopeeImportBlockedError');
  });

  it('8 — carrega motivo e itemId, e a mensagem NOMEIA os dois', () => {
    const err = new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.vinculoInconsistente,
      ITEM_ID,
      'um prodshopee foi encontrado sob um produto filho',
    );
    expect(err.motivo).toBe('vinculo-inconsistente');
    expect(err.itemId).toBe(ITEM_ID);
    expect(err.mensagem).toBe('um prodshopee foi encontrado sob um produto filho');
    expect(err.message).toBe(
      'Importação bloqueada (vinculo-inconsistente) no item 2500139861: um prodshopee foi encontrado sob um produto filho',
    );
  });

  it('9 — sem detalhe a mensagem não ganha `:` pendurado, e `mensagem` é a string vazia', () => {
    // `failures[].mensagem` tem `.default('')` no schema: um `undefined` não
    // sobrevive a um `addDoc`/`setDoc` do SDK, então a classe já normaliza.
    const semDetalhe = new ShopeeImportBlockedError(MOTIVO_IMPORT_BLOQUEADO.itemDeletado, ITEM_ID);
    expect(semDetalhe.mensagem).toBe('');
    expect(semDetalhe.message).toBe('Importação bloqueada (item-deletado) no item 2500139861');

    const detalheVazio = new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.itemDeletado,
      ITEM_ID,
      '',
    );
    expect(detalheVazio.message).toBe(semDetalhe.message);
  });

  it('10 — um item_id grande entra INTEIRO na mensagem, e `0` é um valor real', () => {
    // A mensagem é o que o operador cola na busca, então o id não pode chegar
    // truncado nem arredondado. E `0` é um valor como outro qualquer: nada aqui
    // decide por truthiness (o mesmo erro que fez o legado tratar `model_id: 0`
    // como ausência — `orderIds.ts:139-146`).
    const grande = new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.itemNaoRetornado,
      Number.MAX_SAFE_INTEGER,
    );
    expect(grande.message).toContain('9007199254740991');

    const zero = new ShopeeImportBlockedError(MOTIVO_IMPORT_BLOQUEADO.itemNaoRetornado, 0);
    expect(zero.itemId).toBe(0);
    expect(zero.message).toBe('Importação bloqueada (item-nao-retornado) no item 0');
  });

  it('11 — ⛔ NEAR-MISS: NÃO é contido por conta, embora estenda ShopeeError', () => {
    // A célula decisiva. `erroContidoPorConta` nomeia CLASSES e nunca a base
    // (`containment.ts:46-52`), então herdar de `ShopeeError` não transforma uma
    // recusa de UM anúncio numa pane da CONTA inteira — que é o que o argumento
    // "estenda Error" temia. Se alguém trocar a lista por um
    // `instanceof ShopeeError`, este teste é o que fica vermelho.
    const err = new ShopeeImportBlockedError(MOTIVO_IMPORT_BLOQUEADO.kitSemDetalhe, ITEM_ID);
    expect(err).toBeInstanceOf(ShopeeError);
    expect(erroContidoPorConta(err)).toBe(false);
  });

  it('12 — é reconhecido por `isShopeeError`, para o braço 422 da rota', () => {
    // O catch da rota rethrowa tudo que a guarda recusar (regra 6), então sem
    // isto um item bloqueado viraria 500 em vez de 422.
    const err = new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.kitComponenteNaoVinculado,
      ITEM_ID,
    );
    expect(isShopeeError(err)).toBe(true);
  });
});
