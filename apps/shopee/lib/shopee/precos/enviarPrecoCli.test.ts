/**
 * The pure half of `enviar:precos` (#1521, step 13; reconcile C-s, §4 M72;
 * D2 §5).
 *
 * ⚠️ Five of these are the only thing standing between a rehearsal and a
 * price written by accident, a dry run that drifted from the live run, a leak,
 * or a lie about the exit code — and none of them is a happy path:
 *
 *  - **§1** pins that `--live --dry-run` is REFUSED and that a switch never
 *    reads a value (`--baixar-preco=false` must not AUTHORISE a decrease);
 *  - **§3** runs the REAL live run (real sender, a double client) and the dry
 *    run over the SAME inputs and requires the same rows — the dry run's
 *    resolution, its G0/G1 and its plan are re-stated (they cannot be imported
 *    without the sender), and this is what holds them to the live path; it also
 *    proves the dry run calls `update_price` ZERO times (M72);
 *  - **§5** pins that the SCRIPT names `enviarPrecoManualShopee` only below the
 *    dry-run branch, that this module imports the sender for TYPES only, and
 *    that no branch marks an exit code;
 *  - **§4** pins both `--json` builders as ALLOW-LISTS with a stable key order;
 *  - **§6** pins that a throw is described by CLASS plus `code`/`path` and a
 *    refused conta by the route's own code, never by a payload.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeModelListPayloadSchema,
  shopeeUpdatePriceSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { produtoCollection } from '@delfrance/data/admin/collections';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { SHOPEE_ENVIO_PRECO_MAX_PRODUTOS } from './constantesPreco';
import {
  ArgumentoInvalidoError,
  DECISAO_DO_ENSAIO,
  MSG_EXCEDE_LIMITE,
  MSG_PRODUTO_OBRIGATORIO,
  USO_ENVIAR_PRECOS,
  codigoDaRecusaDaConta,
  decidirItemDoEnsaio,
  descreverErroEnvioPreco,
  descreverRecusaDaConta,
  ehRecusaAntesDoEnvioDePreco,
  ensaiarEnvioDePreco,
  formatarPreco,
  lerArgsEnviarPrecos,
  renderizarEnsaio,
  renderizarResultadoEnvioPreco,
  resumoDaRecusaDaConta,
  resumoDoEnsaio,
  resumoDoEnvioPreco,
  type ContaDoEnsaio,
  type EnsaioDePreco,
  type LeitoresDoEnsaio,
  type LeituraDoEnsaio,
} from './enviarPrecoCli';
import {
  enviarPrecoManualShopee,
  type EnvioPrecoListing,
  type EnvioPrecoResponse,
} from './enviarPrecoManual';
import {
  CODIGO_GUARDA_PRECO,
  MENSAGEM_ENVIO_PRECO_LIMPO,
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoGuardError,
  mensagemDoMotivoDePreco,
} from './errosPreco';
import { criarLeitorDeBaseEmLote } from './leitorDeBase';
import { lerItemParaPreco } from './leituraPreco';
import { precosDaFamilia, type FamiliaDePreco, type ItemDePreco } from './planoPreco';
import type { ContextoContaPreco } from './regiaoPreco';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or seller.  */
/* -------------------------------------------------------------------------- */

const INT = 'int-1';
const TABELA = 'tab-normal';
const ITEM = 2500139861;
const MODELO_A = 2000458802;
const MODELO_B = 2000458803;
const AGORA = 1_760_000_000_000;

const FONTE_CLI = readFileSync(new URL('./enviarPrecoCli.ts', import.meta.url), 'utf8');
const FONTE_SCRIPT = readFileSync(
  new URL('../../../scripts/enviar-precos.ts', import.meta.url),
  'utf8',
);
const PACOTE = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');

const CONTA: ContaDoEnsaio = { regiao: 'BR', moeda: 'BRL', multiplo: 4, tabelaNormalId: TABELA };

function precos(valor: number | null): unknown {
  return valor === null ? {} : { [TABELA]: { valor } };
}

function link(itemId: number, linkDocId: string, extra: Record<string, unknown> = {}) {
  return { contaProdutoShopeeOuterRef: `integracoes/${INT}`, item_id: itemId, linkDocId, ...extra };
}

/** A family with ONE no-model listing priced from the anchor. */
function familiaSimples(
  anchorId: string,
  itemId: number,
  valor: number | null,
  extra: Record<string, unknown> = {},
): FamiliaDePreco {
  return {
    anchorId,
    precos: precos(valor),
    links: [link(itemId, `link-${anchorId}`, extra)],
    children: [],
  };
}

/** A family with ONE has-model listing: two children, each priced on its own. */
function familiaComModelos(
  anchorId: string,
  itemId: number,
  filhos: readonly (readonly [string, number, number | null])[],
): FamiliaDePreco {
  const linkDocId = `link-${anchorId}`;
  return {
    anchorId,
    precos: precos(99),
    links: [link(itemId, linkDocId)],
    children: filhos.map(([produtoId, modelId, valor]) => ({
      produtoId,
      precos: precos(valor),
      varLinks: [
        {
          contaVariacaoShopeeOuterRef: `integracoes/${INT}`,
          produtoShopeeOuterRef: `produtos/${anchorId}/prodshopee/${linkDocId}`,
          model_id: modelId,
          varLinkDocId: `var-${produtoId}`,
        },
      ],
    })),
  };
}

/** A no-model fresh read. */
function leituraSimples(anterior: number | null, moeda = 'BRL'): LeituraDoEnsaio {
  return {
    ausente: false,
    leitura: {
      itemStatus: 'NORMAL',
      temModelos: false,
      modelos: [{ modelId: 0, precoAnterior: anterior, moeda, status: null }],
    },
  };
}

function itemSimples(precoAlvo: number | null, produtoId = 'prod-a'): ItemDePreco {
  return {
    produtoId,
    linkDocId: `link-${produtoId}`,
    itemId: ITEM,
    semModelos: true,
    alvos: [{ modelId: 0, produtoId, varLinkDocId: null, precoAlvo }],
  };
}

