import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CRT, CSOSN, CST_PIS_COFINS, ORIGEM } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { criarLeitorDeImpostoShopee } from './lerImpostoDoProduto';
import { MOTIVO_TAX_INFO_OMITIDO, montarTaxInfo } from './taxInfoPublicacao';

/* ---------------------------------- fixtures ------------------------------ */

const OPERACAO_ID = 'op-1';
const REF_OPERACAO = `operacao/${OPERACAO_ID}`;
const PRODUTO_PAI = 'pai';
/** The id the M-90 mutant would reach for — a child of the same family. */
const PRODUTO_FILHO = `${PRODUTO_PAI}-filho`;
const CATEGORIA_ID = 'cat-1';

/** The Dados Gerais of a COMPLETE tax config, as a stored doc carries them. */
function dadosFiscais(ncm: string): Record<string, unknown> {
  return {
    origem: ORIGEM.nacional,
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: ncm,
    CEST: '2806300',
    configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.tributadaSemCredito, cst: null },
    configuracaoPIS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 1.65 },
    configuracaoCOFINS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pCOFINS: 7.6 },
  };
}

function leituras(db: FakeDb, caminho: string): number {
  return db.opLog.filter((op) => op.path === caminho).length;
}

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  // Tier 5 legitimately falls through on an operação carrying no usable default
  // and says so through `console.debug`; the cascade drops an invalid config doc
  // with a `console.warn`. Neither is the property under test here.
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

/* -------------------------------------------------------------------------- */
/*                        (1) sem operação — zero leituras                     */
/* -------------------------------------------------------------------------- */

describe('sem operação', () => {
  it('sem operacaoOuterRef ⇒ sem-operacao, e o FakeDb não registra leitura nenhuma', async () => {
    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: null });

    const resultado = await leitor.ler(PRODUTO_PAI);

    expect(resultado).toEqual({
      imposto: null,
      motivo: MOTIVO_TAX_INFO_OMITIDO.semOperacao,
    });
    expect(db.opLog).toEqual([]);
    expect(db.caminhos).toEqual([]);
  });

  it('uma operação inexistente ⇒ sem-operacao, e as regras nem são lidas', async () => {
    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });

    const resultado = await leitor.ler(PRODUTO_PAI);

    expect(resultado.imposto).toBeNull();
    expect(resultado.motivo).toBe(MOTIVO_TAX_INFO_OMITIDO.semOperacao);
    expect(leituras(db, `operacao/${OPERACAO_ID}`)).toBe(1);
    expect(db.caminhos).not.toContain(`operacao/${OPERACAO_ID}/regras`);
    expect(db.opLog.map((op) => op.path)).toEqual([`operacao/${OPERACAO_ID}`]);
  });

  it('um ref de operação vazio ⇒ sem-operacao, sem leitura nenhuma', async () => {
    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: '/' });

    expect((await leitor.ler(PRODUTO_PAI)).motivo).toBe(MOTIVO_TAX_INFO_OMITIDO.semOperacao);
    expect(db.opLog).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          (2) os tiers da cascata                            */
/* -------------------------------------------------------------------------- */

