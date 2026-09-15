/**
 * The pure half of `varrer:reservas` (#1516, step 8, plan §3.5).
 *
 * ⚠️ Three of these tests are the only thing standing between a rehearsal and a
 * leak or a lie, and none of them is a happy path:
 *
 *  - the SENTINEL test puts buyer-shaped keys on a row cast to carry them and
 *    asserts none reaches the summary, with a FIELD-COUNT pin so a field added
 *    to the allow-list has to be looked at;
 *  - the zero-arm test pins that every verdict prints even at zero — the
 *    instrument is a week-over-week diff, and a missing line reads exactly like
 *    an arm that did not exist last week;
 *  - the usage test pins the `pnpm-run-args` shape, which CI fails on and which
 *    a docblock cannot spell out without tripping.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { makePedidoIdShopee } from './orderIds';
import { VEREDITOS_RESERVA_TRAVADA } from './reservaTravadaMapping';
import type { CandidatoObservado, ReservaTravadaSweepResult } from './reservaTravadaSweep';
import {
  ArgumentoInvalidoError,
  CAMPOS_RESUMO_RESERVA_TRAVADA,
  USO_VARRER_RESERVAS,
  descreverErroVarredura,
  documentoVarredura,
  parseArgsVarrerReservas,
  renderResumoVarredura,
  resumoDoCandidato,
} from './varrerReservasCli';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real partner id, shop or buyer.        */
/* -------------------------------------------------------------------------- */

const INT_A = 'int-1';
const SN_A = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(INT_A, SN_A);

/** Sentinels — nothing real, and nothing that may reach the output. */
const SENTINELA_COMPRADOR = 'SENTINELA-NOME-DO-COMPRADOR';
const SENTINELA_CPF = 'SENTINELA-CPF-DO-COMPRADOR';
const SENTINELA_ENDERECO = 'SENTINELA-ENDERECO-DE-ENTREGA';

function candidato(over: Partial<CandidatoObservado> = {}): CandidatoObservado {
  return {
    pedidoId: PEDIDO_ID,
    integracaoId: INT_A,
    orderSn: SN_A,
    veredito: 'ainda-nao-pago',
    orderStatus: 'UNPAID',
    pendingTerms: null,
    temPayTime: false,
    idadeDias: 30,
    cancelBy: null,
    cancelReason: null,
    enfileiraria: false,
    avisaria: true,
    ...over,
  };
}

function zerarVeredictos(): ReservaTravadaSweepResult['veredictos'] {
  const m = {} as Record<string, number>;
  for (const v of VEREDITOS_RESERVA_TRAVADA) m[v] = 0;
  return m as ReservaTravadaSweepResult['veredictos'];
}

function resultado(over: Partial<ReservaTravadaSweepResult> = {}): ReservaTravadaSweepResult {
  return {
    enabled: true,
    dryRun: true,
    motivo: null,
    tasksDesabilitado: false,
    maxIdadeDias: 7,
    cutoffUs: 1_759_000_000_000_000,
    examinados: 12,
    paginas: 1,
    naoMarketplace: 2,
    adotado: 0,
    contaInativa: 1,
    foraDoEscopo: 0,
    semShopId: 0,
    candidatos: 1,
    truncado: false,
    veredictos: { ...zerarVeredictos(), 'ainda-nao-pago': 1 },
    avisosVarridos: 3,
    reconciliados: 1,
    reconciliacaoTruncada: false,
    redriveAparentementeNaoAplicado: 0,
    statusArmazenado: { UNPAID: 1 },
    idadeStatusDias: { '7-14': 0, '14-30': 1, '30-60': 0, '60-90': 0, '90+': 0 },
    statusPorIdade: { UNPAID: { '7-14': 0, '14-30': 1, '30-60': 0, '60-90': 0, '90+': 0 } },
    statusArmazenadoPorVeredito: { UNPAID: { ...zerarVeredictos(), 'ainda-nao-pago': 1 } },
    contas: [
      {
        integracaoId: INT_A,
        shopId: 987654,
        pulada: null,
        candidatos: 1,
        lotes: 1,
        lotesComFallback: 0,
        chamadas: 1,
        enfileirados: 0,
        avisosEscritos: 1,
        avisosResolvidos: 0,
        veredictos: { ...zerarVeredictos(), 'ainda-nao-pago': 1 },
        codigosInexistente: {},
        error: null,
      },
    ],
    erros: [],
    ...over,
  };
}

