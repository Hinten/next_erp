import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { erroContidoPorConta } from '../core/containment';
import { MOTIVO_ESTOQUE_SHOPEE, ShopeeStockTasksDisabledError } from '../estoque/errosEstoque';
import { MOTIVO_PRECO_SHOPEE, ShopeePriceSyncTasksDisabledError } from '../precos/errosPreco';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
import {
  DESFECHO_NFE_SHOPEE,
  FRASE_DO_MOTIVO_NFE,
  MOTIVOS_COM_EXCERTO,
  MOTIVOS_QUE_AVISAM,
  MOTIVOS_QUE_CARIMBAM,
  MOTIVO_NFE_SHOPEE,
  ShopeeNfeUploadTasksDisabledError,
  fraseDoErroDoAviso,
  mensagemDoMotivoNfe,
  type DesfechoNfeShopee,
  type MotivoNfeShopee,
} from './errosNfe';
import { resumirTextoDaShopee } from './redacaoNfe';

/** Every slug, in the order the union declares them. */
const TODOS: readonly MotivoNfeShopee[] = Object.values(MOTIVO_NFE_SHOPEE);

/** This module's raw TEXT — two properties below are measured on it. */
const FONTE = readFileSync(fileURLToPath(new URL('./errosNfe.ts', import.meta.url)), 'utf8');

/** Type-level equality: `true` only when A and B are the same set of literals. */
type Igual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The §2.4 table, column by column: A = raises the aviso, S = stamps the frete,
 * X = carries a Shopee excerpt. Written out member by member ON PURPOSE — a
 * set edited together with this table is a reviewed decision; a set edited
 * alone reds the table test.
 */
const TABELA: Readonly<Record<MotivoNfeShopee, { A: boolean; S: boolean; X: boolean }>> = {
  apagada: { A: false, S: false, X: false },
  'nao-aprovada': { A: false, S: false, X: false },
  'xml-ausente': { A: false, S: false, X: false },
  'tpamb-homologacao': { A: false, S: false, X: false },
  'nfe-nao-encontrada': { A: false, S: false, X: false },
  'sem-nfe-aprovada': { A: false, S: false, X: false },
  'nfe-nao-e-de-venda': { A: false, S: false, X: false },
  'pedido-nao-encontrado': { A: false, S: false, X: false },
  'nao-shopee': { A: false, S: false, X: false },
  'emissao-bloqueada': { A: false, S: false, X: false },
  'xml-invalido': { A: true, S: true, X: false },
  'xml-grande-demais': { A: true, S: true, X: false },
  'conta-nao-configurada': { A: false, S: false, X: false },
  'conta-inativa': { A: false, S: false, X: false },
  'sem-shop-id': { A: false, S: false, X: false },
  'configuracao-do-app': { A: false, S: false, X: false },
  'aguardando-serpro': { A: false, S: false, X: false },
  'pedido-inexistente-no-canal': { A: false, S: false, X: false },
  'pedido-nao-br': { A: false, S: false, X: false },
  'pedido-fbs': { A: false, S: false, X: false },
  'loja-cross-border': { A: false, S: false, X: false },
  'pedido-cancelado': { A: false, S: false, X: false },
  'pedido-exportacao': { A: true, S: false, X: false },
  'outra-nfe-anexada': { A: true, S: false, X: false },
  'chave-ilegivel': { A: true, S: false, X: false },
  'nfe-validada': { A: false, S: false, X: false },
  'validacao-pendente': { A: false, S: false, X: false },
  'status-desconhecido': { A: false, S: false, X: false },
  'nota-dispensada': { A: false, S: false, X: false },
  'nao-refletida-ainda': { A: false, S: false, X: false },
  'sefaz-pendente': { A: true, S: true, X: true },
  'nao-anexada': { A: true, S: false, X: false },
  'emissor-shopee': { A: true, S: true, X: false },
  'cnpj-divergente': { A: true, S: true, X: false },
  'uf-divergente': { A: true, S: true, X: false },
  'ie-divergente': { A: true, S: true, X: false },
  'nfe-cancelada': { A: true, S: true, X: false },
  'data-de-emissao-invalida': { A: true, S: true, X: false },
  'modelo-nao-55': { A: true, S: true, X: false },
  'cfop-nao-aceito': { A: true, S: true, X: false },
  'xml-recusado': { A: true, S: true, X: false },
  'chave-invalida': { A: true, S: true, X: false },
  'requisicao-invalida': { A: true, S: true, X: false },
  'chave-em-outro-pedido': { A: true, S: true, X: false },
  'nfe-invalida': { A: true, S: true, X: false },
  'recusa-desconhecida': { A: true, S: true, X: true },
  'ip-nao-declarado': { A: true, S: false, X: false },
  'sem-suporte-a-nfe': { A: false, S: false, X: false },
  reauth: { A: true, S: false, X: false },
  'canal-indisponivel': { A: true, S: false, X: false },
  'reverificacao-indisponivel': { A: false, S: false, X: false },
  'limite-de-taxa': { A: false, S: false, X: false },
  'cota-diaria': { A: false, S: false, X: false },
  'pausa-reenqueues-esgotados': { A: true, S: false, X: false },
  'tasks-desabilitadas': { A: true, S: false, X: false },
  'payload-invalido': { A: false, S: false, X: false },
};

