/**
 * The link verdict: every refusal of the closed list with its near-miss, the
 * order import's own resolution taken as given (proved end to end through its
 * resolver against the fake db), and the fields the verdict reads.
 */
import { describe, expect, it } from 'vitest';
import { unidadeVendavelDaRaiz } from '@delfrance/data/admin/produtos';
import { type EnvioEstoqueAmazon, derivarFilhoUnico, makeEstoqueUid } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { membroParaEstoqueAmazon, quantidadeEstoqueAmazon } from './familiaEstoque';
import {
  FALHA_VINCULO_AMAZON,
  LIMITE_VINCULOS_AMAZON,
  type ResolucaoVinculoAmazon,
  criarResolvedorDeVinculosAmazon,
} from '../pedidos/vinculoProdutoAmazon';
import { MOTIVO_ESTOQUE_AMAZON, RECUSAS_VINCULO_ESTOQUE_AMAZON } from './motivosEstoque';
import {
  type AlvoDoPaiEstoqueAmazon,
  CAMPOS_DONO_ESTOQUE_AMAZON,
  CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON,
  CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON,
  CAMPOS_VINCULO_ESTOQUE_AMAZON,
  type EntradaVinculoEstoqueAmazon,
  LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON,
  type LinkDoSkuEstoqueAmazon,
  type UnidadeDoVinculoEstoqueAmazon,
  type VeredictoVinculoEstoqueAmazon,
  avaliarVinculoEstoqueAmazon,
  ponteiroPaiDoVinculoEstoqueAmazon,
  unidadeComVariacoesEstoqueAmazon,
} from './vinculoEstoque';

const CONTA = 'conta-1';
const SKU = 'SKU-1';
const ASIN = 'ASIN-UM';
const UNIDADE_P: ResolucaoVinculoAmazon = { produtoId: 'P', via: 'vinculo-amazon' };
const AMBIGUO: ResolucaoVinculoAmazon = { produtoId: null, via: FALHA_VINCULO_AMAZON.ambiguo };
const SEM_DONO: ResolucaoVinculoAmazon = { produtoId: null, via: 'unresolved' };

/** A unit no child points at. */
const SEM_FILHOS: UnidadeDoVinculoEstoqueAmazon = { raw: {}, filhosIds: [] };
/** A family's parent: two children. */
const COM_VARIACOES: UnidadeDoVinculoEstoqueAmazon = { raw: {}, filhosIds: ['F1', 'F2'] };

/** The pointer to the parent link doc `produtos/PAI/prodAmazon/lp`, canonical form. */
const PONTEIRO = 'documents/produtos/PAI/prodAmazon/lp';
const CAMINHO_PAI = 'produtos/PAI/prodAmazon/lp';

function link(
  linkId: string,
  dados: Record<string, unknown> = {},
  donoId = 'P',
): LinkDoSkuEstoqueAmazon {
  return {
    linkId,
    donoId,
    dados: { contaAmazonOuterRef: `documents/integracao/${CONTA}`, sku: SKU, asin: ASIN, ...dados },
  };
}

function entrada(over: Partial<EntradaVinculoEstoqueAmazon> = {}): EntradaVinculoEstoqueAmazon {
  return {
    contaId: CONTA,
    sku: SKU,
    resolucao: UNIDADE_P,
    dono: { id: 'P', raw: {} },
    linksDoSku: [link('l1')],
    paisDosLinks: new Map(),
    unidade: SEM_FILHOS,
    ...over,
  };
}

/** A link carrying the pointer, and the pointed-at doc read as `alvo`. */
function comPai(alvo: AlvoDoPaiEstoqueAmazon, dados: Record<string, unknown> = {}) {
  return entrada({
    linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: PONTEIRO, ...dados })],
    paisDosLinks: new Map([[CAMINHO_PAI, alvo]]),
  });
}

const veredicto = (e: EntradaVinculoEstoqueAmazon) => avaliarVinculoEstoqueAmazon(e);
const motivo = (v: VeredictoVinculoEstoqueAmazon) => (v.apto ? 'apto' : v.motivo);

function envio(emMs: number, extra: Partial<EnvioEstoqueAmazon> = {}): Record<string, unknown> {
  return { via: 'patch', emMs, quantidade: 3, resultado: 'aceito', submissionId: 's', ...extra };
}

