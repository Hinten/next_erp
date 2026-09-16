/**
 * The pure half of `importar:anuncio` (#1517, step 9).
 *
 * ⚠️ Four of these are the only thing standing between a rehearsal and a leak or
 * a dead command, and none of them is a happy path:
 *
 *  - **3** drives the summary over an `ItemLido` that REALLY carries a seller
 *    description, a fiscal block and two image URLs, and asserts the rendered
 *    output and the JSON object carry NONE of the three values — with a
 *    FIELD-COUNT pin beside it, so a field added to the allow-list has to be
 *    looked at rather than inherited;
 *  - **1** pins that `--item` refuses everything that is not a bare run of
 *    digits, including the value a trimming reader would have "fixed";
 *  - **4** pins that the documented invocation carries no `--` separator —
 *    `pnpm-run-args.test.js` fails CI on that spelling, and the command would die
 *    on its own separator;
 *  - **5** pins that a REFUSED listing describes itself as an answer
 *    (`bloqueado: <motivo>`), which is what the script's exit 0 rests on.
 */
import { describe, expect, it } from 'vitest';

import {
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  shopeeTaxInfoSchema,
} from '@delfrance/integrations-shopee';
import { importacaoShopeeOptionsSchema, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import { MOTIVO_IMPORT_BLOQUEADO, ShopeeImportBlockedError } from './errosImportacao';
import type { ItemLido, ResultadoImportacaoShopee } from './itemLido';
import type { ComponenteDoKitShopee } from './kitShopee';
import {
  planejarImportacaoShopee,
  type PreparoFilhoShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';
import {
  ArgumentoInvalidoError,
  MSG_ITEM_NAO_NUMERICO,
  USO_IMPORTAR_ANUNCIO,
  descreverBloqueio,
  descreverErroImportacao,
  parseArgsImportarAnuncio,
  renderComponentesKit,
  renderProdutoArmazenado,
  renderResumoImportacao,
  resumirPlano,
  resumirPlanoJson,
  resumirResultado,
  resumoDoPlano,
  resumoDoProdutoArmazenado,
  taxInfoCamposDe,
} from './importarAnuncioCli';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or seller.  */
/* -------------------------------------------------------------------------- */

const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const INTEGRACAO = 'int-1';
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const AGORA = 1_757_000_000_000;

/** Sentinels — nothing real, and nothing that may reach the output. */
const SENTINELA_DESCRICAO = 'SENTINELA-DESCRICAO-AUTORAL-DO-VENDEDOR';
const SENTINELA_NCM = 'SENTINELA-NCM-DA-LOJA';
const SENTINELA_CSOSN = 'SENTINELA-CSOSN-DA-LOJA';
const SENTINELA_FOTO_1 = 'https://sentinela.invalido/foto-1.jpg';
const SENTINELA_FOTO_2 = 'https://sentinela.invalido/foto-2.jpg';

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse(parcial);
}

/** A listing that carries everything the allow-list must keep out. */
function item(parcial: Record<string, unknown> = {}, models?: ItemLido['models']): ItemLido {
  const taxInfo = shopeeTaxInfoSchema.parse({
    ncm: SENTINELA_NCM,
    csosn: SENTINELA_CSOSN,
  });
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica Azul',
      item_sku: 'CAM-AZ',
      gtin_code: '7891234567895',
      category_id: 100017,
      weight: '0.85',
      dimension: { package_length: 20, package_width: 15, package_height: 10 },
      description: SENTINELA_DESCRICAO,
      price_info: [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }],
      stock_info_v2: { seller_stock: [{ stock: 7 }] },
      image: {
        image_url_list: [SENTINELA_FOTO_1, SENTINELA_FOTO_2],
        image_id_list: ['img-1', 'img-2'],
      },
      tax_info: { ncm: SENTINELA_NCM, csosn: SENTINELA_CSOSN },
      ...parcial,
    }),
    models: models ?? null,
    taxInfo,
    kit: null,
    itemId: ITEM_ID,
  };
}

