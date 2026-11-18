import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MAX_CANAIS_LOGISTICA_RASCUNHO_SHOPEE,
  MOTIVO_INDISPONIVEL_CANAL_SHOPEE,
  respostaCanaisShopeeSchema,
  type CanalDaLojaShopeeDto,
  type CanalLogisticaRascunhoShopee,
  type RespostaCanaisShopee,
} from '@delfrance/schemas';

import {
  MODO_LOGISTICA_SHOPEE,
  MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE,
  algumLigadoDisponivelShopee,
  canaisGravadosForaDaLojaShopee,
  chaveCanaisShopee,
  comCanalShopee,
  escolhaAoEscolherCanaisShopee,
  escolhaInicialShopee,
  freteGratisTravadoShopee,
  interruptorTravadoShopee,
  linhasDaLogisticaShopee,
  logisticaEscolhidaNoRascunhoShopee,
  mesmaChaveCanaisShopee,
  modoDaLogisticaShopee,
  motivoDaLogisticaInvalidaShopee,
  type LinhaLogisticaShopee,
} from './logisticaRascunho';

/**
 * The draft's logistics editor model (#1911 P16). Every channel answer is
 * hand-written in the shape of `apps/shopee`'s channels route and parsed by the
 * SHARED `respostaCanaisShopeeSchema` (a web test cannot import that app's
 * fixtures); every id is a fixture id and every name invented. The projection,
 * the ordering and the whitelist are the REAL schemas ones — nothing here is
 * faked.
 *
 * Each rule has a pair and a near miss: a test that the rule APPLIES cannot show
 * where it STOPS (#1372).
 */

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

type Canal = CanalLogisticaRascunhoShopee;

/** Selectable, «Automática» would send it with no free shipping. */
const A = 90003;
/** Selectable, «Automática» would send it with no free shipping. */
const B = 90005;
/** NOT selectable (disabled in the shop, or a fulfillment channel). */
const C = 90007;
/** Selectable, the package does not fit. */
const D = 90009;
/** Selectable and compulsory. */
const E = 90011;
/** Selectable, the shop blocks seller-paid free shipping on it. */
const F = 90013;
/** Selectable, compulsory, and the package does not fit. */
const G = 90015;
/** An id the answer never lists. */
const AUSENTE = 90099;

const LETRAS: Readonly<Record<number, string>> = {
  [A]: 'A',
  [B]: 'B',
  [C]: 'C',
  [D]: 'D',
  [E]: 'E',
  [F]: 'F',
  [G]: 'G',
};

const canal = (
  logisticsChannelId: number,
  p: Partial<CanalDaLojaShopeeDto> = {},
): CanalDaLojaShopeeDto => ({
  logisticsChannelId,
  nome: `Entrega ${LETRAS[logisticsChannelId] ?? String(logisticsChannelId)}`,
  selecionavel: true,
  obrigatorio: false,
  bloqueiaFreteGratisDoVendedor: false,
  indisponivel: null,
  automatica: { isFree: false },
  ...p,
});

/** Through the SHARED schema: a fixture the route could never send fails here. */
const resposta = (
  canais: readonly CanalDaLojaShopeeDto[],
  medidasCompletas = true,
): RespostaCanaisShopee => respostaCanaisShopeeSchema.parse({ medidasCompletas, canais });

const NAO_CABE = MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe;

/** The whole shop, in a NON-sorted `get_channel_list` order (B before A). */
const LOJA = resposta([
  canal(B),
  canal(A),
  canal(C, { selecionavel: false, automatica: null }),
  canal(D, { indisponivel: NAO_CABE, automatica: null }),
  canal(E, { obrigatorio: true }),
  canal(F, { bloqueiaFreteGratisDoVendedor: true }),
  canal(G, { obrigatorio: true, indisponivel: NAO_CABE, automatica: null }),
]);

const on = (logistic_id: number, is_free: boolean | null = false): Canal => ({
  logistic_id,
  enabled: true,
  is_free,
});
const off = (logistic_id: number, is_free: boolean | null = false): Canal => ({
  logistic_id,
  enabled: false,
  is_free,
});

function linha(linhas: readonly LinhaLogisticaShopee[], id: number): LinhaLogisticaShopee {
  const achada = linhas.find((l) => l.logisticId === id);
  if (achada === undefined) throw new Error(`sem linha para ${String(id)}`);
  return achada;
}

/* -------------------------------------------------------------------------- */
/*                         (1) The mode and the key                            */
/* -------------------------------------------------------------------------- */

describe('modoDaLogisticaShopee — o modo do valor do formulário', () => {
  it('`null` ⇒ automática ⟷ ⛔ uma lista, mesmo `[]`, é escolhida', () => {
    expect(modoDaLogisticaShopee(null)).toBe(MODO_LOGISTICA_SHOPEE.automatica);
    expect(modoDaLogisticaShopee([on(A)])).toBe(MODO_LOGISTICA_SHOPEE.escolhida);
    expect(modoDaLogisticaShopee([])).toBe(MODO_LOGISTICA_SHOPEE.escolhida);
  });

  it('as companheiras soletram os valores do tipo', () => {
    expect(MODO_LOGISTICA_SHOPEE).toEqual({ automatica: 'automatica', escolhida: 'escolhida' });
    expect(MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE).toEqual({
      semCanalLigado: 'sem-canal-ligado',
      canalRepetido: 'canal-repetido',
      invalida: 'invalida',
    });
  });
});