describe('an apt link', () => {
  it('names its unit, its dono, its links, its ASINs and its latest outcome', () => {
    expect(veredicto(entrada())).toEqual({
      apto: true,
      unidadeId: 'P',
      donoId: 'P',
      linkIds: ['l1'],
      asinsDoVinculo: [ASIN],
      envioRecente: null,
      contagens: [],
    });
  });

  it('a family-of-one wrapper: the unit is the member, the dono and its links the wrapper’s', () => {
    const v = veredicto(
      entrada({
        resolucao: { produtoId: 'M', via: 'vinculo-amazon' },
        dono: { id: 'W', raw: {} },
        linksDoSku: [link('l1', {}, 'W')],
      }),
    );
    expect(v).toMatchObject({ apto: true, unidadeId: 'M', donoId: 'W', linkIds: ['l1'] });
  });

  it('★ publicado is never a gate: an unpublished dono is apt', () => {
    expect(veredicto(entrada({ dono: { id: 'P', raw: { publicado: false } } })).apto).toBe(true);
  });
});

describe('★ refusal 1: the order import’s resolution, taken as given', () => {
  it('two live donos ⇒ vinculo-ambiguo', () => {
    expect(motivo(veredicto(entrada({ resolucao: AMBIGUO })))).toBe('vinculo-ambiguo');
  });

  it('NEAR-MISS: two link docs under ONE dono ⇒ apt, both written back', () => {
    const v = veredicto(entrada({ linksDoSku: [link('l2'), link('l1')] }));
    expect(v).toMatchObject({ apto: true, linkIds: ['l1', 'l2'], asinsDoVinculo: [ASIN] });
  });

  it('no live dono ⇒ produto-ausente', () => {
    expect(motivo(veredicto(entrada({ resolucao: SEM_DONO })))).toBe('produto-ausente');
  });

  it('a dono the input does not carry, or one holding none of the links ⇒ produto-ausente', () => {
    expect(motivo(veredicto(entrada({ dono: null })))).toBe('produto-ausente');
    expect(motivo(veredicto(entrada({ dono: { id: 'Q', raw: {} } })))).toBe('produto-ausente');
  });

  it('a link doc under a GONE dono is not the SKU’s link: not written back, its outcome and pointer not read', () => {
    const v = veredicto(
      entrada({
        linksDoSku: [
          link('l1', { envioEstoqueAmazon: envio(1_000) }),
          link(
            'l9',
            { envioEstoqueAmazon: envio(9_000), produtoAmazonPaiOuterRef: 'lixo', asin: 'OUTRO' },
            'Q',
          ),
        ],
      }),
    );
    expect(v).toMatchObject({ apto: true, linkIds: ['l1'], asinsDoVinculo: [ASIN] });
    expect(v.apto && v.envioRecente?.emMs).toBe(1_000);
  });
});

describe('★ refusal 1, end to end through the order import’s own resolver (fake db)', () => {
  /** Seeds the docs, resolves the SKU through the resolver, and judges it. */
  async function julgar(
    seed: (db: FakeDb) => void,
    links: LinkDoSkuEstoqueAmazon[],
  ): Promise<VeredictoVinculoEstoqueAmazon> {
    const db = new FakeDb();
    seed(db);
    const resolucao = await criarResolvedorDeVinculosAmazon(asDb(db), CONTA).resolver(SKU);
    const donoId = resolucao.produtoId === null ? null : (links[0]?.donoId ?? null);
    return veredicto(
      entrada({
        resolucao,
        dono: donoId === null ? null : { id: donoId, raw: {} },
        linksDoSku: links,
      }),
    );
  }

  const vinculo = (db: FakeDb, produtoId: string, docId: string) =>
    db.seed(`produtos/${produtoId}/prodAmazon/${docId}`, {
      contaAmazonOuterRef: `documents/integracao/${CONTA}`,
      sku: SKU,
    });

  it('two live donos ⇒ vinculo-ambiguo', async () => {
    const v = await julgar(
      (db) => {
        db.seed('produtos/P', { nome: 'P' });
        db.seed('produtos/Q', { nome: 'Q' });
        vinculo(db, 'P', 'l1');
        vinculo(db, 'Q', 'l2');
      },
      [link('l1'), link('l2', {}, 'Q')],
    );
    expect(motivo(v)).toBe('vinculo-ambiguo');
  });

  it('NEAR-MISS: two docs under one live dono ⇒ apt with both', async () => {
    const v = await julgar(
      (db) => {
        db.seed('produtos/P', { nome: 'P' });
        vinculo(db, 'P', 'l1');
        vinculo(db, 'P', 'l2');
      },
      [link('l1'), link('l2')],
    );
    expect(v).toMatchObject({ apto: true, unidadeId: 'P', linkIds: ['l1', 'l2'] });
  });

  it(`the limit reached (${String(LIMITE_VINCULOS_AMAZON)} docs) ⇒ vinculo-ambiguo`, async () => {
    const ids = Array.from({ length: LIMITE_VINCULOS_AMAZON }, (_, i) => `l${String(i)}`);
    const v = await julgar(
      (db) => {
        db.seed('produtos/P', { nome: 'P' });
        for (const id of ids) vinculo(db, 'P', id);
      },
      ids.map((id) => link(id)),
    );
    expect(motivo(v)).toBe('vinculo-ambiguo');
  });

  it('every dono gone ⇒ produto-ausente', async () => {
    const v = await julgar((db) => vinculo(db, 'P', 'l1'), [link('l1')]);
    expect(motivo(v)).toBe('produto-ausente');
  });
});