/** A synthetic, visibly impossible access key (cUF 99, an all-ones CNPJ) — never a literal. */
const CHAVE_FICTICIA = [
  '99',
  '2609',
  '11111111111111',
  '55',
  '000',
  '000000001',
  '1',
  '00000000',
  '0',
].join('');

describe('MotivoNfeShopee', () => {
  it('1 — o vocabulário é EXATAMENTE estes cinquenta e seis slugs (a tabela §2.4 menos o R5-1)', () => {
    // PERSISTIDO (`aviso.motivo`, o corpo do 409 da rota). O `as const
    // satisfies` garante o TIPO dos valores, mas não impede um renome feito nos
    // dois lugares de uma vez — a igualdade contra literais é o que fica
    // vermelho aí.
    expect([...TODOS].sort()).toEqual(
      [
        'aguardando-serpro',
        'apagada',
        'canal-indisponivel',
        'cfop-nao-aceito',
        'chave-em-outro-pedido',
        'chave-ilegivel',
        'chave-invalida',
        'cnpj-divergente',
        'configuracao-do-app',
        'conta-inativa',
        'conta-nao-configurada',
        'cota-diaria',
        'data-de-emissao-invalida',
        'emissao-bloqueada',
        'emissor-shopee',
        'ie-divergente',
        'ip-nao-declarado',
        'limite-de-taxa',
        'loja-cross-border',
        'modelo-nao-55',
        'nao-anexada',
        'nao-aprovada',
        'nao-refletida-ainda',
        'nao-shopee',
        'nfe-cancelada',
        'nfe-invalida',
        'nfe-nao-e-de-venda',
        'nfe-nao-encontrada',
        'nfe-validada',
        'nota-dispensada',
        'outra-nfe-anexada',
        'pausa-reenqueues-esgotados',
        'payload-invalido',
        'pedido-cancelado',
        'pedido-exportacao',
        'pedido-fbs',
        'pedido-inexistente-no-canal',
        'pedido-nao-br',
        'pedido-nao-encontrado',
        'reauth',
        'recusa-desconhecida',
        'requisicao-invalida',
        'reverificacao-indisponivel',
        'sefaz-pendente',
        'sem-nfe-aprovada',
        'sem-shop-id',
        'sem-suporte-a-nfe',
        'status-desconhecido',
        'tasks-desabilitadas',
        'tpamb-homologacao',
        'uf-divergente',
        'validacao-pendente',
        'xml-ausente',
        'xml-grande-demais',
        'xml-invalido',
        'xml-recusado',
      ].sort(),
    );
    expect(TODOS).toHaveLength(56);
    expect(new Set(TODOS).size).toBe(56);
  });

  it('2 — o const cobre a união INTEIRA, nos dois sentidos, em tempo de compilação', () => {
    // O `satisfies` prova que todo VALOR é membro, jamais que todo membro está
    // no const. Esta igualdade de tipos fecha a outra metade: um membro novo na
    // união sem a entrada no const é erro de `tsc` aqui.
    type ValoresDoConst = (typeof MOTIVO_NFE_SHOPEE)[keyof typeof MOTIVO_NFE_SHOPEE];
    type ValoresDosDesfechos = (typeof DESFECHO_NFE_SHOPEE)[keyof typeof DESFECHO_NFE_SHOPEE];
    const cobre: Igual<ValoresDoConst, MotivoNfeShopee> = true;
    const cobreDesfechos: Igual<ValoresDosDesfechos, DesfechoNfeShopee> = true;
    expect(cobre).toBe(true);
    expect(cobreDesfechos).toBe(true);
  });

  it('3 — todo slug é kebab-case ASCII minúsculo, e as CHAVES do const são o slug em camelCase', () => {
    for (const [chave, slug] of Object.entries(MOTIVO_NFE_SHOPEE)) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(chave).toBe(slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()));
    }
    for (const [chave, slug] of Object.entries(DESFECHO_NFE_SHOPEE)) {
      expect(chave).toBe(slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()));
    }
  });

  it('4 — PAR: a condição que os passos 12/13 já nomeiam usa a MESMA grafia', () => {
    // Uma palavra por condição: um operador lendo uma recusa de NF-e ao lado de
    // uma de estoque ou de preço da mesma conta vê a mesma palavra.
    const doEstoque: readonly string[] = Object.values(MOTIVO_ESTOQUE_SHOPEE);
    const doPreco: readonly string[] = Object.values(MOTIVO_PRECO_SHOPEE);
    for (const slug of [
      'reauth',
      'cota-diaria',
      'conta-nao-configurada',
      'sem-shop-id',
      'tasks-desabilitadas',
      'payload-invalido',
      'pausa-reenqueues-esgotados',
      'recusa-desconhecida',
    ] as const) {
      expect(TODOS).toContain(slug);
      expect(doEstoque).toContain(slug);
    }
    expect(TODOS).toContain('loja-cross-border');
    expect(doPreco).toContain('loja-cross-border');
  });

  it('5 — ⛔ NEAR-MISS: a grafia é compartilhada, o TIPO não — este módulo não importa os vocabulários vizinhos', () => {
    expect(FONTE).not.toMatch(/from '\.\.\/estoque\//);
    expect(FONTE).not.toMatch(/from '\.\.\/precos\//);
    // Os nomes que a reconciliação REJEITOU não são membros.
    const todos: readonly string[] = TODOS;
    for (const rejeitado of [
      'falha-no-envio',
      'nfe-nao-anexada',
      'pendente-sem-motivo',
      'loja-fbs',
      'sefaz-539',
    ]) {
      expect(todos).not.toContain(rejeitado);
    }
  });

  it('5b — ⛔ R5-1: NÃO existe motivo de "frete de outra integradora" — o envio anexa a nota ao PEDIDO', () => {
    // A premissa copiada era a de um canal cujo envio mira um ENVIO físico; o
    // desta Shopee mira o pedido. Um frete reapontado continua enviando, e quem
    // se recusa a tocar um frete alheio é só o carimbo (o desfecho dele).
    const todos: readonly string[] = TODOS;
    expect(todos).not.toContain('frete-de-outra-integradora');
    expect(Object.keys(MOTIVO_NFE_SHOPEE)).not.toContain('freteDeOutraIntegradora');
    expect(FONTE).not.toMatch(/frete-de-outra-integradora/);
    // ⛔ O par que dá sentido: os outros três motivos do pedido continuam.
    for (const doPedido of ['pedido-nao-encontrado', 'nao-shopee', 'emissao-bloqueada']) {
      expect(todos).toContain(doPedido);
    }
  });

  it('6 — os desfechos são EXATAMENTE os nove da §2.4', () => {
    expect(Object.values(DESFECHO_NFE_SHOPEE).sort()).toEqual(
      [
        'enviado',
        'ja-enviado',
        'validada',
        'adiado',
        'pausado',
        'reverificacao-agendada',
        'descartado',
        'recusado',
        'erro-final',
      ].sort(),
    );
  });
});