/** Readers over in-memory maps, each call recorded. */
function leitores(opts: {
  produtos: Record<string, Record<string, unknown>>;
  familias: readonly FamiliaDePreco[];
  leituras?: Record<number, LeituraDoEnsaio>;
}) {
  const leiturasDeProdutos: { ids: string[]; campos: string[] }[] = [];
  const lerFamilias = vi.fn((anchorIds: readonly string[]) =>
    Promise.resolve(
      new Map(
        opts.familias
          .filter((f) => anchorIds.includes(f.anchorId))
          .map((f): [string, FamiliaDePreco] => [f.anchorId, f]),
      ),
    ),
  );
  const lerItem = vi.fn((itemId: number) =>
    Promise.resolve(opts.leituras?.[itemId] ?? ({ ausente: true } as const)),
  );
  const criarLeitorDeItens = vi.fn((_ids: readonly number[]) => lerItem);
  const l: LeitoresDoEnsaio = {
    lerProdutos: (ids, campos) => {
      leiturasDeProdutos.push({ ids: [...ids], campos: [...campos] });
      return Promise.resolve(
        new Map(
          ids.flatMap((id): [string, Record<string, unknown>][] => {
            const p = opts.produtos[id];
            return p === undefined ? [] : [[id, p]];
          }),
        ),
      );
    },
    lerFamilias,
    criarLeitorDeItens,
  };
  return { l, lerFamilias, lerItem, criarLeitorDeItens, leiturasDeProdutos };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  1 · os argumentos                                                         */
/* ========================================================================== */

describe('lerArgsEnviarPrecos', () => {
  const base = ['--integracao', INT, '--produto', 'prod-1'];

  it('o padrão é DRY-RUN, sem baixar preço, sem json e sem projeto', () => {
    expect(lerArgsEnviarPrecos(base)).toEqual({
      kind: 'enviar',
      args: {
        integracaoId: INT,
        produtoIds: ['prod-1'],
        baixarPreco: false,
        live: false,
        json: false,
        projectId: null,
      },
    });
  });

  it('cada flag liga o SEU campo e nada mais', () => {
    const c = lerArgsEnviarPrecos([
      ...base,
      '--live',
      '--baixar-preco',
      '--json',
      '--project',
      'demo-erp',
    ]);
    expect(c).toEqual({
      kind: 'enviar',
      args: {
        integracaoId: INT,
        produtoIds: ['prod-1'],
        baixarPreco: true,
        live: true,
        json: true,
        projectId: 'demo-erp',
      },
    });
  });

  it('--produto é REPETÍVEL, mantém a ordem e tira os repetidos; a forma --flag=valor vale', () => {
    const c = lerArgsEnviarPrecos([
      '--integracao=int-1',
      '--produto=prod-b',
      '--produto',
      'prod-a',
      '--produto',
      'prod-b',
    ]);
    expect(c.kind === 'enviar' && c.args.produtoIds).toEqual(['prod-b', 'prod-a']);
  });

  it('⚠️ não existe lista separada por vírgula: "a,b" é UM id', () => {
    const c = lerArgsEnviarPrecos(['--integracao', INT, '--produto', 'prod-a,prod-b']);
    expect(c.kind === 'enviar' && c.args.produtoIds).toEqual(['prod-a,prod-b']);
  });

  it('⛔ (M72) --live e --dry-run juntos são RECUSADOS, nunca resolvidos por precedência', () => {
    expect(() => lerArgsEnviarPrecos([...base, '--live', '--dry-run'])).toThrow(
      ArgumentoInvalidoError,
    );
    expect(() => lerArgsEnviarPrecos([...base, '--dry-run', '--live'])).toThrow(/contraditórios/);
    // QUASE: cada uma sozinha é aceita.
    expect(lerArgsEnviarPrecos([...base, '--dry-run'])).toMatchObject({ args: { live: false } });
    expect(lerArgsEnviarPrecos([...base, '--live'])).toMatchObject({ args: { live: true } });
  });

  it('⛔ PAR/QUASE: `--baixar-preco` liga a redução; `--baixar-preco=false` é RECUSADO, nunca lido como presente', () => {
    expect(lerArgsEnviarPrecos([...base, '--baixar-preco'])).toMatchObject({
      args: { baixarPreco: true },
    });
    expect(() => lerArgsEnviarPrecos([...base, '--baixar-preco=false'])).toThrow(
      /não aceita valor/,
    );
    expect(() => lerArgsEnviarPrecos([...base, '--live=0'])).toThrow(/não aceita valor/);
  });

  it('--help responde ANTES de qualquer validação, mesmo sem as flags obrigatórias', () => {
    expect(lerArgsEnviarPrecos(['--help'])).toEqual({ kind: 'ajuda' });
    expect(lerArgsEnviarPrecos(['-h', '--live', '--dry-run'])).toEqual({ kind: 'ajuda' });
  });

  it('sem --produto e sem --integracao as duas recusas têm sentença própria', () => {
    expect(() => lerArgsEnviarPrecos(['--integracao', INT])).toThrow(MSG_PRODUTO_OBRIGATORIO);
    expect(() => lerArgsEnviarPrecos(['--produto', 'prod-1'])).toThrow(/--integracao/);
    expect(() => lerArgsEnviarPrecos(['--integracao'])).toThrow(/exige um valor/);
  });

  it('⛔ um id que endereça outro caminho é recusado pela MESMA regra da rota', () => {
    for (const ruim of ['..', '.', 'a/b']) {
      expect(() => lerArgsEnviarPrecos(['--integracao', INT, '--produto', ruim])).toThrow(
        /não é um id de documento/,
      );
    }
  });

  it('o separador "--" e uma opção desconhecida são recusados', () => {
    expect(() => lerArgsEnviarPrecos(['--', ...base])).toThrow(/Separador/);
    expect(() => lerArgsEnviarPrecos([...base, '--reenviar-com-erro'])).toThrow(
      /Opção desconhecida/,
    );
  });

  it('PAR/QUASE: 51 flags com 50 DISTINTOS são aceitas; 51 distintos excedem o limite', () => {
    const cinquenta = Array.from({ length: SHOPEE_ENVIO_PRECO_MAX_PRODUTOS }, (_, i) => `p-${i}`);
    const comRepetido = lerArgsEnviarPrecos([
      '--integracao',
      INT,
      ...[...cinquenta, 'p-0'].flatMap((id) => ['--produto', id]),
    ]);
    expect(comRepetido.kind === 'enviar' && comRepetido.args.produtoIds).toHaveLength(50);
    expect(() =>
      lerArgsEnviarPrecos([
        '--integracao',
        INT,
        ...[...cinquenta, 'p-50'].flatMap((id) => ['--produto', id]),
      ]),
    ).toThrow(MSG_EXCEDE_LIMITE);
  });
});

/* ========================================================================== */
/*  2 · o ensaio: resolução, plano, leitura e decisão                         */
/* ========================================================================== */

describe('decidirItemDoEnsaio', () => {
  it('G0: nenhum modelo com preço ⇒ pularia preco-nao-encontrado, sem nada lido', () => {
    const a = decidirItemDoEnsaio(itemSimples(null), null, CONTA, 'Camiseta', false);
    expect(a).toMatchObject({
      decisao: DECISAO_DO_ENSAIO.pularia,
      motivo: MOTIVO_PRECO_SHOPEE.precoNaoEncontrado,
      modelosNoCorpo: 0,
    });
    expect(a.modelos).toEqual([
      expect.objectContaining({ precoAnterior: null, precoAlvo: null, decisao: 'pularia' }),
    ]);
  });

  it('G1: ausente da leitura de base ⇒ recusaria anuncio-inexistente', () => {
    const a = decidirItemDoEnsaio(itemSimples(15), { ausente: true }, CONTA, null, false);
    expect(a).toMatchObject({
      decisao: DECISAO_DO_ENSAIO.recusaria,
      motivo: MOTIVO_PRECO_SHOPEE.anuncioInexistente,
    });
    expect(a.modelos.map((m) => m.motivo)).toEqual([MOTIVO_PRECO_SHOPEE.anuncioInexistente]);
  });

  it('⚠️ PAR/QUASE: enviaria 15 sobre 10 com UM modelo no corpo — e a mensagem NÃO é a frase no passado do envio limpo', () => {
    const a = decidirItemDoEnsaio(itemSimples(15), leituraSimples(10), CONTA, null, false);
    expect(a).toMatchObject({
      decisao: DECISAO_DO_ENSAIO.enviaria,
      motivo: null,
      mensagem: null,
      modelosNoCorpo: 1,
    });
    expect(a.modelos[0]).toMatchObject({
      precoAnterior: 10,
      precoAlvo: 15,
      decisao: 'enviaria',
      motivo: null,
      mensagem: null,
    });
    expect(JSON.stringify(a)).not.toContain(MENSAGEM_ENVIO_PRECO_LIMPO);
  });

  it('PAR/QUASE: um preço MENOR sem `baixarPreco` ⇒ pularia preco-menor-bloqueado; com ele ⇒ enviaria', () => {
    const sem = decidirItemDoEnsaio(itemSimples(8), leituraSimples(10), CONTA, null, false);
    const com = decidirItemDoEnsaio(itemSimples(8), leituraSimples(10), CONTA, null, true);
    expect(sem).toMatchObject({
      decisao: DECISAO_DO_ENSAIO.pularia,
      motivo: MOTIVO_PRECO_SHOPEE.precoMenorBloqueado,
    });
    expect(com).toMatchObject({ decisao: DECISAO_DO_ENSAIO.enviaria, motivo: null });
  });

  it('a moeda vem do CONTEXTO: SGD fresco numa conta BRL ⇒ recusaria moeda-divergente', () => {
    const a = decidirItemDoEnsaio(itemSimples(15), leituraSimples(10, 'SGD'), CONTA, null, false);
    expect(a).toMatchObject({
      decisao: DECISAO_DO_ENSAIO.recusaria,
      motivo: MOTIVO_PRECO_SHOPEE.moedaDivergente,
      mensagem: mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.moedaDivergente),
    });
  });
});