describe('★ refusals 2 and 3: the parent pointer', () => {
  it('the pointer explicit null, or no pointer field at all ⇒ apt', () => {
    expect(
      veredicto(entrada({ linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: null })] })).apto,
    ).toBe(true);
    expect(veredicto(entrada()).apto).toBe(true);
  });

  it('the pointed-at doc carries THIS SKU ⇒ filho-com-sku-do-pai', () => {
    expect(motivo(veredicto(comPai({ sku: SKU, asin: 'ASIN-PAI' })))).toBe('filho-com-sku-do-pai');
  });

  it('the pointed-at doc carries the link’s non-null ASIN ⇒ filho-com-sku-do-pai', () => {
    expect(motivo(veredicto(comPai({ sku: 'SKU-PAI', asin: ASIN })))).toBe('filho-com-sku-do-pai');
  });

  it('NEAR-MISS: a different SKU and a different ASIN ⇒ apt', () => {
    expect(veredicto(comPai({ sku: 'SKU-PAI', asin: 'ASIN-PAI' })).apto).toBe(true);
  });

  it('NEAR-MISS: both ASINs null (or empty) are NOT the same ASIN ⇒ apt', () => {
    expect(veredicto(comPai({ sku: 'SKU-PAI', asin: null }, { asin: null })).apto).toBe(true);
    expect(veredicto(comPai({ sku: 'SKU-PAI', asin: '' }, { asin: '' })).apto).toBe(true);
  });

  it('★ the SKU is compared EXACTLY: equal ⇒ refused; a case or space change stays distinct ⇒ apt', () => {
    expect(motivo(veredicto(comPai({ sku: 'SKU-1', asin: null })))).toBe('filho-com-sku-do-pai');
    for (const quase of ['sku-1', 'SKU-1 ', ' SKU-1', 'SKU-10', 'SKU1']) {
      expect(veredicto(comPai({ sku: quase, asin: null })).apto, quase).toBe(true);
    }
  });

  it('NEAR-MISS: a pointed-at doc with no SKU matches none, not even a SKU spelled like its absence', () => {
    for (const [skuDoPai, sku] of [
      [undefined, 'undefined'],
      [null, 'null'],
    ] as const) {
      const e = { ...comPai({ sku: skuDoPai, asin: null }), sku };
      expect(veredicto(e).apto, sku).toBe(true);
    }
  });

  it('★ the ASIN is compared EXACTLY: equal ⇒ refused; a case change stays distinct ⇒ apt', () => {
    expect(motivo(veredicto(comPai({ sku: 'X', asin: ASIN })))).toBe('filho-com-sku-do-pai');
    for (const quase of [ASIN.toLowerCase(), `${ASIN} `, `${ASIN}2`]) {
      expect(veredicto(comPai({ sku: 'X', asin: quase })).apto, quase).toBe(true);
    }
  });

  it('the pointer naming a doc that does not exist ⇒ pai-do-vinculo-ilegivel', () => {
    expect(motivo(veredicto(comPai('sumido')))).toBe('pai-do-vinculo-ilegivel');
  });

  it('a readable pointer whose target the caller did not read ⇒ pai-do-vinculo-ilegivel (fail closed)', () => {
    expect(
      motivo(
        veredicto(entrada({ linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: PONTEIRO })] })),
      ),
    ).toBe('pai-do-vinculo-ilegivel');
  });

  it('★ a malformed pointer ⇒ pai-do-vinculo-ilegivel', () => {
    for (const ruim of [
      '',
      'lixo',
      'produtos/PAI',
      'produtos/PAI/prodAmazon',
      'produtos/PAI/prodAmazon/lp/x/y',
      'produtos/PAI/prodamazon/lp',
      'produtos/PAI/prodShopee/lp',
      'Documents/produtos/PAI/prodAmazon/lp',
      ' produtos/PAI/prodAmazon/lp',
      'produtos/PAI/prodAmazon/lp/',
      '/produtos/PAI/prodAmazon/lp',
      'documents/documents/produtos/PAI/prodAmazon/lp',
      'produtos//prodAmazon/lp',
      'produtos/../prodAmazon/lp',
      'integracao/PAI',
      42,
      { path: CAMINHO_PAI },
      true,
    ]) {
      expect(ponteiroPaiDoVinculoEstoqueAmazon(ruim), String(ruim)).toEqual({ tipo: 'ilegivel' });
      // Even with an apt target read at the path a lenient parse would land on.
      const e = entrada({
        linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: ruim })],
        paisDosLinks: new Map([[CAMINHO_PAI, { sku: 'SKU-PAI', asin: 'ASIN-PAI' }]]),
      });
      expect(motivo(veredicto(e)), String(ruim)).toBe('pai-do-vinculo-ilegivel');
    }
  });

  it('★ both stored ref forms of a pointer parse to ONE key (an EQUAL pair), and a different target stays apt', () => {
    expect(ponteiroPaiDoVinculoEstoqueAmazon(PONTEIRO)).toEqual(
      ponteiroPaiDoVinculoEstoqueAmazon(CAMINHO_PAI),
    );
    for (const forma of [PONTEIRO, CAMINHO_PAI]) {
      const e = entrada({
        linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: forma })],
        paisDosLinks: new Map([[CAMINHO_PAI, { sku: 'SKU-PAI', asin: 'ASIN-PAI' }]]),
      });
      expect(veredicto(e).apto, forma).toBe(true);
    }
  });

  it('NEAR-MISS: a pointer to another doc id is another key', () => {
    expect(ponteiroPaiDoVinculoEstoqueAmazon('produtos/PAI/prodAmazon/LP')).not.toEqual(
      ponteiroPaiDoVinculoEstoqueAmazon(CAMINHO_PAI),
    );
  });

  it('the pointer read: absent, unreadable, or its bare path and its two ids', () => {
    expect(ponteiroPaiDoVinculoEstoqueAmazon(undefined)).toEqual({ tipo: 'ausente' });
    expect(ponteiroPaiDoVinculoEstoqueAmazon(null)).toEqual({ tipo: 'ausente' });
    expect(ponteiroPaiDoVinculoEstoqueAmazon('x')).toEqual({ tipo: 'ilegivel' });
    expect(ponteiroPaiDoVinculoEstoqueAmazon(PONTEIRO)).toEqual({
      tipo: 'caminho',
      caminho: CAMINHO_PAI,
      produtoId: 'PAI',
      linkId: 'lp',
    });
  });

  it('every one of the dono’s links is checked: one bad pointer among two refuses', () => {
    const e = entrada({
      linksDoSku: [link('l1'), link('l2', { produtoAmazonPaiOuterRef: 'lixo' })],
    });
    expect(motivo(veredicto(e))).toBe('pai-do-vinculo-ilegivel');
  });
});

