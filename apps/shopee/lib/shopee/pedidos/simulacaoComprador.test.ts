/**
 * The `importar:pedido` CLI's TEST buyer mode (`--importar-cliente`), end to
 * end below the script: the pure simulation in `comprador.ts`, the importer's
 * read-only half carrying it (what the dry run prints), the importer's own
 * defence, the `--live` orchestration on `FakeDb`, and the grep that keeps the
 * option out of every production caller.
 *
 * ⚠️ The REAL-region pins (`comprador.test.ts`, `importarPedido.test.ts`) are
 * not touched by this mode and stay as they are: a normal import of the SG
 * order still captures nothing (`expirado regiao:nao-br`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { clienteIdentidadeId } from '@delfrance/data/admin/clientes';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, TIPO_CLIENTE, cpfCnpjUtilizavel } from '@delfrance/schemas';
import {
  SHOPEE_PROD_API_HOST,
  type ShopeeClient,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import {
  cpfComDvErrado,
  gerarCnpj,
  gerarCpf,
  pontuarCnpj,
  pontuarCpf,
} from '../testing/documentos';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  CPF_FALSO_DE_TESTE,
  FONTE_CPF_SIMULADO,
  SimulacaoCompradorRecusadaError,
  clienteDeShopee,
  exigirRegiaoForaDoBrasilParaSimulacao,
  exigirSandboxParaSimulacao,
  regiaoEstrangeiraParaSimulacao,
  simularCompradorShopee,
  type SimulacaoCompradorShopee,
} from './comprador';
import { importarPedidoComCompradorDeTeste } from './importarCompradorTeste';
import {
  gravarPreparoPedidoShopee,
  importarPedidoShopee,
  mapearPreparoPedidoShopee,
  prepararImportacaoPedidoShopee,
  type PreparoPedidoShopee,
} from './importarPedido';
import {
  descreverErro,
  parseArgsImportarPedido,
  renderCompradorGravado,
  renderCompradorSimulado,
  renderResumoPedido,
  resumoDoCompradorGravado,
  resumoDoCompradorSimulado,
  resumoDoPedidoArmazenado,
  resumoDoPedidoMapeado,
  valoresEnviadosPelaShopee,
  type ProjetoDoModoComprador,
} from './importarPedidoCli';
import { makePedidoIdShopee } from './orderIds';

const INT = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const ORDER_SN_B = '260910KJBHUJDN';
const NOW_MS = 1_789_000_000_000;
const INTEGRACAO_PATH = integracaoCollection.resolvePath({});

/* ------------------------- the literals that must not leak ------------------------- */

const NOME_TESTE = 'Pessoa Ficticia Sandbox';
const CEP_TESTE = '93847261';
/** The SG sandbox's postal code is SIX digits; the committed fixture's is the redactor's `00000000`. */
const ZIP_SG = '739281';
const ENDERECO_SG = 'Avenida Inventada 777, Bloco Z';
/**
 * A second check-digit-valid fake (the one `pagamentoMapping.test.ts` spells),
 * built at RUN time from its base like every other document here.
 */
const CPF_DA_SHOPEE = gerarCpf('529982247');

/** The SG order as the sandbox sends it: masked name, clear street, 6-digit zip. */
function detalheSG(patch: Record<string, unknown> = {}): ShopeeOrderDetailRow {
  const base = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
  return {
    ...base,
    recipient_address: { ...base.recipient_address!, zipcode: ZIP_SG, full_address: ENDERECO_SG },
    ...patch,
  } as ShopeeOrderDetailRow;
}

function simulacao(over: Partial<SimulacaoCompradorShopee> = {}): SimulacaoCompradorShopee {
  return { nomeTeste: null, cepTeste: null, cpfTeste: null, importarEndereco: false, ...over };
}

/** `--cpf-teste`, built at RUN time from a 9-digit base — never a committed DV-valid literal. */
const CPF_TESTE = gerarCpf('418209375');
/** A second one, for "another free --cpf-teste". */
const CPF_TESTE_B = gerarCpf('730164829');

const COMPLETA = simulacao({ nomeTeste: NOME_TESTE, cepTeste: CEP_TESTE, importarEndereco: true });

/* ---------------------------------- harness ---------------------------------- */

interface Cenario {
  readonly db: FakeDb;
  readonly getOrderDetail: ReturnType<typeof vi.fn>;
  readonly buscarCep: ReturnType<typeof vi.fn>;
  readonly deps: { clientFor: () => Promise<ShopeeClient>; viaCep: never };
}

function cenario(detalhe: ShopeeOrderDetailRow = detalheSG()): Cenario {
  const db = new FakeDb();
  db.seed(`${INTEGRACAO_PATH}/${INT}`, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: SHOP,
  } satisfies DocData);
  // The row answers for whichever order_sn was asked, so two orders share one body.
  const getOrderDetail = vi.fn(
    async (args: { orderSnList: string[] }): Promise<ShopeeOrderDetail> => ({
      order_list: [{ ...detalhe, order_sn: args.orderSnList[0]! }],
    }),
  );
  const getEscrowDetail = vi.fn(
    async (): Promise<ShopeeEscrowDetail> =>
      ({
        order_sn: ORDER_SN,
        buyer_user_name: null,
        return_order_sn_list: null,
        order_income: null,
        buyer_payment_info: null,
      }) as unknown as ShopeeEscrowDetail,
  );
  const client = { getOrderDetail, getEscrowDetail } as unknown as ShopeeClient;
  const buscarCep = vi.fn(async () => null);
  return {
    db,
    getOrderDetail,
    buscarCep,
    deps: { clientFor: async () => client, viaCep: { buscarCep } as never },
  };
}

function alvo(orderSn = ORDER_SN) {
  return { integracaoId: INT, shopId: SHOP, orderSn, nowMs: NOW_MS };
}

async function preparar(c: Cenario, sim: SimulacaoCompradorShopee): Promise<PreparoPedidoShopee> {
  const p = await prepararImportacaoPedidoShopee(asDb(c.db), alvo(), {
    ...c.deps,
    simulacaoComprador: sim,
  });
  if (p.kind !== 'preparo') throw new Error(`esperava um preparo, veio ${p.kind}`);
  return p.preparo;
}

function resumoDe(p: PreparoPedidoShopee) {
  return resumoDoCompradorSimulado(p.simulacao!, p.captura, p.armazenado);
}

/** The importer's info log, silenced — `logDoImport` reads its calls. */
let infoSpy: MockInstance<typeof console.info>;

beforeEach(() => {
  __resetAllReadCaches();
  // `overrideDeSandboxAtivo`: the flag AND the resolved sandbox host.
  vi.stubEnv('SHOPEE_SANDBOX', '1');
  vi.stubEnv('SHOPEE_API_HOST', '');
  vi.stubEnv('SHOPEE_AUTH_HOST', '');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  __resetAllReadCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                       the pure simulation and its guards                    */
/* -------------------------------------------------------------------------- */

describe('simularCompradorShopee — reescreve SÓ o que o adaptador do comprador lê', () => {
  it('região BR, o CPF de teste quando a Shopee não manda um, e o resto intocado', () => {
    const real = detalheSG();
    const { linha, cpfDeTesteAplicado } = simularCompradorShopee(real, simulacao());
    expect(linha.region).toBe('BR');
    expect(linha.buyer_cpf_id).toBe(CPF_FALSO_DE_TESTE);
    expect(cpfDeTesteAplicado).toBe(true);
    // Sem substitutos, o bloco é o da Shopee, campo a campo.
    expect(linha.recipient_address).toEqual(real.recipient_address);
    expect(linha.order_status).toBe(real.order_status);
    expect(linha.item_list).toBe(real.item_list);
    // ⚠️ A linha REAL não foi mutada.
    expect(real.region).toBe('SG');
    expect(real.buyer_cpf_id).toBeNull();
  });

  it('--nome-teste e --cep-teste trocam SÓ name e zipcode', () => {
    const real = detalheSG();
    const { linha } = simularCompradorShopee(
      real,
      simulacao({ nomeTeste: NOME_TESTE, cepTeste: CEP_TESTE }),
    );
    expect(linha.recipient_address).toEqual({
      ...real.recipient_address,
      name: NOME_TESTE,
      zipcode: CEP_TESTE,
    });
  });

  it('o CPF UTILIZÁVEL da Shopee vence o de teste; um mascarado não', () => {
    const comCpf = simularCompradorShopee(detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE }), simulacao());
    expect(comCpf.linha.buyer_cpf_id).toBe(CPF_DA_SHOPEE);
    expect(comCpf.cpfDeTesteAplicado).toBe(false);
    // QUASE-ERRO: um CPF mascarado tem onze caracteres e não é utilizável.
    const mascarado = simularCompradorShopee(
      detalheSG({ buyer_cpf_id: '***********' }),
      simulacao(),
    );
    expect(mascarado.linha.buyer_cpf_id).toBe(CPF_FALSO_DE_TESTE);
    expect(mascarado.cpfDeTesteAplicado).toBe(true);
  });

  it('um recipient_address nulo continua nulo — nenhum endereço parcial em volta do nome', () => {
    const { linha } = simularCompradorShopee(
      detalheSG({ recipient_address: null }),
      simulacao({ nomeTeste: NOME_TESTE, cepTeste: CEP_TESTE }),
    );
    expect(linha.recipient_address).toBeNull();
  });
});