describe('ensaiarEnvioDePreco', () => {
  it('⚠️ um FILHO pedido resolve para a âncora; filho + âncora ⇒ UMA família e UM leitor', async () => {
    const r = leitores({
      produtos: {
        'prod-ancora': { nome: 'Âncora' },
        'prod-filho-a': { nome: 'Filho A', paiId: 'prod-ancora' },
      },
      familias: [
        familiaComModelos('prod-ancora', ITEM, [
          ['prod-filho-a', MODELO_A, 12],
          ['prod-filho-b', MODELO_B, 22],
        ]),
      ],
      leituras: {
        [ITEM]: {
          ausente: false,
          leitura: {
            itemStatus: 'NORMAL',
            temModelos: true,
            modelos: [
              { modelId: MODELO_A, precoAnterior: 10, moeda: 'BRL', status: 'MODEL_NORMAL' },
              { modelId: MODELO_B, precoAnterior: 22, moeda: 'BRL', status: 'MODEL_NORMAL' },
            ],
          },
        },
      },
    });

    const e = await ensaiarEnvioDePreco(
      { integracaoId: INT, produtoIds: ['prod-filho-a', 'prod-ancora'], baixarPreco: false },
      CONTA,
      r.l,
    );

    expect(r.lerFamilias).toHaveBeenCalledTimes(1);
    expect(r.lerFamilias).toHaveBeenCalledWith(['prod-ancora']);
    expect(r.criarLeitorDeItens).toHaveBeenCalledTimes(1);
    expect(r.criarLeitorDeItens).toHaveBeenCalledWith([ITEM]);
    expect(r.lerItem).toHaveBeenCalledTimes(1);
    expect(e.anuncios).toHaveLength(1);
    expect(e.anuncios[0]).toMatchObject({
      produtoId: 'prod-ancora',
      produtoNome: 'Âncora',
      decisao: DECISAO_DO_ENSAIO.enviaria,
      modelosNoCorpo: 1,
    });
    expect(e.anuncios[0]?.modelos.map((m) => [m.variacaoProdutoId, m.decisao, m.motivo])).toEqual([
      ['prod-filho-a', 'enviaria', null],
      ['prod-filho-b', 'pularia', MOTIVO_PRECO_SHOPEE.precoIgual],
    ]);
    expect(e.totais).toEqual({ enviaria: 1, pularia: 1, recusaria: 0 });
    // As máscaras de leitura: nome + paiId para os pedidos, e nenhuma segunda
    // leitura quando toda âncora já foi pedida.
    expect(r.leiturasDeProdutos).toEqual([
      { ids: ['prod-filho-a', 'prod-ancora'], campos: ['nome', 'paiId'] },
    ]);
  });

  it('PAR/QUASE: `baixarPreco` chega à decisão — a MESMA redução pula sem ele e seria enviada com ele', async () => {
    const rodar = (baixarPreco: boolean) => {
      const r = leitores({
        produtos: { 'prod-a': { nome: 'A' } },
        familias: [familiaSimples('prod-a', ITEM, 8)],
        leituras: { [ITEM]: leituraSimples(10) },
      });
      return ensaiarEnvioDePreco(
        { integracaoId: INT, produtoIds: ['prod-a'], baixarPreco },
        CONTA,
        r.l,
      );
    };
    const sem = await rodar(false);
    const com = await rodar(true);
    expect(sem.anuncios[0]).toMatchObject({
      decisao: DECISAO_DO_ENSAIO.pularia,
      motivo: MOTIVO_PRECO_SHOPEE.precoMenorBloqueado,
    });
    expect(com.anuncios[0]).toMatchObject({ decisao: DECISAO_DO_ENSAIO.enviaria, motivo: null });
    expect(com.baixarPreco).toBe(true);
    expect(renderizarEnsaio(com).join('\n')).toContain('AUTORIZADO');
    expect(renderizarEnsaio(sem).join('\n')).not.toContain('AUTORIZADO');
  });

  it('o nome da âncora que NINGUÉM pediu vem de uma segunda leitura, mascarada em `nome`', async () => {
    const r = leitores({
      produtos: {
        'prod-ancora': { nome: 'Âncora' },
        'prod-filho-a': { nome: 'Filho A', paiId: 'prod-ancora' },
      },
      familias: [familiaSimples('prod-ancora', ITEM, 15)],
      leituras: { [ITEM]: leituraSimples(10) },
    });
    const e = await ensaiarEnvioDePreco(
      { integracaoId: INT, produtoIds: ['prod-filho-a'], baixarPreco: false },
      CONTA,
      r.l,
    );
    expect(r.leiturasDeProdutos[1]).toEqual({ ids: ['prod-ancora'], campos: ['nome'] });
    expect(e.anuncios[0]?.produtoNome).toBe('Âncora');
  });

  it('G0 antes da leitura: um anúncio sem preço NÃO custa leitura; o leitor é montado sobre TODOS os planejados', async () => {
    const r = leitores({
      produtos: { 'prod-a': { nome: 'A' }, 'prod-b': { nome: 'B' } },
      familias: [familiaSimples('prod-a', ITEM, null), familiaSimples('prod-b', ITEM + 1, 15)],
      leituras: { [ITEM + 1]: leituraSimples(10) },
    });
    const e = await ensaiarEnvioDePreco(
      { integracaoId: INT, produtoIds: ['prod-a', 'prod-b'], baixarPreco: false },
      CONTA,
      r.l,
    );
    expect(r.criarLeitorDeItens).toHaveBeenCalledWith([ITEM, ITEM + 1]);
    expect(r.lerItem.mock.calls).toEqual([[ITEM + 1]]);
    expect(e.anuncios.map((a) => [a.produtoId, a.decisao, a.motivo])).toEqual([
      ['prod-a', 'pularia', MOTIVO_PRECO_SHOPEE.precoNaoEncontrado],
      ['prod-b', 'enviaria', null],
    ]);
  });

  it('o que não chega a anúncio: inexistente, família sumida e sem-link por id pedido; kit nativo vira PULO do plano', async () => {
    const r = leitores({
      produtos: {
        'prod-sem-familia': { nome: 'Sem família' },
        'prod-outra-conta': { nome: 'Outra conta' },
        'prod-kit': { nome: 'Kit' },
      },
      familias: [
        {
          anchorId: 'prod-outra-conta',
          precos: precos(15),
          links: [{ ...link(ITEM, 'link-x'), contaProdutoShopeeOuterRef: 'integracoes/int-2' }],
          children: [],
        },
        familiaSimples('prod-kit', ITEM + 7, 15, { kitNativo: true }),
      ],
    });
    const e = await ensaiarEnvioDePreco(
      {
        integracaoId: INT,
        produtoIds: ['prod-inexistente', 'prod-sem-familia', 'prod-outra-conta', 'prod-kit'],
        baixarPreco: false,
      },
      CONTA,
      r.l,
    );
    expect(e.produtosSemEnvio.map((p) => [p.produtoId, p.motivo])).toEqual([
      ['prod-inexistente', MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado],
      ['prod-sem-familia', MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado],
      ['prod-outra-conta', MOTIVO_PRECO_SHOPEE.semLink],
    ]);
    expect(e.pulos).toEqual([
      {
        produtoId: 'prod-kit',
        produtoNome: 'Kit',
        anuncioId: String(ITEM + 7),
        linkDocId: 'link-prod-kit',
        modelos: 0,
        motivo: MOTIVO_PRECO_SHOPEE.kitDerivado,
        mensagem: mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.kitDerivado),
      },
    ]);
    expect(e.anuncios).toEqual([]);
    // Nada planejado ⇒ nenhum leitor montado, nenhuma chamada.
    expect(r.criarLeitorDeItens).not.toHaveBeenCalled();
    expect(e.solicitados).toBe(4);
    expect(e.familias).toBe(2);
  });
});

