/**
 * `escolherArmaDePublicacao` (step 19, PR 7 — reconcile §2.5.1, L9, L10) — the
 * pure publish dispatcher. Every rule gets its PAIR and its near-miss; the PR 7
 * mutant block of §4.1 (M133–M146) is named on the test that kills it.
 *
 * The links are documents in the stored shape (`prodshopee` raw), never the
 * dispatcher's own partition: what decides is how a STORED doc reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTADO_ANUNCIO_SHOPEE, toOuterRef } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import { MOTIVO_PUBLICACAO_BLOQUEADA } from '../anuncios/errosPublicacao';
import { lerVinculosDaConta, resolverLinkPorProduto } from '../anuncios/linkAnuncio';
import { escolherLink } from '../produtos/resolveProduto';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  escolherArmaDePublicacao,
  type CorpoDoDespacho,
  type ProdutoDoDespacho,
  type ResultadoDoDespacho,
} from './armaDePublicacao';
import type { VinculoDaConta } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*  Fixtures — role ids only (s19-ctx).                                        */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const K = 'kit-k';
const KIT_1 = 2500139870;
const KIT_2 = 2500139873;
const COMUM_1 = 2500139861;
const COMUM_2 = 2500139862;

type Raw = Record<string, unknown>;

function nativo(id: string, itemId: number, extra: Raw = {}): VinculoDaConta {
  return {
    id,
    raw: {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: itemId,
      kitNativo: true,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      ...extra,
    },
  };
}

function comum(id: string, itemId: number, extra: Raw = {}): VinculoDaConta {
  return {
    id,
    raw: {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: itemId,
      kitNativo: false,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      ...extra,
    },
  };
}

const REMOVIDO: Raw = { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido };
const substituidoPor = (novo: string): Raw => ({ substituidoPorLinkDocId: novo, substituidoEm: 1 });

/** A kit produto whose ERP says "the marketplace resolves the composition" (`ehKitVirtualEfetivo`). */
const KIT_EFETIVO: ProdutoDoDespacho = { id: K, paiId: null, ehKit: true, ehKitVirtual: true };
/** An OLD-MODEL kit (L0/L7): `ehKit` on, `ehKitVirtual` false/null. */
const KIT_ANTIGO: ProdutoDoDespacho = { id: K, paiId: null, ehKit: true, ehKitVirtual: null };
const NAO_KIT: ProdutoDoDespacho = { id: 'prod-1', paiId: null, ehKit: false, ehKitVirtual: false };

function corpo(over: Partial<CorpoDoDespacho> = {}): CorpoDoDespacho {
  return { linkDocId: null, recriar: false, converterEmKit: false, principal: null, ...over };
}

function despachar(
  produto: ProdutoDoDespacho,
  vinculos: readonly VinculoDaConta[],
  over: Partial<CorpoDoDespacho> = {},
): ResultadoDoDespacho {
  return escolherArmaDePublicacao({ produto, vinculos, corpo: corpo(over) });
}

/** The refusal, asserting there IS one (and only one problem, the dispatcher's way). */
function recusa(r: ResultadoDoDespacho) {
  if (r.ok) throw new Error(`esperava recusa, veio a arma ${JSON.stringify(r.arma)}`);
  expect(r.problemas).toHaveLength(1);
  return r.problemas[0]!;
}