describe('FRASE_DO_MOTIVO_NFE', () => {
  it('7 — é TOTAL nos dois sentidos: nenhum membro sem frase, nenhuma frase órfã', () => {
    expect(Object.keys(FRASE_DO_MOTIVO_NFE).sort()).toEqual([...TODOS].sort());
  });

  it('8 — toda frase é um FRAGMENTO pt-BR: não vazia, aparada, minúscula no início, sem ponto final', () => {
    for (const motivo of TODOS) {
      const frase = FRASE_DO_MOTIVO_NFE[motivo];
      expect(frase.length).toBeGreaterThan(0);
      expect(frase).toBe(frase.trim());
      expect(frase).not.toMatch(/\s{2}/);
      expect(frase.charAt(0)).toMatch(/\p{Ll}/u);
      expect(frase.endsWith('.')).toBe(false);
      expect(frase).not.toBe(motivo);
    }
  });

  it('9 — ⛔ nenhuma frase nomeia o outro canal', () => {
    for (const motivo of TODOS) {
      expect(FRASE_DO_MOTIVO_NFE[motivo]).not.toMatch(/mercado\s*livre/i);
      expect(FRASE_DO_MOTIVO_NFE[motivo]).not.toMatch(/\bML\b/);
    }
    // Medido também no TEXTO do módulo (comentários incluídos) — o mesmo que a
    // grep da disciplina da pasta mede.
    expect(FONTE).not.toMatch(/mercado\s*livre/i);
  });

  it('10 — ⛔ nenhuma frase carrega identificador: o sanitizador a devolve INTACTA', () => {
    // Se uma frase tivesse um grupo de ≥ 7 dígitos ou um token longo misto, o
    // sanitizador a mascararia — e a frase deixaria de ser igual a si mesma.
    for (const motivo of TODOS) {
      expect(resumirTextoDaShopee(FRASE_DO_MOTIVO_NFE[motivo], 10_000)).toBe(
        FRASE_DO_MOTIVO_NFE[motivo],
      );
    }
  });

  it('11 — ⛔ nenhum `?? fallback` numa consulta à tabela (o #1226)', () => {
    expect(FONTE).not.toMatch(/FRASE_DO_MOTIVO_NFE\[[^\]]+\]\s*\?\?/);
  });

  it('11b — ⛔ R5-6: `canal-indisponivel` começa pelo REMÉDIO e não promete uma conferência automática', () => {
    // Com a válvula da fila fechada na última tentativa, a reverificação só vira
    // um `warn` — nada foi agendado, então a frase não pode prometer que "uma
    // conferência automática ainda vai verificar". O operador confere ou reenvia.
    const frase = FRASE_DO_MOTIVO_NFE['canal-indisponivel'];
    expect(frase.startsWith('verifique no Seller Center')).toBe(true);
    expect(frase).toContain('reenvie a nota pelo ERP');
    expect(frase).not.toMatch(/autom[aá]tic/i);
    expect(frase).not.toMatch(/ainda vai/i);
    // ⛔ QUASE-MISS: a CAUSA continua dita, depois do travessão.
    expect(frase).toMatch(/ — a Shopee não respondeu/);
  });
});