/* ========================================================================== */
/*  3 · PARIDADE com a execução real, e (M72) nenhum update_price no ensaio    */
/* ========================================================================== */

/**
 * The shared double plus `getAll(...refs, { fieldMask })`, extended HERE as
 * the manual run's suite extends it (never in `testing/fakeDb.ts`).
 */
class FakeDbComLote extends FakeDb {
  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    const campos = opcoes?.fieldMask ?? null;
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        const dados = snap.data();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => {
            if (!snap.exists || dados === undefined) return undefined;
            if (campos === null) return dados;
            const saida: DocData = {};
            for (const c of campos) if (Object.hasOwn(dados, c)) saida[c] = dados[c];
            return saida;
          },
        };
      }),
    );
  }
}

describe('⚠️ paridade: o ensaio e o envio REAL respondem as MESMAS linhas', () => {
  const precoBase = (item_id: number, anterior: number, has_model = false) =>
    shopeeItemBaseInfoRowSchema.parse({
      item_id,
      item_status: 'NORMAL',
      has_model,
      price_info: has_model
        ? []
        : [{ currency: 'BRL', original_price: anterior, current_price: anterior }],
    });

  function mundo() {
    const db = new FakeDbComLote();
    const produtos: Record<string, Record<string, unknown>> = {
      'prod-sobe': { nome: 'Sobe' },
      'prod-igual': { nome: 'Igual' },
      'prod-sem-preco': { nome: 'Sem preço' },
      'prod-sumiu': { nome: 'Sumiu na Shopee' },
      'prod-grade': { nome: 'Grade' },
      'prod-grade-a': { nome: 'Grade A', paiId: 'prod-grade' },
      'prod-grade-b': { nome: 'Grade B', paiId: 'prod-grade' },
      'prod-outra-conta': { nome: 'Outra conta' },
      'prod-kit': { nome: 'Kit' },
    };
    for (const [id, dados] of Object.entries(produtos)) db.seed(`produtos/${id}`, dados);
    const familias = [
      familiaSimples('prod-sobe', ITEM, 15),
      familiaSimples('prod-igual', ITEM + 1, 10),
      familiaSimples('prod-sem-preco', ITEM + 2, null),
      familiaSimples('prod-sumiu', ITEM + 3, 15),
      familiaComModelos('prod-grade', ITEM + 4, [
        ['prod-grade-a', MODELO_A, 12],
        ['prod-grade-b', MODELO_B, 8],
      ]),
      {
        anchorId: 'prod-outra-conta',
        precos: precos(15),
        links: [{ ...link(ITEM + 5, 'link-x'), contaProdutoShopeeOuterRef: 'integracoes/int-2' }],
        children: [],
      },
      familiaSimples('prod-kit', ITEM + 6, 15, { kitNativo: true }),
    ];
    // The SEND-time price read (C-d) reads the produto DOCUMENTS: give each one
    // the price its family carries, so the dry run and the real run read one store.
    for (const f of familias) {
      for (const [id, p] of precosDaFamilia(f)) {
        if (p !== null) db.seed(`produtos/${id}`, { ...produtos[id], precos: p });
      }
    }
    // The link documents the real sender writes back to.
    for (const f of familias) {
      for (const l of f.links) db.seed(`produtos/${f.anchorId}/prodshopee/${l.linkDocId}`, {});
      for (const c of f.children) {
        for (const v of c.varLinks)
          db.seed(`produtos/${c.produtoId}/variashopee/${v.varLinkDocId}`, {});
      }
    }
    const lerFamilias = (anchorIds: readonly string[]) =>
      Promise.resolve(
        new Map(
          familias
            .filter((f) => anchorIds.includes(f.anchorId))
            .map((f): [string, FamiliaDePreco] => [f.anchorId, f]),
        ),
      );

    const getItemBaseInfo = vi.fn(({ itemIds }: { itemIds: readonly number[] }) =>
      Promise.resolve(
        shopeeItemBaseInfoPayloadSchema.parse({
          // `prod-sumiu`'s listing is ABSENT from the batch.
          item_list: itemIds
            .filter((id) => id !== ITEM + 3)
            .map((id) => precoBase(id, 10, id === ITEM + 4)),
        }),
      ),
    );
    const getModelList = vi.fn(() =>
      Promise.resolve(
        shopeeModelListPayloadSchema.parse({
          model: [
            {
              model_id: MODELO_A,
              model_status: 'MODEL_NORMAL',
              price_info: [{ currency: 'BRL', original_price: 10, current_price: 10 }],
            },
            {
              model_id: MODELO_B,
              model_status: 'MODEL_NORMAL',
              price_info: [{ currency: 'BRL', original_price: 10, current_price: 10 }],
            },
          ],
        }),
      ),
    );
    // Echoes what it was asked to write — a no-model echo carries NO model_id (probe P4c).
    const updatePrice = vi.fn(
      (corpo: {
        item_id: number;
        price_list: readonly { model_id: number; original_price: number }[];
      }) =>
        Promise.resolve(
          shopeeUpdatePriceSchema.parse({
            request_id: 'req-1',
            error: '',
            message: null,
            warning: null,
            response: {
              success_list: corpo.price_list.map((p) =>
                p.model_id === 0
                  ? { original_price: p.original_price }
                  : { model_id: p.model_id, original_price: p.original_price },
              ),
              failure_list: [],
            },
          }),
        ),
    );
    const client = { getItemBaseInfo, getModelList, updatePrice } as unknown as ShopeeClient;
    const contexto = {
      integracaoId: INT,
      client,
      regiao: 'BR',
      moeda: 'BRL',
      multiplo: 4,
      tabelaNormalId: TABELA,
    } as ContextoContaPreco;
    return { db, lerFamilias, getItemBaseInfo, getModelList, updatePrice, contexto };
  }

  const PEDIDOS = [
    'prod-sobe',
    'prod-igual',
    'prod-sem-preco',
    'prod-sumiu',
    'prod-grade-a',
    'prod-inexistente',
    'prod-outra-conta',
    'prod-kit',
  ];

  const RESULTADO_POR_DECISAO = {
    enviaria: 'enviado',
    pularia: 'pulado',
    recusaria: 'falha',
  } as const;

  function linhasDoEnsaio(e: EnsaioDePreco): string[] {
    return [
      ...e.anuncios.flatMap((a) =>
        a.modelos.map(
          (m) =>
            `${a.produtoId}|${a.anuncioId}|${String(m.variacaoProdutoId)}|${RESULTADO_POR_DECISAO[m.decisao]}|${String(m.motivo)}`,
        ),
      ),
      ...e.pulos.map((p) => `${p.produtoId}|${String(p.anuncioId)}|null|pulado|${p.motivo}`),
    ].sort();
  }

  function linhasDoEnvio(r: EnvioPrecoResponse): string[] {
    return r.listings
      .map(
        (l) =>
          `${l.produtoId}|${String(l.anuncioId)}|${String(l.variacaoProdutoId)}|${l.outcome}|${String(l.motivo)}`,
      )
      .sort();
  }

  it('PAR: as MESMAS linhas por modelo, os MESMOS produtos sem envio — e o ensaio NUNCA chama update_price (M72)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const m = mundo();
    const args = { integracaoId: INT, produtoIds: PEDIDOS, baixarPreco: false };

    const ensaio = await ensaiarEnvioDePreco(args, m.contexto, {
      lerProdutos: async (ids, campos) => {
        const snaps = await m.db.getAll(
          ...ids.map((id) => produtoCollection.docRef(asDb(m.db), {}, id)),
          { fieldMask: [...campos] },
        );
        return new Map(
          snaps.filter((s) => s.exists).map((s): [string, DocData | undefined] => [s.id, s.data()]),
        );
      },
      lerFamilias: m.lerFamilias,
      criarLeitorDeItens: (itemIds) => {
        const lerBase = criarLeitorDeBaseEmLote(m.contexto.client, itemIds);
        return (itemId) => lerItemParaPreco(m.contexto.client, itemId, lerBase);
      },
    });

    // ⛔ M72: o ensaio leu (UMA base em lote + a lista de modelos) e NÃO escreveu.
    expect(m.updatePrice).not.toHaveBeenCalled();
    expect(m.getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(m.db.writes).toEqual([]);

    const resposta = await enviarPrecoManualShopee(asDb(m.db), args, {
      nowMs: AGORA,
      agora: () => 0,
      esperar: () => Promise.resolve(),
      contexto: m.contexto,
      contaNome: 'Loja teste',
      lerFamilias: (_db, a) => m.lerFamilias(a.anchorIds),
    });

    expect(linhasDoEnsaio(ensaio)).toEqual(linhasDoEnvio(resposta));
    expect(ensaio.produtosSemEnvio.map((p) => [p.produtoId, p.motivo])).toEqual(
      resposta.produtosSemEnvio.map((p) => [p.produtoId, p.motivo]),
    );
    expect(ensaio.solicitados).toBe(resposta.solicitados);
    expect(ensaio.familias).toBe(resposta.familias);
    // QUASE: o envio real SIM escreveu — os dois anúncios que o ensaio disse "enviaria".
    expect(m.updatePrice).toHaveBeenCalledTimes(2);
    expect(
      ensaio.anuncios
        .filter((a) => a.decisao === DECISAO_DO_ENSAIO.enviaria)
        .map((a) => a.anuncioId),
    ).toEqual([String(ITEM), String(ITEM + 4)]);
    // A âncora de uma grade e cada variação estão nas linhas; um cenário que
    // perdesse um caso não provaria nada.
    expect(linhasDoEnsaio(ensaio)).toEqual(
      [
        `prod-sobe|${ITEM}|null|enviado|null`,
        `prod-igual|${ITEM + 1}|null|pulado|${MOTIVO_PRECO_SHOPEE.precoIgual}`,
        `prod-sem-preco|${ITEM + 2}|null|pulado|${MOTIVO_PRECO_SHOPEE.precoNaoEncontrado}`,
        `prod-sumiu|${ITEM + 3}|null|falha|${MOTIVO_PRECO_SHOPEE.anuncioInexistente}`,
        `prod-grade|${ITEM + 4}|prod-grade-a|enviado|null`,
        `prod-grade|${ITEM + 4}|prod-grade-b|pulado|${MOTIVO_PRECO_SHOPEE.precoMenorBloqueado}`,
        `prod-kit|${ITEM + 6}|null|pulado|${MOTIVO_PRECO_SHOPEE.kitDerivado}`,
      ].sort(),
    );
  });
});

