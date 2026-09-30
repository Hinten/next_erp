import { describe, expect, it } from 'vitest';

import { MOTIVO_NFE_SHOPEE } from '../nfe/errosNfe';
import type { ResultadoEtiqueta } from './executarEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE, mensagemDoMotivoEtiqueta } from './motivosEtiqueta';
import {
  MENSAGEM_DA_FASE,
  nomeDoArquivoDeEtiqueta,
  type EtiquetaPendente,
} from './pendenteEtiqueta';
import {
  MENSAGEM_FORMATO_DESCONHECIDO,
  MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
  respostaDaEtiqueta,
} from './respostaEtiqueta';

const PACOTE = 'OFG000000000001';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0x80]);

function bytes(
  extra: Partial<Extract<ResultadoEtiqueta, { tipo: 'bytes' }>> = {},
): Extract<ResultadoEtiqueta, { tipo: 'bytes' }> {
  return {
    tipo: 'bytes',
    bytes: PDF,
    formato: 'pdf',
    contentType: 'application/pdf',
    extensao: 'pdf',
    indice: null,
    total: 1,
    ...extra,
  };
}

const PROGRESSO = { total: 1, organizados: 1, comRastreio: 0, prontos: 0 };

describe('MENSAGEM_DA_FASE — o texto congelado do reconcile §2.4', () => {
  it('cada fase tem exatamente a frase congelada', () => {
    expect(MENSAGEM_DA_FASE).toStrictEqual({
      programando: 'Organizando o envio na Shopee…',
      'aguardando-rastreio': 'Envio organizado; aguardando o código de rastreio da transportadora.',
      'gerando-documento': 'Envio organizado; a Shopee está gerando a etiqueta.',
      baixando: 'Baixando a etiqueta…',
      'renovando-credencial': 'Renovando o acesso à Shopee…',
      'limite-de-requisicoes':
        'A Shopee pediu uma pausa entre as chamadas; tentando de novo em instantes.',
      // Review 2 (F5): a READ that drops or runs out of budget reports this neutral
      // phase, never `programando`, which would read as a second arrange.
      consultando: 'Consultando a Shopee…',
    });
  });
});

describe('nomeDoArquivoDeEtiqueta', () => {
  it('o número do PEDIDO, sem sufixo num pedido de um pacote', () => {
    expect(nomeDoArquivoDeEtiqueta('260910KJBHUJDM', 'pdf', null, 1)).toBe(
      'etiqueta-shopee-260910KJBHUJDM.pdf',
    );
    expect(nomeDoArquivoDeEtiqueta('260910KJBHUJDM', 'zip', null, 1)).toBe(
      'etiqueta-shopee-260910KJBHUJDM.zip',
    );
    expect(nomeDoArquivoDeEtiqueta('260910KJBHUJDM', 'txt', null, 1)).toBe(
      'etiqueta-shopee-260910KJBHUJDM.txt',
    );
  });

  it('um número fora do guard [\\w.-]+ (aspas, espaço, %, não-latin1) ⇒ o nome sem número', () => {
    for (const ruim of ['26 09', '26"09', '26%09', 'pedido/1', 'número', '']) {
      expect(nomeDoArquivoDeEtiqueta(ruim, 'pdf', null, 1)).toBe('etiqueta-shopee.pdf');
    }
    expect(nomeDoArquivoDeEtiqueta(null, 'pdf', null, 1)).toBe('etiqueta-shopee.pdf');
    // Near-miss: `.`, `-` and `_` stay (the guard's own set).
    expect(nomeDoArquivoDeEtiqueta('a.b-c_d', 'pdf', null, 1)).toBe('etiqueta-shopee-a.b-c_d.pdf');
  });

  it('S45: o sufixo é a POSIÇÃO do pacote (-p1de2), nunca o número do pacote', () => {
    const nome = nomeDoArquivoDeEtiqueta('260910KJBHUJDM', 'pdf', 1, 2);
    expect(nome).toBe('etiqueta-shopee-260910KJBHUJDM-p1de2.pdf');
    expect(nome).not.toContain('OFG');
  });

  it('sem sufixo quando o índice é nulo, fora de 1…total, ou o pedido tem um pacote só', () => {
    expect(nomeDoArquivoDeEtiqueta('X', 'pdf', null, 2)).toBe('etiqueta-shopee-X.pdf');
    expect(nomeDoArquivoDeEtiqueta('X', 'pdf', 1, 1)).toBe('etiqueta-shopee-X.pdf');
    expect(nomeDoArquivoDeEtiqueta('X', 'pdf', 0, 2)).toBe('etiqueta-shopee-X.pdf');
    expect(nomeDoArquivoDeEtiqueta('X', 'pdf', 3, 2)).toBe('etiqueta-shopee-X.pdf');
    expect(nomeDoArquivoDeEtiqueta('X', 'pdf', 2, 2)).toBe('etiqueta-shopee-X-p2de2.pdf');
  });
});