function modelos() {
  return shopeeModelListPayloadSchema.parse({
    model: [
      { model_id: MODEL_ID, tier_index: [0], model_sku: 'CAM-AZ-P' },
      { model_id: MODEL_ID + 1, tier_index: [1], model_sku: 'CAM-AZ-M' },
    ],
    tier_variation: [{ name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'M' }] }],
  });
}

function filho(modelo: PreparoFilhoShopee['modelo']): PreparoFilhoShopee {
  return { modelo, existente: null, vinculoDeOutraFamilia: false, link: null, estoque: null };
}

function preparo(parcial: Partial<PreparoImportacaoShopee> = {}): PreparoImportacaoShopee {
  return {
    entrada: item(),
    integracaoId: INTEGRACAO,
    nowMs: AGORA,
    options: opcoes(),
    tabelaNormalOuterRef: TABELA_NORMAL,
    tabelaPromocionalOuterRef: 'documents/listaDePrecos/tab-promo',
    depositoOuterRef: DEPOSITO,
    pai: {
      existente: null,
      extraData: null,
      linkSobFilho: false,
      jaTemFilhos: false,
      estoque: null,
    },
    filhos: [],
    linkPai: null,
    grupos: { docs: [] },
    categorias: [],
    imagensJaCacheadas: [],
    ...parcial,
  };
}

function componente(parcial: Partial<ComponenteDoKitShopee> = {}): ComponenteDoKitShopee {
  return {
    modelId: MODEL_ID,
    itemId: ITEM_ID + 1,
    modelIdDoComponente: 0,
    sku: 'COMP-1',
    quantidade: 2,
    produtoId: 'prod-componente',
    via: 'prodshopee',
    ...parcial,
  } as ComponenteDoKitShopee;
}

/* -------------------------------------------------------------------------- */
/*  1. arguments                                                               */
/* -------------------------------------------------------------------------- */