describe('--cpf-teste na simulação — a precedência é Shopee > --cpf-teste > o CPF falso', () => {
  it('sem CPF da Shopee, o --cpf-teste entra NO LUGAR do falso — e a fonte diz qual', () => {
    const r = simularCompradorShopee(detalheSG(), simulacao({ cpfTeste: CPF_TESTE }));
    expect(r.linha.buyer_cpf_id).toBe(CPF_TESTE);
    expect(r.fonteDoCpf).toBe(FONTE_CPF_SIMULADO.cpfTeste);
    expect(r.cpfDeTesteAplicado).toBe(true);
    // QUASE-ERRO: without the flag the repo's fake is still the answer.
    const semFlag = simularCompradorShopee(detalheSG(), simulacao());
    expect(semFlag.linha.buyer_cpf_id).toBe(CPF_FALSO_DE_TESTE);
    expect(semFlag.fonteDoCpf).toBe(FONTE_CPF_SIMULADO.cpfFalso);
    expect(semFlag.cpfDeTesteAplicado).toBe(true);
  });

  it('⚠️ o CPF UTILIZÁVEL da Shopee vence o --cpf-teste — o dado real ganha, como hoje', () => {
    const r = simularCompradorShopee(
      detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE }),
      simulacao({ cpfTeste: CPF_TESTE }),
    );
    expect(r.linha.buyer_cpf_id).toBe(CPF_DA_SHOPEE);
    expect(r.fonteDoCpf).toBe(FONTE_CPF_SIMULADO.shopee);
    expect(r.cpfDeTesteAplicado).toBe(false);
    // QUASE-ERRO: a MASKED Shopee CPF is not usable, so --cpf-teste wins over it.
    const mascarado = simularCompradorShopee(
      detalheSG({ buyer_cpf_id: '***********' }),
      simulacao({ cpfTeste: CPF_TESTE }),
    );
    expect(mascarado.linha.buyer_cpf_id).toBe(CPF_TESTE);
    expect(mascarado.fonteDoCpf).toBe(FONTE_CPF_SIMULADO.cpfTeste);
  });

  it('o --cpf-teste não mexe em mais nada: um recipient_address nulo continua nulo', () => {
    const r = simularCompradorShopee(
      detalheSG({ recipient_address: null }),
      simulacao({ cpfTeste: CPF_TESTE, nomeTeste: NOME_TESTE }),
    );
    expect(r.linha.recipient_address).toBeNull();
    expect(r.linha.buyer_cpf_id).toBe(CPF_TESTE);
    expect(r).toMatchObject({ nomeTesteAplicado: false, cepTesteAplicado: false });
    // …and with a block, the block is Shopee's, field by field.
    const real = detalheSG();
    expect(
      simularCompradorShopee(real, simulacao({ cpfTeste: CPF_TESTE })).linha.recipient_address,
    ).toEqual(real.recipient_address);
  });

  it('um valor PONTUADO que chegue por outro caminho vira a forma canônica', () => {
    const r = simularCompradorShopee(detalheSG(), simulacao({ cpfTeste: pontuarCpf(CPF_TESTE) }));
    expect(r.linha.buyer_cpf_id).toBe(CPF_TESTE);
  });

  it('⚠️ um --cpf-teste inválido RECUSA — nunca cai em silêncio para o CPF falso', () => {
    for (const ruim of [cpfComDvErrado(CPF_TESTE), '1'.repeat(11), CPF_TESTE.slice(0, 10), '']) {
      let mensagem = '';
      try {
        simularCompradorShopee(detalheSG(), simulacao({ cpfTeste: ruim }));
      } catch (err) {
        if (!(err instanceof SimulacaoCompradorRecusadaError)) throw err;
        mensagem = err.message;
      }
      expect(mensagem).toContain('--cpf-teste não é um CPF utilizável');
      if (ruim !== '') expect(mensagem).not.toContain(ruim);
    }
    // Even when Shopee's usable document would win: a bad input is refused, not ignored.
    expect(() =>
      simularCompradorShopee(
        detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE }),
        simulacao({ cpfTeste: cpfComDvErrado(CPF_TESTE) }),
      ),
    ).toThrow(SimulacaoCompradorRecusadaError);
  });

  it('⚠️ um CNPJ VÁLIDO como cpfTeste também RECUSA aqui — a defesa não depende do parser', () => {
    const cnpj = gerarCnpj('434567890001');
    // The anchor: the capture predicate WOULD take it — the PF narrowing is what refuses.
    expect(cpfCnpjUtilizavel(cnpj)).toBe(cnpj);
    for (const grafia of [cnpj, pontuarCnpj(cnpj)]) {
      expect(() => simularCompradorShopee(detalheSG(), simulacao({ cpfTeste: grafia }))).toThrow(
        new SimulacaoCompradorRecusadaError(
          '--cpf-teste não é um CPF utilizável (11 dígitos, dígitos verificadores válidos). ' +
            'Nada foi gravado.',
        ),
      );
    }
    // QUASE-ERRO: a valid CPF in the same position is accepted.
    expect(simularCompradorShopee(detalheSG(), simulacao({ cpfTeste: CPF_TESTE })).fonteDoCpf).toBe(
      FONTE_CPF_SIMULADO.cpfTeste,
    );
  });
});

describe('as duas guardas do modo de teste', () => {
  it('sem o override de sandbox, recusa', () => {
    expect(() => exigirSandboxParaSimulacao(false)).toThrow(SimulacaoCompradorRecusadaError);
    expect(() => exigirSandboxParaSimulacao(true)).not.toThrow();
  });

  it('uma região BR — ou ausente — recusa; uma estrangeira passa', () => {
    expect(() => exigirRegiaoForaDoBrasilParaSimulacao('BR')).toThrow(
      SimulacaoCompradorRecusadaError,
    );
    expect(() => exigirRegiaoForaDoBrasilParaSimulacao(null)).toThrow(
      SimulacaoCompradorRecusadaError,
    );
    expect(() => exigirRegiaoForaDoBrasilParaSimulacao('SG')).not.toThrow();
  });

  it('⚠️ mais estrita que pedidoForaDoBrasil: vazio, espaços e caixa baixa NÃO são estrangeiros', () => {
    for (const regiao of ['', '  ', 'br', 'Br', ' SG', 'SG ', 'sg', 'SGP', 'S']) {
      expect(regiaoEstrangeiraParaSimulacao(regiao)).toBe(false);
      expect(() => exigirRegiaoForaDoBrasilParaSimulacao(regiao)).toThrow(
        SimulacaoCompradorRecusadaError,
      );
    }
    // QUASE-ERRO: duas maiúsculas que não são BR passam — e a mensagem mostra o valor cru.
    for (const regiao of ['SG', 'MY', 'TW'])
      expect(regiaoEstrangeiraParaSimulacao(regiao)).toBe(true);
    expect(() => exigirRegiaoForaDoBrasilParaSimulacao('')).toThrow('região ""');
  });
});

/* -------------------------------------------------------------------------- */
/*            the read-only half with the simulation (what the dry run sees)   */
/* -------------------------------------------------------------------------- */