describe('★ refusal 4: a unit with variations', () => {
  /** A kit root `K` whose sole member the web wrote, exactly as its writer stamps the pointer. */
  const KIT_COM_ESPELHO: UnidadeDoVinculoEstoqueAmazon = {
    raw: { ehKit: true, paiId: null, filhoUnicoId: derivarFilhoUnico([{ id: 'KM' }]) },
    filhosIds: ['KM'],
  };
  const doKit = (unidade: UnidadeDoVinculoEstoqueAmazon) =>
    entrada({
      resolucao: { produtoId: 'K', via: 'vinculo-amazon' },
      dono: { id: 'K', raw: {} },
      linksDoSku: [link('l1', {}, 'K')],
      unidade,
    });

  it('a non-kit unit with children ⇒ unidade-com-variacoes', () => {
    expect(motivo(veredicto(entrada({ unidade: COM_VARIACOES })))).toBe('unidade-com-variacoes');
    expect(motivo(veredicto(entrada({ unidade: { raw: {}, filhosIds: ['F1'] } })))).toBe(
      'unidade-com-variacoes',
    );
  });

  it('NEAR-MISS: no children ⇒ apt', () => {
    expect(veredicto(entrada({ unidade: SEM_FILHOS })).apto).toBe(true);
  });

  it('★ a KIT root with its own sole-member mirror ⇒ apt, publishing the kit’s component-min (the unit the order binds)', () => {
    // The order import binds a kit root itself, never its mirror.
    expect(
      unidadeVendavelDaRaiz({
        ehKit: true,
        produtoId: 'K',
        familia: { id: 'K', paiId: null, filhoUnicoId: 'KM' },
      }),
    ).toBe('K');
    const v = veredicto(doKit(KIT_COM_ESPELHO));
    expect(v).toMatchObject({ apto: true, unidadeId: 'K', donoId: 'K' });
    const membro = membroParaEstoqueAmazon(
      {
        id: v.apto ? v.unidadeId : '',
        raw: { ehKit: true, componentesKit: { A: { quantidade: 2 } } },
      },
      { caminho: `produtos/K/estoques/${makeEstoqueUid('K', 'dep-1')}`, raw: { quantidade: 50 } },
      [{ caminho: `produtos/A/estoques/${makeEstoqueUid('A', 'dep-1')}`, raw: { quantidade: 9 } }],
    );
    expect(quantidadeEstoqueAmazon(membro)).toBe(4);
  });

  it('★ NEAR-MISS: a kit root with TWO children (two kit variations) ⇒ unidade-com-variacoes', () => {
    expect(motivo(veredicto(doKit({ raw: KIT_COM_ESPELHO.raw, filhosIds: ['KM', 'KV2'] })))).toBe(
      'unidade-com-variacoes',
    );
  });

  it('★ NEAR-MISS: a kit whose one child is NOT the one its filhoUnicoId names (drift) ⇒ refused; the same id ⇒ apt (an EQUAL pair)', () => {
    for (const outro of ['KX', 'km', 'KM ', '']) {
      expect(
        motivo(veredicto(doKit({ raw: KIT_COM_ESPELHO.raw, filhosIds: [outro] }))),
        outro,
      ).toBe('unidade-com-variacoes');
    }
    expect(veredicto(doKit({ raw: KIT_COM_ESPELHO.raw, filhosIds: ['KM'] })).apto).toBe(true);
  });

  it('★ NEAR-MISS: a non-kit root with one child and no filhoUnicoId (drifted), or naming it, ⇒ still refused', () => {
    for (const raw of [{}, { ehKit: false, filhoUnicoId: 'KM' }, { filhoUnicoId: 'KM' }]) {
      expect(motivo(veredicto(doKit({ raw, filhosIds: ['KM'] }))), JSON.stringify(raw)).toBe(
        'unidade-com-variacoes',
      );
    }
  });

  it('NEAR-MISS: a kit with one child but no readable pointer, or a kit that is itself a child ⇒ refused (fail closed)', () => {
    for (const raw of [
      { ehKit: true },
      { ehKit: true, filhoUnicoId: null },
      { ehKit: true, filhoUnicoId: '' },
      { ehKit: 'true', filhoUnicoId: 'KM' },
      { ehKit: true, paiId: 'PAI', filhoUnicoId: 'KM' },
      { ehKit: true, paiId: '', filhoUnicoId: 'KM' },
      { ehKit: true, paiId: 42, filhoUnicoId: 'KM' },
    ]) {
      expect(
        unidadeComVariacoesEstoqueAmazon('K', { raw, filhosIds: ['KM'] }),
        JSON.stringify(raw),
      ).toBe(true);
    }
    // A kit root with NO child at all publishes its own composition: no variation.
    expect(unidadeComVariacoesEstoqueAmazon('K', { raw: KIT_COM_ESPELHO.raw, filhosIds: [] })).toBe(
      false,
    );
  });

  it('the seek needs at most two children to decide', () => {
    expect(LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON).toBe(2);
  });
});