describe('mensagemDoMotivoNfe', () => {
  it('12 — PAR: é o fragmento com a primeira letra maiúscula e um ponto — para todos os 56', () => {
    for (const motivo of TODOS) {
      const frase = FRASE_DO_MOTIVO_NFE[motivo];
      const mensagem = mensagemDoMotivoNfe(motivo);
      expect(mensagem.endsWith('.')).toBe(true);
      expect(mensagem.slice(1, -1)).toBe(frase.slice(1));
      expect(mensagem.charAt(0)).toMatch(/\p{Lu}/u);
    }
    expect(mensagemDoMotivoNfe('reauth')).toBe(
      'Reconecte a conta Shopee — a autorização da loja expirou.',
    );
  });

  it('13 — ⛔ NEAR-MISS: a frase do aviso NÃO é a mensagem (sem maiúscula, sem ponto)', () => {
    expect(fraseDoErroDoAviso('reauth', null)).not.toBe(mensagemDoMotivoNfe('reauth'));
    expect(fraseDoErroDoAviso('reauth', null)).toBe(FRASE_DO_MOTIVO_NFE.reauth);
  });
});

describe('os conjuntos — a ÚNICA fonte de aviso, carimbo e excerto', () => {
  it('14 — a tabela §2.4, membro a membro: A / S / X de cada um dos 56', () => {
    expect(Object.keys(TABELA).sort()).toEqual([...TODOS].sort());
    for (const motivo of TODOS) {
      const linha = TABELA[motivo];
      expect({ motivo, A: MOTIVOS_QUE_AVISAM.has(motivo) }).toEqual({ motivo, A: linha.A });
      expect({ motivo, S: MOTIVOS_QUE_CARIMBAM.has(motivo) }).toEqual({ motivo, S: linha.S });
      expect({ motivo, X: MOTIVOS_COM_EXCERTO.has(motivo) }).toEqual({ motivo, X: linha.X });
    }
    expect(MOTIVOS_QUE_AVISAM.size).toBe(26);
    expect(MOTIVOS_QUE_CARIMBAM.size).toBe(17);
    expect(MOTIVOS_COM_EXCERTO.size).toBe(2);
  });

  it('15 — CARIMBAM ⊂ AVISAM e COM_EXCERTO ⊂ AVISAM: um carimbo sem aviso é um pedido que para em silêncio', () => {
    for (const m of MOTIVOS_QUE_CARIMBAM) expect(MOTIVOS_QUE_AVISAM.has(m)).toBe(true);
    for (const m of MOTIVOS_COM_EXCERTO) expect(MOTIVOS_QUE_AVISAM.has(m)).toBe(true);
    // Todo membro dos conjuntos é membro da união.
    const todos: ReadonlySet<string> = new Set<string>(TODOS);
    for (const conjunto of [MOTIVOS_QUE_AVISAM, MOTIVOS_QUE_CARIMBAM, MOTIVOS_COM_EXCERTO]) {
      for (const m of conjunto) expect(todos.has(m)).toBe(true);
    }
  });

  it('16 — ⛔ NEAR-MISS: a AUSÊNCIA de resposta avisa mas não carimba', () => {
    // Transporte esgotado, nota que não aparece, concessão vencida, IP não
    // declarado, válvula, pausas: nada disso é uma recusa DESTA NF-e.
    for (const m of [
      'canal-indisponivel',
      'nao-anexada',
      'reauth',
      'ip-nao-declarado',
      'tasks-desabilitadas',
      'pausa-reenqueues-esgotados',
    ] as const) {
      expect(MOTIVOS_QUE_AVISAM.has(m)).toBe(true);
      expect(MOTIVOS_QUE_CARIMBAM.has(m)).toBe(false);
    }
    // E a nota ANEXADA pode ser a válida: outra nota, chave ilegível, exportação.
    for (const m of ['outra-nfe-anexada', 'chave-ilegivel', 'pedido-exportacao'] as const) {
      expect(MOTIVOS_QUE_AVISAM.has(m)).toBe(true);
      expect(MOTIVOS_QUE_CARIMBAM.has(m)).toBe(false);
    }
  });

  it('17 — PAR: os defeitos LOCAIS do XML carimbam — nenhum retry o tornaria enviável', () => {
    for (const m of ['xml-invalido', 'xml-grande-demais'] as const) {
      expect(MOTIVOS_QUE_AVISAM.has(m)).toBe(true);
      expect(MOTIVOS_QUE_CARIMBAM.has(m)).toBe(true);
    }
  });
});