describe('o dry-run sobre a order SG — a metade só-leitura com a simulação', () => {
  it('sem substitutos: nome:mascarado, CEP de 6 dígitos, NADA construído e NADA gravado', async () => {
    const c = cenario();
    const p = await preparar(c, simulacao());

    expect(p.simulacao!.capturaReal).toEqual({
      estado: 'expirado',
      camposRecusados: ['regiao:nao-br'],
    });
    expect(p.captura).toEqual({ estado: 'pendente', camposRecusados: ['nome:mascarado'] });
    expect(p.simulacao!.cpfDeTesteAplicado).toBe(true);
    expect(p.simulacao!.endereco).toBeNull();
    // The REAL row is the one everything else reads.
    expect(p.linha.region).toBe('SG');
    expect(p.simulacao!.detalheComprador.region).toBe('BR');

    const r = resumoDe(p);
    expect(r.endereco).toMatchObject({
      resultado: 'nao-construido',
      recusados: ['nome:mascarado'],
      digitosDoCep: 6,
      cepValido: false,
    });
    const texto = renderCompradorSimulado(r).join('\n');
    expect(texto).toContain('veredito real ........... expirado regiao:nao-br');
    expect(texto).toContain('veredito simulado ....... pendente nome:mascarado');
    expect(texto).toContain('sem-cep — CEP precisa de 8 dígitos; veio com 6');
    expect(texto).toContain('não construído (nome:mascarado)');
    // The read-only half writes nothing at all.
    expect(c.db.writes).toEqual([]);
  });

  it('--nome-teste: o veredito vira capturado e o cliente sai PF com o CPF de teste', async () => {
    const p = await preparar(cenario(), simulacao({ nomeTeste: NOME_TESTE }));
    expect(p.captura).toEqual({ estado: 'capturado', camposRecusados: [] });
    expect(clienteDeShopee(p.simulacao!.detalheComprador)).toMatchObject({
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: NOME_TESTE,
      cpf_cnpj: CPF_FALSO_DE_TESTE,
      telefone: null,
    });
    // The 6-digit zip still refuses the endereço — at the BUILDER now.
    expect(p.simulacao!.endereco).toMatchObject({ kind: 'sem-cep' });
    expect(resumoDe(p).endereco.resultado).toBe('sem-cep');
  });

  it('--nome-teste + --cep-teste: ok, UF AC por ausência, país SG, com os fallbacks', async () => {
    const p = await preparar(cenario(), COMPLETA);
    const saida = p.simulacao!.endereco;
    expect(saida?.kind).toBe('ok');
    if (saida?.kind !== 'ok') return;
    expect(saida.fields.estado).toBe('AC');
    expect(saida.fields.pais).toBe('SG');
    expect(resumoDe(p).endereco).toEqual({
      resultado: 'ok',
      recusados: [],
      digitosDoCep: 8,
      cepValido: true,
      uf: 'AC',
      ufPadraoPorAusencia: true,
      pais: 'SG',
      fallbacks: ['numero=S/N', 'bairro=SEM BAIRRO', 'cidade=NAO INFORMADA'],
    });
    const texto = renderCompradorSimulado(resumoDe(p)).join('\n');
    expect(texto).toContain('UF .................... AC   (padrão AC: a Shopee não mandou estado)');
    expect(texto).toContain('país .................. SG');
  });

  it('cada portão que recusa se nomeia — o mesmo veredito que o importador usaria', async () => {
    const real = detalheSG().recipient_address!;
    const com = (patch: Record<string, unknown>) =>
      cenario(detalheSG({ recipient_address: { ...real, ...patch } }));
    const sim = simulacao({ nomeTeste: NOME_TESTE, importarEndereco: true });
    for (const [patch, esperado] of [
      [{ zipcode: '' }, ['cep:ausente']],
      [{ full_address: '****' }, ['logradouro:mascarado']],
      [{ zipcode: '  ', full_address: null }, ['logradouro:ausente', 'cep:ausente']],
    ] as const) {
      const p = await preparar(com(patch), sim);
      expect(p.simulacao!.endereco).toBeNull();
      expect(p.simulacao!.portoesEndereco).toEqual({ recusados: esperado, entrada: null });
      expect(resumoDe(p).endereco).toMatchObject({
        resultado: 'nao-construido',
        recusados: esperado,
      });
      expect(renderCompradorSimulado(resumoDe(p)).join('\n')).toContain(
        `não construído (${esperado.join(', ')})`,
      );
    }
    // QUASE-ERRO: every gate passing names nothing — the builder ran.
    const ok = await preparar(com({ zipcode: CEP_TESTE }), sim);
    expect(ok.simulacao!.portoesEndereco?.recusados).toEqual([]);
    expect(ok.simulacao!.endereco?.kind).toBe('ok');
  });

  it('QUASE-ERRO: um state que resolve vira a UF dele — não o AC por ausência', async () => {
    const real = detalheSG();
    const c = cenario(
      detalheSG({ recipient_address: { ...real.recipient_address!, state: 'SP' } }),
    );
    const r = resumoDe(await preparar(c, COMPLETA));
    expect(r.endereco).toMatchObject({ resultado: 'ok', uf: 'SP', ufPadraoPorAusencia: false });
    const texto = renderCompradorSimulado(r).join('\n');
    expect(texto).toContain('UF .................... SP');
    expect(texto).not.toContain('padrão AC');
  });

  it('state XX: uf-desconhecida, e o dry-run NÃO chama o ViaCEP', async () => {
    const real = detalheSG();
    const c = cenario(
      detalheSG({ recipient_address: { ...real.recipient_address!, state: 'XX' } }),
    );
    const p = await preparar(c, COMPLETA);
    expect(p.simulacao!.endereco?.kind).toBe('uf-desconhecida');
    expect(c.buscarCep).not.toHaveBeenCalled();
    expect(resumoDe(p).endereco).toMatchObject({ uf: 'AC', ufPadraoPorAusencia: false });
    expect(renderCompradorSimulado(resumoDe(p)).join('\n')).toContain(
      'seria recuperada pelo ViaCEP em --live',
    );
  });

  it('recipient_address nulo: continua nulo, nome:ausente, endereço não construído', async () => {
    const p = await preparar(cenario(detalheSG({ recipient_address: null })), COMPLETA);
    expect(p.simulacao!.detalheComprador.recipient_address).toBeNull();
    expect(p.captura).toEqual({ estado: 'pendente', camposRecusados: ['nome:ausente'] });
    expect(resumoDe(p).endereco).toMatchObject({
      resultado: 'nao-construido',
      recusados: ['endereco:ausente'],
      digitosDoCep: null,
    });
  });

  it('⚠️ em TODO cenário a região REAL decide bloquearEmissaoNFe e o país', async () => {
    for (const sim of [
      simulacao(),
      simulacao({ nomeTeste: NOME_TESTE }),
      COMPLETA,
      simulacao({ importarEndereco: true }),
    ]) {
      const p = await preparar(cenario(), sim);
      const mapeado = mapearPreparoPedidoShopee(p, {
        clienteOuterRef: null,
        enderecoOuterRef: null,
        camposRecusadosExtra: [],
      });
      expect(mapeado.criacao.bloquearEmissaoNFe).toBe(true);
      const saida = p.simulacao!.endereco;
      if (saida !== null && saida.kind !== 'sem-cep') expect(saida.fields.pais).toBe('SG');
    }
  });

  it('as flags do resumo dizem o que foi APLICADO — e o render as escreve', async () => {
    const semNada = resumoDe(await preparar(cenario(), simulacao()));
    expect(semNada).toMatchObject({
      cpfDeTesteAplicado: true,
      nomeTesteAplicado: false,
      cepTesteAplicado: false,
      importarEndereco: false,
    });
    const textoSemNada = renderCompradorSimulado(semNada).join('\n');
    expect(textoSemNada).toContain('CPF de teste aplicado ... sim');
    expect(textoSemNada).toContain('nome de teste ........... não — vale o que a Shopee mandou');
    expect(textoSemNada).toContain('CEP de teste ............ não — vale o que a Shopee mandou');
    expect(textoSemNada).toContain('gravar endereço ......... não — passe --importar-endereco');

    const tudo = resumoDe(await preparar(cenario(), COMPLETA));
    expect(tudo).toMatchObject({
      cpfDeTesteAplicado: true,
      nomeTesteAplicado: true,
      cepTesteAplicado: true,
      importarEndereco: true,
    });
    const textoTudo = renderCompradorSimulado(tudo).join('\n');
    expect(textoTudo).toContain('nome de teste ........... aplicado');
    expect(textoTudo).toContain('CEP de teste ............ aplicado');
    expect(textoTudo).toContain('gravar endereço ......... sim');

    // QUASE-ERRO: o CPF da Shopee utilizável ⇒ o de teste NÃO foi aplicado.
    const comCpf = resumoDe(
      await preparar(cenario(detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE })), simulacao()),
    );
    expect(comCpf.cpfDeTesteAplicado).toBe(false);
    expect(renderCompradorSimulado(comCpf).join('\n')).toContain('CPF de teste aplicado ... não');

    // QUASE-ERRO: sem bloco de endereço, um substituto pedido NÃO foi aplicado em nada.
    const semBloco = resumoDe(
      await preparar(cenario(detalheSG({ recipient_address: null })), COMPLETA),
    );
    expect(semBloco).toMatchObject({ nomeTesteAplicado: false, cepTesteAplicado: false });
  });

  it('um pedido que já existe com a captura TERMINAL é avisado no dry-run', async () => {
    const c = cenario();
    // A normal import first: the SG order stores `expirado regiao:nao-br`.
    await importarPedidoShopee(asDb(c.db), alvo(), c.deps);
    const p = await preparar(c, COMPLETA);
    const r = resumoDe(p);
    expect(r.capturaTerminalArmazenada).toBe('expirado');
    // QUASE-ERRO: the normal import linked nobody, so there is no link warning.
    expect(r.clienteVinculadoId).toBeNull();
    expect(renderCompradorSimulado(r).join('\n')).not.toContain('o pedido já vincula');
    expect(renderCompradorSimulado(r).join('\n')).toContain(
      'o pedido já existe e a captura do comprador já terminou (expirado)',
    );
  });
});