function arma(r: ResultadoDoDespacho) {
  if (!r.ok) throw new Error(`esperava arma, veio ${r.problemas.map((p) => p.motivo).join()}`);
  return r.arma;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  (−1) a variation child                                                     */
/* ========================================================================== */

describe('(−1) um filho de variação nunca publica — `produto-e-filho`', () => {
  it('(M144) um MEMBRO com ehKitVirtual espelhado ⇒ produto-e-filho no campo paiId — com e sem --converter-em-kit', () => {
    const membro: ProdutoDoDespacho = { id: 'kit-k-un', paiId: K, ehKit: true, ehKitVirtual: true };
    for (const converterEmKit of [false, true]) {
      const p = recusa(despachar(membro, [], { converterEmKit }));
      expect(p).toMatchObject({
        campo: 'paiId',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
      });
      expect(p.mensagem).toContain(`o produto kit-k-un é uma variação de ${K}`);
    }
  });

  it('⛔ quase-par: o PAI (paiId null) com a MESMA flag ⇒ kit-criar', () => {
    expect(arma(despachar(KIT_EFETIVO, []))).toEqual({ arma: 'kit-criar' });
  });
});

/* ========================================================================== */
/*  (1) converterEmKit                                                         */
/* ========================================================================== */

describe('(1) --converter-em-kit (L8)', () => {
  it('(M143) um produto com ehKit DESLIGADO ⇒ converter-sem-kit (campo ehKit), mesmo com anúncio comum', () => {
    const p = recusa(despachar(NAO_KIT, [comum('link-comum', COMUM_1)], { converterEmKit: true }));
    expect(p).toMatchObject({
      campo: 'ehKit',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.converterSemKit,
    });
    expect(p.mensagem).toBe(
      'o produto prod-1 não está marcado como kit («É kit») — só um kit com componentes pode ser ' +
        'convertido em kit nativo',
    );
  });

  it('(M143) o kit ANTIGO (ehKitVirtual null) com um anúncio comum vivo ⇒ kit-converter nele — nunca ehKitVirtual', () => {
    expect(
      arma(despachar(KIT_ANTIGO, [comum('link-comum', COMUM_1)], { converterEmKit: true })),
    ).toEqual({ arma: 'kit-converter', antecessorLinkDocId: 'link-comum' });
  });

  it('(M143) um kit nativo vivo AO LADO do comum ⇒ kit-converter (a retomada), nunca ja-e-kit-nativo', () => {
    const vinculos = [nativo('a-kit', KIT_1), comum('b-comum', COMUM_1)];
    expect(arma(despachar(KIT_ANTIGO, vinculos, { converterEmKit: true }))).toEqual({
      arma: 'kit-converter',
      antecessorLinkDocId: 'b-comum',
    });
  });

  it('(M142 / M143) só UM kit nativo vivo, nenhum comum ⇒ ja-e-kit-nativo NOMEANDO-o (campo kitNativo)', () => {
    const p = recusa(
      despachar(
        KIT_ANTIGO,
        [nativo('a-kit', KIT_1), comum('b-comum', COMUM_1, substituidoPor('a-kit'))],
        {
          converterEmKit: true,
        },
      ),
    );
    expect(p).toMatchObject({
      campo: 'kitNativo',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.jaEKitNativo,
    });
    expect(p.mensagem).toBe(
      'o produto já é kit nativo nesta conta (vínculo a-kit) e não tem anúncio comum ativo para ' +
        'converter — publique sem --converter-em-kit',
    );
  });

  it('(M142, L10-R6) DOIS kits nativos vivos e nenhum comum ⇒ vinculos-ambiguos nomeando os dois, nunca ja-e-kit-nativo', () => {
    const p = recusa(
      despachar(KIT_ANTIGO, [nativo('b-kit', KIT_2), nativo('a-kit', KIT_1)], {
        converterEmKit: true,
      }),
    );
    expect(p.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.vinculosAmbiguos);
    expect(p.mensagem).toContain(`a-kit (item ${String(KIT_1)})`);
    expect(p.mensagem).toContain(`b-kit (item ${String(KIT_2)})`);
  });

  it('(M142, L10(3)) DOIS anúncios comuns vivos, sem --link ⇒ kit-converter no LEXICAMENTE primeiro (escolherLink), nunca uma recusa', () => {
    const vinculos = [comum('z-comum', COMUM_2), comum('m-comum', COMUM_1)];
    const r = arma(despachar(KIT_ANTIGO, vinculos, { converterEmKit: true }));
    expect(r).toEqual({ arma: 'kit-converter', antecessorLinkDocId: 'm-comum' });
    // The SAME pick step 11's rule makes over the same rows.
    expect(
      escolherLink(
        vinculos.map((v) => ({ ...v, produtoId: K })),
        {},
      )?.id,
    ).toBe('m-comum');
  });

  it('(M142) `--link` nomeando o SEGUNDO comum ⇒ kit-converter nele', () => {
    const vinculos = [comum('z-comum', COMUM_2), comum('m-comum', COMUM_1)];
    expect(
      arma(despachar(KIT_ANTIGO, vinculos, { converterEmKit: true, linkDocId: 'z-comum' })),
    ).toEqual({ arma: 'kit-converter', antecessorLinkDocId: 'z-comum' });
  });

  it('`--link` num comum SUBSTITUÍDO ⇒ vinculo-substituido; num nativo, removido ou ausente ⇒ converter-sem-anuncio-comum', () => {
    const vinculos = [
      nativo('a-kit', KIT_1),
      comum('b-velho', COMUM_1, substituidoPor('a-kit')),
      comum('c-removido', COMUM_2, REMOVIDO),
    ];
    expect(
      recusa(despachar(KIT_ANTIGO, vinculos, { converterEmKit: true, linkDocId: 'b-velho' })),
    ).toMatchObject({ motivo: MOTIVO_PUBLICACAO_BLOQUEADA.vinculoSubstituido });
    for (const linkDocId of ['a-kit', 'c-removido', 'nao-existe']) {
      const p = recusa(despachar(KIT_ANTIGO, vinculos, { converterEmKit: true, linkDocId }));
      expect(p, linkDocId).toMatchObject({
        campo: 'linkDocId',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.converterSemAnuncioComum,
        mensagem:
          'não há anúncio comum ativo deste produto nesta conta para converter em kit nativo',
      });
    }
  });

  it('nenhum vínculo vivo de tipo algum ⇒ converter-sem-anuncio-comum (um REMOVIDO comum não conta)', () => {
    const p = recusa(
      despachar(KIT_ANTIGO, [comum('c-removido', COMUM_2, REMOVIDO)], { converterEmKit: true }),
    );
    expect(p.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.converterSemAnuncioComum);
  });
});

/* ========================================================================== */
/*  (2) a named link                                                           */
/* ========================================================================== */

describe('(2) um --link nomeado', () => {
  it('um vínculo que NÃO é desta conta ⇒ o braço de item com esse id (o 404 de sempre)', () => {
    expect(arma(despachar(NAO_KIT, [], { linkDocId: 'de-outra-conta' }))).toEqual({
      arma: 'item',
      linkDocId: 'de-outra-conta',
    });
  });

  it('um kit nativo VIVO ⇒ kit-atualizar; com --recriar ⇒ kit-recriar nele', () => {
    const vinculos = [nativo('a-kit', KIT_1), nativo('b-kit', KIT_2)];
    expect(arma(despachar(KIT_EFETIVO, vinculos, { linkDocId: 'b-kit' }))).toEqual({
      arma: 'kit-atualizar',
      linkDocId: 'b-kit',
    });
    expect(arma(despachar(KIT_EFETIVO, vinculos, { linkDocId: 'b-kit', recriar: true }))).toEqual({
      arma: 'kit-recriar',
      linkDocId: 'b-kit',
    });
  });

  it('(M136) um kit nativo SUBSTITUÍDO sem --recriar ⇒ vinculo-substituido nomeando o sucessor; COM --recriar ⇒ kit-recriar (a nova tentativa do delete)', () => {
    const vinculos = [nativo('a-velho', KIT_1, substituidoPor('b-novo')), nativo('b-novo', KIT_2)];
    const p = recusa(despachar(KIT_EFETIVO, vinculos, { linkDocId: 'a-velho' }));
    expect(p).toMatchObject({
      campo: 'linkDocId',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.vinculoSubstituido,
    });
    expect(p.mensagem).toContain('substituído pelo kit nativo b-novo');
    expect(arma(despachar(KIT_EFETIVO, vinculos, { linkDocId: 'a-velho', recriar: true }))).toEqual(
      { arma: 'kit-recriar', linkDocId: 'a-velho' },
    );
  });

  it('(M140) um kit nativo REMOVIDO sem --recriar ⇒ listagem-removida cuja frase diz `--link <ele> --recriar`; COM --recriar ⇒ kit-recriar nele', () => {
    const vinculos = [nativo('a-kit', KIT_1, REMOVIDO)];
    const p = recusa(despachar(KIT_EFETIVO, vinculos, { linkDocId: 'a-kit' }));
    expect(p.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida);
    expect(p.mensagem).toBe(
      `o kit nativo ${String(KIT_1)} foi excluído na Shopee — publique com --link a-kit --recriar ` +
        'para criar um novo',
    );
    expect(arma(despachar(KIT_EFETIVO, vinculos, { linkDocId: 'a-kit', recriar: true }))).toEqual({
      arma: 'kit-recriar',
      linkDocId: 'a-kit',
    });
  });

  it('(M136) um anúncio COMUM substituído, nomeado ⇒ vinculo-substituido — mesmo com --recriar', () => {
    const vinculos = [nativo('a-kit', KIT_1), comum('b-velho', COMUM_1, substituidoPor('a-kit'))];
    for (const recriar of [false, true]) {
      expect(
        recusa(despachar(KIT_ANTIGO, vinculos, { linkDocId: 'b-velho', recriar })).motivo,
      ).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.vinculoSubstituido);
    }
  });

  it('um anúncio comum vivo OU removido (não substituído), nomeado ⇒ o braço de item NELE', () => {
    const vinculos = [comum('a-vivo', COMUM_1), comum('b-removido', COMUM_2, REMOVIDO)];
    expect(arma(despachar(NAO_KIT, vinculos, { linkDocId: 'b-removido' }))).toEqual({
      arma: 'item',
      linkDocId: 'b-removido',
    });
  });

  it('(M137) --recriar num anúncio COMUM ⇒ opcao-de-kit-em-anuncio-comum no campo recriar', () => {
    const p = recusa(
      despachar(NAO_KIT, [comum('a-vivo', COMUM_1)], { linkDocId: 'a-vivo', recriar: true }),
    );
    expect(p).toMatchObject({
      campo: 'recriar',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.opcaoDeKitEmAnuncioComum,
      mensagem: '--principal, --recriar e --converter-em-kit só valem para kit nativo',
    });
  });
});