describe('★ refusal 5: the dono’s opt-out, enviarEstoque === false under THIS conta’s key', () => {
  const comStatus = (status: unknown, dados: Record<string, unknown> = {}) =>
    entrada({
      dono: { id: 'P', raw: { statusProdutosMarketplace: status } },
      linksDoSku: [link('l1', dados)],
    });

  it('enviarEstoque === false under <contaId>_<asin> ⇒ envio-desligado', () => {
    expect(motivo(veredicto(comStatus({ [`${CONTA}_${ASIN}`]: { enviarEstoque: false } })))).toBe(
      'envio-desligado',
    );
  });

  it("NEAR-MISSES: undefined, true, the string 'false', 0, null, no entry, no map ⇒ apt", () => {
    for (const valor of [undefined, true, 'false', 0, null]) {
      expect(
        veredicto(comStatus({ [`${CONTA}_${ASIN}`]: { enviarEstoque: valor } })).apto,
        String(valor),
      ).toBe(true);
    }
    expect(veredicto(comStatus({ [`${CONTA}_${ASIN}`]: {} })).apto).toBe(true);
    expect(veredicto(comStatus({})).apto).toBe(true);
    expect(veredicto(comStatus(null)).apto).toBe(true);
    expect(veredicto(comStatus('desligado')).apto).toBe(true);
  });

  it('★ NEAR-MISSES: another conta’s key, another ASIN’s key, a case change of either ⇒ apt', () => {
    for (const chave of [
      `conta-2_${ASIN}`,
      `${CONTA}_ASIN-OUTRO`,
      `${CONTA}_${ASIN.toLowerCase()}`,
      `CONTA-1_${ASIN}`,
      `${CONTA}-${ASIN}`,
      `${CONTA}_${ASIN} `,
    ]) {
      expect(veredicto(comStatus({ [chave]: { enviarEstoque: false } })).apto, chave).toBe(true);
    }
  });

  it('the key carries the link’s ASIN EXACTLY as stored: a lower-case ASIN under its own key ⇒ envio-desligado, under the upper-cased key ⇒ apt', () => {
    const minusculo = { asin: 'asin-um' };
    expect(
      motivo(veredicto(comStatus({ [`${CONTA}_asin-um`]: { enviarEstoque: false } }, minusculo))),
    ).toBe('envio-desligado');
    expect(
      veredicto(comStatus({ [`${CONTA}_ASIN-UM`]: { enviarEstoque: false } }, minusculo)).apto,
    ).toBe(true);
  });

  it('a link with no ASIN has no key to switch off ⇒ apt', () => {
    expect(
      veredicto(comStatus({ [`${CONTA}_${ASIN}`]: { enviarEstoque: false } }, { asin: null })).apto,
    ).toBe(true);
  });

  it('any of the dono’s link ASINs switched off ⇒ envio-desligado, whichever of them sorts first', () => {
    // ASIN-OUTRO sorts before ASIN-UM: switching off either must refuse.
    for (const desligado of ['ASIN-OUTRO', ASIN]) {
      const e = entrada({
        dono: {
          id: 'P',
          raw: {
            statusProdutosMarketplace: { [`${CONTA}_${desligado}`]: { enviarEstoque: false } },
          },
        },
        linksDoSku: [link('l1'), link('l2', { asin: 'ASIN-OUTRO' })],
      });
      expect(motivo(veredicto(e)), desligado).toBe('envio-desligado');
    }
  });
});