describe('os tiers', () => {
  it('resolve pelo tier impostoProduto quando o doc nomeia a operação da conta', async () => {
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda' });
    db.seed(`produtos/${PRODUTO_PAI}/imposto/${OPERACAO_ID}`, {
      impostoOpercaoOuterRef: REF_OPERACAO,
      ...dadosFiscais('61091000'),
    });

    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });
    const resultado = await leitor.ler(PRODUTO_PAI);

    expect(resultado.motivo).toBeNull();
    expect(resultado.imposto?.NCM).toBe('61091000');
    // e o bloco que sai daí é o bloco completo — as duas metades casam
    expect(montarTaxInfo(resultado.imposto).taxInfo?.ncm).toBe('61091000');
  });

  it('cai para a operação (tier 5) quando nada mais casa', async () => {
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda', ...dadosFiscais('99887766') });

    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });
    const resultado = await leitor.ler(PRODUTO_PAI);

    expect(resultado.motivo).toBeNull();
    expect(resultado.imposto?.NCM).toBe('99887766');
  });

  it('resolve pelo tier categoria quando o produto aponta a categoria', async () => {
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda' });
    db.seed(`produtos/${PRODUTO_PAI}`, {
      categoriaProdutoOuterRef: `documents/categorias/${CATEGORIA_ID}`,
    });
    db.seed(`categorias/${CATEGORIA_ID}/imposto/${OPERACAO_ID}`, {
      impostoCategoriaOperacaoOuterRef: REF_OPERACAO,
      ...dadosFiscais('11112222'),
    });

    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });

    expect((await leitor.ler(PRODUTO_PAI)).imposto?.NCM).toBe('11112222');
  });

  it('resolve retorna null ⇒ sem-imposto', async () => {
    // Uma operação SEM default utilizável (nenhuma `origem`): o tier 5 cai, e
    // não há nenhum outro tier para responder.
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda' });

    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });
    const resultado = await leitor.ler(PRODUTO_PAI);

    expect(resultado.imposto).toBeNull();
    expect(resultado.motivo).toBe(MOTIVO_TAX_INFO_OMITIDO.semImposto);
  });

  it('aceita as três formas de ref que o corpus carrega — canônica, nua e só o id', async () => {
    for (const ref of [
      `documents/operacao/${OPERACAO_ID}`,
      `operacao/${OPERACAO_ID}`,
      OPERACAO_ID,
    ]) {
      const banco = new FakeDb();
      banco.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda', ...dadosFiscais('33334444') });
      const leitor = criarLeitorDeImpostoShopee({ db: asDb(banco), operacaoOuterRef: ref });
      expect((await leitor.ler(PRODUTO_PAI)).imposto?.NCM, ref).toBe('33334444');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                          (3) o memo do bundle                               */
/* -------------------------------------------------------------------------- */

describe('o memo do bundle', () => {
  it('o bundle é lido UMA vez para duas chamadas', async () => {
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda', ...dadosFiscais('55556666') });

    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });
    await leitor.ler(PRODUTO_PAI);
    await leitor.ler('outro-produto');

    expect(leituras(db, `operacao/${OPERACAO_ID}`)).toBe(1);
    expect(leituras(db, `operacao/${OPERACAO_ID}/regras`)).toBe(1);
  });

  it('uma operação AUSENTE também é memoizada — a segunda chamada não relê nada', async () => {
    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });

    await leitor.ler(PRODUTO_PAI);
    await leitor.ler('outro-produto');

    expect(leituras(db, `operacao/${OPERACAO_ID}`)).toBe(1);
  });

  it('duas chamadas CONCORRENTES compartilham uma única leitura do bundle', async () => {
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda', ...dadosFiscais('77778888') });

    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });
    await Promise.all([leitor.ler(PRODUTO_PAI), leitor.ler('outro-produto')]);

    expect(leituras(db, `operacao/${OPERACAO_ID}`)).toBe(1);
  });

  it('dois LEITORES não compartilham memo — o memo é por instância, para o publish em lote', async () => {
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda', ...dadosFiscais('99990000') });

    await criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO }).ler(
      PRODUTO_PAI,
    );
    await criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO }).ler(
      PRODUTO_PAI,
    );

    expect(leituras(db, `operacao/${OPERACAO_ID}`)).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (4) o id do produto PAI                              */
/* -------------------------------------------------------------------------- */

describe('o id que a cascata recebe', () => {
  it('usa o id do produto PAI — a subcoleção imposto de um filho é ignorada', async () => {
    db.seed(`operacao/${OPERACAO_ID}`, { nome: 'Venda' });
    db.seed(`produtos/${PRODUTO_PAI}/imposto/${OPERACAO_ID}`, {
      impostoOpercaoOuterRef: REF_OPERACAO,
      ...dadosFiscais('61091000'),
    });
    db.seed(`produtos/${PRODUTO_FILHO}/imposto/${OPERACAO_ID}`, {
      impostoOpercaoOuterRef: REF_OPERACAO,
      ...dadosFiscais('12345678'),
    });

    const leitor = criarLeitorDeImpostoShopee({ db: asDb(db), operacaoOuterRef: REF_OPERACAO });
    const resultado = await leitor.ler(PRODUTO_PAI);

    expect(resultado.imposto?.NCM).toBe('61091000');
    expect(resultado.imposto?.NCM).not.toBe('12345678');
    // ⚠️ E nenhum caminho do filho foi TOCADO. O `tax_info` do Shopee é
    // item-level: não existe bloco fiscal por modelo em lugar nenhum da wire,
    // então a subcoleção de um filho é ignorada por construção.
    expect(db.caminhos.filter((c) => c.includes(PRODUTO_FILHO))).toEqual([]);
  });
});