describe('o que sai no STDOUT e no --json — nunca CPF, nome, rua nem os dígitos do CEP', () => {
  it('o relatório inteiro do dry-run (pedido + comprador) não carrega nenhum literal', async () => {
    for (const sim of [simulacao(), COMPLETA]) {
      const p = await preparar(cenario(), sim);
      const r = resumoDe(p);
      const resumoPedido = resumoDoPedidoMapeado(
        p.pedidoId,
        mapearPreparoPedidoShopee(p, {
          clienteOuterRef: null,
          enderecoOuterRef: null,
          camposRecusadosExtra: [],
        }),
      );
      const stdout = [
        ...renderResumoPedido(resumoPedido),
        ...renderCompradorSimulado(r),
        JSON.stringify({ resumo: resumoPedido, comprador: r }),
      ].join('\n');
      for (const literal of [CPF_FALSO_DE_TESTE, NOME_TESTE, ENDERECO_SG, CEP_TESTE, ZIP_SG]) {
        expect(stdout).not.toContain(literal);
      }
      // QUASE-ERRO: a CONTAGEM de dígitos sai — é o diagnóstico, e não identifica ninguém.
      expect(stdout).toMatch(/veio com 6|8 dígitos/);
    }
  });

  it('a âncora: os VALORES saem no stderr — e só no modo comprador, no sandbox, fora do BR', async () => {
    // A FULL-substitution preparo: the function must pick the REAL row itself.
    const p = await preparar(cenario(), COMPLETA);
    expect(p.simulacao!.detalheComprador.recipient_address!.name).toBe(NOME_TESTE);
    const base = { overrideSandboxAtivo: true, preparo: p };
    const linhas = valoresEnviadosPelaShopee(base);
    const stderr = linhas.join('\n');
    // What Shopee SENT — the real row, never the substitutes.
    expect(stderr).toContain(JSON.stringify(ENDERECO_SG));
    expect(stderr).toContain(JSON.stringify(ZIP_SG));
    expect(stderr).toContain('"****"');
    expect(stderr).not.toContain(NOME_TESTE);
    expect(stderr).not.toContain(CEP_TESTE);
    // Every one of the eight fields gets its own labelled line.
    for (const campo of [
      'name',
      'phone',
      'full_address',
      'zipcode',
      'state',
      'city',
      'district',
      'town',
    ]) {
      expect(stderr).toMatch(new RegExp(`^ {2}${campo}\\.* `, 'm'));
    }
    expect(linhas).toHaveLength(9);

    expect(valoresEnviadosPelaShopee({ ...base, overrideSandboxAtivo: false })).toEqual([]);
    const comRegiao = (region: string | null) => ({ ...p, linha: { ...p.linha, region } });
    for (const region of ['BR', null, '', 'br']) {
      expect(valoresEnviadosPelaShopee({ ...base, preparo: comRegiao(region) })).toEqual([]);
    }
    // A real import's preparo carries no `simulacao`: nothing is printed.
    const real = await prepararImportacaoPedidoShopee(asDb(cenario().db), alvo(), cenario().deps);
    if (real.kind !== 'preparo') throw new Error('esperava um preparo');
    expect(real.preparo.simulacao).toBeNull();
    expect(valoresEnviadosPelaShopee({ ...base, preparo: real.preparo })).toEqual([]);
  });

  it('QUASE-ERRO: um recipient_address nulo sai como UMA linha, sem campos', async () => {
    const p = await preparar(cenario(detalheSG({ recipient_address: null })), COMPLETA);
    const linhas = valoresEnviadosPelaShopee({ overrideSandboxAtivo: true, preparo: p });
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toBe('  (recipient_address: null)');
  });
});

/** Every spelling of a document an output must never carry. */
function grafiasDe(cpf: string): string[] {
  return [cpf, pontuarCpf(cpf)];
}