/* ========================================================================== */
/*  (3) the live native kits                                                   */
/* ========================================================================== */

describe('(3) os kits nativos vivos', () => {
  it('(M133) um kit IMPORTADO (ehKitVirtual false, vínculo kitNativo true) ⇒ kit-atualizar — o VÍNCULO é a autoridade, nunca o braço de item', () => {
    const importado: ProdutoDoDespacho = { id: K, paiId: null, ehKit: true, ehKitVirtual: false };
    expect(arma(despachar(importado, [nativo('a-kit', KIT_1)]))).toEqual({
      arma: 'kit-atualizar',
      linkDocId: 'a-kit',
    });
  });

  it('(M135) DOIS kits nativos vivos ⇒ vinculos-ambiguos nomeando os DOIS, com a dica `--link <kit antigo> --recriar` — nunca o lexicamente primeiro', () => {
    for (const vinculos of [
      [nativo('a-kit', KIT_1), nativo('b-kit', KIT_2)],
      [nativo('b-kit', KIT_2), nativo('a-kit', KIT_1)],
    ]) {
      const p = recusa(despachar(KIT_EFETIVO, vinculos));
      expect(p).toMatchObject({
        campo: 'linkDocId',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.vinculosAmbiguos,
      });
      expect(p.mensagem).toContain('o produto tem 2 kits nativos ativos nesta conta');
      expect(p.mensagem).toContain(`a-kit (item ${String(KIT_1)}), b-kit (item ${String(KIT_2)})`);
      expect(p.mensagem).toContain('--link <kit antigo> --recriar');
    }
  });

  it('(M136) um SUBSTITUÍDO e um vivo ⇒ kit-atualizar no VIVO, mesmo quando o substituído ordena primeiro', () => {
    const vinculos = [nativo('a-velho', KIT_1, substituidoPor('b-novo')), nativo('b-novo', KIT_2)];
    expect(arma(despachar(KIT_EFETIVO, vinculos))).toEqual({
      arma: 'kit-atualizar',
      linkDocId: 'b-novo',
    });
  });

  it('(L8 / RT14) um kit nativo vivo e o comum ainda VIVO ⇒ kit-atualizar no NATIVO (a regra 3 vem antes da 4)', () => {
    const vinculos = [comum('a-comum', COMUM_1), nativo('b-kit', KIT_1)];
    expect(arma(despachar(KIT_ANTIGO, vinculos))).toEqual({
      arma: 'kit-atualizar',
      linkDocId: 'b-kit',
    });
  });

  it('(M137, quase-par) --principal num kit-atualizar é PERMITIDO (comparado, nunca aplicado)', () => {
    expect(arma(despachar(KIT_EFETIVO, [nativo('a-kit', KIT_1)], { principal: 'comp-a' }))).toEqual(
      { arma: 'kit-atualizar', linkDocId: 'a-kit' },
    );
  });
});