describe('chaveCanaisShopee — uma leitura por conta, produto e revisão do produto (D16-10)', () => {
  it('outra revisão do produto ⇒ outra chave ⟷ a mesma ⇒ a mesma', () => {
    const chave = chaveCanaisShopee('int-1', 'prod-1', 1_700_000_000_000);

    expect(chave).toEqual(['shopee', 'canais', 'int-1', 'prod-1', 1_700_000_000_000]);
    expect(JSON.stringify(chaveCanaisShopee('int-1', 'prod-1', 1_700_000_000_000))).toBe(
      JSON.stringify(chave),
    );
    expect(JSON.stringify(chaveCanaisShopee('int-1', 'prod-1', 1_700_000_000_001))).not.toBe(
      JSON.stringify(chave),
    );
    expect(JSON.stringify(chaveCanaisShopee('int-1', 'prod-1', null))).not.toBe(
      JSON.stringify(chave),
    );
    // Other conta, other produto: other keys too.
    expect(JSON.stringify(chaveCanaisShopee('int-12', 'prod-1', 1_700_000_000_000))).not.toBe(
      JSON.stringify(chave),
    );
    expect(JSON.stringify(chaveCanaisShopee('int-1', 'prod-12', 1_700_000_000_000))).not.toBe(
      JSON.stringify(chave),
    );
  });
});

