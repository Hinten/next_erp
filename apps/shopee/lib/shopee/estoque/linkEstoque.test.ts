import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';

// ⚠️ The REAL admin handles over the shared fake Firestore, never a mock of
// `mergeIfExists`: half of what this module promises — a FLAT patch, an absent
// document answering `false` instead of being resurrected — is a property of
// that handle, and a mocked writer cannot show either.
import { FakeDb, asDb } from '../testing/fakeDb';
import { MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';
import { podeEnviarEstoqueShopee } from './podeEnviarEstoque';
import {
  CAMPOS_DO_PATCH_DE_ESTOQUE,
  codigoDoErp,
  registrarEnvioLimpo,
  registrarEnvioParcial,
  registrarRecusaDeEstoque,
  registrarRecusaDeModelo,
} from './linkEstoque';

const AGORA_MS = 1_760_000_000_000;
const INTEGRACAO = 'int-1';
const PRODUTO = 'prod-abc';
const FILHO = 'prod-filho';
const LINK_DOC = 'link-1';
const VAR_LINK_DOC = 'varlink-1';

const CAMINHO_LINK = `produtos/${PRODUTO}/prodshopee/${LINK_DOC}`;
const CAMINHO_VARIACAO = `produtos/${FILHO}/variashopee/${VAR_LINK_DOC}`;

const ALVO = { integracaoId: INTEGRACAO, produtoId: PRODUTO, linkDocId: LINK_DOC } as const;
const ALVO_VARIACAO = {
  integracaoId: INTEGRACAO,
  produtoId: FILHO,
  varLinkDocId: VAR_LINK_DOC,
} as const;

/** Shopee's own spelling for the refusal the sender's arm H recognises. */
const CODIGO_COM_PREFIXO = 'product.error_item_uneditable';
/** The same code with the module prefix stripped — what must NOT be stored. */
const CODIGO_SEM_PREFIXO = 'error_item_uneditable';

const avisos: unknown[][] = [];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  avisos.length = 0;
});

/** A parent link document that already exists — `mergeIfExists` needs one. */
function semearLink(db: FakeDb): void {
  db.seed(CAMINHO_LINK, { item_id: 2_500_139_861, estadoAnuncio: 'ativo', item_status: 'NORMAL' });
}

/** A child variation link document that already exists. */
function semearVariacao(db: FakeDb): void {
  db.seed(CAMINHO_VARIACAO, { model_id: 2_000_458_802 });
}

function patchesEm(db: FakeDb, caminho: string): Record<string, unknown>[] {
  return db.patches.filter((p) => p.path === caminho).map((p) => p.patch);
}

function unicoPatch(db: FakeDb, caminho: string): Record<string, unknown> {
  const todos = patchesEm(db, caminho);
  expect(todos).toHaveLength(1);
  return todos[0] ?? {};
}

const FONTE = readFileSync(fileURLToPath(new URL('./linkEstoque.ts', import.meta.url)), 'utf8');

/* -------------------------------------------------------------------------- */
/*  (1) o envio limpo — o ÚNICO que zera                                       */
/* -------------------------------------------------------------------------- */