/* ========================================================================== */
/*  4 · os renderizadores, o JSON e as tabelas                                */
/* ========================================================================== */

/** O id que o passo 9 cunharia para o anúncio de fixture: um sha256, 64 hex. */
const ID_LONGO = createHash('sha256')
  .update(`shopee|${INT}|${String(ITEM)}`)
  .digest('hex');
/** O tamanho de um id automático do Firestore. */
const ID_CURTO = 'Ab3dE5fG7hJ9kL1mN2pQ';

/** As células de uma linha: a tabela as separa por 2+ brancos. */
const celulas = (linha: string): string[] => linha.trim().split(/\s{2,}/);
/** Os tokens separados por branco — um número colado a um id não é um token. */
const tokens = (linha: string): string[] => linha.trim().split(/\s+/);
/** Onde cada célula COMEÇA — a coluna que o olho do operador segue. */
const inicios = (linha: string): number[] =>
  [...linha.matchAll(/(?:^|\s{2,})(\S)/g)].map((m) => m.index + m[0].length - 1);
const linhaQueComeca = (linhas: readonly string[], prefixo: string): string =>
  linhas.find((l) => l.trimStart().startsWith(prefixo)) ?? '';

function ensaioCom(
  modelos: EnsaioDePreco['anuncios'][number]['modelos'],
  over: Partial<EnsaioDePreco> = {},
): EnsaioDePreco {
  return {
    integracaoId: INT,
    regiao: 'BR',
    moeda: 'BRL',
    multiplo: 4,
    baixarPreco: false,
    solicitados: 1,
    familias: 1,
    anuncios: [
      {
        produtoId: 'prod-ancora',
        produtoNome: 'Camiseta',
        anuncioId: String(ITEM),
        linkDocId: 'link-1',
        semModelos: false,
        decisao: DECISAO_DO_ENSAIO.enviaria,
        motivo: null,
        mensagem: null,
        modelosNoCorpo: 1,
        modelos,
      },
    ],
    pulos: [],
    produtosSemEnvio: [],
    totais: { enviaria: 1, pularia: 0, recusaria: 0 },
    ...over,
  };
}

