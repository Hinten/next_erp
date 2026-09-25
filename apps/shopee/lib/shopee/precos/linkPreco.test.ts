import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';
import { produtoShopeeLinkSchema, variacaoShopeeLinkSchema } from '@delfrance/schemas';

// ⚠️ The REAL admin handles over the shared fake Firestore, never a mock of
// `mergeIfExists`: half of what this module promises — a FLAT patch, an absent
// document answering `false` instead of being resurrected — is a property of
// that handle, and a mocked writer cannot show either (step 12's shape).
import { limitarMensagemProblema } from '../anuncios/errosPublicacao';
import { FakeDb, asDb } from '../testing/fakeDb';
import { MENSAGEM_POR_MOTIVO_PRECO, MOTIVO_PRECO_SHOPEE } from './errosPreco';
import {
  CAMPOS_DO_PATCH_DE_PRECO,
  registrarPrecoDeModelo,
  registrarPrecoLimpo,
  registrarRecusaDeModelo,
  registrarRecusaDePreco,
} from './linkPreco';

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

/** The code the sandbox probe measured (B-3), in Shopee's own prefixed spelling. */
const CODIGO_COM_PREFIXO = 'product.error_update_price_fail';
/** The same code with the module prefix stripped — what must NOT be stored. */
const CODIGO_SEM_PREFIXO = 'error_update_price_fail';
/** A per-model `failed_reason` as the probe saw it (P9) — free text, not a code. */
const RAZAO_DO_MODELO = 'model ID not exist in sku';

/** The four refusal fields of the ITEM doc — what the one clearer must null. */
const QUATRO_DE_RECUSA = [
  'precoRecusaEm',
  'precoRecusaCodigo',
  'precoRecusaMotivo',
  'precoRecusaMensagem',
] as const;

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

/** An item link that already exists — `mergeIfExists` needs one. */
function semearLink(db: FakeDb, extra: Record<string, unknown> = {}): void {
  db.seed(CAMINHO_LINK, {
    item_id: 2_500_139_861,
    estadoAnuncio: 'ativo',
    item_status: 'NORMAL',
    ...extra,
  });
}

/** A model link that already exists. */
function semearVariacao(db: FakeDb, extra: Record<string, unknown> = {}): void {
  db.seed(CAMINHO_VARIACAO, { model_id: 2_000_458_802, ...extra });
}

function patchesEm(db: FakeDb, caminho: string): Record<string, unknown>[] {
  return db.patches.filter((p) => p.path === caminho).map((p) => p.patch);
}

function unicoPatch(db: FakeDb, caminho: string): Record<string, unknown> {
  const todos = patchesEm(db, caminho);
  expect(todos).toHaveLength(1);
  return todos[0] ?? {};
}

function armazenado(db: FakeDb, caminho: string): Record<string, unknown> {
  return (db.store[caminho]?.data ?? {}) as Record<string, unknown>;
}

/**
 * The READER's rule for a model row, as the schema's docblock pins it: legible
 * while `precoRecusaEm >= (precoEnviadoEm ?? 0)`, compared on the SAME doc.
 */
function recusaDoModeloLegivel(doc: Record<string, unknown>): boolean {
  const recusa = doc.precoRecusaEm;
  const enviado = doc.precoEnviadoEm;
  if (typeof recusa !== 'number') return false;
  return recusa >= (typeof enviado === 'number' ? enviado : 0);
}

/** A refusal already stamped on the item — what a clean send must clear. */
const RECUSA_ANTERIOR = {
  precoRecusaEm: AGORA_MS - 60_000,
  precoRecusaCodigo: CODIGO_COM_PREFIXO,
  precoRecusaMotivo: MOTIVO_PRECO_SHOPEE.precoRecusado,
  precoRecusaMensagem: 'Update price failed, please try later.',
} as const;

/** Step 12's stock fields on the same doc — none of them this module's. */
const ESTOQUE_ANTERIOR = {
  estoqueEnviadoEm: AGORA_MS - 120_000,
  estoqueEnviado: 7,
  estoqueModelosEnviados: 3,
  estoqueRecusaEm: AGORA_MS - 90_000,
  estoqueRecusaCodigo: 'product.error_item_uneditable',
} as const;