describe('fraseDoErroDoAviso', () => {
  const EXCERTO = 'Rejeição 539: Duplicidade de NF-e';

  it('18 — PAR: um motivo X ganha `: <excerto>` depois do seu fragmento', () => {
    for (const m of MOTIVOS_COM_EXCERTO) {
      expect(fraseDoErroDoAviso(m, EXCERTO)).toBe(`${FRASE_DO_MOTIVO_NFE[m]}: ${EXCERTO}`);
    }
  });

  it('19 — ⛔ NEAR-MISS: todo motivo FORA de X ignora o excerto, seja qual for', () => {
    for (const m of TODOS) {
      if (MOTIVOS_COM_EXCERTO.has(m)) continue;
      expect(fraseDoErroDoAviso(m, EXCERTO)).toBe(FRASE_DO_MOTIVO_NFE[m]);
      expect(fraseDoErroDoAviso(m, `chave ${CHAVE_FICTICIA}`)).toBe(FRASE_DO_MOTIVO_NFE[m]);
    }
  });

  it('20 — sem excerto (null ou em branco), um motivo X rende só o fragmento', () => {
    for (const m of MOTIVOS_COM_EXCERTO) {
      expect(fraseDoErroDoAviso(m, null)).toBe(FRASE_DO_MOTIVO_NFE[m]);
      expect(fraseDoErroDoAviso(m, ' \t ')).toBe(FRASE_DO_MOTIVO_NFE[m]);
      expect(fraseDoErroDoAviso(m, 'Wrong parameters, detail: ..')).toBe(FRASE_DO_MOTIVO_NFE[m]);
    }
  });

  it('21 — ⛔ um excerto NÃO sanitizado entregue por engano ainda sai mascarado', () => {
    const cru = `Wrong parameters, detail: Rejeição 539: Duplicidade de NF-e [chNFe:${CHAVE_FICTICIA}]..`;
    const erro = fraseDoErroDoAviso('sefaz-pendente', cru);
    expect(erro).toBe(
      `${FRASE_DO_MOTIVO_NFE['sefaz-pendente']}: Rejeição 539: Duplicidade de NF-e •••`,
    );
    expect(erro).not.toMatch(/\d{7}/);
    expect(erro.includes(CHAVE_FICTICIA)).toBe(false);
  });
});