describe('respostaDaEtiqueta — 200 bytes', () => {
  it('Content-Type EXATO do sniff, attachment com o nome, no-store; os bytes idênticos', async () => {
    const res = respostaDaEtiqueta(bytes(), { numero: '260910KJBHUJDM', nfe: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="etiqueta-shopee-260910KJBHUJDM.pdf"',
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toStrictEqual(PDF);
  });

  it('ZPL sai como text/plain PURO — sem charset (o agente compara a string)', () => {
    const res = respostaDaEtiqueta(
      bytes({ formato: 'zpl', contentType: 'text/plain', extensao: 'txt' }),
      { numero: 'N1', nfe: null },
    );
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="etiqueta-shopee-N1.txt"',
    );
  });

  it('um download por pacote leva -p<i>de<n> e nunca o número do pacote (S45)', () => {
    const res = respostaDaEtiqueta(bytes({ indice: 2, total: 2 }), { numero: 'N1', nfe: null });
    const disp = res.headers.get('Content-Disposition') ?? '';
    expect(disp).toBe('attachment; filename="etiqueta-shopee-N1-p2de2.pdf"');
    expect(disp).not.toContain(PACOTE);
  });
});

describe('respostaDaEtiqueta — 202 pendente', () => {
  it('o corpo VERBATIM, com no-store', async () => {
    const corpo: EtiquetaPendente = {
      acao: 'escolher-envio',
      fase: 'programando',
      pacote: PACOTE,
      pacoteRotulo: 'Pacote 1 de 2',
      mensagem: 'm',
      enderecos: [{ id: '2001', rotulo: 'Rua do Vendedor', principal: true, horarios: [] }],
      permiteDropoff: true,
      escolhaInvalida: false,
      progresso: PROGRESSO,
    };
    const res = respostaDaEtiqueta({ tipo: 'pendente', corpo }, { numero: 'N1', nfe: null });
    expect(res.status).toBe(202);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toStrictEqual(corpo);
  });
});

describe('respostaDaEtiqueta — 409 recusa', () => {
  it('{error, code, motivo, mensagem} com a frase do motivo; tentarApos só quando existe', async () => {
    const res = respostaDaEtiqueta(
      { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.janelaFechada },
      { numero: 'N1', nfe: null },
    );
    expect(res.status).toBe(409);
    const mensagem = mensagemDoMotivoEtiqueta('janela-fechada');
    expect(await res.json()).toStrictEqual({
      error: mensagem,
      code: 'SHOPEE_ETIQUETA_RECUSADA',
      motivo: 'janela-fechada',
      mensagem,
    });

    const diario = respostaDaEtiqueta(
      {
        tipo: 'recusa',
        motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
        tentarApos: 1_790_000_000_000,
      },
      { numero: 'N1', nfe: null },
    );
    expect(await diario.json()).toMatchObject({
      motivo: 'limite-diario',
      tentarApos: 1_790_000_000_000,
    });
  });

  it('R3-F1 PAR: uma `recusa-desconhecida` com `shopeeCode` leva o código no 409 — e nunca a operação', async () => {
    const res = respostaDaEtiqueta(
      {
        tipo: 'recusa',
        motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
        shopeeCode: 'some_new_code',
        operacao: 'programar',
      },
      { numero: 'N1', nfe: null },
    );
    const mensagem = mensagemDoMotivoEtiqueta('recusa-desconhecida');
    expect(await res.json()).toStrictEqual({
      error: mensagem,
      code: 'SHOPEE_ETIQUETA_RECUSADA',
      motivo: 'recusa-desconhecida',
      mensagem,
      shopeeCode: 'some_new_code',
    });
  });

  it('R3-F1 QUASE-MISS: a mesma recusa SEM `shopeeCode` não inventa a chave', async () => {
    const res = respostaDaEtiqueta(
      { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida, operacao: 'programar' },
      { numero: 'N1', nfe: null },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect('shopeeCode' in body).toBe(false);
    expect('operacao' in body).toBe(false);
  });

  it('nfe-pendente leva o desfecho do reenvio em `nfe` e na mensagem', async () => {
    const res = respostaDaEtiqueta(
      { tipo: 'nfe-pendente' },
      { numero: 'N1', nfe: { desfecho: 'enfileirado', atrasoSegundos: 0 } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('SHOPEE_ETIQUETA_RECUSADA');
    expect(body.motivo).toBe('nfe-pendente');
    expect(body.nfe).toStrictEqual({ desfecho: 'enfileirado', atrasoSegundos: 0 });
    expect(body.mensagem).toContain(mensagemDoMotivoEtiqueta('nfe-pendente'));
    expect(body.mensagem).toContain('reenviou');
    expect(body.error).toBe(body.mensagem);

    const semPermissao = respostaDaEtiqueta(
      { tipo: 'nfe-pendente' },
      { numero: 'N1', nfe: { desfecho: 'sem-permissao' } },
    );
    const b2 = (await semPermissao.json()) as Record<string, unknown>;
    expect(b2.nfe).toStrictEqual({ desfecho: 'sem-permissao' });
    expect(b2.mensagem).not.toContain('reenviou');
  });

  it('R1-F2 PAR: `nao-elegivel` por `sem-nfe-aprovada` pede a EMISSÃO — nenhum aviso é citado (nada foi enviado)', async () => {
    const res = respostaDaEtiqueta(
      { tipo: 'nfe-pendente' },
      {
        numero: 'N1',
        nfe: { desfecho: 'nao-elegivel', motivoNfe: MOTIVO_NFE_SHOPEE.semNfeAprovada },
      },
    );
    const body = (await res.json()) as Record<string, unknown>;
    const mensagem = String(body.mensagem);
    expect(mensagem.startsWith(`${mensagemDoMotivoEtiqueta('nfe-pendente')} `)).toBe(true);
    expect(mensagem).toContain('emita a NF-e do pedido e clique em Imprimir de novo');
    expect(mensagem).not.toContain('aviso');
    expect(body.nfe).toStrictEqual({
      desfecho: 'nao-elegivel',
      motivoNfe: MOTIVO_NFE_SHOPEE.semNfeAprovada,
    });
  });

  it('R1-F2 QUASE-MISS: `nao-elegivel` por `emissao-bloqueada` mantém a frase do AVISO, e não pede emissão', async () => {
    const res = respostaDaEtiqueta(
      { tipo: 'nfe-pendente' },
      {
        numero: 'N1',
        nfe: { desfecho: 'nao-elegivel', motivoNfe: MOTIVO_NFE_SHOPEE.emissaoBloqueada },
      },
    );
    const mensagem = String(((await res.json()) as Record<string, unknown>).mensagem);
    expect(mensagem).toContain('confira o aviso de NF-e do pedido');
    expect(mensagem).not.toContain('emita a NF-e');
  });

  it('nfe-pendente sem desfecho não inventa a chave `nfe`', async () => {
    const res = respostaDaEtiqueta({ tipo: 'nfe-pendente' }, { numero: 'N1', nfe: null });
    const body = (await res.json()) as Record<string, unknown>;
    expect('nfe' in body).toBe(false);
    expect(body.mensagem).toBe(mensagemDoMotivoEtiqueta('nfe-pendente'));
  });
});

describe('respostaDaEtiqueta — 403 e 502', () => {
  it('403 SHOPEE_ETIQUETA_SEM_PERMISSAO com motivo programar-envio', async () => {
    const res = respostaDaEtiqueta({ tipo: 'sem-permissao' }, { numero: 'N1', nfe: null });
    expect(res.status).toBe(403);
    expect(await res.json()).toStrictEqual({
      error: MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
      code: 'SHOPEE_ETIQUETA_SEM_PERMISSAO',
      motivo: 'programar-envio',
      mensagem: MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
    });
  });

  it('S44: formato desconhecido é 502 JSON, NUNCA application/octet-stream', async () => {
    const res = respostaDaEtiqueta({ tipo: 'formato-desconhecido' }, { numero: 'N1', nfe: null });
    expect(res.status).toBe(502);
    expect(res.headers.get('Content-Type')).not.toContain('octet-stream');
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toStrictEqual({
      error: MENSAGEM_FORMATO_DESCONHECIDO,
      code: 'SHOPEE_ETIQUETA_FORMATO_DESCONHECIDO',
    });
  });
});