const FONTE = readFileSync(fileURLToPath(new URL('./linkPreco.ts', import.meta.url)), 'utf8');

/* -------------------------------------------------------------------------- */
/*  (1) a lista — amarrada ao schema                                           */
/* -------------------------------------------------------------------------- */

describe('CAMPOS_DO_PATCH_DE_PRECO', () => {
  it('1 — ⚠️ PAR: a lista menos ultimaModificacao É o conjunto preco* que o schema do ITEM declara, nos dois sentidos', () => {
    // O tipo já amarra cada nome à grafia do schema (`satisfies` sobre o
    // `shape`); isto é a rede do OUTRO sentido, que o tipo não vê: um sétimo
    // `preco*` declarado no schema e esquecido aqui sobreviveria à única escrita
    // que zera tudo.
    const doSchema = Object.keys(produtoShopeeLinkSchema.shape)
      .filter((campo) => campo.startsWith('preco'))
      .sort();
    const daLista = CAMPOS_DO_PATCH_DE_PRECO.filter((campo) => campo !== 'ultimaModificacao');
    expect([...daLista].sort()).toEqual(doSchema);
    expect(doSchema).toHaveLength(6);
  });

  it('2 — ⚠️ NEAR-MISS: ultimaModificacao está na lista e NÃO no schema (passagem não declarada, registro 141)', () => {
    expect(CAMPOS_DO_PATCH_DE_PRECO).toContain('ultimaModificacao');
    expect(Object.hasOwn(produtoShopeeLinkSchema.shape, 'ultimaModificacao')).toBe(false);
    expect(Object.hasOwn(variacaoShopeeLinkSchema.shape, 'ultimaModificacao')).toBe(false);
    expect(CAMPOS_DO_PATCH_DE_PRECO).toHaveLength(7);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) o envio limpo — o ÚNICO que zera                                       */
/* -------------------------------------------------------------------------- */

describe('registrarPrecoLimpo', () => {
  it('3 — ⚠️ PAR: o conjunto de chaves do patch É CAMPOS_DO_PATCH_DE_PRECO, inteiro (M59)', async () => {
    const db = new FakeDb();
    semearLink(db);

    const escrito = await registrarPrecoLimpo(asDb(db), ALVO, {
      precoEnviado: 49.9,
      nowMs: AGORA_MS,
    });

    expect(escrito).toBe(true);
    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.keys(patch).sort()).toEqual([...CAMPOS_DO_PATCH_DE_PRECO].sort());
  });

  it('4 — ⚠️ M59: uma recusa anterior é ZERADA — os quatro campos ficam `null` PRESENTES, nunca ausentes', async () => {
    // Uma chave ausente e um `null` são fatos diferentes: o leitor precisa
    // distinguir "diagnosticado e depois resolvido" de "nunca diagnosticado".
    // Um patch que apenas OMITISSE um dos quatro deixaria a recusa antiga de pé
    // com o anúncio já sincronizado — e o documento MESCLADO é o que prova.
    const db = new FakeDb();
    semearLink(db, RECUSA_ANTERIOR);

    await registrarPrecoLimpo(asDb(db), ALVO, { precoEnviado: 49.9, nowMs: AGORA_MS });

    const patch = unicoPatch(db, CAMINHO_LINK);
    const doc = armazenado(db, CAMINHO_LINK);
    for (const campo of QUATRO_DE_RECUSA) {
      expect(Object.hasOwn(patch, campo), `${campo} precisa estar PRESENTE no patch`).toBe(true);
      expect(patch[campo], `${campo} precisa ser null no patch`).toBeNull();
      expect(doc[campo], `${campo} precisa ser null no documento`).toBeNull();
    }
  });

  it('5 — carimba precoEnviadoEm e ultimaModificacao com o MESMO nowMs, e grava o preço enviado de um item SEM modelo', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarPrecoLimpo(asDb(db), ALVO, { precoEnviado: 49.9, nowMs: AGORA_MS });

    expect(unicoPatch(db, CAMINHO_LINK)).toEqual({
      precoEnviado: 49.9,
      precoEnviadoEm: AGORA_MS,
      precoRecusaEm: null,
      precoRecusaCodigo: null,
      precoRecusaMotivo: null,
      precoRecusaMensagem: null,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('6 — ⚠️ NEAR-MISS (M63, metade do escritor): um item COM modelos grava precoEnviado `null` PRESENTE — e aposenta um preço sem-modelo antigo', async () => {
    // Um item com modelos guarda os preços um por modelo, no `variashopee`. O
    // `null` é escrito, não omitido: um preço de quando o anúncio ainda não
    // tinha variações não pode sobreviver ao lado de um envio por modelo.
    const db = new FakeDb();
    semearLink(db, { precoEnviado: 12.5, precoEnviadoEm: AGORA_MS - 1_000 });

    await registrarPrecoLimpo(asDb(db), ALVO, { precoEnviado: null, nowMs: AGORA_MS });

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'precoEnviado')).toBe(true);
    expect(patch.precoEnviado).toBeNull();
    expect(armazenado(db, CAMINHO_LINK).precoEnviado).toBeNull();
    expect(armazenado(db, CAMINHO_LINK).precoEnviadoEm).toBe(AGORA_MS);
  });

  it('7 — ⚠️ NEAR-MISS: nunca toca um campo estoque* — os de step 12 sobrevivem byte a byte', async () => {
    const db = new FakeDb();
    semearLink(db, ESTOQUE_ANTERIOR);

    await registrarPrecoLimpo(asDb(db), ALVO, { precoEnviado: 49.9, nowMs: AGORA_MS });

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.keys(patch).filter((campo) => campo.startsWith('estoque'))).toEqual([]);
    expect(armazenado(db, CAMINHO_LINK)).toMatchObject(ESTOQUE_ANTERIOR);
  });

  it('8 — escreve no documento do vínculo e em NENHUM outro caminho', async () => {
    const db = new FakeDb();
    semearLink(db);
    semearVariacao(db);

    await registrarPrecoLimpo(asDb(db), ALVO, { precoEnviado: 49.9, nowMs: AGORA_MS });

    expect(db.writes.map((w) => w.path)).toEqual([CAMINHO_LINK]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) a recusa do item                                                       */
/* -------------------------------------------------------------------------- */

describe('registrarRecusaDePreco', () => {
  const recusa = {
    codigo: CODIGO_COM_PREFIXO,
    motivo: MOTIVO_PRECO_SHOPEE.precoRecusado,
    mensagem: 'Update price failed, please try later.',
    nowMs: AGORA_MS,
  } as const;

  it('9 — ⚠️ PAR: escreve EXATAMENTE os quatro de recusa + ultimaModificacao, carimbados', async () => {
    const db = new FakeDb();
    semearLink(db);

    const escrito = await registrarRecusaDePreco(asDb(db), ALVO, recusa);

    expect(escrito).toBe(true);
    expect(unicoPatch(db, CAMINHO_LINK)).toEqual({
      precoRecusaEm: AGORA_MS,
      precoRecusaCodigo: CODIGO_COM_PREFIXO,
      precoRecusaMotivo: MOTIVO_PRECO_SHOPEE.precoRecusado,
      precoRecusaMensagem: recusa.mensagem,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('10 — ⚠️ NEAR-MISS do envio limpo: o par de sucesso fica AUSENTE do patch, e o armazenado sobrevive', async () => {
    // Uma recusa não enviou nada: o `precoEnviado` anterior continua sendo a
    // resposta honesta a "o que este ERP conseguiu que a Shopee aceitasse", e
    // `precoEnviadoEm` quer dizer "o item INTEIRO em dia" — um parcial também
    // passa por aqui e não pode reivindicá-lo.
    const db = new FakeDb();
    semearLink(db, { precoEnviado: 45, precoEnviadoEm: AGORA_MS - 5_000 });

    await registrarRecusaDePreco(asDb(db), ALVO, recusa);

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'precoEnviado')).toBe(false);
    expect(Object.hasOwn(patch, 'precoEnviadoEm')).toBe(false);
    expect(armazenado(db, CAMINHO_LINK)).toMatchObject({
      precoEnviado: 45,
      precoEnviadoEm: AGORA_MS - 5_000,
    });
  });

  it('11 — o código é guardado VERBATIM, prefixo e tudo — o sufixo nu NÃO é o que fica', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarRecusaDePreco(asDb(db), ALVO, recusa);

    const guardado = unicoPatch(db, CAMINHO_LINK).precoRecusaCodigo;
    expect(guardado).toBe(CODIGO_COM_PREFIXO);
    expect(guardado).not.toBe(CODIGO_SEM_PREFIXO);
  });

  it('12 — o motivo é guardado como o SLUG, nunca a frase pt-BR (renderizada na leitura) — e um parcial também passa', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarRecusaDePreco(asDb(db), ALVO, recusa);
    // O escritor não decide o que carimba (`MOTIVOS_QUE_CARIMBAM` é do
    // remetente): o parcial chega aqui com `envio-parcial` e é gravado como veio.
    await registrarRecusaDePreco(asDb(db), ALVO, {
      codigo: RAZAO_DO_MODELO,
      motivo: MOTIVO_PRECO_SHOPEE.envioParcial,
      mensagem: null,
      nowMs: AGORA_MS + 1,
    });

    const [primeiro, parcial] = patchesEm(db, CAMINHO_LINK);
    expect(primeiro?.precoRecusaMotivo).toBe('preco-recusado');
    expect(primeiro?.precoRecusaMotivo).not.toBe(MENSAGEM_POR_MOTIVO_PRECO['preco-recusado']);
    expect(parcial?.precoRecusaMotivo).toBe('envio-parcial');
  });

  it('13 — ⚠️ PAR: a mensagem passa pelo cap ÚNICO do app (o do problema de publicação)', async () => {
    const db = new FakeDb();
    semearLink(db);
    const longa = 'x'.repeat(5_000);

    await registrarRecusaDePreco(asDb(db), ALVO, { ...recusa, mensagem: longa });

    const guardada = String(unicoPatch(db, CAMINHO_LINK).precoRecusaMensagem);
    expect(guardada).toBe(limitarMensagemProblema(longa));
    expect(guardada.length).toBeLessThan(longa.length);
    expect(guardada.endsWith('…')).toBe(true);
  });

  it('14 — ⚠️ NEAR-MISS do cap: uma mensagem curta é guardada VERBATIM, sem reticências', async () => {
    const db = new FakeDb();
    semearLink(db);

    await registrarRecusaDePreco(asDb(db), ALVO, recusa);

    expect(unicoPatch(db, CAMINHO_LINK).precoRecusaMensagem).toBe(recusa.mensagem);
  });

  it('15 — ⚠️ NEAR-MISS: mensagem `null` é gravada como null PRESENTE — o texto de uma recusa anterior NÃO sobrevive ao lado do código novo', async () => {
    // Uma recusa NOSSA (`erp:razao-de-precos-excedida`) não tem mensagem da
    // Shopee. Omitir a chave deixaria a frase da recusa anterior pendurada no
    // código novo, contando outra história.
    const db = new FakeDb();
    semearLink(db, RECUSA_ANTERIOR);

    await registrarRecusaDePreco(asDb(db), ALVO, {
      codigo: 'erp:razao-de-precos-excedida',
      motivo: MOTIVO_PRECO_SHOPEE.razaoDePrecosExcedida,
      mensagem: null,
      nowMs: AGORA_MS,
    });

    const patch = unicoPatch(db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'precoRecusaMensagem')).toBe(true);
    expect(patch.precoRecusaMensagem).toBeNull();
    expect(armazenado(db, CAMINHO_LINK)).toMatchObject({
      precoRecusaCodigo: 'erp:razao-de-precos-excedida',
      precoRecusaMensagem: null,
    });
  });

  it('16 — nunca toca um campo estoque*', async () => {
    const db = new FakeDb();
    semearLink(db, ESTOQUE_ANTERIOR);

    await registrarRecusaDePreco(asDb(db), ALVO, recusa);

    expect(
      Object.keys(unicoPatch(db, CAMINHO_LINK)).filter((c) => c.startsWith('estoque')),
    ).toEqual([]);
    expect(armazenado(db, CAMINHO_LINK)).toMatchObject(ESTOQUE_ANTERIOR);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) o modelo — o par de sucesso e a recusa, sem limpeza nenhuma             */
/* -------------------------------------------------------------------------- */

describe('registrarPrecoDeModelo', () => {
  it('17 — escreve EXATAMENTE três chaves, no documento variashopee do produto FILHO', async () => {
    const db = new FakeDb();
    semearVariacao(db);

    const escrito = await registrarPrecoDeModelo(asDb(db), ALVO_VARIACAO, {
      preco: 19.9,
      nowMs: AGORA_MS,
    });

    expect(escrito).toBe(true);
    expect(db.writes.map((w) => w.path)).toEqual([CAMINHO_VARIACAO]);
    expect(unicoPatch(db, CAMINHO_VARIACAO)).toEqual({
      precoEnviado: 19.9,
      precoEnviadoEm: AGORA_MS,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('18 — ⚠️ PAR (o documento MESCLADO): o sucesso do modelo EXPIRA a sua recusa anterior sem escrever null nenhum', async () => {
    // O mecanismo, não a chave: a recusa fica de pé no documento, e é a
    // comparação do leitor no MESMO doc que a aposenta.
    const db = new FakeDb();
    semearVariacao(db, { precoRecusaEm: AGORA_MS - 60_000, precoRecusaCodigo: RAZAO_DO_MODELO });
    expect(recusaDoModeloLegivel(armazenado(db, CAMINHO_VARIACAO))).toBe(true);

    await registrarPrecoDeModelo(asDb(db), ALVO_VARIACAO, { preco: 19.9, nowMs: AGORA_MS });

    const doc = armazenado(db, CAMINHO_VARIACAO);
    expect(doc.precoRecusaEm).toBe(AGORA_MS - 60_000);
    expect(doc.precoRecusaCodigo).toBe(RAZAO_DO_MODELO);
    expect(recusaDoModeloLegivel(doc)).toBe(false);
    expect(Object.values(unicoPatch(db, CAMINHO_VARIACAO)).includes(null)).toBe(false);
  });

  it('19 — ⚠️ NEAR-MISS: um sucesso ANTERIOR não esconde uma recusa POSTERIOR', async () => {
    const db = new FakeDb();
    semearVariacao(db);

    await registrarPrecoDeModelo(asDb(db), ALVO_VARIACAO, { preco: 19.9, nowMs: AGORA_MS });
    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      codigo: RAZAO_DO_MODELO,
      nowMs: AGORA_MS + 1,
    });

    const doc = armazenado(db, CAMINHO_VARIACAO);
    expect(recusaDoModeloLegivel(doc)).toBe(true);
    // E o preço aceito antes continua de pé: a recusa não apaga o que foi aceito.
    expect(doc.precoEnviado).toBe(19.9);
  });
});

describe('registrarRecusaDeModelo', () => {
  const doModelo = { codigo: RAZAO_DO_MODELO, nowMs: AGORA_MS };

  it('20 — escreve EXATAMENTE três chaves, com o failed_reason VERBATIM e o carimbo em MILISSEGUNDOS', async () => {
    const db = new FakeDb();
    semearVariacao(db);

    const escrito = await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, doModelo);

    expect(escrito).toBe(true);
    expect(db.writes.map((w) => w.path)).toEqual([CAMINHO_VARIACAO]);
    expect(unicoPatch(db, CAMINHO_VARIACAO)).toEqual({
      precoRecusaEm: AGORA_MS,
      precoRecusaCodigo: RAZAO_DO_MODELO,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('20b — ⚠️ NEAR-MISS do texto livre: um código com PREFIXO no modelo (o de topo, para um modelo que as listas não nomeiam) também fica VERBATIM', async () => {
    // Appendix C C-3: um modelo que nem `success_list` nem `failure_list`
    // nomeia herda a classificação do código de TOPO — e é esse código, com o
    // prefixo do módulo, que o remetente carimba no filho.
    const db = new FakeDb();
    semearVariacao(db);

    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      codigo: CODIGO_COM_PREFIXO,
      nowMs: AGORA_MS,
    });

    const guardado = unicoPatch(db, CAMINHO_VARIACAO).precoRecusaCodigo;
    expect(guardado).toBe(CODIGO_COM_PREFIXO);
    expect(guardado).not.toBe(CODIGO_SEM_PREFIXO);
  });

  it('21 — ⚠️ uma segunda chamada NUNCA zera nada e não toca o par de sucesso do modelo', async () => {
    const db = new FakeDb();
    semearVariacao(db, { precoEnviado: 19.9, precoEnviadoEm: AGORA_MS - 10_000 });

    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, doModelo);
    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      codigo: 'outro',
      nowMs: AGORA_MS + 1,
    });

    for (const patch of patchesEm(db, CAMINHO_VARIACAO)) {
      expect(Object.values(patch).includes(null)).toBe(false);
      expect(Object.hasOwn(patch, 'precoEnviado')).toBe(false);
      expect(Object.hasOwn(patch, 'precoEnviadoEm')).toBe(false);
    }
    expect(armazenado(db, CAMINHO_VARIACAO)).toMatchObject({
      precoRecusaEm: AGORA_MS + 1,
      precoRecusaCodigo: 'outro',
      precoEnviado: 19.9,
      precoEnviadoEm: AGORA_MS - 10_000,
    });
  });

  it('22 — o módulo não exporta NENHUMA limpeza, e cada handle tem UM só escritor privado (texto cru)', () => {
    expect(/export\s+(async\s+)?function\s+limpar/i.test(FONTE)).toBe(false);
    // Um uso de cada handle (import + a chamada dentro do escritor privado), e
    // cada escritor privado com exatamente DUAS funções públicas por cima:
    // acrescentar uma terceira — uma limpeza no sucesso — muda estes números.
    expect(FONTE.match(/produtoShopeeLinkCollection/g)).toHaveLength(2);
    expect(FONTE.match(/variacaoShopeeLinkCollection/g)).toHaveLength(2);
    expect(FONTE.match(/escreverNoLink\(/g)).toHaveLength(3);
    expect(FONTE.match(/escreverNaVariacao\(/g)).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) o mecanismo de escrita                                                 */
/* -------------------------------------------------------------------------- */

describe('o mecanismo', () => {
  it('23 — ⚠️ um vínculo apagado no meio responde false, avisa UMA vez e NÃO é ressuscitado', async () => {
    // O `merge` do handle é um UPSERT: recriaria o documento carregando só as
    // chaves deste patch e nenhuma das obrigatórias do schema — um fantasma.
    const db = new FakeDb();

    const escrito = await registrarPrecoLimpo(asDb(db), ALVO, {
      precoEnviado: 49.9,
      nowMs: AGORA_MS,
    });

    expect(escrito).toBe(false);
    expect(db.store[CAMINHO_LINK]).toBeUndefined();
    expect(db.writes).toEqual([]);
    expect(avisos).toHaveLength(1);
    expect(String(avisos[0]?.[0])).toContain('desapareceu');
  });

  it('24 — o aviso nomeia conta, produto e documento — e NENHUM corpo (nem código, nem mensagem)', async () => {
    const db = new FakeDb();

    const escrito = await registrarRecusaDePreco(asDb(db), ALVO, {
      codigo: CODIGO_COM_PREFIXO,
      motivo: MOTIVO_PRECO_SHOPEE.precoRecusado,
      mensagem: 'Update price failed, please try later.',
      nowMs: AGORA_MS,
    });

    expect(escrito).toBe(false);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.[1]).toEqual({
      integracaoId: INTEGRACAO,
      produtoId: PRODUTO,
      linkDocId: LINK_DOC,
    });
    expect(JSON.stringify(avisos)).not.toContain(CODIGO_COM_PREFIXO);
    expect(JSON.stringify(avisos)).not.toContain('try later');
  });

  it('25 — a variação apagada no meio segue a MESMA regra, nos DOIS escritores do modelo', async () => {
    const db = new FakeDb();

    const sucesso = await registrarPrecoDeModelo(asDb(db), ALVO_VARIACAO, {
      preco: 19.9,
      nowMs: AGORA_MS,
    });
    const recusa = await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      codigo: RAZAO_DO_MODELO,
      nowMs: AGORA_MS,
    });

    expect([sucesso, recusa]).toEqual([false, false]);
    expect(db.store[CAMINHO_VARIACAO]).toBeUndefined();
    expect(db.writes).toEqual([]);
    expect(avisos).toHaveLength(2);
    for (const aviso of avisos) {
      expect(aviso[1]).toEqual({
        integracaoId: INTEGRACAO,
        produtoId: FILHO,
        varLinkDocId: VAR_LINK_DOC,
      });
    }
  });

  it('26 — INVARIANTE sobre as quatro funções: todo valor é primitivo ou null, nenhuma chave tem ponto, nenhuma é estoque*', async () => {
    const db = new FakeDb();
    semearLink(db);
    semearVariacao(db);

    await registrarPrecoLimpo(asDb(db), ALVO, { precoEnviado: null, nowMs: AGORA_MS });
    await registrarRecusaDePreco(asDb(db), ALVO, {
      codigo: CODIGO_COM_PREFIXO,
      motivo: MOTIVO_PRECO_SHOPEE.precoRecusado,
      mensagem: 'Update price failed, please try later.',
      nowMs: AGORA_MS,
    });
    await registrarPrecoDeModelo(asDb(db), ALVO_VARIACAO, { preco: 19.9, nowMs: AGORA_MS });
    await registrarRecusaDeModelo(asDb(db), ALVO_VARIACAO, {
      codigo: RAZAO_DO_MODELO,
      nowMs: AGORA_MS,
    });

    expect(db.patches).toHaveLength(4);
    for (const { path, patch } of db.patches) {
      for (const [chave, valor] of Object.entries(patch)) {
        expect(chave.includes('.'), `${path}: ${chave} tem ponto`).toBe(false);
        expect(chave.startsWith('estoque'), `${path}: ${chave} é do estoque`).toBe(false);
        expect(
          valor === null || (typeof valor !== 'object' && typeof valor !== 'function'),
          `${path}: ${chave} não é escalar`,
        ).toBe(true);
      }
    }
  });

  it('27 — o MECANISMO, contra o handle real: um objeto aninhado ou uma chave com ponto lança TypeError', async () => {
    const db = new FakeDb();
    semearLink(db);

    await expect(
      produtoShopeeLinkCollection.mergeIfExists(asDb(db), { produtoId: PRODUTO }, LINK_DOC, {
        precoRecusa: { em: AGORA_MS, codigo: CODIGO_COM_PREFIXO },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      produtoShopeeLinkCollection.mergeIfExists(asDb(db), { produtoId: PRODUTO }, LINK_DOC, {
        'precoRecusa.codigo': CODIGO_COM_PREFIXO,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('28 — regra 7 no texto cru: nenhuma API de transação nem de pré-condição, e nenhum relógio lido', () => {
    // As agulhas são montadas em tempo de execução: este arquivo de teste não
    // pode, ele mesmo, conter as palavras que outras redes do repo procuram.
    const proibidas = [
      ['run', 'Transaction'].join(''),
      ['last', 'UpdateTime'].join(''),
      ['Date', '.now('].join(''),
      ['new Date', '()'].join(''),
    ];
    for (const agulha of proibidas) {
      expect(FONTE.includes(agulha), agulha).toBe(false);
    }
  });
});