describe('ShopeeNfeUploadTasksDisabledError', () => {
  it('22 — é um Error com nome próprio, e NÃO é nenhuma das classes irmãs de tasks', () => {
    const err = new ShopeeNfeUploadTasksDisabledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ShopeeNfeUploadTasksDisabledError');
    expect(err).not.toBeInstanceOf(ShopeeTasksDisabledError);
    expect(err).not.toBeInstanceOf(ShopeeStockTasksDisabledError);
    expect(err).not.toBeInstanceOf(ShopeePriceSyncTasksDisabledError);
    expect(new ShopeeTasksDisabledError()).not.toBeInstanceOf(ShopeeNfeUploadTasksDisabledError);
  });

  it('23 — ⛔ NÃO é contida por conta — a válvula tem de chegar ao braço que avisa', () => {
    expect(erroContidoPorConta(new ShopeeNfeUploadTasksDisabledError())).toBe(false);
    // ⛔ O par que dá sentido: a classe compartilhada continua contida, de
    // propósito. Sem esta linha a asserção acima passaria mesmo com a contenção
    // desligada para todo mundo.
    expect(erroContidoPorConta(new ShopeeTasksDisabledError())).toBe(true);
  });

  it('24 — ⛔ `core/containment.ts` não nomeia esta classe, medido no TEXTO', () => {
    const contencao = readFileSync(
      fileURLToPath(new URL('../core/containment.ts', import.meta.url)),
      'utf8',
    );
    expect(contencao).toContain('ShopeeTasksDisabledError'); // âncora: o arquivo é o certo
    expect(contencao.includes('ShopeeNfeUploadTasksDisabledError')).toBe(false);
  });
});