describe('★ a link with no ASIN is apt and counted', () => {
  it('asin: null ⇒ apt, flagged semAsinNoVinculo', () => {
    expect(veredicto(entrada({ linksDoSku: [link('l1', { asin: null })] }))).toMatchObject({
      apto: true,
      asinsDoVinculo: [],
      contagens: ['semAsinNoVinculo'],
    });
  });

  it('an empty ASIN reads as none; no field at all the same', () => {
    expect(veredicto(entrada({ linksDoSku: [link('l1', { asin: '' })] }))).toMatchObject({
      contagens: ['semAsinNoVinculo'],
    });
    const semCampo: LinkDoSkuEstoqueAmazon = { linkId: 'l1', donoId: 'P', dados: { sku: SKU } };
    expect(veredicto(entrada({ linksDoSku: [semCampo] }))).toMatchObject({
      contagens: ['semAsinNoVinculo'],
    });
  });

  it('the ASINs are distinct and sorted, whatever the link order', () => {
    expect(
      veredicto(
        entrada({
          linksDoSku: [
            link('l1', { asin: 'B-ASIN' }),
            link('l2', { asin: 'A-ASIN' }),
            link('l3', { asin: 'B-ASIN' }),
          ],
        }),
      ),
    ).toMatchObject({ asinsDoVinculo: ['A-ASIN', 'B-ASIN'] });
  });

  it('NEAR-MISS: one doc with an ASIN among two ⇒ not counted, that ASIN carried', () => {
    expect(
      veredicto(entrada({ linksDoSku: [link('l1', { asin: null }), link('l2')] })),
    ).toMatchObject({
      asinsDoVinculo: [ASIN],
      contagens: [],
    });
  });
});