describe('--cpf-teste no dry-run — a FONTE sai, os dígitos nunca', () => {
  it('a linha «CPF de teste aplicado» diz de onde veio: --cpf-teste, o falso do repo, ou a Shopee', async () => {
    for (const [detalhe, sim, linha, fonte] of [
      [
        detalheSG(),
        simulacao({ cpfTeste: CPF_TESTE }),
        'CPF de teste aplicado ... sim (informado em --cpf-teste)',
        FONTE_CPF_SIMULADO.cpfTeste,
      ],
      [
        detalheSG(),
        simulacao(),
        'CPF de teste aplicado ... sim (o CPF falso do repo)',
        FONTE_CPF_SIMULADO.cpfFalso,
      ],
      [
        detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE }),
        simulacao({ cpfTeste: CPF_TESTE }),
        'CPF de teste aplicado ... não — vale o da Shopee',
        FONTE_CPF_SIMULADO.shopee,
      ],
    ] as const) {
      const p = await preparar(cenario(detalhe), sim);
      expect(p.simulacao!.fonteDoCpf).toBe(fonte);
      const r = resumoDe(p);
      expect(r.fonteDoCpf).toBe(fonte);
      expect(r.cpfDeTesteAplicado).toBe(fonte !== FONTE_CPF_SIMULADO.shopee);
      expect(renderCompradorSimulado(r).join('\n')).toContain(linha);
    }
  });

  it('com --cpf-teste e --nome-teste o veredito simulado é capturado SOB o --cpf-teste', async () => {
    const p = await preparar(cenario(), simulacao({ cpfTeste: CPF_TESTE, nomeTeste: NOME_TESTE }));
    expect(p.captura).toEqual({ estado: 'capturado', camposRecusados: [] });
    expect(clienteDeShopee(p.simulacao!.detalheComprador)).toMatchObject({
      tipo: TIPO_CLIENTE.pessoaFisica,
      cpf_cnpj: CPF_TESTE,
    });
    // The REAL row is untouched — the substitute lives only on the buyer row.
    expect(p.linha.buyer_cpf_id).toBeNull();
  });

  it('⚠️ nem o stdout, nem o --json, nem o bloco de VALORES do stderr carregam os dígitos', async () => {
    for (const sim of [
      simulacao({ cpfTeste: CPF_TESTE }),
      simulacao({ ...COMPLETA, cpfTeste: CPF_TESTE }),
    ]) {
      const p = await preparar(cenario(), sim);
      const r = resumoDe(p);
      const resumoPedido = resumoDoPedidoMapeado(
        p.pedidoId,
        mapearPreparoPedidoShopee(p, {
          clienteOuterRef: null,
          enderecoOuterRef: null,
          camposRecusadosExtra: [],
        }),
      );
      const saidas = {
        stdout: [...renderResumoPedido(resumoPedido), ...renderCompradorSimulado(r)].join('\n'),
        json: JSON.stringify({ resumo: resumoPedido, comprador: r }),
        stderr: valoresEnviadosPelaShopee({ overrideSandboxAtivo: true, preparo: p }).join('\n'),
      };
      // Anchors: each surface is non-empty, and the stderr block really printed values.
      expect(saidas.stdout).toContain('informado em --cpf-teste');
      expect(saidas.json).toContain('"fonteDoCpf":"cpf-teste"');
      expect(saidas.stderr).toContain(JSON.stringify(ENDERECO_SG));
      for (const [onde, texto] of Object.entries(saidas)) {
        for (const grafia of grafiasDe(CPF_TESTE)) {
          expect(texto, `${onde} carrega o --cpf-teste`).not.toContain(grafia);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                         the importer's own defence                          */
/* -------------------------------------------------------------------------- */

describe('o importador recusa a simulação sozinho — defesa em profundidade', () => {
  it('sem SHOPEE_SANDBOX=1: recusa ANTES de chamar a Shopee, zero escritas', async () => {
    vi.stubEnv('SHOPEE_SANDBOX', '');
    const c = cenario();
    await expect(
      importarPedidoShopee(asDb(c.db), alvo(), { ...c.deps, simulacaoComprador: COMPLETA }),
    ).rejects.toBeInstanceOf(SimulacaoCompradorRecusadaError);
    expect(c.getOrderDetail).not.toHaveBeenCalled();
    expect(c.db.writes).toEqual([]);
  });

  it('a flag sem o host de sandbox resolvido também recusa (a regra do override)', async () => {
    vi.stubEnv('SHOPEE_API_HOST', SHOPEE_PROD_API_HOST);
    const c = cenario();
    await expect(
      importarPedidoShopee(asDb(c.db), alvo(), { ...c.deps, simulacaoComprador: COMPLETA }),
    ).rejects.toBeInstanceOf(SimulacaoCompradorRecusadaError);
    expect(c.db.writes).toEqual([]);
  });

  it('a METADE DE ESCRITA re-confere: um preparo com simulação, sem o sandbox, não grava', async () => {
    const c = cenario();
    const p = await preparar(c, COMPLETA);
    vi.stubEnv('SHOPEE_SANDBOX', '');
    await expect(gravarPreparoPedidoShopee(asDb(c.db), alvo(), p, c.deps)).rejects.toBeInstanceOf(
      SimulacaoCompradorRecusadaError,
    );
    vi.stubEnv('SHOPEE_SANDBOX', '1');
    // …and a preparo whose REAL row says BR (built by hand: prepare would refuse it).
    const comoBR = { ...p, linha: { ...p.linha, region: 'BR' } };
    await expect(
      gravarPreparoPedidoShopee(asDb(c.db), alvo(), comoBR, c.deps),
    ).rejects.toBeInstanceOf(SimulacaoCompradorRecusadaError);
    expect(c.db.writes).toEqual([]);
    // QUASE-ERRO: the same preparo, sandbox on and the real region, writes.
    const r = await gravarPreparoPedidoShopee(asDb(c.db), alvo(), p, c.deps);
    expect(r.acao).toBe('criado');
  });

  it('uma order de região BR — ou sem região — recusa depois da leitura, zero escritas', async () => {
    for (const region of ['BR', null, '', 'br']) {
      const c = cenario(detalheSG({ region }));
      await expect(
        importarPedidoShopee(asDb(c.db), alvo(), { ...c.deps, simulacaoComprador: COMPLETA }),
      ).rejects.toBeInstanceOf(SimulacaoCompradorRecusadaError);
      expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
      expect(c.db.writes).toEqual([]);
    }
  });

  it('QUASE-ERRO: sem a opção, o ambiente não importa — a importação normal segue', async () => {
    vi.stubEnv('SHOPEE_SANDBOX', '');
    const c = cenario();
    const r = await importarPedidoShopee(asDb(c.db), alvo(), c.deps);
    expect(r.acao).toBe('criado');
    expect('compradorDeTeste' in r).toBe(false);
    // …and the importer's log line carries NO `compradorDeTeste` key — not even `false`.
    expect(Object.prototype.hasOwnProperty.call(logDoImport(), 'compradorDeTeste')).toBe(false);
  });
});

/** The payload of the importer's one `pedido importado` info line. */
function logDoImport(): Record<string, unknown> {
  const chamadas = infoSpy.mock.calls.filter(([mensagem]) =>
    String(mensagem).includes('pedido importado'),
  );
  expect(chamadas).toHaveLength(1);
  return chamadas[0]![1] as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*                          the --live path on FakeDb                          */
/* -------------------------------------------------------------------------- */

const PEDIDO_PATH = `pedidos/${makePedidoIdShopee(INT, ORDER_SN)}`;

/** A service account issued for the named project — what the guard accepts. */
const PROJETO_OK: ProjetoDoModoComprador = {
  projetoPedido: 'demo-erp',
  projetoResolvido: 'demo-erp',
  projetoDaCredencial: 'demo-erp',
};

function live(
  c: Cenario,
  sim: SimulacaoCompradorShopee,
  orderSn = ORDER_SN,
  projeto: ProjetoDoModoComprador = PROJETO_OK,
) {
  return importarPedidoComCompradorDeTeste(asDb(c.db), alvo(orderSn), sim, projeto, c.deps);
}

/** Every stdout/`--json` surface of a `--live` buyer-mode run, as the script builds them. */
function saidaDoLive(c: Cenario, resultado: Parameters<typeof resumoDoCompradorGravado>[0]) {
  const pedidoId = resultado.pedidoId!;
  const depois = c.db.store[`pedidos/${pedidoId}`]?.data ?? null;
  const gravado = resumoDoCompradorGravado(resultado, depois);
  const resumo = depois === null ? null : resumoDoPedidoArmazenado(pedidoId, depois);
  return {
    gravado,
    texto: [
      ...renderCompradorGravado(gravado),
      ...(resumo === null ? [] : renderResumoPedido(resumo)),
      JSON.stringify({ comprador: gravado, resumo }),
    ].join('\n'),
  };
}

async function recusaDe(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SimulacaoCompradorRecusadaError) return err.message;
    throw err;
  }
  throw new Error('esperava uma recusa do modo de teste');
}

describe('--live com o comprador de TESTE', () => {
  it('um pedido NOVO ganha cliente, endereço fiscal e o endereço de entrega (PR 1)', async () => {
    const c = cenario();
    const r = await live(c, COMPLETA);
    expect(r.kind).toBe('importado');
    if (r.kind !== 'importado') return;
    expect(r.resultado.acao).toBe('criado');

    const clienteId = c.db.idsEm('clientes')[0]!;
    const enderecoId = c.db.idsEm(`clientes/${clienteId}/enderecos`)[0]!;
    expect(r.resultado.compradorDeTeste).toEqual({
      cliente: { clienteId, criado: true, matchedBy: null },
      enderecoOuterRef: `documents/clientes/${clienteId}/enderecos/${enderecoId}`,
      fonteDoCpf: FONTE_CPF_SIMULADO.cpfFalso,
    });
    expect(r.colisao).toEqual({ kind: 'livre' });

    const pedido = c.db.store[PEDIDO_PATH]!.data;
    expect(pedido.clientePedidoOuterRef).toBe(`documents/clientes/${clienteId}`);
    expect(pedido.enderecoFiscalOuterRef).toBe(
      `documents/clientes/${clienteId}/enderecos/${enderecoId}`,
    );
    expect((pedido.freteInicial as DocData).enderecoFreteOuterReference).toBe(
      pedido.enderecoFiscalOuterRef,
    );
    expect(pedido.capturaComprador).toMatchObject({ estado: 'capturado' });
    // The REAL region still blocks the NF-e.
    expect(pedido.bloquearEmissaoNFe).toBe(true);

    expect(c.db.store[`clientes/${clienteId}`]!.data).toMatchObject({
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: NOME_TESTE,
      cpf_cnpj: CPF_FALSO_DE_TESTE,
      telefone: null,
    });
    expect(c.db.store[`clientes/${clienteId}/enderecos/${enderecoId}`]!.data).toMatchObject({
      estado: 'AC',
      pais: 'SG',
      cep: CEP_TESTE,
      logradouro: ENDERECO_SG,
      numero: 'S/N',
      bairro: 'SEM BAIRRO',
    });
    expect(c.buscarCep).not.toHaveBeenCalled();
    // ONE Shopee read: the refusals and the write share the same preparo.
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    // The log line marks the test buyer — a boolean, nothing else.
    expect(logDoImport()).toMatchObject({ compradorDeTeste: true });

    // stdout / --json: ids, verdicts and paths — never the CPF, the name, the street or the CEP.
    const { gravado, texto } = saidaDoLive(c, r.resultado);
    expect(texto).toContain(`${clienteId}   criado=sim`);
    expect(texto).toContain(enderecoId);
    // The --live block names the SOURCE too, as the dry run does.
    expect(gravado.fonteDoCpf).toBe(FONTE_CPF_SIMULADO.cpfFalso);
    expect(texto).toContain('CPF de teste aplicado ... sim (o CPF falso do repo)');
    expect(gravado.limpeza).toEqual([
      PEDIDO_PATH,
      `clientes/${clienteId}/enderecos/${enderecoId}`,
      `clientes/${clienteId}`,
    ]);
    for (const literal of [CPF_FALSO_DE_TESTE, NOME_TESTE, ENDERECO_SG, CEP_TESTE, ZIP_SG]) {
      expect(texto).not.toContain(literal);
    }
  });

  it('o CPF UTILIZÁVEL da Shopee vence o de teste no --live — e também não sai no stdout', async () => {
    const c = cenario(detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE }));
    const r = await live(c, COMPLETA);
    if (r.kind !== 'importado') throw new Error('esperava importado');
    const clienteId = r.resultado.compradorDeTeste!.cliente!.clienteId;
    expect(c.db.store[`clientes/${clienteId}`]!.data.cpf_cnpj).toBe(CPF_DA_SHOPEE);
    const { gravado, texto } = saidaDoLive(c, r.resultado);
    expect(texto).toContain(clienteId);
    expect(gravado.fonteDoCpf).toBe(FONTE_CPF_SIMULADO.shopee);
    expect(texto).toContain('CPF de teste aplicado ... não — vale o da Shopee');
    for (const literal of [CPF_DA_SHOPEE, CPF_FALSO_DE_TESTE, NOME_TESTE, ENDERECO_SG, CEP_TESTE]) {
      expect(texto).not.toContain(literal);
    }
  });

  it('state XX no --live: o endereço sai uf-desconhecida e o ViaCEP É chamado (como numa importação)', async () => {
    const real = detalheSG();
    const c = cenario(
      detalheSG({ recipient_address: { ...real.recipient_address!, state: 'XX' } }),
    );
    await live(c, COMPLETA);
    expect(c.buscarCep).toHaveBeenCalledTimes(1);
    expect(c.db.store[PEDIDO_PATH]!.data.enderecoFiscalOuterRef).not.toBeNull();
  });

  it('⚠️ o projeto vem ANTES de tudo: sem --project, ou sem conta de serviço, zero leituras da Shopee', async () => {
    for (const projeto of [
      { ...PROJETO_OK, projetoPedido: null },
      { ...PROJETO_OK, projetoDaCredencial: null },
      { ...PROJETO_OK, projetoDaCredencial: 'outro' },
    ]) {
      const c = cenario();
      await expect(live(c, COMPLETA, ORDER_SN, projeto)).rejects.toBeInstanceOf(
        SimulacaoCompradorRecusadaError,
      );
      expect(c.getOrderDetail).not.toHaveBeenCalled();
      expect(c.db.writes).toEqual([]);
    }
  });

  it('sem --importar-endereco: o cliente é vinculado e NENHUM endereço é gravado', async () => {
    const c = cenario();
    await live(c, simulacao({ nomeTeste: NOME_TESTE, cepTeste: CEP_TESTE }));
    const clienteId = c.db.idsEm('clientes')[0]!;
    expect(c.db.idsEm(`clientes/${clienteId}/enderecos`)).toEqual([]);
    const pedido = c.db.store[PEDIDO_PATH]!.data;
    expect(pedido.clientePedidoOuterRef).toBe(`documents/clientes/${clienteId}`);
    expect(pedido.enderecoFiscalOuterRef).toBeNull();
  });

  it('o MESMO nome numa order nova converge: matchedBy cpf_cnpj, o mesmo endereço', async () => {
    const c = cenario();
    const a = await live(c, COMPLETA);
    const b = await live(c, COMPLETA, ORDER_SN_B);
    if (a.kind !== 'importado' || b.kind !== 'importado') throw new Error('esperava importado');
    const clienteId = a.resultado.compradorDeTeste!.cliente!.clienteId;
    expect(b.colisao).toEqual({ kind: 'mesmo-nome', clienteIds: [clienteId] });
    expect(b.resultado.compradorDeTeste).toEqual({
      cliente: { clienteId, criado: false, matchedBy: 'cpf_cnpj' },
      enderecoOuterRef: a.resultado.compradorDeTeste!.enderecoOuterRef,
      fonteDoCpf: FONTE_CPF_SIMULADO.cpfFalso,
    });
    expect(c.db.idsEm('clientes')).toEqual([clienteId]);
    expect(c.db.idsEm(`clientes/${clienteId}/enderecos`)).toHaveLength(1);
  });

  it('⚠️ o cliente do seed (CPF de teste, OUTRO nome, sem índice) recusa — ZERO escritas', async () => {
    const c = cenario();
    c.db.seed('clientes/seed-1', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Cliente Dev Pessoa Fisica',
      cpf_cnpj: CPF_FALSO_DE_TESTE,
    });
    const mensagem = await recusaDe(live(c, COMPLETA));
    expect(mensagem).toContain('seed-1');
    expect(mensagem).toContain('--nome-teste');
    expect(mensagem).not.toContain('Cliente Dev');
    expect(c.db.writes).toEqual([]);
    expect(c.db.store[PEDIDO_PATH]).toBeUndefined();
  });

  it('um dono que só o ÍNDICE conhece (CPF gravado com pontuação) também recusa', async () => {
    const c = cenario();
    c.db.seed('clientes/legado-1', { nome: 'Outro Nome', cpf_cnpj: '123.456.789-09' });
    c.db.seed(`clienteIdentidades/${clienteIdentidadeId('cpf_cnpj', CPF_FALSO_DE_TESTE)}`, {
      tipo: 'cpf_cnpj',
      // `apagado-1` no longer exists — `findOrCreateCliente` prunes it, so must this.
      clienteIds: ['apagado-1', 'legado-1'],
      ultimaModificacao: 1,
    });
    const mensagem = await recusaDe(live(c, COMPLETA));
    expect(mensagem).toContain('legado-1');
    expect(mensagem).not.toContain('apagado-1');
    expect(c.db.writes).toEqual([]);
  });

  it('QUASE-ERRO: um dono do índice que NÃO tem mais o documento não colide', async () => {
    const c = cenario();
    c.db.seed('clientes/mudou-1', { nome: 'Outro Nome', cpf_cnpj: CPF_DA_SHOPEE });
    c.db.seed(`clienteIdentidades/${clienteIdentidadeId('cpf_cnpj', CPF_FALSO_DE_TESTE)}`, {
      tipo: 'cpf_cnpj',
      clienteIds: ['mudou-1'],
      ultimaModificacao: 1,
    });
    const r = await live(c, COMPLETA);
    expect(r.kind === 'importado' && r.colisao).toEqual({ kind: 'livre' });
    expect(r.kind === 'importado' && r.resultado.compradorDeTeste?.cliente?.criado).toBe(true);
  });

  it('um pedido existente com a captura TERMINAL recusa — ZERO escritas', async () => {
    const c = cenario();
    await importarPedidoShopee(asDb(c.db), alvo(), c.deps);
    expect(c.db.store[PEDIDO_PATH]!.data.capturaComprador).toMatchObject({ estado: 'expirado' });
    c.db.writes.length = 0;

    const mensagem = await recusaDe(live(c, COMPLETA));
    expect(mensagem).toBe(
      'o pedido já existe e a captura do comprador já terminou (expirado); use um pedido de teste novo.',
    );
    expect(c.db.writes).toEqual([]);
    expect(c.db.idsEm('clientes')).toEqual([]);
  });

  it('o fluxo do SG: sem substitutos fica PENDENTE (não terminal); com --nome-teste, vincula', async () => {
    const c = cenario();
    const primeira = await live(c, simulacao({ importarEndereco: true }));
    expect(primeira.kind === 'importado' && primeira.colisao).toBeNull();
    expect(c.db.idsEm('clientes')).toEqual([]);
    expect(c.db.store[PEDIDO_PATH]!.data.capturaComprador).toMatchObject({
      estado: 'pendente',
      camposRecusados: ['nome:mascarado'],
    });

    await live(c, COMPLETA);
    const pedido = c.db.store[PEDIDO_PATH]!.data;
    expect(c.db.idsEm('clientes')).toHaveLength(1);
    expect(pedido.clientePedidoOuterRef).not.toBeNull();
    expect(pedido.enderecoFiscalOuterRef).not.toBeNull();
    expect(pedido.capturaComprador).toMatchObject({ estado: 'capturado' });
    // PR 1's FIRST-FILL path: the delivery address rides the first fiscal fill.
    expect((pedido.freteInicial as DocData).enderecoFreteOuterReference).toBe(
      pedido.enderecoFiscalOuterRef,
    );
  });

  it('--nome-teste primeiro, --importar-endereco depois: o endereço vincula no MESMO pedido', async () => {
    const c = cenario();
    await live(c, simulacao({ nomeTeste: NOME_TESTE, cepTeste: CEP_TESTE }));
    const clienteId = c.db.idsEm('clientes')[0]!;
    expect(c.db.store[PEDIDO_PATH]!.data).toMatchObject({
      capturaComprador: { estado: 'capturado' },
      clientePedidoOuterRef: `documents/clientes/${clienteId}`,
      enderecoFiscalOuterRef: null,
    });

    // The dry run between the two says what the second --live will meet.
    const previa = resumoDe(await preparar(c, COMPLETA));
    expect(previa.clienteVinculadoId).toBe(clienteId);
    expect(previa.capturaTerminalArmazenada).toBeNull();
    expect(renderCompradorSimulado(previa).join('\n')).toContain(
      `o pedido já vincula o cliente ${clienteId}`,
    );
    // QUASE-ERRO: without --importar-endereco nothing is left to fill — terminal.
    expect(
      resumoDe(await preparar(c, simulacao({ nomeTeste: NOME_TESTE }))).capturaTerminalArmazenada,
    ).toBe('capturado');

    const segunda = await live(c, COMPLETA);
    if (segunda.kind !== 'importado') throw new Error('esperava importado');
    expect(segunda.colisao).toEqual({ kind: 'mesmo-nome', clienteIds: [clienteId] });
    const enderecoId = c.db.idsEm(`clientes/${clienteId}/enderecos`)[0]!;
    const pedido = c.db.store[PEDIDO_PATH]!.data;
    expect(pedido.enderecoFiscalOuterRef).toBe(
      `documents/clientes/${clienteId}/enderecos/${enderecoId}`,
    );
    expect((pedido.freteInicial as DocData).enderecoFreteOuterReference).toBe(
      pedido.enderecoFiscalOuterRef,
    );
    // The cleanup lists what the pedido LINKS, the earlier run's cliente included.
    expect(saidaDoLive(c, segunda.resultado).gravado.limpeza).toContain(`clientes/${clienteId}`);

    // QUASE-ERRO: a third run has nothing left to fill — refused, zero writes.
    c.db.writes.length = 0;
    expect(await recusaDe(live(c, COMPLETA))).toContain('já terminou (capturado)');
    expect(c.db.writes).toEqual([]);
  });

  it('⚠️ um cliente vinculado À MÃO (não é o comprador de teste) recusa — ZERO escritas', async () => {
    const c = cenario();
    // A first run with a masked name stores `pendente` and links nothing…
    await live(c, simulacao({ importarEndereco: true }));
    // …then an operator links somebody else on the pedido form.
    c.db.seed('clientes/operador-1', { nome: 'Outra Pessoa', cpf_cnpj: CPF_DA_SHOPEE });
    c.db.seed(PEDIDO_PATH, {
      ...c.db.store[PEDIDO_PATH]!.data,
      clientePedidoOuterRef: 'documents/clientes/operador-1',
    });
    c.db.writes.length = 0;

    for (const sim of [COMPLETA, simulacao({ importarEndereco: true })]) {
      const mensagem = await recusaDe(live(c, sim));
      expect(mensagem).toContain('(cliente operador-1)');
      expect(mensagem).not.toContain('Outra Pessoa');
    }
    expect(c.db.writes).toEqual([]);
    expect(c.db.idsEm('clientes/operador-1/enderecos')).toEqual([]);
  });
});

/** Every `console.info` / `console.warn` payload of the run, as one string. */
function logsDoRun(): string {
  return JSON.stringify([...infoSpy.mock.calls, ...vi.mocked(console.warn).mock.calls]);
}

/** The values the run's `cpf_cnpj ==` queries asked for — the document the collision check used. */
function documentosConsultados(c: Cenario): unknown[] {
  return c.db.consultas.flatMap((q) =>
    q.clausulas.filter(([campo]) => campo === 'cpf_cnpj').map(([, valor]) => valor),
  );
}

/** A cliente holding the repo's fake CPF under another name — staging's NF-e live / dev-seed leftovers. */
function seedDoCpfFalso(c: Cenario): void {
  c.db.seed('clientes/ci-seed-cliente', {
    tipo: TIPO_CLIENTE.pessoaFisica,
    nome: 'Cliente Dev Pessoa Fisica',
    cpf_cnpj: CPF_FALSO_DE_TESTE,
  });
}

describe('--live com --cpf-teste', () => {
  const COM_CPF = simulacao({ ...COMPLETA, cpfTeste: CPF_TESTE });

  it('cria o cliente SOB o --cpf-teste e o vincula — e nenhuma saída, nem log, carrega os dígitos', async () => {
    const c = cenario();
    const r = await live(c, COM_CPF);
    if (r.kind !== 'importado') throw new Error('esperava importado');
    expect(r.colisao).toEqual({ kind: 'livre' });
    const clienteId = r.resultado.compradorDeTeste!.cliente!.clienteId;
    expect(r.resultado.compradorDeTeste!.cliente!.criado).toBe(true);
    expect(c.db.store[`clientes/${clienteId}`]!.data).toMatchObject({
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: NOME_TESTE,
      cpf_cnpj: CPF_TESTE,
    });
    const pedido = c.db.store[PEDIDO_PATH]!.data;
    expect(pedido.clientePedidoOuterRef).toBe(`documents/clientes/${clienteId}`);
    expect(pedido.capturaComprador).toMatchObject({ estado: 'capturado' });
    // The collision check asked about the --cpf-teste document — never the fake.
    expect(documentosConsultados(c)).toContain(CPF_TESTE);
    expect(documentosConsultados(c)).not.toContain(CPF_FALSO_DE_TESTE);

    const { gravado, texto } = saidaDoLive(c, r.resultado);
    expect(texto).toContain(clienteId);
    // The --live block (and its --json) names the SOURCE the cliente was created under.
    expect(gravado.fonteDoCpf).toBe(FONTE_CPF_SIMULADO.cpfTeste);
    expect(texto).toContain('CPF de teste aplicado ... sim (informado em --cpf-teste)');
    expect(texto).toContain('"fonteDoCpf":"cpf-teste"');
    const logs = logsDoRun();
    // Anchor: the importer DID log its line.
    expect(logs).toContain('pedido importado');
    for (const grafia of grafiasDe(CPF_TESTE)) {
      expect(texto).not.toContain(grafia);
      expect(logs).not.toContain(grafia);
    }
  });

  it('⚠️ o cliente do CPF FALSO (o staging de hoje) NÃO bloqueia um --cpf-teste livre', async () => {
    const c = cenario();
    seedDoCpfFalso(c);
    const r = await live(c, COM_CPF);
    if (r.kind !== 'importado') throw new Error('esperava importado');
    expect(r.colisao).toEqual({ kind: 'livre' });
    const clienteId = r.resultado.compradorDeTeste!.cliente!.clienteId;
    expect(clienteId).not.toBe('ci-seed-cliente');
    expect(c.db.store[`clientes/${clienteId}`]!.data.cpf_cnpj).toBe(CPF_TESTE);
    // The holder of the fake is left exactly as it was.
    expect(c.db.store['clientes/ci-seed-cliente']!.data.cpf_cnpj).toBe(CPF_FALSO_DE_TESTE);

    // QUASE-ERRO: the SAME seed without --cpf-teste refuses, and points at the flag first.
    const sem = cenario();
    seedDoCpfFalso(sem);
    const mensagem = await recusaDe(live(sem, COMPLETA));
    expect(mensagem).toMatch(/^o CPF falso do repo/);
    expect(mensagem).toContain('ci-seed-cliente');
    expect(mensagem.indexOf('--cpf-teste')).toBeLessThan(mensagem.indexOf('--nome-teste'));
    expect(sem.db.writes).toEqual([]);
  });

  it('⚠️ um cliente que JÁ tem o --cpf-teste, com outro nome, bloqueia — ZERO escritas, ids só', async () => {
    const c = cenario();
    c.db.seed('clientes/dono-1', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Outra Pessoa Qualquer',
      cpf_cnpj: CPF_TESTE,
    });
    const mensagem = await recusaDe(live(c, COM_CPF));
    expect(mensagem).toMatch(
      /^o CPF informado em --cpf-teste já pertence a outro cliente \(dono-1\)/,
    );
    expect(c.db.writes).toEqual([]);
    expect(c.db.store[PEDIDO_PATH]).toBeUndefined();
    expect(documentosConsultados(c)).toEqual([CPF_TESTE]);
    // What the operator sees: the refusal line — no name, no digits.
    const saida = descreverErro(new SimulacaoCompradorRecusadaError(mensagem)).join('\n');
    expect(saida).not.toContain('Outra Pessoa');
    for (const grafia of grafiasDe(CPF_TESTE)) expect(saida).not.toContain(grafia);
  });

  it('um dono que só o ÍNDICE conhece (o --cpf-teste gravado PONTUADO) também bloqueia', async () => {
    const c = cenario();
    c.db.seed('clientes/legado-2', { nome: 'Outro Nome', cpf_cnpj: pontuarCpf(CPF_TESTE) });
    c.db.seed(`clienteIdentidades/${clienteIdentidadeId('cpf_cnpj', CPF_TESTE)}`, {
      tipo: 'cpf_cnpj',
      clienteIds: ['legado-2'],
      ultimaModificacao: 1,
    });
    const mensagem = await recusaDe(live(c, COM_CPF));
    expect(mensagem).toContain('legado-2');
    expect(c.db.writes).toEqual([]);
  });

  it('QUASE-ERRO: o MESMO nome sob o --cpf-teste converge numa order nova — matchedBy cpf_cnpj', async () => {
    const c = cenario();
    const a = await live(c, COM_CPF);
    const b = await live(c, COM_CPF, ORDER_SN_B);
    if (a.kind !== 'importado' || b.kind !== 'importado') throw new Error('esperava importado');
    const clienteId = a.resultado.compradorDeTeste!.cliente!.clienteId;
    expect(b.colisao).toEqual({ kind: 'mesmo-nome', clienteIds: [clienteId] });
    expect(b.resultado.compradorDeTeste!.cliente).toEqual({
      clienteId,
      criado: false,
      matchedBy: 'cpf_cnpj',
    });
    // QUASE-ERRO: ANOTHER free --cpf-teste with the same name is another cliente.
    const outro = await live(
      c,
      simulacao({ ...COMPLETA, cpfTeste: CPF_TESTE_B }),
      '260910KJBHUJDP',
    );
    if (outro.kind !== 'importado') throw new Error('esperava importado');
    expect(outro.colisao).toEqual({ kind: 'livre' });
    expect(outro.resultado.compradorDeTeste!.cliente!.clienteId).not.toBe(clienteId);
  });

  it('⚠️ o CPF utilizável da SHOPEE ainda vence no --live: um dono do --cpf-teste não importa', async () => {
    const c = cenario(detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE }));
    c.db.seed('clientes/dono-1', { nome: 'Outra Pessoa Qualquer', cpf_cnpj: CPF_TESTE });
    const r = await live(c, COM_CPF);
    if (r.kind !== 'importado') throw new Error('esperava importado');
    expect(r.colisao).toEqual({ kind: 'livre' });
    const clienteId = r.resultado.compradorDeTeste!.cliente!.clienteId;
    expect(c.db.store[`clientes/${clienteId}`]!.data.cpf_cnpj).toBe(CPF_DA_SHOPEE);
    expect(documentosConsultados(c)).not.toContain(CPF_TESTE);
    // …and a holder of SHOPEE's document says so, without suggesting --cpf-teste.
    const d = cenario(detalheSG({ buyer_cpf_id: CPF_DA_SHOPEE }));
    d.db.seed('clientes/dono-2', { nome: 'Outra Pessoa Qualquer', cpf_cnpj: CPF_DA_SHOPEE });
    const mensagem = await recusaDe(live(d, COM_CPF));
    expect(mensagem).toMatch(
      /^o documento que a Shopee mandou já pertence a outro cliente \(dono-2\)/,
    );
    expect(d.db.writes).toEqual([]);
  });

  it('o parser e o --live falam a MESMA forma: o valor pontuado da linha de comando grava canônico', async () => {
    const cmd = parseArgsImportarPedido([
      '--integracao',
      INT,
      '--order-sn',
      ORDER_SN,
      '--importar-cliente',
      '--importar-endereco',
      '--nome-teste',
      NOME_TESTE,
      '--cep-teste',
      CEP_TESTE,
      `--cpf-teste=${pontuarCpf(CPF_TESTE)}`,
    ]);
    if (cmd.kind !== 'importar' || cmd.args.comprador === undefined) {
      throw new Error('esperava o modo comprador');
    }
    const c = cenario();
    const r = await live(c, cmd.args.comprador);
    if (r.kind !== 'importado') throw new Error('esperava importado');
    const clienteId = r.resultado.compradorDeTeste!.cliente!.clienteId;
    expect(c.db.store[`clientes/${clienteId}`]!.data.cpf_cnpj).toBe(CPF_TESTE);
  });
});