describe('registrarEnvioLimpo', () => {
  it('1 — ⚠️ PAR: o conjunto de chaves do patch É CAMPOS_DO_PATCH_DE_ESTOQUE, inteiro', async () => {
    // O par que o mutante M-86 ataca pelos dois lados: um campo acrescentado à
    // lista e esquecido aqui, ou escrito aqui e ausente da lista, quebra esta
    // asserção. O tipo já recusa os dois no compilador; isto é a rede que
    // enxerga a GRAFIA, que o tipo não confere contra o schema.
    const db = new FakeDb();
    semearLink(db);

    const escrito = await registrarEnvioLimpo(asDb(db), ALVO, {
      nowMs: AGORA_MS,
      quantidade: 7,
      modelos: 3,
    });

    expect(escrito).toBe(true);
    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.keys(patch).sort()).toEqual([...CAMPOS_DO_PATCH_DE_ESTOQUE].sort());
  });

  it('2 — os seis campos de recusa ficam `null`, nunca AUSENTES', async () => {
    // Uma chave ausente e um `null` são fatos diferentes (regra 7 da raiz): o
    // leitor precisa distinguir "diagnosticado e depois resolvido" de "nunca
    // diagnosticado", e o conjunto de pulo só arma com um `estoqueRecusaEm`
    // NÃO nulo. Um patch que apenas OMITISSE os seis deixaria a recusa antiga
    // de pé com o anúncio já sincronizado.
    const db = new FakeDb();
    semearLink(db);

    await registrarEnvioLimpo(asDb(db), ALVO, { nowMs: AGORA_MS, quantidade: 7, modelos: 3 });

    const patch = unicoPatch(db, CAMINHO_LINK);
    for (const campo of [
      'estoqueRecusaEm',
      'estoqueRecusaCodigo',
      'estoqueRecusaMotivo',
      'estoqueRecusaMensagem',
      'estoqueRecusaEstado',
      'estoqueRecusaItemStatus',
      'estoqueRecusaAte',
    ]) {
      expect(Object.hasOwn(patch, campo), `${campo} precisa estar PRESENTE`).toBe(true);
      expect(patch[campo], `${campo} precisa ser null`).toBeNull();
    }
  });

  it('3 — carimba estoqueEnviadoEm e ultimaModificacao com o MESMO nowMs, e a quantidade enviada', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarEnvioLimpo(asDb(db), ALVO, { nowMs: AGORA_MS, quantidade: 7, modelos: 3 });

    expect(unicoPatch(db, CAMINHO_LINK)).toMatchObject({
      estoqueEnviadoEm: AGORA_MS,
      ultimaModificacao: AGORA_MS,
      estoqueEnviado: 7,
      estoqueModelosEnviados: 3,
    });
  });

  it('4 — quantidade 0 e modelos 0 são VALORES, não ausências', async () => {
    // ⚠️ NEAR-MISS de qualquer teste de veracidade: zerar o estoque de um
    // anúncio é o envio mais comum que existe neste canal, e `model_id: 0` é o
    // item sem variação. Um `if (quantidade)` em qualquer ponto do caminho some
    // com o campo.
    const db = new FakeDb();
    semearLink(db);

    await registrarEnvioLimpo(asDb(db), ALVO, { nowMs: AGORA_MS, quantidade: 0, modelos: 0 });

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(patch.estoqueEnviado).toBe(0);
    expect(patch.estoqueModelosEnviados).toBe(0);
  });

  it('5 — escreve no documento do vínculo e em NENHUM outro caminho', async () => {
    const db = new FakeDb();
    semearLink(db);
    semearVariacao(db);

    await registrarEnvioLimpo(asDb(db), ALVO, { nowMs: AGORA_MS, quantidade: 7, modelos: 3 });

    expect(db.writes.map((w) => w.path)).toEqual([CAMINHO_LINK]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) o envio parcial — o que NÃO carimba                                    */
/* -------------------------------------------------------------------------- */

describe('registrarEnvioParcial', () => {
  const parcial = {
    nowMs: AGORA_MS,
    quantidade: 7,
    modelos: 4,
    codigo: 'model ID not exist in sku',
    mensagem: 'Parte dos modelos foi recusada pela Shopee.',
  };

  it('6 — ⚠️ NEAR-MISS do envio limpo: estoqueEnviadoEm fica AUSENTE do patch, nem sequer null', async () => {
    // M-87. `estoqueEnviadoEm` significa "a última vez que este anúncio esteve
    // INTEIRAMENTE em dia", e é a âncora contra a qual a visibilidade das
    // linhas-filhas é comparada (`filho.estoqueRecusaEm >= pai.estoqueEnviadoEm`).
    // Carimbá-lo aqui esconderia o diagnóstico que este mesmo envio acabou de
    // produzir — as linhas nasceriam velhas.
    const db = new FakeDb();
    semearLink(db);

    await registrarEnvioParcial(asDb(db), ALVO, parcial);

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'estoqueEnviadoEm')).toBe(false);
  });

  it('7 — o motivo é `envio-parcial` e o código é o do PRIMEIRO modelo recusado, VERBATIM', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarEnvioParcial(asDb(db), ALVO, parcial);

    expect(unicoPatch(db, CAMINHO_LINK)).toMatchObject({
      estoqueRecusaMotivo: MOTIVO_ESTOQUE_SHOPEE.envioParcial,
      estoqueRecusaCodigo: parcial.codigo,
      estoqueRecusaEm: AGORA_MS,
      estoqueEnviado: 7,
      estoqueModelosEnviados: 4,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('8 — não escreve NENHUMA das metades da impressão digital nem estoqueRecusaAte', async () => {
    // ⚠️ Este teste fixa as SETE CHAVES da costura congelada, e só isso. Ele
    // NÃO prova que o anúncio volta a ser enviado: esse é um veredito do portão
    // sobre o documento MESCLADO, e quem o exercita é o teste 8b logo abaixo.
    const db = new FakeDb();
    semearLink(db);

    await registrarEnvioParcial(asDb(db), ALVO, parcial);

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'estoqueRecusaEstado')).toBe(false);
    expect(Object.hasOwn(patch, 'estoqueRecusaItemStatus')).toBe(false);
    expect(Object.hasOwn(patch, 'estoqueRecusaAte')).toBe(false);
    expect(Object.keys(patch).sort()).toEqual([
      'estoqueEnviado',
      'estoqueModelosEnviados',
      'estoqueRecusaCodigo',
      'estoqueRecusaEm',
      'estoqueRecusaMensagem',
      'estoqueRecusaMotivo',
      'ultimaModificacao',
    ]);
  });

  it('8b — a PROPRIEDADE, sobre o documento MESCLADO: um parcial não arma o pulo', async () => {
    // O que o teste 8 não consegue ver. O mecanismo de ESTADO do portão não
    // pergunta se as metades foram ESCRITAS — ele compara as duas leituras
    // GRAVADAS com as duas leituras ATUAIS, e `escreverNoLink` é um MERGE, de
    // modo que uma impressão antiga sobrevive ao parcial. Aqui a impressão
    // anterior aponta para uma leitura DIFERENTE da atual, e por isso o
    // reenvio acontece.
    //
    // ⚠️ E ela sobrevive DE PROPÓSITO: uma leitura gravada só é levantada pela
    // leitura se MEXER, e um parcial não mexe em nenhuma. O caso das DUAS
    // leituras nulas é o teste 8c — ele não arma mais, e a razão está no
    // portão, não neste patch.
    const db = new FakeDb();
    db.seed(CAMINHO_LINK, {
      item_id: 2_500_139_861,
      estadoAnuncio: 'ativo',
      item_status: 'NORMAL',
      // A recusa anterior foi tirada quando o anúncio estava PAUSADO.
      estoqueRecusaEm: AGORA_MS - 60_000,
      estoqueRecusaEstado: 'pausado',
      estoqueRecusaItemStatus: 'UNLIST',
    });

    await registrarEnvioParcial(asDb(db), ALVO, parcial);

    const armazenado = db.store[CAMINHO_LINK]?.data as Record<string, unknown>;
    expect(podeEnviarEstoqueShopee(armazenado, {}, { nowMs: AGORA_MS })).toEqual({ enviar: true });
  });

  it('8c — ⚠️ o caso das DUAS leituras nulas: o parcial continua NÃO armando o pulo', async () => {
    // O canto que o docblock deste escritor sempre afirmou e que o portão não
    // sustentava: num vínculo sem `estadoAnuncio` e sem `item_status` — todo
    // vínculo que um envio limpo acabou de zerar, e todo import do passo 9 que
    // foldou um status desconhecido — o `estoqueRecusaEm` que este patch
    // carimba encontrava `null === null` nas DUAS metades e travava
    // `recusa-anterior` indefinidamente, sem nada que pudesse se mexer para
    // levantá-lo. A decisão do dono (L2-1) foi exigir ao menos UMA leitura
    // GRAVADA, e é por isso que o patch de sete chaves do teste 8 significa o
    // que diz.
    const db = new FakeDb();
    db.seed(CAMINHO_LINK, { item_id: 2_500_139_861 });

    await registrarEnvioParcial(asDb(db), ALVO, parcial);

    const armazenado = db.store[CAMINHO_LINK]?.data as Record<string, unknown>;
    expect(armazenado.estoqueRecusaEm).toBe(AGORA_MS);
    expect(Object.hasOwn(armazenado, 'estoqueRecusaEstado')).toBe(false);
    expect(podeEnviarEstoqueShopee(armazenado, {}, { nowMs: AGORA_MS })).toEqual({ enviar: true });
  });

  it('9 — a mensagem passa pelo cap ÚNICO do módulo de erros', async () => {
    const db = new FakeDb();
    semearLink(db);
    const longa = 'x'.repeat(5_000);

    await registrarEnvioParcial(asDb(db), ALVO, { ...parcial, mensagem: longa });

    const guardada = unicoPatch(db, CAMINHO_LINK).estoqueRecusaMensagem;
    expect(typeof guardada).toBe('string');
    expect(String(guardada).length).toBeLessThan(longa.length);
    expect(String(guardada).endsWith('…')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) a recusa do anúncio — a impressão digital                              */
/* -------------------------------------------------------------------------- */

describe('registrarRecusaDeEstoque', () => {
  const recusa = {
    nowMs: AGORA_MS,
    motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioNaoEditavel,
    codigo: CODIGO_COM_PREFIXO,
    mensagem: 'A Shopee não permite editar este anúncio agora.',
    estadoAnuncio: 'ativo',
    itemStatus: 'NORMAL',
  } as const;

  it('10 — ⚠️ PAR: as duas metades da impressão digital são guardadas COMO VIERAM', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarRecusaDeEstoque(asDb(db), ALVO, recusa);

    expect(unicoPatch(db, CAMINHO_LINK)).toMatchObject({
      estoqueRecusaEstado: 'ativo',
      estoqueRecusaItemStatus: 'NORMAL',
      estoqueRecusaEm: AGORA_MS,
      estoqueRecusaMotivo: MOTIVO_ESTOQUE_SHOPEE.anuncioNaoEditavel,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('11 — ⚠️ NEAR-MISS: uma leitura `null` é guardada como null PRESENTE, nunca inventada nem omitida', async () => {
    // Uma coluna `.nullable().default(null)` antes da primeira escrita parece
    // exatamente com uma chave ausente, e o conjunto de pulo compara duas
    // LEITURAS REGISTRADAS por identidade. Inventar um valor aqui arma um pulo
    // contra uma leitura que ninguém fez; omitir a chave deixa a metade antiga
    // de pé.
    const db = new FakeDb();
    semearLink(db);

    await registrarRecusaDeEstoque(asDb(db), ALVO, {
      ...recusa,
      estadoAnuncio: null,
      itemStatus: null,
    });

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'estoqueRecusaEstado')).toBe(true);
    expect(Object.hasOwn(patch, 'estoqueRecusaItemStatus')).toBe(true);
    expect(patch.estoqueRecusaEstado).toBeNull();
    expect(patch.estoqueRecusaItemStatus).toBeNull();
  });

  it('12 — estoqueRecusaAte é null quando `ate` é omitido e o NÚMERO quando é dado', async () => {
    const db = new FakeDb();
    semearLink(db);
    const ate = AGORA_MS + 60_000;

    await registrarRecusaDeEstoque(asDb(db), ALVO, recusa);
    await registrarRecusaDeEstoque(asDb(db), ALVO, {
      ...recusa,
      motivo: MOTIVO_ESTOQUE_SHOPEE.bloqueadoPorPromocao,
      ate,
    });

    const [sem, com] = patchesEm(db, CAMINHO_LINK);
    expect(sem?.estoqueRecusaAte).toBeNull();
    expect(com?.estoqueRecusaAte).toBe(ate);
  });

  it('13 — ⚠️ M-88: o código é guardado VERBATIM, prefixo e tudo — o sufixo nu NÃO é o que fica', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarRecusaDeEstoque(asDb(db), ALVO, recusa);

    const guardado = unicoPatch(db, CAMINHO_LINK).estoqueRecusaCodigo;
    expect(guardado).toBe(CODIGO_COM_PREFIXO);
    expect(guardado).not.toBe(CODIGO_SEM_PREFIXO);
  });

  it('14 — não escreve quantidade nenhuma: uma recusa não enviou nada', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarRecusaDeEstoque(asDb(db), ALVO, recusa);

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'estoqueEnviado')).toBe(false);
    expect(Object.hasOwn(patch, 'estoqueModelosEnviados')).toBe(false);
    expect(Object.hasOwn(patch, 'estoqueEnviadoEm')).toBe(false);
  });

  it('15 — a mensagem passa pelo mesmo cap único', async () => {
    const db = new FakeDb();
    semearLink(db);
    const longa = 'y'.repeat(5_000);

    await registrarRecusaDeEstoque(asDb(db), ALVO, { ...recusa, mensagem: longa });

    const guardada = String(unicoPatch(db, CAMINHO_LINK).estoqueRecusaMensagem);
    expect(guardada.length).toBeLessThan(longa.length);
    expect(guardada.endsWith('…')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) a recusa do modelo — e a ausência de qualquer limpeza                   */
/* -------------------------------------------------------------------------- */

describe('registrarRecusaDeModelo', () => {
  const doModelo = { nowMs: AGORA_MS, codigo: 'model ID not exist in sku' };

  it('16 — escreve EXATAMENTE três chaves, no documento variashopee do produto FILHO', async () => {
    const db = new FakeDb();
    semearVariacao(db);

    const escrito = await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, doModelo);

    expect(escrito).toBe(true);
    expect(db.writes.map((w) => w.path)).toEqual([CAMINHO_VARIACAO]);
    expect(Object.keys(unicoPatch(db, CAMINHO_VARIACAO)).sort()).toEqual([
      'estoqueRecusaCodigo',
      'estoqueRecusaEm',
      'ultimaModificacao',
    ]);
  });

  it('17 — guarda o failed_reason VERBATIM e carimba em MILISSEGUNDOS', async () => {
    const db = new FakeDb();
    semearVariacao(db);

    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, doModelo);

    expect(unicoPatch(db, CAMINHO_VARIACAO)).toEqual({
      estoqueRecusaEm: AGORA_MS,
      estoqueRecusaCodigo: doModelo.codigo,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('18 — ⚠️ uma segunda chamada NUNCA zera nada: não existe API de limpeza para o filho', async () => {
    // ZERO escritas de limpeza é o mecanismo, não uma omissão: a linha expira
    // por COMPARAÇÃO contra o `estoqueEnviadoEm` do pai. Limpar no sucesso
    // custaria uma escrita por modelo por envio, várias vezes por hora, para
    // dois campos que ninguém lê para decidir coisa alguma.
    const db = new FakeDb();
    semearVariacao(db);

    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, doModelo);
    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      nowMs: AGORA_MS + 1,
      codigo: 'outro',
    });

    for (const patch of patchesEm(db, CAMINHO_VARIACAO)) {
      expect(Object.values(patch).some((v) => v === null)).toBe(false);
    }
    expect(db.store[CAMINHO_VARIACAO]?.data).toMatchObject({
      estoqueRecusaEm: AGORA_MS + 1,
      estoqueRecusaCodigo: 'outro',
    });
  });

  it('19 — o módulo não exporta NENHUMA função de limpeza, e há UM só escritor do filho (texto cru)', () => {
    expect(/export\s+(async\s+)?function\s+limpar/i.test(FONTE)).toBe(false);
    // Um único uso do handle (import + a chamada dentro do escritor privado) e
    // um único ponto de chamada desse escritor: acrescentar um segundo — uma
    // limpeza no sucesso — muda estes dois números.
    expect(FONTE.match(/variacaoShopeeLinkCollection/g)).toHaveLength(2);
    expect(FONTE.match(/escreverNaVariacao/g)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) o mecanismo de escrita                                                 */
/* -------------------------------------------------------------------------- */

describe('o mecanismo', () => {
  it('20 — ⚠️ M-85: um vínculo apagado no meio responde false, avisa uma vez e NÃO é ressuscitado', async () => {
    // O `merge` do handle é um UPSERT: recriaria o documento carregando só as
    // onze chaves deste patch e nenhuma das obrigatórias do schema — um
    // fantasma. `mergeIfExists` é `update()` mais um narrow de NOT_FOUND.
    const db = new FakeDb();

    const escrito = await registrarEnvioLimpo(asDb(db), ALVO, {
      nowMs: AGORA_MS,
      quantidade: 7,
      modelos: 3,
    });

    expect(escrito).toBe(false);
    expect(db.store[CAMINHO_LINK]).toBeUndefined();
    expect(db.writes).toEqual([]);
    expect(avisos).toHaveLength(1);
    expect(String(avisos[0]?.[0])).toContain('desapareceu');
  });

  it('21 — o aviso nomeia conta, produto e documento — e NENHUM corpo', async () => {
    const db = new FakeDb();

    await registrarRecusaDeEstoque(asDb(db), ALVO, {
      nowMs: AGORA_MS,
      motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioNaoEditavel,
      codigo: CODIGO_COM_PREFIXO,
      mensagem: 'A Shopee não permite editar este anúncio agora.',
      estadoAnuncio: 'ativo',
      itemStatus: 'NORMAL',
    });

    expect(avisos[0]?.[1]).toEqual({
      integracaoId: INTEGRACAO,
      produtoId: PRODUTO,
      linkDocId: LINK_DOC,
    });
  });

  it('22 — a variação apagada no meio segue a MESMA regra', async () => {
    const db = new FakeDb();

    const escrito = await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      nowMs: AGORA_MS,
      codigo: 'model ID not exist in sku',
    });

    expect(escrito).toBe(false);
    expect(db.store[CAMINHO_VARIACAO]).toBeUndefined();
    expect(db.writes).toEqual([]);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.[1]).toEqual({
      integracaoId: INTEGRACAO,
      produtoId: FILHO,
      varLinkDocId: VAR_LINK_DOC,
    });
  });

  it('23 — INVARIANTE sobre as quatro funções: todo valor de todo patch é primitivo ou null, e nenhuma chave tem ponto', async () => {
    const db = new FakeDb();
    semearLink(db);
    semearVariacao(db);

    await registrarEnvioLimpo(asDb(db), ALVO, { nowMs: AGORA_MS, quantidade: 7, modelos: 3 });
    await registrarEnvioParcial(asDb(db), ALVO, {
      nowMs: AGORA_MS,
      quantidade: 7,
      modelos: 4,
      codigo: 'model ID not exist in sku',
      mensagem: 'parcial',
    });
    await registrarRecusaDeEstoque(asDb(db), ALVO, {
      nowMs: AGORA_MS,
      motivo: MOTIVO_ESTOQUE_SHOPEE.bloqueadoPorPromocao,
      codigo: 'error_cannt_edit_stock_in_promotion',
      mensagem: 'promoção',
      estadoAnuncio: 'ativo',
      itemStatus: 'NORMAL',
      ate: AGORA_MS + 60_000,
    });
    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      nowMs: AGORA_MS,
      codigo: 'model ID not exist in sku',
    });

    expect(db.patches).toHaveLength(4);
    for (const { path, patch } of db.patches) {
      for (const [chave, valor] of Object.entries(patch)) {
        expect(chave.includes('.'), `${path}: ${chave} tem ponto`).toBe(false);
        expect(
          valor === null || (typeof valor !== 'object' && typeof valor !== 'function'),
          `${path}: ${chave} não é escalar`,
        ).toBe(true);
      }
    }
  });

  it('24 — ⚠️ M-84: o MECANISMO, contra o handle real — um objeto aninhado lança TypeError', async () => {
    // Provado contra o handle de verdade e não por leitura: acrescentar um
    // `ultimaPublicacao` (ou qualquer mapa) a um patch deste módulo é um erro de
    // execução, não uma escrita sutilmente diferente. `update()` SUBSTITUI o
    // mapa onde o set-merge funde.
    const db = new FakeDb();
    semearLink(db);

    await expect(
      produtoShopeeLinkCollection.mergeIfExists(asDb(db), { produtoId: PRODUTO }, LINK_DOC, {
        ultimaPublicacao: { em: AGORA_MS, etapa: 'update_stock' },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      produtoShopeeLinkCollection.mergeIfExists(asDb(db), { produtoId: PRODUTO }, LINK_DOC, {
        'estoqueRecusa.codigo': 'x',
      }),
    ).rejects.toThrow(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) o código do ERP                                                        */
/* -------------------------------------------------------------------------- */

describe('codigoDoErp', () => {
  it('25 — ⚠️ PAR: uma grafia só, `erp:<motivo>`', () => {
    expect(codigoDoErp(MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite)).toBe('erp:task-excede-limite');
    expect(codigoDoErp(MOTIVO_ESTOQUE_SHOPEE.semItemId)).toBe('erp:sem-item-id');
  });

  it('26 — ⚠️ NEAR-MISS: o slug CRU não é o código guardado, e o prefixo não é `erp-` nem `erp/`', () => {
    const codigo = codigoDoErp(MOTIVO_ESTOQUE_SHOPEE.semItemId);
    expect(codigo).not.toBe(MOTIVO_ESTOQUE_SHOPEE.semItemId);
    expect(codigo.startsWith('erp:')).toBe(true);
    expect(codigo.startsWith('erp-')).toBe(false);
  });

  it('27 — é o que uma recusa NOSSA guarda, verbatim, sem cap e sem reescrita', async () => {
    const db = new FakeDb();
    semearLink(db);
    const codigo = codigoDoErp(MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite);

    await registrarRecusaDeEstoque(asDb(db), ALVO, {
      nowMs: AGORA_MS,
      motivo: MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite,
      codigo,
      mensagem: 'A tarefa excede o limite de modelos por chamada.',
      estadoAnuncio: 'ativo',
      itemStatus: 'NORMAL',
    });

    expect(unicoPatch(db, CAMINHO_LINK).estoqueRecusaCodigo).toBe(codigo);
  });
});