describe('parseArgsImportarAnuncio', () => {
  it('lê a linha de comando completa', () => {
    const cmd = parseArgsImportarAnuncio([
      '--integracao',
      INTEGRACAO,
      '--item',
      String(ITEM_ID),
      '--json',
      '--project',
      'meu-projeto',
    ]);
    expect(cmd).toEqual({
      kind: 'importar',
      args: {
        integracaoId: INTEGRACAO,
        itemId: ITEM_ID,
        live: false,
        json: true,
        projectId: 'meu-projeto',
      },
    });
  });

  it('aceita a forma --chave=valor', () => {
    const cmd = parseArgsImportarAnuncio([
      `--integracao=${INTEGRACAO}`,
      `--item=${String(ITEM_ID)}`,
    ]);
    expect(cmd.kind === 'importar' ? cmd.args.itemId : null).toBe(ITEM_ID);
  });

  it('--help é respondido ANTES de qualquer validação', () => {
    expect(parseArgsImportarAnuncio(['--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsImportarAnuncio(['-h'])).toEqual({ kind: 'ajuda' });
    // Sem os obrigatórios, com uma opção desconhecida e com a contradição junto:
    // nenhuma delas pode roubar a ajuda.
    expect(parseArgsImportarAnuncio(['--live', '--dry-run', '--nao-existe', '--help'])).toEqual({
      kind: 'ajuda',
    });
  });

  it('⛔ --live e --dry-run juntos são RECUSADOS, nunca resolvidos por precedência', () => {
    expect(() =>
      parseArgsImportarAnuncio([
        '--integracao',
        INTEGRACAO,
        '--item',
        String(ITEM_ID),
        '--live',
        '--dry-run',
      ]),
    ).toThrow(ArgumentoInvalidoError);
  });

  it('dry-run é o PADRÃO e --live é a única forma de gravar', () => {
    const seco = parseArgsImportarAnuncio(['--integracao', INTEGRACAO, '--item', String(ITEM_ID)]);
    expect(seco.kind === 'importar' ? seco.args.live : true).toBe(false);
    const vivo = parseArgsImportarAnuncio([
      '--integracao',
      INTEGRACAO,
      '--item',
      String(ITEM_ID),
      '--live',
    ]);
    expect(vivo.kind === 'importar' ? vivo.args.live : false).toBe(true);
  });

  it('exige --integracao e --item', () => {
    expect(() => parseArgsImportarAnuncio(['--item', String(ITEM_ID)])).toThrow(
      ArgumentoInvalidoError,
    );
    expect(() => parseArgsImportarAnuncio(['--integracao', INTEGRACAO])).toThrow(
      ArgumentoInvalidoError,
    );
  });

  it('⛔ --item NÃO numérico é recusado com a frase dele', () => {
    for (const bruto of ['abc', '25e9', '2500139861x', '', '-1', '1.5', '1,5', '٢٥']) {
      expect(() =>
        parseArgsImportarAnuncio(['--integracao', INTEGRACAO, `--item=${bruto}`]),
      ).toThrow(ArgumentoInvalidoError);
    }
    try {
      parseArgsImportarAnuncio(['--integracao', INTEGRACAO, '--item=abc']);
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ArgumentoInvalidoError)) throw err;
      expect(err.message).toBe(MSG_ITEM_NAO_NUMERICO);
    }
  });

  it('⛔ --item com ESPAÇOS é recusado — o leitor numérico não apara nada', () => {
    // Um leitor que desse `.trim()` aceitaria os três e importaria um id que o
    // operador não digitou.
    for (const bruto of [' 2500139861', '2500139861 ', ' 2500139861 ']) {
      expect(() =>
        parseArgsImportarAnuncio(['--integracao', INTEGRACAO, `--item=${bruto}`]),
      ).toThrow(ArgumentoInvalidoError);
    }
  });

  it('⛔ --item 0 e um id fora do inteiro seguro são recusados', () => {
    expect(() => parseArgsImportarAnuncio(['--integracao', INTEGRACAO, '--item=0'])).toThrow(
      ArgumentoInvalidoError,
    );
    // int64 da Shopee que não cabe exato num number: importaria OUTRO anúncio.
    expect(() =>
      parseArgsImportarAnuncio(['--integracao', INTEGRACAO, '--item=9007199254740993']),
    ).toThrow(ArgumentoInvalidoError);
  });

  it('⛔ o separador "--" repassado pelo pnpm é recusado com a explicação', () => {
    expect(() =>
      parseArgsImportarAnuncio(['--', '--integracao', INTEGRACAO, '--item', String(ITEM_ID)]),
    ).toThrow(ArgumentoInvalidoError);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. the plan summary                                                        */
/* -------------------------------------------------------------------------- */

describe('resumoDoPlano — o que o ensaio mostra', () => {
  it('descreve a criação de um anúncio simples, campo a campo', () => {
    const plano = planejarImportacaoShopee(preparo());
    const entrada = item();
    const r = resumoDoPlano(plano, entrada);

    expect(r.itemId).toBe(ITEM_ID);
    expect(r.acao).toBe('criar');
    expect(r.nome).toBe('Camiseta Básica Azul');
    expect(r.nomeChars).toBe('Camiseta Básica Azul'.length);
    expect(r.sku).toBe('CAM-AZ');
    expect(r.gtin).toBe('7891234567895');
    expect(r.publicado).toBe(true);
    expect(r.pesoKg).toBe(0.85);
    expect(r.alturaCm).toBe(10);
    expect(r.preco).toEqual({ tabelaId: 'tab-normal', valor: 99.9 });
    expect(r.precoIgnorado).toBeNull();
    expect(r.estoque).toBe(7);
    expect(r.variacoes).toEqual({ total: 0, criar: 0, existentes: 0, semLink: 0 });
    expect(r.links.pai).toBe('add');
    expect(r.links.paiRefPendente).toBe(true);
    expect(r.fotos).toEqual({ noAnuncio: 2, jaEmCache: 0, aBaixar: 2 });
    expect(r.ehKit).toBe(false);
    expect(r.kit).toBeNull();
  });

  it('conta variações, grupos e vínculos a partir do PLANO', () => {
    const mods = modelos();
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({ has_model: true }, mods),
        filhos: mods.model.map((m) => filho(m)),
      }),
    );
    const r = resumoDoPlano(plano, item({ has_model: true }, mods));

    expect(r.variacoes.total).toBe(2);
    expect(r.variacoes.criar).toBe(2);
    expect(r.variacoes.existentes).toBe(0);
    expect(r.filhos).toHaveLength(2);
    expect(r.filhos[0]?.modelId).toBe(MODEL_ID);
    expect(r.filhos[0]?.produtoId).toBe(plano.filhoUnico.idsPlanejados[0]);
    expect(r.filhos.every((f) => f.link === 'add')).toBe(true);
    expect(r.links.filhosAdd).toBe(2);
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0]?.criar).toBe(true);
    expect(r.grupos[0]?.nome).toBe('Tamanho');
    expect(r.grupos[0]?.variantes).toBe(2);
  });

  it('nomeia o motivo quando o preço ou o estoque NÃO seriam gravados', () => {
    const plano = planejarImportacaoShopee(
      preparo({
        entrada: item({ price_info: [{ currency: 'SGD', original_price: 9.9 }] }),
        depositoOuterRef: null,
      }),
    );
    const r = resumoDoPlano(plano, item());
    // O ensaio na sandbox SG imprime exatamente esta ressalva.
    expect(r.preco).toBeNull();
    expect(r.precoIgnorado).toBe('moeda-nao-brl');
    expect(r.estoque).toBeNull();
    expect(r.estoqueIgnorado).toBe('sem-deposito');
    expect(renderResumoImportacao(r).join('\n')).toContain('moeda-nao-brl');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. the allow-list — the reason this module exists                          */
/* -------------------------------------------------------------------------- */

describe('a redação é uma ALLOW-LIST', () => {
  const plano = planejarImportacaoShopee(preparo());
  const entrada = item();
  const resumo = resumoDoPlano(plano, entrada);
  const comoJson = JSON.stringify(resumirPlanoJson(plano, entrada));
  const comoTexto = resumirPlano(plano, entrada).join('\n');

  it('⛔ NÃO carrega a description do vendedor — só a contagem de caracteres', () => {
    // A descrição REALMENTE está no plano: é o que `extraData.descricao` gravaria.
    expect(plano.extraData?.descricao).toBe(SENTINELA_DESCRICAO);
    expect(comoJson).not.toContain(SENTINELA_DESCRICAO);
    expect(comoTexto).not.toContain(SENTINELA_DESCRICAO);
    expect(resumo.descricaoChars).toBe(SENTINELA_DESCRICAO.length);
    expect(resumo.camposExtraData).toContain('descricao');
    expect(comoTexto).toContain('REDIGIDA');
  });

  it('⛔ NÃO carrega VALORES de tax_info — só as chaves presentes', () => {
    expect(resumo.taxInfoPresente).toBe(true);
    expect(resumo.taxInfoCampos).toEqual(['csosn', 'ncm']);
    expect(comoJson).not.toContain(SENTINELA_NCM);
    expect(comoJson).not.toContain(SENTINELA_CSOSN);
    expect(comoTexto).not.toContain(SENTINELA_NCM);
    expect(comoTexto).not.toContain(SENTINELA_CSOSN);
  });

  it('⛔ NÃO carrega URL de imagem — só contagens', () => {
    // As URLs estão no plano (é o que as fotos baixariam), e mesmo assim não saem.
    expect(plano.fotos.baixar.map((f) => f.url)).toEqual([SENTINELA_FOTO_1, SENTINELA_FOTO_2]);
    expect(comoJson).not.toContain(SENTINELA_FOTO_1);
    expect(comoJson).not.toContain(SENTINELA_FOTO_2);
    expect(comoTexto).not.toContain('https://');
    expect(resumo.fotos.aBaixar).toBe(2);
  });

  it('taxInfoCamposDe ignora chaves nulas e vazias, e nunca lê um valor', () => {
    expect(taxInfoCamposDe({ ...entrada, taxInfo: null })).toEqual([]);
    const vazio = shopeeTaxInfoSchema.parse({ ncm: '', cest: null, csosn: '00' });
    // ⚠️ `"00"` é DADO ("este item não tem"), não ausência: a chave conta.
    expect(taxInfoCamposDe({ ...entrada, taxInfo: vazio })).toEqual(['csosn']);
  });

  it('⛔ o conjunto de campos do resumo é FIXO — um campo novo tem de ser olhado', () => {
    expect(Object.keys(resumo).sort()).toEqual(
      [
        'acao',
        'alturaCm',
        'camposExtraData',
        'camposProduto',
        'categorias',
        'descricaoChars',
        'ehKit',
        'estoque',
        'estoqueIgnorado',
        'filhos',
        'fotos',
        'grupos',
        'gtin',
        'itemId',
        'kit',
        'larguraCm',
        'links',
        'nome',
        'nomeChars',
        'pesoKg',
        'preco',
        'precoIgnorado',
        'produtoId',
        'profundidadeCm',
        'publicado',
        'sku',
        'taxInfoCampos',
        'taxInfoPresente',
        'variacoes',
      ].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  4. the usage text                                                          */
/* -------------------------------------------------------------------------- */

describe('USO_IMPORTAR_ANUNCIO', () => {
  it('⛔ NÃO documenta o separador "--" em invocação nenhuma', () => {
    // `packages/config-eslint/rules/pnpm-run-args.test.js` reprova essa grafia, e
    // o comando morreria com o próprio separador nos argumentos.
    for (const linha of USO_IMPORTAR_ANUNCIO.split('\n')) {
      expect(linha).not.toMatch(/\s--\s/);
    }
    expect(USO_IMPORTAR_ANUNCIO).not.toContain('importar:anuncio --');
  });

  it('nomeia as duas obrigatórias e diz que o padrão é dry-run', () => {
    expect(USO_IMPORTAR_ANUNCIO).toContain('--integracao');
    expect(USO_IMPORTAR_ANUNCIO).toContain('--item');
    expect(USO_IMPORTAR_ANUNCIO).toContain('É o PADRÃO');
  });

  it('não carrega id real nenhum (partner, shop, token)', () => {
    expect(USO_IMPORTAR_ANUNCIO).not.toMatch(/partner|shop_id|token|secret/i);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. blocked listings and errors                                             */
/* -------------------------------------------------------------------------- */

describe('descreverBloqueio / descreverErroImportacao', () => {
  it('um anúncio RECUSADO é descrito como resposta — é nisso que o exit 0 se apoia', () => {
    const err = new ShopeeImportBlockedError(
      MOTIVO_IMPORT_BLOQUEADO.kitComponenteNaoVinculado,
      ITEM_ID,
      'componente 999 sem produto no ERP',
    );
    const linhas = descreverBloqueio(err);
    expect(linhas[0]).toBe(
      'bloqueado: kit-componente-nao-vinculado — componente 999 sem produto no ERP',
    );
    expect(linhas.join('\n')).toContain(String(ITEM_ID));
    expect(linhas.join('\n')).toContain('Nada foi gravado');
  });

  it('um motivo sem detalhe não imprime um travessão solto', () => {
    const err = new ShopeeImportBlockedError(MOTIVO_IMPORT_BLOQUEADO.semNome, ITEM_ID);
    expect(descreverBloqueio(err)[0]).toBe('bloqueado: sem-nome');
  });

  it('um argumento inválido imprime a ajuda DESTE comando', () => {
    const linhas = descreverErroImportacao(new ArgumentoInvalidoError('--item é obrigatório.'));
    expect(linhas[0]).toBe('❌ --item é obrigatório.');
    expect(linhas.join('\n')).toContain('importar:anuncio');
  });

  it('delega o resto da taxonomia Shopee ao descritor compartilhado', () => {
    const linhas = descreverErroImportacao(new Error('quebrou'));
    expect(linhas[0]).toBe('❌ Error');
    expect(linhas.join('\n')).not.toContain('importar:anuncio');
  });
});

/* -------------------------------------------------------------------------- */
/*  6. kits, --live and the stored produto                                     */
/* -------------------------------------------------------------------------- */

describe('kit, resultado e produto relido', () => {
  it('a tabela de componentes diz qual não vinculou', () => {
    const linhas = renderComponentesKit([
      { ...componente(), produtoId: 'prod-a' },
      { ...componente(), itemId: ITEM_ID + 2, produtoId: null, via: 'unresolved' },
    ]);
    expect(linhas.join('\n')).toContain('prod-a');
    expect(linhas.join('\n')).toContain('NÃO VINCULADO (unresolved)');
  });

  it('o resumo de um kit conta resolvidos e produtos distintos', () => {
    const plano = planejarImportacaoShopee(preparo());
    const r = resumoDoPlano(plano, item(), [
      componente(),
      { ...componente(), modelId: MODEL_ID + 1 },
      { ...componente(), itemId: ITEM_ID + 3, produtoId: null, via: 'unresolved' },
    ]);
    expect(r.ehKit).toBe(true);
    expect(r.kit?.componentes).toHaveLength(3);
    expect(r.kit?.resolvidos).toBe(2);
    // Dois componentes distintos apontam para o MESMO produto: um produto só.
    expect(r.kit?.produtos).toBe(1);
  });

  it('resumirResultado imprime o que o importador reportou, campo a campo', () => {
    const res: ResultadoImportacaoShopee = {
      produtoId: 'prod-1',
      criado: true,
      nome: 'Camiseta Básica Azul',
      variacoes: { total: 2, criadas: 1, semLink: 1 },
      fotos: { importadas: 2, ignoradas: 0, falhas: 0 },
      kit: { componentes: 3, criado: true },
    };
    const texto = resumirResultado(res).join('\n');
    expect(texto).toContain('prod-1');
    expect(texto).toContain('2 no total · 1 criadas · 1 sem vínculo');
    expect(texto).toContain('3 componentes');
  });

  it('o produto relido é lido DEFENSIVAMENTE — um documento vazio ainda renderiza', () => {
    const vazio = resumoDoProdutoArmazenado('prod-1', {});
    expect(vazio.existe).toBe(true);
    expect(vazio.nome).toBeNull();
    expect(renderProdutoArmazenado(vazio).join('\n')).toContain('prod-1');

    const ausente = resumoDoProdutoArmazenado('prod-1', null);
    expect(ausente.existe).toBe(false);
    expect(renderProdutoArmazenado(ausente).join('\n')).toContain('não foi encontrado');

    const cheio = resumoDoProdutoArmazenado('prod-1', {
      nome: 'Camiseta',
      sku: 'CAM-AZ',
      paiId: null,
      filhoUnicoId: 'prod-2',
      publicado: true,
      ehKit: false,
      pesoBrutoKg: 0.85,
      precos: { 'tab-normal': { valor: 99.9 } },
    });
    expect(cheio.precos).toEqual([{ tabelaId: 'tab-normal', valor: 99.9 }]);
    expect(renderProdutoArmazenado(cheio).join('\n')).toContain('tab-normal = 99.9');
  });
});