/* ========================================================================== */
/*  (4) a live ordinary listing — step 11's pick, unchanged                    */
/* ========================================================================== */

describe('(4) o anúncio comum vivo — a escolha do passo 11, INALTERADA (L10(3))', () => {
  it('(M145) DOIS comuns vivos num produto NÃO-kit ⇒ o braço de item no LEXICAMENTE primeiro, zero recusa', () => {
    const vinculos = [comum('z-comum', COMUM_2), comum('m-comum', COMUM_1)];
    expect(arma(despachar(NAO_KIT, vinculos))).toEqual({ arma: 'item', linkDocId: 'm-comum' });
  });

  it('(M145) o MESMO para um kit ehKitVirtualEfetivo SEM vínculo nativo — nunca kit-criar, nunca uma recusa', () => {
    const vinculos = [comum('z-comum', COMUM_2), comum('m-comum', COMUM_1)];
    expect(arma(despachar(KIT_EFETIVO, vinculos))).toEqual({ arma: 'item', linkDocId: 'm-comum' });
  });

  it('(M145, variante) um comum REMOVIDO que ordena primeiro + um vivo, num não-kit ⇒ o item no REMOVIDO, exatamente como na main', () => {
    const vinculos = [comum('b-vivo', COMUM_2), comum('a-removido', COMUM_1, REMOVIDO)];
    expect(arma(despachar(NAO_KIT, vinculos))).toEqual({ arma: 'item', linkDocId: 'a-removido' });
  });

  it('(M145, quase-par) + UM nativo vivo ⇒ kit-atualizar nele; + DOIS ⇒ vinculos-ambiguos', () => {
    const comuns = [comum('z-comum', COMUM_2), comum('m-comum', COMUM_1)];
    expect(arma(despachar(KIT_EFETIVO, [...comuns, nativo('k1', KIT_1)]))).toEqual({
      arma: 'kit-atualizar',
      linkDocId: 'k1',
    });
    expect(
      recusa(despachar(KIT_EFETIVO, [...comuns, nativo('k1', KIT_1), nativo('k2', KIT_2)])).motivo,
    ).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.vinculosAmbiguos);
  });

  it('(M141) o id é SEMPRE entregue: com um comum vivo, nunca `linkDocId: null` — nem quando o removido nativo ordena primeiro', () => {
    const vinculos = [nativo('a-kit-removido', KIT_1, REMOVIDO), comum('b-comum', COMUM_1)];
    expect(arma(despachar(KIT_EFETIVO, vinculos))).toEqual({ arma: 'item', linkDocId: 'b-comum' });
  });

  it('um comum SUBSTITUÍDO nunca é a escolha: removido-e-substituído (L10-R5) fica de fora com o comum vivo', () => {
    const vinculos = [
      comum('a-convertido', COMUM_1, { ...REMOVIDO, ...substituidoPor('x') }),
      comum('b-vivo', COMUM_2),
    ];
    expect(arma(despachar(NAO_KIT, vinculos))).toEqual({ arma: 'item', linkDocId: 'b-vivo' });
  });

  it('(M137) --principal no braço de item ⇒ opcao-de-kit-em-anuncio-comum no campo principal — nunca ignorado', () => {
    const p = recusa(despachar(NAO_KIT, [comum('a-vivo', COMUM_1)], { principal: 'comp-a' }));
    expect(p).toMatchObject({
      campo: 'principal',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.opcaoDeKitEmAnuncioComum,
    });
    // ⛔ quase-par: sem --principal o mesmo produto publica.
    expect(arma(despachar(NAO_KIT, [comum('a-vivo', COMUM_1)]))).toEqual({
      arma: 'item',
      linkDocId: 'a-vivo',
    });
  });
});