/* -------------------------------------------------------------------------- */
/*                 the option never reaches a production caller                */
/* -------------------------------------------------------------------------- */

/** `apps/shopee/`. */
const RAIZ_DO_APP = new URL('../../../', import.meta.url);

/** Every `.ts` under the app's code roots, minus tests, keyed by app-relative path. */
function fontesDoApp(): Map<string, string> {
  const fontes = new Map<string, string>();
  const ler = (dir: URL, prefixo: string): void => {
    for (const nome of readdirSync(dir)) {
      const url = new URL(nome, dir);
      if (statSync(url).isDirectory()) {
        if (nome !== 'node_modules') ler(new URL(`${nome}/`, dir), `${prefixo}${nome}/`);
        continue;
      }
      if (!/\.tsx?$/.test(nome) || nome.endsWith('.test.ts')) continue;
      fontes.set(`${prefixo}${nome}`, readFileSync(url, 'utf8'));
    }
  };
  for (const raiz of ['lib/', 'app/', 'functions/src/', 'scripts/']) {
    ler(new URL(raiz, RAIZ_DO_APP), raiz);
  }
  return fontes;
}

function quemNomeia(padrao: RegExp): string[] {
  return [...fontesDoApp()]
    .filter(([, texto]) => padrao.test(texto))
    .map(([arquivo]) => arquivo)
    .sort();
}