function linhaEnviada(over: Partial<EnvioPrecoListing> = {}): EnvioPrecoListing {
  return {
    produtoId: 'prod-ancora',
    produtoNome: 'Camiseta',
    variacaoProdutoId: null,
    anuncioId: String(ITEM),
    linkDocId: 'link-1',
    outcome: 'enviado',
    motivo: null,
    mensagem: MENSAGEM_ENVIO_PRECO_LIMPO,
    preco: 15,
    precoAnterior: 10,
    variacoes: null,
    codigo: null,
    ...over,
  };
}

function envelope(listings: readonly EnvioPrecoListing[]): EnvioPrecoResponse {
  return {
    canal: 'shopee',
    integracaoId: INT,
    contaNome: 'Loja teste',
    solicitados: 1,
    familias: 1,
    resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
    listings,
    produtosSemEnvio: [
      {
        produtoId: 'prod-x',
        produtoNome: null,
        motivo: MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado,
        mensagem: mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado),
      },
    ],
    pausadoAte: null,
  };
}

describe('formatarPreco', () => {
  it('pt-BR, duas casas, SEM símbolo de moeda; null ⇒ —', () => {
    expect(formatarPreco(10)).toBe('10,00');
    expect(formatarPreco(1234.5)).toBe('1.234,50');
    expect(formatarPreco(0.01)).toBe('0,01');
    expect(formatarPreco(null)).toBe('—');
    expect(formatarPreco(10)).not.toMatch(/R\$|BRL/);
  });
});

describe('as tabelas impressas — cada coluna medida pelo que ela imprime', () => {
  it('PAR: no ENSAIO, uma variação de 64 caracteres deixa um vão antes de "anterior" e cada preço é o seu próprio token', () => {
    expect(ID_LONGO).toHaveLength(64);
    const linhas = renderizarEnsaio(
      ensaioCom([
        {
          modelId: MODELO_A,
          variacaoProdutoId: ID_LONGO,
          precoAnterior: 10,
          precoAlvo: 12.5,
          decisao: DECISAO_DO_ENSAIO.enviaria,
          motivo: null,
          mensagem: null,
        },
      ]),
    );
    const cabecalho = linhaQueComeca(linhas, 'model_id');
    const doModelo = linhaQueComeca(linhas, String(MODELO_A));
    expect(celulas(doModelo)).toEqual([
      String(MODELO_A),
      ID_LONGO,
      '10,00',
      '12,50',
      'enviaria',
      '—',
    ]);
    expect(tokens(doModelo)).toEqual(celulas(doModelo));
    expect(inicios(doModelo)).toEqual(inicios(cabecalho));
  });

  it('QUASE: no ENSAIO, um id de 20 caracteres e células "—" seguem alinhados sob o cabeçalho', () => {
    const linhas = renderizarEnsaio(
      ensaioCom([
        {
          modelId: MODELO_A,
          variacaoProdutoId: ID_CURTO,
          precoAnterior: null,
          precoAlvo: 15,
          decisao: DECISAO_DO_ENSAIO.pularia,
          motivo: MOTIVO_PRECO_SHOPEE.precoAtualIlegivel,
          mensagem: mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.precoAtualIlegivel),
        },
        {
          modelId: MODELO_B,
          variacaoProdutoId: ID_CURTO,
          precoAnterior: 10,
          precoAlvo: null,
          decisao: DECISAO_DO_ENSAIO.pularia,
          motivo: MOTIVO_PRECO_SHOPEE.precoNaoEncontrado,
          mensagem: mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.precoNaoEncontrado),
        },
      ]),
    );
    const cabecalho = linhaQueComeca(linhas, 'model_id');
    const semAnterior = linhaQueComeca(linhas, String(MODELO_A));
    const semAlvo = linhaQueComeca(linhas, String(MODELO_B));
    expect(celulas(semAnterior)).toEqual([
      String(MODELO_A),
      ID_CURTO,
      '—',
      '15,00',
      'pularia',
      MOTIVO_PRECO_SHOPEE.precoAtualIlegivel,
    ]);
    expect(celulas(semAlvo)).toEqual([
      String(MODELO_B),
      ID_CURTO,
      '10,00',
      '—',
      'pularia',
      MOTIVO_PRECO_SHOPEE.precoNaoEncontrado,
    ]);
    expect(inicios(semAnterior)).toEqual(inicios(cabecalho));
    expect(inicios(semAlvo)).toEqual(inicios(cabecalho));
  });

  it('PAR: no --live, um produto de 64 caracteres não encosta no NOME e as colunas seguem o cabeçalho', () => {
    const linhas = renderizarResultadoEnvioPreco(
      envelope([
        linhaEnviada({ produtoId: ID_LONGO, variacaoProdutoId: ID_CURTO }),
        linhaEnviada({
          produtoId: ID_LONGO,
          variacaoProdutoId: ID_LONGO,
          outcome: 'falha',
          motivo: MOTIVO_PRECO_SHOPEE.precoForaDaFaixa,
          mensagem: mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.precoForaDaFaixa),
          preco: null,
          codigo: 'product.error_price_out_of_range',
        }),
      ]),
    );
    const cabecalho = linhaQueComeca(linhas, 'produto ');
    const [enviada, recusada] = linhas.filter((l) => l.trimStart().startsWith(ID_LONGO));
    expect(celulas(enviada ?? '')).toEqual([
      ID_LONGO,
      'Camiseta',
      String(ITEM),
      ID_CURTO,
      'enviado',
      '10,00',
      '15,00',
      'limpo',
      MENSAGEM_ENVIO_PRECO_LIMPO,
    ]);
    expect(celulas(recusada ?? '').slice(4, 9)).toEqual([
      'falha',
      '10,00',
      '—',
      MOTIVO_PRECO_SHOPEE.precoForaDaFaixa,
      `[product.error_price_out_of_range] ${mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.precoForaDaFaixa)}`,
    ]);
    expect(inicios(enviada ?? '')).toEqual(inicios(cabecalho));
    expect(inicios(recusada ?? '')).toEqual(inicios(cabecalho));
  });

  it('⚠️ nenhuma linha dos dois relatórios termina em branco', () => {
    const todas = [
      ...renderizarEnsaio(
        ensaioCom([
          {
            modelId: 0,
            variacaoProdutoId: null,
            precoAnterior: 10,
            precoAlvo: 15,
            decisao: DECISAO_DO_ENSAIO.enviaria,
            motivo: null,
            mensagem: null,
          },
        ]),
      ),
      ...renderizarResultadoEnvioPreco(envelope([linhaEnviada()])),
    ];
    expect(todas.filter((l) => l !== l.trimEnd())).toEqual([]);
  });

  it('o cabeçalho do ensaio nomeia a moeda UMA vez e a razão da região', () => {
    const texto = renderizarEnsaio(ensaioCom([], { moeda: 'SGD', regiao: 'SG', multiplo: 5 })).join(
      '\n',
    );
    expect(texto).toContain('SGD (todos os preços abaixo nesta moeda)');
    expect(texto).toContain('5× entre variações');
    expect(texto).not.toContain('R$');
  });
});