describe('mesmaChaveCanaisShopee — a resposta ainda é da chave da seção (a revisão mudou durante a leitura?)', () => {
  const REV = 1_700_000_000_000;

  it('⭐ duas chaves montadas dos MESMOS três valores (outro array) ⇒ a mesma leitura; também com a revisão `null` dos dois lados ⟷ ⛔ QUASE: a revisão a +1, `null` × `0` (nos dois sentidos), outro produto, outra conta, a conta `""` ⇒ distintas', () => {
    const chave = chaveCanaisShopee('int-1', 'prod-1', REV);
    const deNovo = chaveCanaisShopee('int-1', 'prod-1', REV);
    expect(deNovo).not.toBe(chave);
    expect(mesmaChaveCanaisShopee(chave, deNovo)).toBe(true);
    expect(mesmaChaveCanaisShopee(chave, chave)).toBe(true);
    expect(
      mesmaChaveCanaisShopee(
        chaveCanaisShopee('int-1', 'prod-1', null),
        chaveCanaisShopee('int-1', 'prod-1', null),
      ),
    ).toBe(true);

    // ⛔ QUASE: one element apart, alone.
    expect(mesmaChaveCanaisShopee(chave, chaveCanaisShopee('int-1', 'prod-1', REV + 1))).toBe(
      false,
    );
    expect(
      mesmaChaveCanaisShopee(
        chaveCanaisShopee('int-1', 'prod-1', null),
        chaveCanaisShopee('int-1', 'prod-1', 0),
      ),
    ).toBe(false);
    expect(
      mesmaChaveCanaisShopee(
        chaveCanaisShopee('int-1', 'prod-1', 0),
        chaveCanaisShopee('int-1', 'prod-1', null),
      ),
    ).toBe(false);
    expect(mesmaChaveCanaisShopee(chave, chaveCanaisShopee('int-1', 'prod-12', REV))).toBe(false);
    expect(mesmaChaveCanaisShopee(chave, chaveCanaisShopee('int-12', 'prod-1', REV))).toBe(false);
    // The section's `contaId ?? ''`: no conta never matches a conta.
    expect(mesmaChaveCanaisShopee(chave, chaveCanaisShopee('', 'prod-1', REV))).toBe(false);
  });

  it('⛔ exata: comprimentos diferentes — um prefixo, ou um `undefined` a mais — e uma igualdade frouxa (`1` × `"1"`, `null` × `undefined`) nunca são a mesma leitura', () => {
    const chave = chaveCanaisShopee('int-1', 'prod-1', 1);
    const prefixo = chave.slice(0, 4);
    expect(mesmaChaveCanaisShopee(chave, prefixo)).toBe(false);
    expect(mesmaChaveCanaisShopee(prefixo, chave)).toBe(false);
    expect(mesmaChaveCanaisShopee([...prefixo, undefined], prefixo)).toBe(false);
    expect(mesmaChaveCanaisShopee(chave, [...prefixo, '1'])).toBe(false);
    expect(
      mesmaChaveCanaisShopee(chaveCanaisShopee('int-1', 'prod-1', null), [...prefixo, undefined]),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                         (2) linhasDaLogisticaShopee                         */
/* -------------------------------------------------------------------------- */

describe('linhasDaLogisticaShopee — as linhas da seção', () => {
  const AB = resposta([canal(A), canal(B)]);

  it('⭐ as DUAS formas de leitura — `[{A,on},{B,off}]` e `[{A,on}]` — dão linhas IDÊNTICAS (B desligado) ⟷ ⛔ `[{A,on},{B,on}]` dá B ligado', () => {
    const formaA = linhasDaLogisticaShopee([on(A), off(B)], AB);
    const formaB = linhasDaLogisticaShopee([on(A)], AB);

    expect(formaA).toEqual(formaB);
    expect(linha(formaB, A)).toMatchObject({ ligado: true, podeDesligar: true, podeLigar: false });
    expect(linha(formaB, B)).toMatchObject({ ligado: false, podeLigar: true, podeDesligar: false });

    const ambos = linhasDaLogisticaShopee([on(A), on(B)], AB);
    expect(linha(ambos, B)).toMatchObject({ ligado: true, podeDesligar: true });
    expect(ambos).not.toEqual(formaA);
  });

  it('⛔ um canal `selecionavel: false` gravado ligado (C) NÃO tem linha e aparece em `canaisGravadosForaDaLojaShopee` com o nome da DTO ⟷ ⭐ um id selecionável nunca é «fora da loja»; um id ausente da DTO sai com `nome: null`', () => {
    const valor = [on(A), on(C), on(AUSENTE)];

    expect(linhasDaLogisticaShopee(valor, LOJA).map((l) => l.logisticId)).not.toContain(C);
    expect(canaisGravadosForaDaLojaShopee(valor, LOJA)).toEqual([
      { logisticId: C, nome: 'Entrega C' },
      { logisticId: AUSENTE, nome: null },
    ]);

    // Every selectable id, ON, OFF, unavailable or compulsory, has its row.
    expect(
      canaisGravadosForaDaLojaShopee([on(A), off(B), on(D), off(E), on(F), on(G)], LOJA),
    ).toEqual([]);
  });

  it('um canal fora da loja gravado DESLIGADO também é listado (sai da lista do mesmo jeito), uma vez por id', () => {
    expect(canaisGravadosForaDaLojaShopee([off(C), on(A), on(C)], LOJA)).toEqual([
      { logisticId: C, nome: 'Entrega C' },
    ]);
  });

  it('⛔ junta por id: a DTO invertida e com outros nomes liga/desliga as mesmas linhas, com os nomes da DTO ⟷ 90003 nunca casa com 900030', () => {
    const valor = [on(A, true), off(B)];
    const invertida = resposta([canal(B, { nome: 'Outro B' }), canal(A, { nome: 'Outro A' })]);

    const linhas = linhasDaLogisticaShopee(valor, invertida);
    expect(linhas.map((l) => l.logisticId)).toEqual([B, A]);
    expect(linha(linhas, A)).toMatchObject({ nome: 'Outro A', ligado: true, freteGratis: true });
    expect(linha(linhas, B)).toMatchObject({ nome: 'Outro B', ligado: false, freteGratis: false });

    const parecida = resposta([canal(900030), canal(B)]);
    expect(linha(linhasDaLogisticaShopee([on(A)], parecida), 900030).ligado).toBe(false);
    expect(canaisGravadosForaDaLojaShopee([on(A)], parecida)).toEqual([
      { logisticId: A, nome: null },
    ]);
  });

  it('as linhas seguem a ordem da DTO (90005 antes de 90003), nunca a do valor', () => {
    const linhas = linhasDaLogisticaShopee([on(A), on(B)], LOJA);

    expect(linhas.map((l) => l.logisticId)).toEqual([B, A, D, E, F, G]);
  });

  it('o nome é o da DTO; `null` continua null (o componente nomeia pelo id)', () => {
    const semNome = resposta([canal(A, { nome: null })]);

    expect(linha(linhasDaLogisticaShopee([], semNome), A).nome).toBeNull();
    expect(linha(linhasDaLogisticaShopee([], LOJA), A).nome).toBe('Entrega A');
  });

  it('obrigatório (E): ligado e travado (`podeDesligar: false`) mesmo sobre um valor que o grava desligado ⟷ ⛔ um canal comum desligado aparece desligado', () => {
    const linhas = linhasDaLogisticaShopee([on(A), off(E), off(B)], LOJA);

    expect(linha(linhas, E)).toMatchObject({
      ligado: true,
      obrigatorio: true,
      podeDesligar: false,
      podeLigar: false,
    });
    expect(linha(linhasDaLogisticaShopee([], LOJA), E).ligado).toBe(true);
    expect(linha(linhas, B)).toMatchObject({ ligado: false, obrigatorio: false, podeLigar: true });
  });

  it("obrigatório + indisponível (G): ligado, `indisponivel: 'nao-cabe'`, `podeDesligar: false` ⟷ ⛔ indisponível comum desligado (D): `podeLigar: false`", () => {
    const linhas = linhasDaLogisticaShopee([on(A)], LOJA);

    expect(linha(linhas, G)).toMatchObject({
      ligado: true,
      indisponivel: NAO_CABE,
      podeDesligar: false,
      podeLigar: false,
    });
    expect(linha(linhas, D)).toMatchObject({
      ligado: false,
      indisponivel: NAO_CABE,
      podeLigar: false,
    });
  });

  it('indisponível LIGADO: `podeDesligar: true` ⟷ desligado: `podeLigar: false`', () => {
    expect(linha(linhasDaLogisticaShopee([on(D)], LOJA), D)).toMatchObject({
      ligado: true,
      podeDesligar: true,
    });
    expect(linha(linhasDaLogisticaShopee([off(D)], LOJA), D)).toMatchObject({
      ligado: false,
      podeLigar: false,
    });
  });

  it('frete grátis bloqueado (F): `freteGratis: false` sobre um `is_free: true` gravado ⟷ ⛔ desbloqueado mantém true', () => {
    const linhas = linhasDaLogisticaShopee([on(F, true), on(A, true)], LOJA);

    expect(linha(linhas, F)).toMatchObject({ freteGratis: false, bloqueiaFreteGratis: true });
    expect(linha(linhas, A)).toMatchObject({ freteGratis: true, bloqueiaFreteGratis: false });
  });

  it('⭐ as duas travas da linha: o «Ligado» trava no obrigatório ligado (E, G) e no indisponível desligado (D); o frete grátis no bloqueado (F) e no indisponível DESLIGADO (D, Q-F1 b) ⟷ ⛔ QUASE: o mesmo D LIGADO não trava nenhum; G (obrigatório indisponível, ligado) trava só o «Ligado»; um comum desligado (B) nenhum', () => {
    const travas = (valor: readonly Canal[]) =>
      linhasDaLogisticaShopee(valor, LOJA).map((l) => [
        l.logisticId,
        interruptorTravadoShopee(l),
        freteGratisTravadoShopee(l),
      ]);

    // [id, «Ligado» travado, frete grátis travado] — DTO order.
    expect(travas([on(A)])).toEqual([
      [B, false, false],
      [A, false, false],
      [D, true, true],
      [E, true, false],
      [F, false, true],
      [G, true, false],
    ]);
    // QUASE: the same unavailable D, stored ON — it can be switched off, and keeps its free shipping.
    expect(travas([on(A), on(D, true)])[2]).toEqual([D, false, false]);
    // A stored tick on the OFF unavailable D does not unlock it either.
    expect(travas([on(A), off(D, true)])[2]).toEqual([D, true, true]);
  });

  it('um id repetido: a PRIMEIRA entrada do valor fala; a DTO repetida dá UMA linha (a primeira)', () => {
    expect(linha(linhasDaLogisticaShopee([on(A, true), off(A)], LOJA), A)).toMatchObject({
      ligado: true,
      freteGratis: true,
    });
    expect(linha(linhasDaLogisticaShopee([off(A), on(A, true)], LOJA), A)).toMatchObject({
      ligado: false,
      freteGratis: false,
    });

    const repetida = resposta([canal(A), canal(A, { nome: 'Outra A' }), canal(B)]);
    const linhas = linhasDaLogisticaShopee([], repetida);
    expect(linhas.map((l) => l.logisticId)).toEqual([A, B]);
    expect(linha(linhas, A).nome).toBe('Entrega A');
  });
});

/* -------------------------------------------------------------------------- */
/*                              (3) comCanalShopee                             */
/* -------------------------------------------------------------------------- */

describe('comCanalShopee — uma interação reconstrói a lista inteira', () => {
  it('⭐ a lista COMPLETA dos selecionáveis, ordenada por logistic_id, sem os fora da loja ⟷ ⛔ nunca só a linha mexida', () => {
    const valor = [on(A), on(C), on(AUSENTE)];

    const novo = comCanalShopee(valor, LOJA, B, { ligado: true });

    // DTO order is B, A, …; the value is sorted. C and the absent id are gone.
    expect(novo).toEqual([on(A), on(B), off(D), on(E), off(F), on(G)]);
    expect(novo).not.toEqual([on(B)]);
  });

  it('um canal ligado a partir de nenhuma entrada tem `is_free: false` ⟷ ⛔ nunca o `automatica.isFree` nem a flag do produto', () => {
    // B would go free under «Automática» (its `automatica.isFree` is true) —
    // the editor never borrows it, and it has no produto flag to borrow.
    const loja = resposta([canal(A), canal(B, { automatica: { isFree: true } })]);

    expect(comCanalShopee([on(A)], loja, B, { ligado: true })).toEqual([on(A), on(B, false)]);
  });

  it('⭐ ida e volta ligar→desligar→ligar sobre `[{A,on,false},{B,off,false}]` volta byte a byte ⟷ ⛔ (forma B, documentado) a mesma ida e volta sobre `[{A,on}]` dá `[{A,on},{B,off}]` — um desligado explícito', () => {
    const AB = resposta([canal(B), canal(A)]);
    const guardado = [on(A), off(B)];

    const bLigado = comCanalShopee(guardado, AB, B, { ligado: true });
    expect(bLigado).toEqual([on(A), on(B)]);
    const bDeVolta = comCanalShopee(bLigado, AB, B, { ligado: false });
    expect(JSON.stringify(bDeVolta)).toBe(JSON.stringify(guardado));

    const aDesligado = comCanalShopee(guardado, AB, A, { ligado: false });
    const aDeVolta = comCanalShopee(aDesligado, AB, A, { ligado: true });
    expect(JSON.stringify(aDeVolta)).toBe(JSON.stringify(guardado));

    // Shape B (the read-back omits the OFF channel): the same round trip writes
    // the explicit off — an edit, residual R4. Only the DISPLAY folds the two.
    const formaB = [on(A)];
    const ida = comCanalShopee(formaB, AB, B, { ligado: true });
    const volta = comCanalShopee(ida, AB, B, { ligado: false });
    expect(volta).toEqual([on(A), off(B)]);
    expect(volta).not.toEqual(formaB);
  });

  it('recusas devolvem O PRÓPRIO valor (mesma referência): desligar E, ligar D desligado, um id sem linha (C), frete grátis em F ⟷ cada mudança vizinha permitida responde um valor novo', () => {
    const valor: readonly Canal[] = [on(A), off(B), off(D), on(E), off(F), on(G)];

    expect(comCanalShopee(valor, LOJA, E, { ligado: false })).toBe(valor);
    expect(comCanalShopee(valor, LOJA, G, { ligado: false })).toBe(valor);
    expect(comCanalShopee(valor, LOJA, D, { ligado: true })).toBe(valor);
    expect(comCanalShopee(valor, LOJA, C, { ligado: true })).toBe(valor);
    expect(comCanalShopee(valor, LOJA, AUSENTE, { ligado: true })).toBe(valor);
    expect(comCanalShopee(valor, LOJA, F, { freteGratis: true })).toBe(valor);
    // One refused part refuses the whole change.
    expect(comCanalShopee(valor, LOJA, F, { ligado: true, freteGratis: true })).toBe(valor);

    // The neighbours: each allowed, each a new value.
    expect(comCanalShopee(valor, LOJA, E, { ligado: true })).not.toBe(valor);
    expect(comCanalShopee(valor, LOJA, B, { ligado: true })).toEqual([
      on(A),
      on(B),
      off(D),
      on(E),
      off(F),
      on(G),
    ]);
    expect(comCanalShopee(valor, LOJA, A, { freteGratis: true })).toEqual([
      on(A, true),
      off(B),
      off(D),
      on(E),
      off(F),
      on(G),
    ]);
    expect(comCanalShopee(valor, LOJA, F, { ligado: true })).toEqual([
      on(A),
      off(B),
      off(D),
      on(E),
      on(F),
      on(G),
    ]);
    expect(comCanalShopee(valor, LOJA, F, { freteGratis: false })).not.toBe(valor);
    const comD = [on(A), on(D)];
    expect(comCanalShopee(comD, LOJA, D, { ligado: false })).toEqual([
      on(A),
      off(B),
      off(D),
      on(E),
      off(F),
      on(G),
    ]);
  });

  it('⭐ Q-F1 (b): frete grátis — marcado OU desmarcado — numa linha DESLIGADA e indisponível (D) devolve O PRÓPRIO valor ⟷ ⛔ QUASE: a mesma mudança no D LIGADO grava o `is_free` dele; num desligado DISPONÍVEL (B) e no obrigatório indisponível ligado (G), também', () => {
    const valor: readonly Canal[] = [on(A), off(B), off(D), on(E), off(F), on(G)];

    expect(comCanalShopee(valor, LOJA, D, { freteGratis: true })).toBe(valor);
    expect(comCanalShopee(valor, LOJA, D, { freteGratis: false })).toBe(valor);
    // A tick the value already holds on the OFF unavailable D is never unticked either.
    const dMarcado: readonly Canal[] = [on(A), off(D, true)];
    expect(comCanalShopee(dMarcado, LOJA, D, { freteGratis: false })).toBe(dMarcado);
    expect(comCanalShopee(dMarcado, LOJA, D, { freteGratis: true })).toBe(dMarcado);

    // ⛔ QUASE: the same D stored ON (unavailable, but ON) — each way flips D's is_free.
    const dLigado: readonly Canal[] = [on(A), on(D)];
    expect(comCanalShopee(dLigado, LOJA, D, { freteGratis: true })).toEqual([
      on(A),
      off(B),
      on(D, true),
      on(E),
      off(F),
      on(G),
    ]);
    const dLigadoMarcado: readonly Canal[] = [on(A), on(D, true)];
    expect(comCanalShopee(dLigadoMarcado, LOJA, D, { freteGratis: false })).toEqual([
      on(A),
      off(B),
      on(D, false),
      on(E),
      off(F),
      on(G),
    ]);
    // ⛔ QUASE: an OFF but AVAILABLE row (B) takes it, OFF.
    expect(comCanalShopee(valor, LOJA, B, { freteGratis: true })).toEqual([
      on(A),
      off(B, true),
      off(D),
      on(E),
      off(F),
      on(G),
    ]);
    expect(comCanalShopee(valor, LOJA, B, { freteGratis: false })).not.toBe(valor);
    // ⛔ QUASE: compulsory AND unavailable, but ON (G) — its free shipping moves.
    expect(comCanalShopee(valor, LOJA, G, { freteGratis: true })).toEqual([
      on(A),
      off(B),
      off(D),
      on(E),
      off(F),
      on(G, true),
    ]);
  });

  it('⛔ QUASE-PAR da recusa Q-F1 (b): ela é só do FRETE GRÁTIS — `{ ligado: false }` num D desligado e indisponível (nenhum movimento) responde um valor novo, e toda reconstrução (por D ou por outra linha) leva o `is_free` guardado de D como está', () => {
    const dMarcado: readonly Canal[] = [on(A), off(D, true)];

    const novo = comCanalShopee(dMarcado, LOJA, D, { ligado: false });
    expect(novo).not.toBe(dMarcado);
    expect(novo).toEqual([on(A), off(B), off(D, true), on(E), off(F), on(G)]);
    // A rebuild driven by ANOTHER row carries D's held tick verbatim (inert: D is OFF).
    expect(comCanalShopee(dMarcado, LOJA, A, { freteGratis: true })).toEqual([
      on(A, true),
      off(B),
      off(D, true),
      on(E),
      off(F),
      on(G),
    ]);
  });

  it('⭐ Q-F1 (b), até onde a recusa vai: num desligado indisponível de frete TAMBÉM bloqueado, desmarcar um `is_free` velho devolve O PRÓPRIO valor; `ligado` e `freteGratis` juntos num D desligado são recusados inteiros ⟷ ⛔ QUASE: o mesmo desmarcar num bloqueado DISPONÍVEL (F) e a mesma dupla num desligado disponível (B) respondem um valor novo', () => {
    /** Selectable, the package does not fit, AND the shop blocks seller-paid free shipping. */
    const H = 90017;
    const loja = resposta([
      canal(A),
      canal(H, { indisponivel: NAO_CABE, automatica: null, bloqueiaFreteGratisDoVendedor: true }),
    ]);
    const hVelho: readonly Canal[] = [on(A), off(H, true)];

    expect(comCanalShopee(hVelho, loja, H, { freteGratis: false })).toBe(hVelho);
    expect(comCanalShopee(hVelho, loja, H, { freteGratis: true })).toBe(hVelho);
    const valor: readonly Canal[] = [on(A), off(B), off(D), on(E), off(F), on(G)];
    expect(comCanalShopee(valor, LOJA, D, { ligado: false, freteGratis: true })).toBe(valor);

    // ⛔ QUASE: a blocked but AVAILABLE row (F) drops its stale tick.
    expect(comCanalShopee([on(A), off(F, true)], LOJA, F, { freteGratis: false })).toEqual([
      on(A),
      off(B),
      off(D),
      on(E),
      off(F),
      on(G),
    ]);
    // ⛔ QUASE: the same pair on an OFF but available row (B) is a new value.
    expect(comCanalShopee(valor, LOJA, B, { ligado: true, freteGratis: true })).toEqual([
      on(A),
      on(B, true),
      off(D),
      on(E),
      off(F),
      on(G),
    ]);
  });

  it('E sempre gravado ligado, mesmo quando o valor o tinha desligado ⟷ ⛔ um comum mantém o desligado', () => {
    const novo = comCanalShopee([on(A), off(B), off(E)], LOJA, A, { freteGratis: true });

    expect(novo.find((c) => c.logistic_id === E)).toEqual(on(E));
    expect(novo.find((c) => c.logistic_id === B)).toEqual(off(B));
  });

  it('⭐ D16-4: um `is_free: null` guardado é regravado false ⟷ ⛔ um true guardado continua true', () => {
    const AB = resposta([canal(A), canal(B)]);

    expect(comCanalShopee([on(A, null), on(B, true)], AB, B, { ligado: true })).toEqual([
      on(A, false),
      on(B, true),
    ]);
  });

  it('frete grátis bloqueado (F): uma entrada gravada `is_free: true` é reconstruída false ⟷ ⛔ desbloqueado (A) mantém true', () => {
    const novo = comCanalShopee([on(A, true), on(F, true)], LOJA, B, { ligado: true });

    expect(novo.find((c) => c.logistic_id === F)).toEqual(on(F, false));
    expect(novo.find((c) => c.logistic_id === A)).toEqual(on(A, true));
  });

  it('um id repetido no valor sai UMA vez, com a primeira entrada', () => {
    const AB = resposta([canal(A), canal(B)]);

    expect(comCanalShopee([on(A, true), off(A)], AB, B, { ligado: false })).toEqual([
      on(A, true),
      off(B),
    ]);
  });

  it("51 selecionáveis ⇒ `motivoDaLogisticaInvalidaShopee` 'invalida' (MAX 50)", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => 91_001 + i);
    const de51 = resposta(ids(MAX_CANAIS_LOGISTICA_RASCUNHO_SHOPEE + 1).map((id) => canal(id)));
    const de50 = resposta(ids(MAX_CANAIS_LOGISTICA_RASCUNHO_SHOPEE).map((id) => canal(id)));

    const demais = comCanalShopee([], de51, 91_001, { ligado: true });
    expect(demais).toHaveLength(51);
    expect(motivoDaLogisticaInvalidaShopee(demais)).toBe(
      MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.invalida,
    );

    const cinquenta = comCanalShopee([], de50, 91_001, { ligado: true });
    expect(cinquenta).toHaveLength(50);
    expect(motivoDaLogisticaInvalidaShopee(cinquenta)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                            (4) «Escolher canais»                            */
/* -------------------------------------------------------------------------- */

describe('escolhaInicialShopee — o pré-preenchimento a partir da resposta', () => {
  it('⭐ linhas com `automatica` ligadas com o seu `isFree`; as demais desligadas com false; E e G ligados; ordenado ⟷ ⛔ nunca o canal não selecionável', () => {
    const loja = resposta([
      canal(B, { automatica: { isFree: true } }),
      canal(A),
      canal(C, { selecionavel: false, automatica: { isFree: true } }),
      canal(D, { indisponivel: NAO_CABE, automatica: null }),
      canal(E, { obrigatorio: true }),
      canal(F, { bloqueiaFreteGratisDoVendedor: true }),
      canal(G, { obrigatorio: true, indisponivel: NAO_CABE, automatica: null }),
    ]);

    expect(escolhaInicialShopee(loja)).toEqual([
      on(A, false),
      on(B, true),
      off(D, false),
      on(E, false),
      on(F, false),
      on(G, false),
    ]);
    expect(escolhaInicialShopee(loja).map((c) => c.logistic_id)).not.toContain(C);
  });

  it('um canal bloqueado nunca sai com frete grátis, mesmo se a `automatica` dissesse true ⟷ desbloqueado com `automatica {isFree:true}` sai true', () => {
    const loja = resposta([
      canal(F, { bloqueiaFreteGratisDoVendedor: true, automatica: { isFree: true } }),
      canal(A, { automatica: { isFree: true } }),
    ]);

    expect(escolhaInicialShopee(loja)).toEqual([on(A, true), on(F, false)]);
  });

  it('um obrigatório que a `automatica` mandaria com frete grátis sai com ele ⟷ sem `automatica`, false', () => {
    const loja = resposta([
      canal(E, { obrigatorio: true, automatica: { isFree: true } }),
      canal(G, { obrigatorio: true, indisponivel: NAO_CABE, automatica: null }),
    ]);

    expect(escolhaInicialShopee(loja)).toEqual([on(E, true), on(G, false)]);
  });
});

describe('escolhaAoEscolherCanaisShopee — o que «Escolher canais» põe no formulário (D16-2)', () => {
  it('⭐ com lista guardada devolve ELA (mesma referência) ⟷ sem lista e sem resposta ⇒ null; sem lista com resposta ⇒ `escolhaInicialShopee(resposta)`', () => {
    // Verbatim — an OFF compulsory entry included (residual R3).
    const guardada: readonly Canal[] = [on(A), off(E)];

    expect(escolhaAoEscolherCanaisShopee(guardada, null)).toBe(guardada);
    expect(escolhaAoEscolherCanaisShopee(guardada, LOJA)).toBe(guardada);
    expect(escolhaAoEscolherCanaisShopee(null, null)).toBeNull();
    expect(escolhaAoEscolherCanaisShopee(null, LOJA)).toEqual(escolhaInicialShopee(LOJA));
    expect(escolhaAoEscolherCanaisShopee(null, LOJA)).not.toEqual(guardada);
  });
});

/* -------------------------------------------------------------------------- */
/*                     (5) The warning and the save verdict                    */
/* -------------------------------------------------------------------------- */

describe('algumLigadoDisponivelShopee — o aviso de nenhum ligado disponível', () => {
  // No compulsory channel here: E would show ON (and count) on every value.
  const ABD = resposta([
    canal(A),
    canal(B),
    canal(D, { indisponivel: NAO_CABE, automatica: null }),
  ]);

  it('`[{D,on}]` ⇒ false ⟷ `[{A,on}]` ⇒ true; `[{A,off}]` ⇒ false', () => {
    expect(algumLigadoDisponivelShopee([on(D)], ABD)).toBe(false);
    expect(algumLigadoDisponivelShopee([on(A)], ABD)).toBe(true);
    expect(algumLigadoDisponivelShopee([off(A)], ABD)).toBe(false);
    expect(algumLigadoDisponivelShopee([on(D), on(A)], ABD)).toBe(true);
  });

  it('um obrigatório indisponível (G) aparece ligado mas não conta ⟷ um disponível ligado conta', () => {
    const ADG = resposta([
      canal(A),
      canal(D, { indisponivel: NAO_CABE, automatica: null }),
      canal(G, { obrigatorio: true, indisponivel: NAO_CABE, automatica: null }),
    ]);

    expect(algumLigadoDisponivelShopee([on(D)], ADG)).toBe(false);
    expect(algumLigadoDisponivelShopee([on(D), on(A)], ADG)).toBe(true);
  });

  it('um canal fora da loja gravado ligado não conta (não tem linha)', () => {
    expect(
      algumLigadoDisponivelShopee([on(C)], resposta([canal(A), canal(C, { selecionavel: false })])),
    ).toBe(false);
  });
});

describe('motivoDaLogisticaInvalidaShopee — o veredito da whitelist, pelas mensagens exportadas', () => {
  it("tudo desligado e `[]` ⇒ 'sem-canal-ligado' ⟷ ⭐ um ligado ⇒ null; `null` ⇒ null; id repetido ⇒ 'canal-repetido'", () => {
    expect(motivoDaLogisticaInvalidaShopee([off(A), off(B)])).toBe(
      MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado,
    );
    expect(motivoDaLogisticaInvalidaShopee([])).toBe(
      MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado,
    );
    expect(motivoDaLogisticaInvalidaShopee([on(A), off(B)])).toBeNull();
    expect(motivoDaLogisticaInvalidaShopee(null)).toBeNull();
    expect(motivoDaLogisticaInvalidaShopee([on(A), off(A)])).toBe(
      MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.canalRepetido,
    );
  });

  it("nenhum ligado vem antes do repetido ⟷ ⛔ um `is_free: null` com um ligado é 'invalida', nunca null", () => {
    expect(motivoDaLogisticaInvalidaShopee([off(A), off(A)])).toBe(
      MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado,
    );
    expect(motivoDaLogisticaInvalidaShopee([on(A, null)])).toBe(
      MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.invalida,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                         (6) Did the ERP choose it                           */
/* -------------------------------------------------------------------------- */

describe('logisticaEscolhidaNoRascunhoShopee — pela projeção do rascunho guardado', () => {
  const CARIMBO = 1_700_000_000_000;
  const LISTA = [{ logistic_id: A, enabled: true, is_free: false }];

  it('lista carimbada ⇒ true ⟷ ⛔ a MESMA lista sem carimbo ⇒ false; `null` carimbado ⇒ false', () => {
    expect(
      logisticaEscolhidaNoRascunhoShopee({
        item_id: null,
        logistic_info: LISTA,
        logisticaGravadaEm: CARIMBO,
      }),
    ).toBe(true);
    expect(logisticaEscolhidaNoRascunhoShopee({ item_id: null, logistic_info: LISTA })).toBe(false);
    expect(
      logisticaEscolhidaNoRascunhoShopee({
        item_id: null,
        logistic_info: null,
        logisticaGravadaEm: CARIMBO,
      }),
    ).toBe(false);
  });

  it('um `[]` carimbado é uma escolha (a projeção lê `[]`) ⟷ um carimbo ilegível (texto) não é carimbo', () => {
    expect(
      logisticaEscolhidaNoRascunhoShopee({ logistic_info: [], logisticaGravadaEm: CARIMBO }),
    ).toBe(true);
    expect(
      logisticaEscolhidaNoRascunhoShopee({
        logistic_info: LISTA,
        logisticaGravadaEm: String(CARIMBO),
      }),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                       (7) The rules stay elsewhere                          */
/* -------------------------------------------------------------------------- */

describe('o módulo não re-deriva regra do servidor (#1369)', () => {
  it('⭐ `logisticaRascunho.ts` nunca soletra um campo cru da Shopee, o carimbo, o leitor da lista guardada, uma comparação de valores ou uma ordenação própria', () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    const fonte = readFileSync(join(aqui, 'logisticaRascunho.ts'), 'utf8');
    // Built from parts (the `atributosRascunho.test.ts` shape). Only the MODULE
    // is read: this file's fixtures may name the stamp, the module may not.
    // The comparison banned is of draft VALUES; `mesmaChaveCanaisShopee`
    // compares two query keys, never a value.
    const proibidos = [
      ['mask', 'channel', 'id'].join('_'),
      ['fee', 'type'].join('_'),
      ['item', 'max', 'dimension'].join('_'),
      ['block', 'seller', 'cover', 'shipping', 'fee'].join('_'),
      ['logistica', 'Gravada', 'Em'].join(''),
      ['ler', 'Logistica', 'Armazenada', 'Shopee'].join(''),
      ['mesmo', 'Valor'].join(''),
      ['values', 'Equal'].join(''),
      ['.', 'sort', '('].join(''),
    ];

    for (const proibido of proibidos) {
      expect(fonte, proibido).not.toContain(proibido);
    }
  });
});

describe('chaveCanaisShopee com `linkDocId` — a leitura de um anúncio publicado (PR3)', () => {
  it('⭐ sem `linkDocId` a chave tem 5 elementos (byte a byte a de sempre); com ele, 6 ⟷ NEAR-MISS: outro `linkDocId` ⇒ outra chave, e a de 5 nunca é a de 6', () => {
    const cinco = chaveCanaisShopee('int-1', 'prod-1', 1);
    const seis = chaveCanaisShopee('int-1', 'prod-1', 1, 'L-1');

    expect(cinco).toEqual(['shopee', 'canais', 'int-1', 'prod-1', 1]);
    expect(seis).toEqual(['shopee', 'canais', 'int-1', 'prod-1', 1, 'L-1']);
    expect(mesmaChaveCanaisShopee(seis, chaveCanaisShopee('int-1', 'prod-1', 1, 'L-1'))).toBe(true);
    expect(mesmaChaveCanaisShopee(seis, chaveCanaisShopee('int-1', 'prod-1', 1, 'L-2'))).toBe(
      false,
    );
    expect(mesmaChaveCanaisShopee(seis, cinco)).toBe(false);
    expect(mesmaChaveCanaisShopee(cinco, seis)).toBe(false);
  });

  it('o resíduo documentado: a chave NÃO carrega a logística gravada do vínculo — o mesmo vínculo e a mesma revisão são a MESMA chave', () => {
    expect(
      mesmaChaveCanaisShopee(
        chaveCanaisShopee('int-1', 'prod-1', 1, 'L-1'),
        chaveCanaisShopee('int-1', 'prod-1', 1, 'L-1'),
      ),
    ).toBe(true);
  });
});

describe('comCanalShopee `manterForaDaLista` — um anúncio publicado não desliga o que a lista não mostra (R5)', () => {
  // C is NOT selectable; AUSENTE is not in the answer at all. Both are stored.
  const guardado = [on(A), on(C), off(AUSENTE, null)];

  it('⭐ `true`: os canais gravados sem linha seguem com o MESMO ligado/desligado, uma vez por id, ordenados — um `is_free: null` vira `false` (a escrita estrita só aceita booleano; o servidor faz o mesmo) ⟷ NEAR-MISS: `false` os descarta', () => {
    const mantido = comCanalShopee(
      guardado,
      LOJA,
      B,
      { ligado: true },
      { manterForaDaLista: true },
    );
    expect(mantido).toEqual([
      on(A),
      on(B),
      on(C),
      off(D),
      on(E),
      off(F),
      on(G),
      off(AUSENTE, false),
    ]);

    const descartado = comCanalShopee(
      guardado,
      LOJA,
      B,
      { ligado: true },
      { manterForaDaLista: false },
    );
    expect(descartado.some((c) => c.logistic_id === C || c.logistic_id === AUSENTE)).toBe(false);
  });

  it('o padrão (sem o argumento) é o do rascunho: byte a byte igual a `manterForaDaLista: false`', () => {
    expect(JSON.stringify(comCanalShopee(guardado, LOJA, B, { ligado: true }))).toBe(
      JSON.stringify(
        comCanalShopee(guardado, LOJA, B, { ligado: true }, { manterForaDaLista: false }),
      ),
    );
  });

  it('um id repetido fora da lista vale uma vez (a PRIMEIRA entrada) ⟷ uma mudança recusada segue devolvendo o MESMO valor', () => {
    const repetido = [on(A), on(C, true), off(C)];
    const novo = comCanalShopee(repetido, LOJA, B, { ligado: true }, { manterForaDaLista: true });
    expect(novo.filter((c) => c.logistic_id === C)).toEqual([on(C, true)]);

    // E is compulsory: switching it off is refused whole, options or not.
    expect(comCanalShopee(repetido, LOJA, E, { ligado: false }, { manterForaDaLista: true })).toBe(
      repetido,
    );
  });
});