const IMPORTADOR = 'lib/shopee/pedidos/importarPedido.ts';
const SCRIPT = 'scripts/importar-pedido.ts';
const CLI = 'lib/shopee/pedidos/importarPedidoCli.ts';
const LIVE = 'lib/shopee/pedidos/importarCompradorTeste.ts';
const COMPRADOR = 'lib/shopee/pedidos/comprador.ts';

describe('a opção de teste não chega a nenhum chamador de produção', () => {
  it('`simulacaoComprador` só aparece no importador, no script e no --live do script', () => {
    // The anchors first: a grep that matched nothing would pass vacuously.
    expect(quemNomeia(/\bsimulacaoComprador\b/)).toEqual([LIVE, IMPORTADOR, SCRIPT].sort());
  });

  it('a simulação, o seu tipo e o CPF de teste só aparecem nos módulos do modo', () => {
    expect(
      quemNomeia(/\b(simularCompradorShopee|SimulacaoCompradorShopee|CPF_FALSO_DE_TESTE)\b/),
    ).toEqual([CLI, COMPRADOR, LIVE, IMPORTADOR].sort());
    // …and the literal itself is spelled exactly once in production code.
    expect(quemNomeia(/12345678909/)).toEqual([COMPRADOR]);
  });

  it('o módulo do --live só é importado pelo script', () => {
    expect(quemNomeia(/importarCompradorTeste'/)).toEqual([SCRIPT]);
  });

  it('o script: o dry-run não chama escritor nenhum, e os VALORES vão só para o stderr', () => {
    // `scripts/` is outside vitest's include, so its two load-bearing calls are
    // pinned on the SOURCE — between the dry-run and the live section markers.
    const fonte = fontesDoApp().get(SCRIPT)!;
    const inicio = fonte.indexOf('/* --------------------------------- dry-run');
    const fim = fonte.indexOf('/* ---------------------------------- live');
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const dryRun = fonte.slice(inicio, fim);
    const vivo = fonte.slice(fim);
    // Anchors: the dry run reads, the live section writes.
    expect(dryRun).toContain('prepararImportacaoPedidoShopee(');
    expect(vivo).toMatch(/\bimportarPedidoShopee\(/);
    expect(vivo).toMatch(/\bimportarPedidoComCompradorDeTeste\(/);
    expect(dryRun).not.toMatch(
      /\b(importarPedidoShopee|gravarPreparoPedidoShopee|importarPedidoComCompradorDeTeste|findOrCreateCliente|ensureEndereco|salvarPedidoShopee)\(/,
    );
    // The values block goes, line by line, to `aviso` (stderr) and nowhere else.
    expect(dryRun).toMatch(
      /for \(const linha of valoresEnviadosPelaShopee\(\{[^}]*\}\)\) \{\s*aviso\(linha\);\s*\}/,
    );
    expect(fonte.match(/valoresEnviadosPelaShopee\(/g)).toHaveLength(1);
  });

  it('o script nunca toca no --cpf-teste: o preâmbulo vem pronto da metade testada', () => {
    // `scripts/` is outside vitest, so the preamble line is built — and tested
    // with the digits as input — in `importarPedidoCli.ts`; the script only
    // hands it the comprador.
    const fonte = fontesDoApp().get(SCRIPT)!;
    expect(fonte).not.toMatch(/cpfTeste/);
    const preambulo = fonte.match(/\blinhaDoCompradorNoPreambulo\(comprador\)/g) ?? [];
    expect(preambulo).toHaveLength(1);
  });

  it('o script: o comprador (com os dígitos dentro) só vai para lugares CONHECIDOS', () => {
    // ⚠️ An alias is how the digits would leak without naming `cpfTeste` —
    // `aviso(JSON.stringify(comprador))`, `const c = comprador`, a template.
    // So every use of the VARIABLE is one of the allowed shapes, counted.
    const fonte = fontesDoApp().get(SCRIPT)!;
    const usos = fonte.match(/(?<![.\w])comprador\b(?!\s*:)/g) ?? [];
    const permitidos = [
      /const comprador = comando\.args\.comprador \?\? null;/g,
      /(?<![.\w])comprador [!=]== null\b/g,
      /\blinhaDoCompradorNoPreambulo\(comprador\)/g,
      /\{ simulacaoComprador: comprador \}/g,
      /\bimportarPedidoComCompradorDeTeste\(db, alvo, comprador, projeto\)/g,
    ].map((padrao) => (fonte.match(padrao) ?? []).length);
    // Anchors: every allowed shape is really there — a pattern that matched
    // nothing would let the count pass vacuously.
    for (const n of permitidos) expect(n).toBeGreaterThan(0);
    expect(usos.length).toBe(permitidos.reduce((a, b) => a + b, 0));
    // …and the parsed args and the raw argv are read once each, never printed.
    expect(fonte.match(/\bcomando\.args\b/g) ?? []).toHaveLength(2);
    expect(fonte.match(/\bprocess\.argv\b/g) ?? []).toHaveLength(1);
  });

  it('nenhuma rota, gatilho, varredura ou braço de notificação nomeia o modo', () => {
    const proibidos =
      /\b(simulacaoComprador|simularCompradorShopee|importarPedidoComCompradorDeTeste)\b/;
    const fontes = fontesDoApp();
    const producao = [...fontes.keys()].filter(
      (a) =>
        a.startsWith('functions/src/') ||
        a.startsWith('app/') ||
        a === 'lib/shopee/notificacoes/notificacao.ts' ||
        /Sweep\.ts$/.test(a),
    );
    // Anchor: the universe is not empty.
    expect(producao).toContain('lib/shopee/notificacoes/notificacao.ts');
    expect(producao.some((a) => a.startsWith('functions/src/'))).toBe(true);
    expect(producao.some((a) => a.startsWith('app/api/'))).toBe(true);
    expect(producao.filter((a) => proibidos.test(fontes.get(a)!))).toEqual([]);
  });
});