describe('os resumos --json são ALLOW-LISTS, com ordem de chaves estável', () => {
  it('⛔ resumoDoEnsaio: uma chave extra no ensaio, no anúncio e no modelo NÃO sai; as chaves saem nesta ordem', () => {
    const modelo = {
      modelId: 0,
      variacaoProdutoId: null,
      precoAnterior: 10,
      precoAlvo: 15,
      decisao: DECISAO_DO_ENSAIO.enviaria,
      motivo: null,
      mensagem: null,
      corpoCru: 'nao-deve-sair',
    };
    const e = ensaioCom([modelo]);
    const sujo = {
      ...e,
      token: 'nao-deve-sair',
      anuncios: e.anuncios.map((a) => ({ ...a, item_name: 'nao-deve-sair' })),
    } as EnsaioDePreco;
    const resumo = resumoDoEnsaio(sujo);
    const texto = JSON.stringify(resumo);
    expect(texto).not.toContain('nao-deve-sair');
    expect(Object.keys(resumo)).toEqual([
      'integracaoId',
      'regiao',
      'moeda',
      'multiplo',
      'baixarPreco',
      'solicitados',
      'familias',
      'totais',
      'anuncios',
      'pulos',
      'produtosSemEnvio',
    ]);
    const anuncio = (resumo['anuncios'] as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(anuncio)).toEqual([
      'produtoId',
      'produtoNome',
      'anuncioId',
      'linkDocId',
      'semModelos',
      'decisao',
      'motivo',
      'mensagem',
      'modelosNoCorpo',
      'modelos',
    ]);
    // Estável: o mesmo ensaio dá o MESMO documento, byte a byte.
    expect(JSON.stringify(resumoDoEnsaio(e))).toBe(JSON.stringify(resumoDoEnsaio(e)));
  });

  it('⛔ resumoDoEnvioPreco: allow-list nos TRÊS níveis — envelope, linha e sem-envio', () => {
    const sujo = {
      ...envelope([{ ...linhaEnviada(), corpoCru: 'nao-deve-sair' } as EnvioPrecoListing]),
      segredo: 'nao-deve-sair',
    } as EnvioPrecoResponse;
    const resumo = resumoDoEnvioPreco(sujo);
    expect(JSON.stringify(resumo)).not.toContain('nao-deve-sair');
    expect(Object.keys(resumo)).toEqual([
      'canal',
      'integracaoId',
      'contaNome',
      'solicitados',
      'familias',
      'resumo',
      'listings',
      'produtosSemEnvio',
      'pausadoAte',
    ]);
    const linha = (resumo['listings'] as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(linha)).toEqual([
      'produtoId',
      'produtoNome',
      'variacaoProdutoId',
      'anuncioId',
      'linkDocId',
      'outcome',
      'motivo',
      'mensagem',
      'preco',
      'precoAnterior',
      'codigo',
    ]);
  });
});

/* ========================================================================== */
/*  5 · o script: o envio só no ramo live, e nenhum exitCode nos ramos        */
/* ========================================================================== */