/* ========================================================================== */
/*  (5) no live link                                                           */
/* ========================================================================== */

describe('(5) nenhum vínculo vivo', () => {
  it('(M134) ehKitVirtual LIGADO com ehKit DESLIGADO ⇒ kit-virtual-sem-kit (campo ehKitVirtual), nunca o braço de item', () => {
    const p = recusa(
      despachar({ id: 'prod-1', paiId: null, ehKit: false, ehKitVirtual: true }, []),
    );
    expect(p).toMatchObject({
      campo: 'ehKitVirtual',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.kitVirtualSemKit,
      mensagem:
        'o produto prod-1 está marcado como kit virtual, mas «É kit» está desligado — ligue «É kit» ' +
        'e informe os componentes, ou desligue «É kit virtual»',
    });
  });

  it('(M134, quase-par) ehKit E ehKitVirtual ⇒ kit-criar; nenhum dos dois ⇒ o primeiro publish de item (linkDocId null)', () => {
    expect(arma(despachar(KIT_EFETIVO, []))).toEqual({ arma: 'kit-criar' });
    expect(arma(despachar(NAO_KIT, []))).toEqual({ arma: 'item', linkDocId: null });
    // ⚠️ `=== true`: um 'true' de texto não é a flag.
    expect(arma(despachar({ ...KIT_EFETIVO, ehKitVirtual: 'true' }, []))).toEqual({
      arma: 'item',
      linkDocId: null,
    });
  });

  it('(M140) só um nativo REMOVIDO: efetivo ⇒ kit-criar (o primeiro kit, L0); não-efetivo ⇒ listagem-removida com a frase do kit', () => {
    const vinculos = [nativo('a-kit', KIT_1, REMOVIDO)];
    expect(arma(despachar(KIT_EFETIVO, vinculos))).toEqual({ arma: 'kit-criar' });
    const p = recusa(despachar(KIT_ANTIGO, vinculos));
    expect(p.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida);
    expect(p.mensagem).toContain('--link a-kit --recriar');
  });

  it('dois nativos REMOVIDOS ⇒ a frase nomeia o MAIS NOVO por ultimaModificacao, não o lexicamente primeiro', () => {
    const vinculos = [
      nativo('a-velho', KIT_1, { ...REMOVIDO, ultimaModificacao: 1_000 }),
      nativo('b-novo', KIT_2, { ...REMOVIDO, ultimaModificacao: 2_000 }),
    ];
    expect(recusa(despachar(KIT_ANTIGO, vinculos)).mensagem).toContain('--link b-novo --recriar');
  });

  it('(R6-M09 D5) um nativo SUBSTITUÍDO e ainda vivo, MAIS NOVO, ao lado de um REMOVIDO mais velho ⇒ a frase do kit nomeia o REMOVIDO, nunca vinculo-substituido', () => {
    // The recriar whose delete did not take (a-velho superseded by b-novo), and
    // then b-novo deleted in Seller Centre: a-velho still SELLS, so "foi
    // excluído" would be false about it — the one a `--recriar` replaces is b-novo.
    const vinculos = [
      nativo('a-velho', KIT_1, { ...substituidoPor('b-novo'), ultimaModificacao: 2_000 }),
      nativo('b-novo', KIT_2, { ...REMOVIDO, ultimaModificacao: 1_000 }),
    ];
    const p = recusa(despachar(KIT_ANTIGO, vinculos));
    expect(p.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida);
    expect(p.mensagem).toBe(
      `o kit nativo ${String(KIT_2)} foi excluído na Shopee — publique com --link b-novo --recriar ` +
        'para criar um novo',
    );
    // ⛔ quase-par: sem NENHUM nativo removido, o substituído responde a SUA recusa.
    const soSubstituido = recusa(despachar(KIT_ANTIGO, [vinculos[0]!]));
    expect(soSubstituido.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.vinculoSubstituido);
    expect(soSubstituido.mensagem).toContain('vínculo a-velho');
  });

  it('(R6-M09 D7) um nativo REMOVIDO e um comum REMOVIDO num não-efetivo ⇒ a frase do KIT (X antes de RO), nunca o braço de item no comum', () => {
    // The ordinary one sorts FIRST, so an RO-before-X order could not hide behind
    // the lexical pick.
    const vinculos = [comum('a-comum', COMUM_1, REMOVIDO), nativo('b-kit', KIT_1, REMOVIDO)];
    const p = recusa(despachar(KIT_ANTIGO, vinculos));
    expect(p.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida);
    expect(p.mensagem).toBe(
      `o kit nativo ${String(KIT_1)} foi excluído na Shopee — publique com --link b-kit --recriar ` +
        'para criar um novo',
    );
    // ⛔ quase-par: sem o nativo, o MESMO comum removido vai ao braço de item (o
    // listagem-removida do passo 11, como na main).
    expect(arma(despachar(KIT_ANTIGO, [vinculos[0]!]))).toEqual({
      arma: 'item',
      linkDocId: 'a-comum',
    });
  });

  it('(R6-M09 D11) um carimbo ILEGÍVEL ordena como o MAIS VELHO: o nativo removido com ultimaModificacao é o nomeado', () => {
    // The stamp-less and the text-stamped ones sort FIRST by id, so only the
    // stamp rule can name the stamped one.
    const vinculos = [
      nativo('a-sem-carimbo', KIT_1, REMOVIDO),
      nativo('b-carimbo-texto', 2500139874, { ...REMOVIDO, ultimaModificacao: '9999999999999' }),
      nativo('c-carimbado', KIT_2, { ...REMOVIDO, ultimaModificacao: 1_000 }),
    ];
    expect(recusa(despachar(KIT_ANTIGO, vinculos)).mensagem).toContain(
      '--link c-carimbado --recriar',
    );
    // ⛔ quase-par: dois ilegíveis empatam e o id desempata (o lexicamente primeiro).
    expect(recusa(despachar(KIT_ANTIGO, vinculos.slice(0, 2))).mensagem).toContain(
      '--link a-sem-carimbo --recriar',
    );
  });

  it('(M146) só um comum REMOVIDO: efetivo ⇒ kit-criar; não-efetivo ⇒ o braço de item NELE (⇒ listagem-removida, como na main)', () => {
    const vinculos = [comum('a-removido', COMUM_1, REMOVIDO)];
    expect(arma(despachar(KIT_EFETIVO, vinculos))).toEqual({ arma: 'kit-criar' });
    expect(arma(despachar(NAO_KIT, vinculos))).toEqual({ arma: 'item', linkDocId: 'a-removido' });
  });

  it('só um comum SUBSTITUÍDO (não efetivo) ⇒ vinculo-substituido nomeando-o', () => {
    const p = recusa(despachar(KIT_ANTIGO, [comum('a-velho', COMUM_1, substituidoPor('k-novo'))]));
    expect(p.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.vinculoSubstituido);
    expect(p.mensagem).toContain('vínculo a-velho');
    expect(p.mensagem).toContain('k-novo');
  });

  it('(M137) --principal num PRIMEIRO publish de item ⇒ opcao-de-kit-em-anuncio-comum', () => {
    expect(recusa(despachar(NAO_KIT, [], { principal: 'comp-a' })).motivo).toBe(
      MOTIVO_PUBLICACAO_BLOQUEADA.opcaoDeKitEmAnuncioComum,
    );
    // ⛔ quase-par: num kit-criar o --principal é o nomeado (L1).
    expect(arma(despachar(KIT_EFETIVO, [], { principal: 'comp-a' }))).toEqual({
      arma: 'kit-criar',
    });
  });
});