/* ========================================================================== */
/*  os argumentos                                                             */
/* ========================================================================== */

describe('parseArgsVarrerReservas', () => {
  it('a matriz de recusas', () => {
    // ⚠️ A CLASSE e a MENSAGEM, nas duas asserções: só a classe deixaria passar
    // uma recusa que acontece pelo motivo errado (a mensagem é o que a operadora
    // lê), e só a mensagem deixaria passar um `Error` genérico, que o script
    // trata de outro jeito.
    const recusa = (argv: string[], trecho: string): void => {
      expect(() => parseArgsVarrerReservas(argv), argv.join(' ')).toThrowError(
        ArgumentoInvalidoError,
      );
      expect(() => parseArgsVarrerReservas(argv), argv.join(' ')).toThrowError(trecho);
    };

    recusa(['--live', '--dry-run'], 'contraditórios');
    recusa(['--sei-la'], 'Opção desconhecida');
    recusa(['--integracao'], 'exige um valor');
    recusa(['--integracao', '--json'], 'exige um valor');
    recusa(['--max-idade-d', '0'], 'maior que zero');
    recusa(['--max-idade-d', '-1'], 'maior que zero');
    recusa(['--max-idade-d', 'x'], 'maior que zero');
    // ⚠️ `parseInt` would read this as 7 and a clamp would read it as the
    // default — both silently rehearse a horizon nobody asked for.
    recusa(['--max-idade-d', '7d'], 'maior que zero');
    recusa(['--', '--json'], 'Separador');
  });

  it('o caminho feliz, e os padrões que importam', () => {
    // Sem nada: TODAS as contas, o horizonte do ambiente, e DRY-RUN.
    expect(parseArgsVarrerReservas([])).toEqual({
      integracaoId: null,
      maxIdadeDias: null,
      live: false,
      projectId: null,
      json: false,
      help: false,
    });

    expect(
      parseArgsVarrerReservas([
        '--integracao',
        INT_A,
        '--max-idade-d',
        '14',
        '--project',
        'demo-erp',
        '--json',
        '--live',
      ]),
    ).toEqual({
      integracaoId: INT_A,
      maxIdadeDias: 14,
      live: true,
      projectId: 'demo-erp',
      json: true,
      help: false,
    });

    // A grafia `--flag=valor` vale tanto quanto a de dois tokens.
    expect(parseArgsVarrerReservas(['--integracao=int-9', '--max-idade-d=21'])).toMatchObject({
      integracaoId: 'int-9',
      maxIdadeDias: 21,
    });

    // `--dry-run` explícito é o padrão dito em voz alta, nunca uma contradição.
    expect(parseArgsVarrerReservas(['--dry-run'])).toMatchObject({ live: false });
  });

  it('`--help` ganha de TODA validação, inclusive de uma contradição', () => {
    const ajuda = { integracaoId: null, maxIdadeDias: null, live: false, projectId: null };
    expect(parseArgsVarrerReservas(['--help'])).toMatchObject({ ...ajuda, help: true });
    expect(parseArgsVarrerReservas(['-h'])).toMatchObject({ ...ajuda, help: true });
    expect(parseArgsVarrerReservas(['--sei-la', '--help'])).toMatchObject({ help: true });
    expect(parseArgsVarrerReservas(['--live', '--dry-run', '-h'])).toMatchObject({ help: true });
    expect(parseArgsVarrerReservas(['--max-idade-d', '0', '--help'])).toMatchObject({ help: true });
  });

  it('…e o SCRIPT devolve na ajuda antes do primeiro `await import`', () => {
    // A outra metade do trato, e é ESTRUTURAL: nada abaixo da linha de import
    // dinâmico foi carregado ainda, então nenhuma leitura de env em escopo de
    // módulo, nenhum singleton de admin e nenhum cliente pode rodar no caminho
    // da ajuda. Um teste unitário do parser não consegue ver isso.
    const fonte = readFileSync(
      new URL('../../../scripts/varrer-reservas.ts', import.meta.url),
      'utf8',
    );
    const ajuda = fonte.indexOf('args.help');
    const primeiroImport = fonte.indexOf('await import(');
    expect(ajuda).toBeGreaterThan(0);
    expect(primeiroImport).toBeGreaterThan(0);
    expect(ajuda).toBeLessThan(primeiroImport);
  });

  it('…e o PAR de deps do script, pinado no texto cru porque nada o executa', () => {
    // ⚠️ `scripts/` está fora do `include` do vitest: NADA no repositório roda
    // este arquivo, então três mutações dele passam verdes por toda a suíte —
    // `--live` entregando `ignorarFlagMestra` (a asserção pareada do tick lança
    // `ShopeeConfigError`, mas nenhuma lane de CI a veria), `--dry-run` deixando
    // de entregar `forcarDryRun`, e o acumulador do ensaio empurrando DUAS
    // linhas por candidato — o que duplicaria cada linha da tabela cruzada que é
    // o artefato do passo 8. Um pino de texto é o instrumento mais fraco que
    // existe; é também o único que alcança este arquivo.
    const fonte = readFileSync(
      new URL('../../../scripts/varrer-reservas.ts', import.meta.url),
      'utf8',
    );
    // Só o CÓDIGO: o docblock do topo explica o par e citá-lo não é usá-lo.
    const codigo = fonte
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');

    expect(codigo).toContain('...(live ? {} : { forcarDryRun: true, ignorarFlagMestra: true })');
    expect(codigo.match(/forcarDryRun/g) ?? []).toHaveLength(1);
    expect(codigo.match(/ignorarFlagMestra/g) ?? []).toHaveLength(1);
    expect(codigo.match(/linhas\.push\(resumoDoCandidato\(/g) ?? []).toHaveLength(1);
  });

  it('o uso NÃO carrega um separador `--` entre flags', () => {
    // Um `pnpm run` com o separador antes das flags repassa o token literal
    // para o script, e todo CLI deste repo parseia `process.argv` sozinho —
    // então o comando documentado morreria no próprio separador.
    // `pnpm-run-args.test.js` derruba a CI na grafia que carrega um, INCLUSIVE
    // dentro desta string.
    expect(USO_VARRER_RESERVAS).not.toMatch(/pnpm .*[^ ] -- +-/);
    // ÂNCORA: o negativo não pode ser vazio — o texto tem mesmo uma invocação.
    expect(USO_VARRER_RESERVAS).toContain('pnpm --filter @delfrance/shopee-app varrer:reservas');
    // E diz em voz alta que o dry-run é o padrão e que ele CHAMA a Shopee.
    expect(USO_VARRER_RESERVAS).toContain('É o PADRÃO');
    expect(USO_VARRER_RESERVAS).toContain('SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED=1');
  });
});

/* ========================================================================== */
/*  a redação                                                                 */
/* ========================================================================== */

describe('resumoDoCandidato', () => {
  it('o resumo tem exatamente 12 campos e um cast com chaves extras não as deixa passar', () => {
    // Uma linha que finge carregar o que uma `.passthrough()` do wire poderia
    // trazer, e que uma futura mudança de schema poderia acrescentar de graça.
    const contaminado = {
      ...candidato({ cancelBy: 'system', cancelReason: 'BACKEND_LOGISTICS_NOT_STARTED' }),
      buyer_username: SENTINELA_COMPRADOR,
      buyer_cpf_id: SENTINELA_CPF,
      recipient_address: SENTINELA_ENDERECO,
      buyer_cancel_reason: SENTINELA_COMPRADOR,
    } as unknown as CandidatoObservado;

    const r = resumoDoCandidato(contaminado);

    // (a) a lista de permissão é FECHADA nos dois sentidos, e o número é fixado
    // para que um campo novo tenha de ser olhado em vez de entrar de carona.
    expect(Object.keys(r).sort()).toEqual([...CAMPOS_RESUMO_RESERVA_TRAVADA].sort());
    expect(CAMPOS_RESUMO_RESERVA_TRAVADA).toHaveLength(12);

    // (b) nem o objeto…
    const serializado = JSON.stringify(r);
    expect(serializado).not.toContain(SENTINELA_COMPRADOR);
    expect(serializado).not.toContain(SENTINELA_CPF);
    expect(serializado).not.toContain(SENTINELA_ENDERECO);
    expect(serializado).not.toContain('buyer_');

    // (c) …nem as linhas renderizadas.
    const texto = renderResumoVarredura(resultado(), [r]).join('\n');
    expect(texto).not.toContain(SENTINELA_COMPRADOR);
    expect(texto).not.toContain(SENTINELA_CPF);
    expect(texto).not.toContain(SENTINELA_ENDERECO);

    // (d) ÂNCORA: o negativo não pode ser vazio — o resumo carrega mesmo o que
    // o item 37 do registro precisa ver.
    expect(r.cancelBy).toBe('system');
    expect(r.cancelReason).toBe('BACKEND_LOGISTICS_NOT_STARTED');
    expect(r.orderStatus).toBe('UNPAID');
    expect(r.idadeDias).toBe(30);
    expect(texto).toContain(SN_A);
    expect(texto).toContain('BACKEND_LOGISTICS_NOT_STARTED');
  });

  it('`temPayTime` é um BOOLEAN — o carimbo em si nunca sai da varredura', () => {
    const r = resumoDoCandidato(candidato({ temPayTime: true, veredito: 'pendente-pago' }));
    expect(r.temPayTime).toBe(true);
    // ⚠️ E não existe campo por onde o número pudesse viajar.
    expect(Object.keys(r)).not.toContain('payTime');
    expect(JSON.stringify(r)).not.toContain('1760');
  });
});

/* ========================================================================== */
/*  a renderização                                                            */
/* ========================================================================== */

/**
 * The lines of ONE `### ` section, and nothing else.
 *
 * ⚠️ It exists because the whole-report `toContain` is VACUOUS for a verdict
 * name: the `status armazenado × veredito` table prints all eleven arms too, so
 * a renderer that skipped every zero-valued line in the verdict block would
 * still satisfy it. Measured — that exact mutant survived until this helper
 * existed.
 */
function secao(texto: string, titulo: string): string {
  const linhas = texto.split('\n');
  const i = linhas.findIndex((l) => l.startsWith(`### ${titulo}`));
  expect(i, `seção ausente: ${titulo}`).toBeGreaterThanOrEqual(0);
  const resto = linhas.slice(i + 1);
  const fim = resto.findIndex((l) => l.startsWith('### '));
  return (fim === -1 ? resto : resto.slice(0, fim)).join('\n');
}

describe('renderResumoVarredura', () => {
  it('imprime todos os braços de veredito, inclusive os de valor zero', () => {
    const texto = renderResumoVarredura(resultado(), [resumoDoCandidato(candidato())]).join('\n');

    // ⚠️ Os ONZE, no BLOCO de vereditos, não só os que aconteceram: o instrumento
    // é um diff semana a semana e uma linha ausente se lê igualzinho a um braço
    // que não existia. E a asserção é sobre a SEÇÃO, porque o relatório inteiro
    // já contém os onze nomes pela tabela cruzada lá embaixo.
    expect(VEREDITOS_RESERVA_TRAVADA).toHaveLength(11);
    const bloco = secao(texto, 'vereditos');
    for (const v of VEREDITOS_RESERVA_TRAVADA) {
      expect(bloco, v).toContain(v);
    }
    // O braço que ACONTECEU sai com o seu número, e os zerados com o zero.
    expect(bloco).toMatch(/ainda-nao-pago \.+ 1/);
    expect(bloco).toMatch(/manter-devolucao \.+ 0/);
    expect(bloco).toMatch(/tasks-desabilitado \.+ 0/);

    // As porteiras 1 saem SEPARADAS, com o aviso de que não somam com candidatos.
    expect(texto).toContain('nunca somadas com candidatos');
    expect(texto).toContain('naoMarketplace');

    // As três tabelas de diagnóstico saem compactas, com os cinco baldes.
    expect(texto).toContain('marketplace.status armazenado');
    expect(texto).toContain('status armazenado × idade');
    expect(texto).toContain('status armazenado × veredito');
    expect(texto).toContain('7-14=0 14-30=1 30-60=0 60-90=0 90+=0');

    // Os efeitos são SOMADOS das contas — eles só existem por conta.
    expect(texto).toContain('chamadas get_order_detail');

    // E a linha do candidato, com a ordem de colunas estável.
    expect(texto).toContain(PEDIDO_ID);
    expect(texto).toContain('status=UNPAID');
    expect(texto).toContain('enfileiraria=não avisaria=sim');
  });

  it('a flag mestra desligada rende um relatório curto que NOMEIA a variável', () => {
    const texto = renderResumoVarredura(
      resultado({ enabled: false, motivo: 'flag-desligada', candidatos: 0, contas: [] }),
      [],
    ).join('\n');

    expect(texto).toContain('SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED');
    expect(texto).toContain('flag-desligada');
    // ⚠️ E NÃO finge ter medido nada: sem tabelas, sem vereditos.
    expect(texto).not.toContain('status armazenado × idade');
  });

  it('sem conta nenhuma no escopo o relatório diz isso em vez de imprimir vazio', () => {
    const texto = renderResumoVarredura(
      resultado({ contas: [], candidatos: 0, veredictos: zerarVeredictos() }),
      [],
    ).join('\n');
    expect(texto).toContain('nenhuma conta ATIVA no escopo');
    expect(texto).toContain('(nenhum)');
  });
});

/* ========================================================================== */
/*  o `--json`                                                                */
/* ========================================================================== */

describe('documentoVarredura', () => {
  it('`--json` é um único documento parseável sem nenhum dado do comprador', () => {
    const contaminado = {
      ...candidato(),
      buyer_username: SENTINELA_COMPRADOR,
      recipient_address: SENTINELA_ENDERECO,
    } as unknown as CandidatoObservado;

    const texto = JSON.stringify(
      documentoVarredura(resultado(), [resumoDoCandidato(contaminado)]),
      null,
      2,
    );

    // UM documento, e parseável de ponta a ponta.
    const lido = JSON.parse(texto) as {
      resultado: ReservaTravadaSweepResult;
      candidatos: CandidatoObservado[];
    };
    expect(lido.resultado.candidatos).toBe(1);
    expect(lido.candidatos).toHaveLength(1);
    expect(Object.keys(lido.candidatos[0]!).sort()).toEqual(
      [...CAMPOS_RESUMO_RESERVA_TRAVADA].sort(),
    );

    expect(texto).not.toContain(SENTINELA_COMPRADOR);
    expect(texto).not.toContain(SENTINELA_ENDERECO);
    expect(texto).not.toContain('buyer_');
    // ÂNCORA: o documento carrega mesmo os contadores que o ensaio lê.
    expect(lido.resultado.statusArmazenado.UNPAID).toBe(1);
  });
});

/* ========================================================================== */
/*  os erros                                                                  */
/* ========================================================================== */

describe('descreverErroVarredura', () => {
  it('descreve por CLASSE e imprime o uso num ArgumentoInvalidoError', () => {
    const linhas = descreverErroVarredura(new ArgumentoInvalidoError('opção desconhecida: --x'));
    expect(linhas[0]).toContain('opção desconhecida: --x');
    expect(linhas.join('\n')).toContain('varrer:reservas');
    // ⚠️ O uso DESTE CLI, nunca o do importador.
    expect(linhas.join('\n')).not.toContain('importar:pedido');
  });

  it('qualquer outra falha cai na tabela COMPARTILHADA do importador', () => {
    // ⚠️ Importada, nunca reimplementada: as CLIs deste app enfrentam a mesma
    // taxonomia de erro, e uma segunda cópia dessa tabela é como uma delas
    // começa a imprimir um payload.
    const linhas = descreverErroVarredura(new TypeError('x is not a function'));
    expect(linhas[0]).toContain('TypeError');
    expect(linhas.join('\n')).not.toContain('varrer:reservas');
  });
});