describe('scripts/enviar-precos.ts', () => {
  const INICIO_DRY = FONTE_SCRIPT.indexOf('if (!live) {');
  const INICIO_LIVE = FONTE_SCRIPT.indexOf('/* ---------------------------------- live');
  const RAMO_DRY = FONTE_SCRIPT.slice(INICIO_DRY, INICIO_LIVE);
  const RAMO_LIVE = FONTE_SCRIPT.slice(INICIO_LIVE, FONTE_SCRIPT.indexOf('await main().catch('));

  it('⛔ (M72) só chama enviarPrecoManualShopee DEPOIS do ramo do dry-run, e uma vez só', () => {
    expect(INICIO_DRY).toBeGreaterThan(0);
    expect(INICIO_LIVE).toBeGreaterThan(INICIO_DRY);
    const chamada = FONTE_SCRIPT.indexOf('await enviarPrecoManualShopee(');
    expect(chamada).toBeGreaterThan(INICIO_LIVE);
    expect(FONTE_SCRIPT.match(/await enviarPrecoManualShopee\(/g)).toHaveLength(1);
  });

  it('⛔ (M72) o ramo do dry-run nomeia o ENSAIO e a LEITURA, e NENHUM remetente', () => {
    expect(RAMO_DRY).toContain('ensaiarEnvioDePreco(');
    expect(RAMO_DRY).toContain('lerItemParaPreco(');
    expect(RAMO_DRY).toContain('criarLeitorDeBaseEmLote(');
    expect(RAMO_DRY).not.toContain('enviarPrecoManual');
    expect(RAMO_DRY).not.toContain('enviarPrecoDoItem');
    expect(RAMO_DRY).not.toContain('updatePrice');
    expect(RAMO_DRY).not.toMatch(/precos\/enviarPreco'/);
  });

  it('⛔ (M72) o módulo do CLI importa o remetente e a execução manual SÓ como tipo', () => {
    const imports = [
      ...FONTE_CLI.matchAll(
        /import\s+(type\s+)?\{[^}]*\}\s+from\s+'\.\/(enviarPreco(?:Manual)?)'/g,
      ),
    ];
    expect(imports.map((m) => m[2])).toEqual(['enviarPrecoManual']);
    expect(imports.every((m) => m[1] !== undefined)).toBe(true);
    expect(FONTE_CLI).not.toMatch(/from '\.\/enviarPreco'/);
    expect(FONTE_CLI).not.toContain('updatePrice');
  });

  it('⚠️ o veredito da conta roda nos DOIS modos, antes do ramo do dry-run, e a recusa sai com 0', () => {
    const veredito = FONTE_SCRIPT.indexOf('await avaliarContaParaPreco(');
    expect(veredito).toBeGreaterThan(0);
    expect(veredito).toBeLessThan(INICIO_DRY);
    const recusa = FONTE_SCRIPT.slice(
      FONTE_SCRIPT.indexOf('if (!veredito.ok) {'),
      FONTE_SCRIPT.indexOf('const contexto = veredito.contexto;'),
    );
    expect(recusa).toContain('descreverRecusaDaConta(');
    expect(recusa).toContain('return;');
    expect(recusa).not.toContain('process.exitCode');
  });

  it('⚠️ nenhum ramo marca código de saída — só o catch de main(), uma vez', () => {
    expect(RAMO_DRY).not.toContain('process.exitCode');
    expect(RAMO_LIVE.length).toBeGreaterThan(0);
    expect(RAMO_LIVE).not.toContain('process.exitCode');
    expect(FONTE_SCRIPT.match(/process\.exitCode = 1/g)).toHaveLength(1);
    expect(FONTE_SCRIPT.indexOf('process.exitCode = 1')).toBeGreaterThan(
      FONTE_SCRIPT.indexOf('await main().catch('),
    );
  });

  it('UMA leitura do relógio lógico, entregue para baixo; o relógio decorrido é outro leitor', () => {
    expect(FONTE_SCRIPT.match(/const nowMs = Date\.now\(\);/g)).toHaveLength(1);
    expect(FONTE_SCRIPT.match(/Date\.now\(\)/g)).toHaveLength(2);
    expect(RAMO_LIVE).toContain('agora: () => Date.now()');
  });

  it('devolve na ajuda ANTES do primeiro await import', () => {
    const ajuda = FONTE_SCRIPT.indexOf("comando.kind === 'ajuda'");
    const primeiroImport = FONTE_SCRIPT.indexOf('await import(');
    expect(ajuda).toBeGreaterThan(0);
    expect(ajuda).toBeLessThan(primeiroImport);
  });

  it('o preâmbulo imprime o valor BRUTO do sandbox, o host resolvido e o override pelo predicado do veredito', () => {
    expect(FONTE_SCRIPT).toContain('process.env.SHOPEE_SANDBOX');
    expect(FONTE_SCRIPT).toContain('ctx.config.hosts.apiHost');
    expect(FONTE_SCRIPT).toContain('overrideDeSandboxAtivo(ctx.config)');
  });

  it('o texto de uso NÃO documenta o separador "--" e não carrega id real', () => {
    expect(USO_ENVIAR_PRECOS).not.toMatch(/pnpm .*[^ ] -- +-/);
    expect(USO_ENVIAR_PRECOS).toContain('enviar:precos');
    expect(USO_ENVIAR_PRECOS).toContain('É o PADRÃO');
    expect(USO_ENVIAR_PRECOS).toContain('--baixar-preco');
    expect(USO_ENVIAR_PRECOS).not.toMatch(/partner_key|shop_id|token|secret/i);
  });

  it('⛔ nenhum dos dois arquivos carrega uma sequência de 6+ dígitos', () => {
    expect(FONTE_CLI).not.toMatch(/[0-9]{6,}/);
    expect(FONTE_SCRIPT).not.toMatch(/[0-9]{6,}/);
    expect(USO_ENVIAR_PRECOS).toContain('int-1');
  });

  it('o package.json ganha EXATAMENTE um script, com a string exata', () => {
    const pacote = JSON.parse(PACOTE) as { scripts: Record<string, string> };
    expect(pacote.scripts['enviar:precos']).toBe(
      'dotenv -e ../../.env.local -- tsx scripts/enviar-precos.ts',
    );
    expect(
      Object.values(pacote.scripts).filter((v) => v.includes('scripts/enviar-precos.ts')),
    ).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  6 · o caminho do exit 1, e a recusa da conta (exit 0)                     */
/* ========================================================================== */

describe('descreverErroEnvioPreco', () => {
  it('um argumento inválido imprime a ajuda DESTE comando, não a de outro', () => {
    const texto = descreverErroEnvioPreco(new ArgumentoInvalidoError(MSG_PRODUTO_OBRIGATORIO)).join(
      '\n',
    );
    expect(texto).toContain(MSG_PRODUTO_OBRIGATORIO);
    expect(texto).toContain('enviar:precos');
    expect(texto).not.toContain('enviar:estoque');
  });

  it('a guarda sai por CLASSE + code, e o saco `extra` NÃO é impresso', () => {
    const linhas = descreverErroEnvioPreco(
      new ShopeeEnvioPrecoGuardError(
        CODIGO_GUARDA_PRECO.contaPausada,
        mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.contaPausada),
        { pausadoAte: 'nao-deve-sair' },
      ),
    );
    expect(linhas[0]).toBe(`❌ ShopeeEnvioPrecoGuardError (${CODIGO_GUARDA_PRECO.contaPausada})`);
    expect(linhas.join('\n')).not.toContain('nao-deve-sair');
  });

  it('⚠️ PAR/QUASE: ehRecusaAntesDoEnvioDePreco cobre as DUAS classes e nada mais', () => {
    expect(ehRecusaAntesDoEnvioDePreco(new ArgumentoInvalidoError('x'))).toBe(true);
    expect(
      ehRecusaAntesDoEnvioDePreco(
        new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaRecusada, 'recusada'),
      ),
    ).toBe(true);
    // QUASE: um erro da API pode vir DEPOIS de um update_price que caiu.
    expect(
      ehRecusaAntesDoEnvioDePreco(
        new ShopeeApiError('recusou', {
          code: 'error_param',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/update_price',
        }),
      ),
    ).toBe(false);
    expect(ehRecusaAntesDoEnvioDePreco(new TypeError('bug nosso'))).toBe(false);
    expect(ehRecusaAntesDoEnvioDePreco(null)).toBe(false);
  });

  it('um erro da Shopee sai por CLASSE + code/path, sem corpo nenhum', () => {
    const texto = descreverErroEnvioPreco(
      new ShopeeApiError('Shopee /api/v2/product/update_price respondeu error_param (HTTP 200)', {
        code: 'error_param',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/update_price',
        requestId: 'req-1',
      }),
    ).join('\n');
    expect(texto).toContain('code=error_param');
    expect(texto).toContain('path=/api/v2/product/update_price');
    expect(texto).not.toMatch(/token|partner_key|shop_id/i);
  });
});

describe('a recusa da conta — o código da ROTA, impresso', () => {
  it('PAR: região não suportada ⇒ 422 SHOPEE_PRECO_CONTA_RECUSADA, com a região', () => {
    const recusa = {
      ok: false as const,
      motivo: MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada,
      regiao: 'SG',
      erro: null,
    };
    expect(codigoDaRecusaDaConta(recusa)).toBe(CODIGO_GUARDA_PRECO.contaRecusada);
    const texto = descreverRecusaDaConta(recusa).join('\n');
    expect(texto).toContain(`422 ${CODIGO_GUARDA_PRECO.contaRecusada}`);
    expect(texto).toContain(mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada));
    expect(texto).toMatch(/região \.+ SG/);
    expect(resumoDaRecusaDaConta(recusa)).toEqual({
      code: CODIGO_GUARDA_PRECO.contaRecusada,
      status: 422,
      motivo: MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada,
      mensagem: mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada),
      regiao: 'SG',
    });
  });

  it('QUASE: sem tabela normal ⇒ o 400 SHOPEE_CONTA_SEM_TABELA_NORMAL da rota, e sem linha de região', () => {
    const recusa = {
      ok: false as const,
      motivo: MOTIVO_PRECO_SHOPEE.semTabelaNormal,
      regiao: null,
      erro: null,
    };
    expect(codigoDaRecusaDaConta(recusa)).toBe(CODIGO_GUARDA_PRECO.contaSemTabelaNormal);
    const texto = descreverRecusaDaConta(recusa).join('\n');
    expect(texto).toContain(`400 ${CODIGO_GUARDA_PRECO.contaSemTabelaNormal}`);
    expect(texto).not.toContain('região');
    expect(texto).toContain('Nada foi lido nem enviado');
  });
});

/** Compile-time: the reader shape `lerItemParaPreco` answers fits the rehearsal's. */
const _cabe: (r: Awaited<ReturnType<typeof lerItemParaPreco>>) => LeituraDoEnsaio = (r) => r;
void _cabe;