describe('the order of the refusals', () => {
  it('the resolution first, then the pointers, then the unit, then the opt-out', () => {
    const tudoErrado = (over: Partial<EntradaVinculoEstoqueAmazon>) =>
      entrada({
        dono: {
          id: 'P',
          raw: { statusProdutosMarketplace: { [`${CONTA}_${ASIN}`]: { enviarEstoque: false } } },
        },
        unidade: COM_VARIACOES,
        linksDoSku: [
          link('l1', { produtoAmazonPaiOuterRef: 'lixo' }),
          link('l2', { produtoAmazonPaiOuterRef: PONTEIRO }),
        ],
        paisDosLinks: new Map([[CAMINHO_PAI, { sku: SKU, asin: null }]]),
        ...over,
      });
    expect(motivo(veredicto(tudoErrado({ resolucao: AMBIGUO })))).toBe('vinculo-ambiguo');
    expect(motivo(veredicto(tudoErrado({})))).toBe('pai-do-vinculo-ilegivel');
    expect(
      motivo(
        veredicto(tudoErrado({ linksDoSku: [link('l2', { produtoAmazonPaiOuterRef: PONTEIRO })] })),
      ),
    ).toBe('filho-com-sku-do-pai');
    expect(motivo(veredicto(tudoErrado({ linksDoSku: [link('l1')] })))).toBe(
      'unidade-com-variacoes',
    );
    expect(motivo(veredicto(tudoErrado({ linksDoSku: [link('l1')], unidade: SEM_FILHOS })))).toBe(
      'envio-desligado',
    );
  });

  it('★ every pointer is checked before any parent identity: a parent carrying THIS SKU on the first link, an unreadable pointer on the second ⇒ pai-do-vinculo-ilegivel', () => {
    const e = entrada({
      linksDoSku: [
        link('l1', { produtoAmazonPaiOuterRef: PONTEIRO }),
        link('l2', { produtoAmazonPaiOuterRef: 'lixo' }),
      ],
      paisDosLinks: new Map([[CAMINHO_PAI, { sku: SKU, asin: null }]]),
    });
    expect(motivo(veredicto(e))).toBe('pai-do-vinculo-ilegivel');
  });

  it('every refusal it answers is in the closed link-refusal set', () => {
    for (const m of [
      'vinculo-ambiguo',
      'produto-ausente',
      'pai-do-vinculo-ilegivel',
      'filho-com-sku-do-pai',
      'unidade-com-variacoes',
      'envio-desligado',
    ] as const) {
      expect(RECUSAS_VINCULO_ESTOQUE_AMAZON.has(m), m).toBe(true);
    }
    expect(RECUSAS_VINCULO_ESTOQUE_AMAZON.has(MOTIVO_ESTOQUE_AMAZON.naoListado)).toBe(false);
  });
});