/* ========================================================================== */
/*  the body reader's own contract                                             */
/* ========================================================================== */

describe('o contrato do leitor de corpo', () => {
  it('--recriar sem --link e as duas ações juntas são defeito do CHAMADOR — lançam, nunca uma arma', () => {
    expect(() => despachar(KIT_EFETIVO, [], { recriar: true })).toThrow(/recriar sem linkDocId/);
    expect(() =>
      despachar(KIT_EFETIVO, [], { recriar: true, converterEmKit: true, linkDocId: 'a' }),
    ).toThrow(/recriar e converterEmKit/);
  });
});

/* ========================================================================== */
/*  (M145) over STORED docs: the dispatcher vs main's publish resolver          */
/* ========================================================================== */

describe('(M145) sobre documentos GRAVADOS: o despacho escolhe o MESMO id que o resolvedor léxico do passo 11', () => {
  async function comparar(db: FakeDb, produtoId: string, produto: ProdutoDoDespacho) {
    const vinculos = await lerVinculosDaConta(asDb(db), INTEGRACAO, produtoId);
    const doDespacho = arma(despachar(produto, vinculos));
    const doResolvedor = await resolverLinkPorProduto(asDb(db), INTEGRACAO, produtoId, null);
    return { doDespacho, doResolvedor: doResolvedor?.linkDocId ?? null };
  }

  it('dois comuns vivos, e um removido que ordena primeiro: o id é o da main em ambos', async () => {
    const db = new FakeDb();
    db.seed('produtos/prod-1', { nome: 'Camiseta', paiId: null });
    db.seed('produtos/prod-1/prodshopee/z-comum', comum('z-comum', COMUM_2).raw);
    db.seed('produtos/prod-1/prodshopee/m-comum', comum('m-comum', COMUM_1).raw);
    const vivos = await comparar(db, 'prod-1', NAO_KIT);
    expect(vivos).toEqual({
      doDespacho: { arma: 'item', linkDocId: 'm-comum' },
      doResolvedor: 'm-comum',
    });

    db.seed('produtos/prod-1/prodshopee/a-removido', comum('a-removido', 2500139863, REMOVIDO).raw);
    const comRemovido = await comparar(db, 'prod-1', NAO_KIT);
    expect(comRemovido).toEqual({
      doDespacho: { arma: 'item', linkDocId: 'a-removido' },
      doResolvedor: 'a-removido',
    });
  });

  it('(OP-27) a ORDEM é a do passo 11, o CONJUNTO cresceu: um vínculo na grafia NUA legada que ordena primeiro é a escolha dos DOIS (a main o ignorava e escolhia o canônico)', async () => {
    const db = new FakeDb();
    db.seed('produtos/prod-1', { nome: 'Camiseta', paiId: null });
    db.seed('produtos/prod-1/prodshopee/b-canonico', comum('b-canonico', COMUM_2).raw);
    db.seed('produtos/prod-1/prodshopee/a-legado', {
      ...comum('a-legado', COMUM_1).raw,
      contaProdutoShopeeOuterRef: `integracao/${INTEGRACAO}`,
    });
    expect(await comparar(db, 'prod-1', NAO_KIT)).toEqual({
      doDespacho: { arma: 'item', linkDocId: 'a-legado' },
      doResolvedor: 'a-legado',
    });

    // ⛔ quase-par: a grafia nua de OUTRA conta continua fora dos dois.
    const outra = new FakeDb();
    outra.seed('produtos/prod-1', { nome: 'Camiseta', paiId: null });
    outra.seed('produtos/prod-1/prodshopee/b-canonico', comum('b-canonico', COMUM_2).raw);
    outra.seed('produtos/prod-1/prodshopee/a-alheio', {
      ...comum('a-alheio', COMUM_1).raw,
      contaProdutoShopeeOuterRef: 'integracao/int-2',
    });
    expect(await comparar(outra, 'prod-1', NAO_KIT)).toEqual({
      doDespacho: { arma: 'item', linkDocId: 'b-canonico' },
      doResolvedor: 'b-canonico',
    });
  });
});