describe('the latest stored outcome (the recent-send rule’s input)', () => {
  it('none stored ⇒ null', () => {
    expect(veredicto(entrada())).toMatchObject({ envioRecente: null });
  });

  it('the latest emMs among the dono’s docs, whatever its via', () => {
    const v = veredicto(
      entrada({
        linksDoSku: [
          link('l1', { envioEstoqueAmazon: envio(2_000, { quantidade: 4 }) }),
          link('l2', {
            envioEstoqueAmazon: {
              via: 'feed',
              emMs: 3_000,
              quantidade: null,
              resultado: 'recusado',
              feedId: '12345',
            },
          }),
          link('l3', { envioEstoqueAmazon: envio(1_000) }),
        ],
      }),
    );
    expect(v.apto && v.envioRecente).toMatchObject({ via: 'feed', emMs: 3_000, feedId: '12345' });
  });

  it('a stored entry its schema refuses is skipped, never read as a send', () => {
    const v = veredicto(
      entrada({
        linksDoSku: [
          link('l1', { envioEstoqueAmazon: envio(1_000) }),
          link('l2', {
            envioEstoqueAmazon: { via: 'patch', emMs: '9000', quantidade: 3, resultado: 'aceito' },
          }),
          link('l3', {
            envioEstoqueAmazon: {
              via: 'feed',
              emMs: 9_000,
              quantidade: 3,
              resultado: 'aceito',
              feedId: '1',
            },
          }),
        ],
      }),
    );
    expect(v.apto && v.envioRecente?.emMs).toBe(1_000);
  });

  it('an equal emMs keeps the smallest link id’s entry', () => {
    const v = veredicto(
      entrada({
        linksDoSku: [
          link('l2', { envioEstoqueAmazon: envio(5_000, { quantidade: 2 }) }),
          link('l1', { envioEstoqueAmazon: envio(5_000, { quantidade: 1 }) }),
        ],
      }),
    );
    expect(v.apto && v.envioRecente?.quantidade).toBe(1);
  });
});

describe('★ the declared fields are all the verdict reads', () => {
  const projetar = (raw: Readonly<Record<string, unknown>>, campos: readonly string[]) =>
    Object.fromEntries(Object.entries(raw).filter(([k]) => campos.includes(k)));

  it('a projection of every link, the dono and every parent to them changes no verdict', () => {
    const ruido = {
      productDataJson: { a: 1 },
      issues: [{ code: 'X' }],
      listingStatus: ['BUYABLE'],
      publicado: false,
    };
    const casos: EntradaVinculoEstoqueAmazon[] = [
      entrada(),
      entrada({ linksDoSku: [link('l1', { asin: null })] }),
      comPai({ sku: SKU, asin: null }),
      comPai({ sku: 'X', asin: ASIN }),
      comPai({ sku: 'X', asin: 'Y' }),
      comPai('sumido'),
      entrada({ linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: 'lixo' })] }),
      entrada({
        dono: {
          id: 'P',
          raw: { statusProdutosMarketplace: { [`${CONTA}_${ASIN}`]: { enviarEstoque: false } } },
        },
      }),
      entrada({ linksDoSku: [link('l1', { envioEstoqueAmazon: envio(7_000) })] }),
      entrada({ unidade: COM_VARIACOES }),
      entrada({
        unidade: { raw: { ehKit: true, paiId: null, filhoUnicoId: 'PM' }, filhosIds: ['PM'] },
      }),
      entrada({ unidade: { raw: { ehKit: true, filhoUnicoId: 'PM' }, filhosIds: ['PX'] } }),
    ];
    for (const e of casos) {
      const cheio: EntradaVinculoEstoqueAmazon = {
        ...e,
        unidade: { ...e.unidade, raw: { ...ruido, ...e.unidade.raw } },
        dono: e.dono === null ? null : { id: e.dono.id, raw: { ...ruido, ...e.dono.raw } },
        linksDoSku: e.linksDoSku.map((l) => ({ ...l, dados: { ...ruido, ...l.dados } })),
        paisDosLinks: new Map(
          [...e.paisDosLinks].map(([k, alvo]) => [k, alvo === 'sumido' ? alvo : { ...alvo }]),
        ),
      };
      const projetado: EntradaVinculoEstoqueAmazon = {
        ...e,
        unidade: {
          ...e.unidade,
          raw: projetar(cheio.unidade.raw, CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON),
        },
        dono:
          e.dono === null
            ? null
            : { id: e.dono.id, raw: projetar(cheio.dono?.raw ?? {}, CAMPOS_DONO_ESTOQUE_AMAZON) },
        linksDoSku: cheio.linksDoSku.map((l) => ({
          ...l,
          dados: projetar(l.dados, CAMPOS_VINCULO_ESTOQUE_AMAZON),
        })),
        paisDosLinks: new Map(
          [...e.paisDosLinks].map(([k, alvo]) => [
            k,
            alvo === 'sumido'
              ? alvo
              : (projetar(alvo, CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON) as {
                  sku: unknown;
                  asin: unknown;
                }),
          ]),
        ),
      };
      expect(veredicto(projetado)).toEqual(veredicto(cheio));
    }
  });
});
