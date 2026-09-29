/**
 * Unit tests for the NF-e notification mappers. Pure functions, no
 * DOM — testing the PT-BR mapping + color choice for every typed
 * error class + every estado.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeCertificateError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  NFeXsdValidationFailedError,
  type NFeEmitResult,
} from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE, IE_SENTINELA, TIPO_CLIENTE, type TipoCliente } from '@delfrance/schemas';

import {
  ID_DEST,
  IND_IE_DEST,
  lerDestinatarioNFe,
  type DestinatarioNFe,
  type IdDest,
  type IndIEDest,
} from './destinatarioNFe';
import {
  CSTAT_DESTINATARIO_ISENTO_RECUSADO,
  cadastroAindaDeclaraIsento,
  notificationForNFeError,
  notificationForNFeErrorComContexto,
  notificationForNFeResult,
  orientacaoRejeicaoNFe,
  rejeicaoPrecisaContexto,
  type CadastroClienteRejeicao,
  type CarregarContextoRejeicao,
  type ClienteDaRejeicao,
  type ContextoRejeicaoNFe,
} from './errors';
import { nfeAssinadoXml } from './nfeAssinadoFixture';

function emitResult(over: Partial<NFeEmitResult> = {}): NFeEmitResult {
  return {
    nfeId: 'nfev4-001',
    pedidoId: 'PED-001',
    estado: ESTADO_NFE.aprovada,
    chave: '35260514200166000187550010000000071000000018',
    nRec: '12345',
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    ...over,
  };
}

describe('notificationForNFeResult', () => {
  it('maps estado=aprovada → green with protocol', () => {
    const n = notificationForNFeResult(emitResult());
    expect(n.color).toBe('green');
    expect(n.title).toBe('NF-e autorizada');
    expect(n.message).toContain('12345');
    expect(n.message).toContain('100');
  });

  it('falls back to last-15 of chave when nRec is null on aprovada', () => {
    const n = notificationForNFeResult(emitResult({ nRec: null }));
    expect(n.message).toContain('071000000018');
  });

  it('maps estado=enviando → blue', () => {
    const n = notificationForNFeResult(
      emitResult({ estado: ESTADO_NFE.enviando, cStat: '103', xMotivo: 'Lote recebido' }),
    );
    expect(n.color).toBe('blue');
    expect(n.title).toBe('NF-e em processamento');
  });

  it('maps estado=aguardandoResposta → blue', () => {
    const n = notificationForNFeResult(
      emitResult({ estado: ESTADO_NFE.aguardandoResposta, cStat: '105' }),
    );
    expect(n.color).toBe('blue');
  });

  it('maps estado=rejeitada → red (defensive — 422 normally throws NFeRejectedError)', () => {
    const n = notificationForNFeResult(
      emitResult({ estado: ESTADO_NFE.rejeitada, cStat: '226', xMotivo: 'UF inválida' }),
    );
    expect(n.color).toBe('red');
    expect(n.message).toContain('226');
    expect(n.message).toContain('UF inválida');
  });

  it('maps unknown estado → gray fallback', () => {
    const n = notificationForNFeResult(emitResult({ estado: '9' as never }));
    expect(n.color).toBe('gray');
    expect(n.title).toBe('NF-e enviada');
  });

  it('maps estado=epecAprovado (cStat 135/136) → teal EPEC-registered toast with next step', () => {
    const n = notificationForNFeResult(
      emitResult({
        estado: ESTADO_NFE.epecAprovado,
        cStat: '136',
        xMotivo: 'Evento registrado, mas nao vinculado a NF-e',
        nRec: null,
      }),
    );
    expect(n.color).toBe('teal');
    expect(n.title).toBe('EPEC registrado');
    expect(n.message).toContain('136');
    expect(n.message).toContain('transmitir a NF-e completa');
  });

  it("maps estado=epecAprovado + cStat 468 → yellow 'não sincronizado' wait-and-retry toast", () => {
    const n = notificationForNFeResult(
      emitResult({
        estado: ESTADO_NFE.epecAprovado,
        cStat: '468',
        xMotivo: 'Rejeição: EPEC não Sincronizado na Base de Dados da SEFAZ Autorizadora',
        nRec: null,
      }),
    );
    expect(n.color).toBe('yellow');
    expect(n.title).toBe('EPEC ainda não sincronizado na SEFAZ');
    expect(n.message).toContain('cStat=468');
    expect(n.message).toContain('Aguarde alguns minutos');
  });

  it('reused=true → yellow "já emitida" toast (dedup skip), overrides estado branch', () => {
    const n = notificationForNFeResult(emitResult({ reused: true }));
    expect(n.color).toBe('yellow');
    expect(n.title).toBe('NFe já emitida');
    expect(n.message).toContain('pulada');
    expect(n.message).toContain('100');
  });
});

describe('notificationForNFeError', () => {
  it('NFeRejectedError → red with cStat + xMotivo', () => {
    const err = new NFeRejectedError('226', 'UF inválida', { foo: 'bar' });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('SEFAZ rejeitou a NF-e');
    expect(n.message).toContain('226');
    expect(n.message).toContain('UF inválida');
  });

  it('NFeCertificateError → cert toast with the pt-BR message, never framed as SEFAZ', () => {
    const err = new NFeCertificateError(
      "Filial 'dev-filial-01' não possui certificado digital cadastrado. " +
        'Faça o upload do certificado A1 na aba "Certificado Digital" da filial.',
      422,
      { code: 'NFeCertError' },
      'NFeCertError',
    );
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Certificado digital da filial');
    expect(n.message).toContain('não possui certificado digital');
    expect(n.message).not.toMatch(/SEFAZ/i);
  });

  it('NFeBlockedError → yellow', () => {
    const err = new NFeBlockedError('PED-001', { error: 'bloqueada' });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('yellow');
    expect(n.title).toBe('Pedido bloqueado');
  });

  it('NFePedidoNotFoundError → red carrying the pedidoId', () => {
    const err = new NFePedidoNotFoundError('PED-MISSING', { error: 'nope' });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.message).toContain('PED-MISSING');
  });

  it('NFeAuthError 401 → Sessão inválida, surfaces server message', () => {
    const err = new NFeAuthError('Token inválido ou expirado.', 401, {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Sessão inválida');
    expect(n.message).toBe('Token inválido ou expirado.');
  });

  it('NFeAuthError 403 → Sem permissão, surfaces server message', () => {
    const err = new NFeAuthError('Sem permissão para esta operação.', 403, {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Sem permissão');
    expect(n.message).toBe('Sem permissão para esta operação.');
  });

  it('NFeRuntimeNotReadyError → surfaces body.code as the message', () => {
    const err = new NFeRuntimeNotReadyError('NF-e runtime not ready', {
      error: 'NF-e runtime not ready',
      code: "Failed to read certificate file at '/some/path/cert.pfx'",
    });
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Servidor NF-e indisponível');
    expect(n.message).toBe("Failed to read certificate file at '/some/path/cert.pfx'");
  });

  it('NFeRuntimeNotReadyError → falls back to generic message when body has no code', () => {
    const err = new NFeRuntimeNotReadyError('NF-e runtime not ready', {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Servidor NF-e indisponível');
    expect(n.message).toContain('certificado, chain TLS ou runtime');
  });

  it('NFeBadRequestError → red with the underlying message', () => {
    const err = new NFeBadRequestError('pedidoId deve ser uma string', {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Requisição inválida');
    expect(n.message).toBe('pedidoId deve ser uma string');
  });

  it('NFeNetworkError → red', () => {
    const err = new NFeNetworkError('Failed to fetch');
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro de rede');
  });

  it('NFeServerError → red with the underlying message', () => {
    const err = new NFeServerError('transport failed', 500, {});
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro no servidor de NF-e');
    expect(n.message).toBe('transport failed');
  });

  it('NFeXsdValidationFailedError → schema toast, not the generic server error (#1602)', () => {
    // An emission whose XML fails the XSD also reaches the client coded
    // `NFeXsdValidationError`, so it maps here instead of to NFeServerError.
    const err = new NFeXsdValidationFailedError(
      "XSD validation failed for <NFe>: Element 'xNome': [facet 'maxLength']",
      500,
      {},
    );
    const n = notificationForNFeError(err);
    expect(n.color).toBe('red');
    expect(n.title).toBe('XML fora do schema da SEFAZ');
    expect(n.message).toContain('<NFe>');
  });

  it('generic Error → red fallback', () => {
    const n = notificationForNFeError(new Error('algo deu errado'));
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro inesperado');
    expect(n.message).toBe('algo deu errado');
  });

  it('non-Error thrown value → red with generic message', () => {
    const n = notificationForNFeError('weird');
    expect(n.color).toBe('red');
    expect(n.title).toBe('Erro inesperado');
    expect(n.message).toContain('desconhecida');
  });
});

// ---------------------------------------------------------------------------
// cStat 805 — "destinatário isento de IE" guidance (#852)
// ---------------------------------------------------------------------------

const XMOTIVO_805 =
  'Rejeição: A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição Estadual';
const ALVO = { pedidoId: 'ped-1', nfeId: 'nfev4-1' } as const;

function rejeicao(cStat: string, body: unknown = { ...ALVO, estado: ESTADO_NFE.rejeitada }) {
  return new NFeRejectedError(cStat, XMOTIVO_805, body);
}

/** Today's generic 422 toast — the shape every non-guided path must keep, byte for byte. */
function generico(cStat: string, xMotivo = XMOTIVO_805) {
  return { title: 'SEFAZ rejeitou a NF-e', message: `cStat=${cStat}: ${xMotivo}`, color: 'red' };
}

function destinatario(
  over: { idDest?: IdDest; indIEDest?: IndIEDest; uf?: string | null } = {},
): DestinatarioNFe {
  return {
    idDest: over.idDest ?? ID_DEST.interna,
    indIEDest: over.indIEDest ?? IND_IE_DEST.isento,
    uf: over.uf === undefined ? 'SP' : over.uf,
  };
}

function cadastro(
  over: { nome?: string | null; tipo?: TipoCliente | null; ie?: string | null } = {},
): CadastroClienteRejeicao {
  return {
    nome: over.nome === undefined ? 'ACME LTDA' : over.nome,
    tipo: over.tipo === undefined ? TIPO_CLIENTE.pessoaJuridica : over.tipo,
    ie: over.ie === undefined ? IE_SENTINELA.isento : over.ie,
  };
}

function contexto(
  over: {
    destinatario?: DestinatarioNFe | null;
    cliente?: ClienteDaRejeicao | null;
  } = {},
): ContextoRejeicaoNFe {
  return {
    destinatario: over.destinatario === undefined ? destinatario() : over.destinatario,
    cliente: over.cliente === undefined ? { id: 'cli-1', cadastro: cadastro() } : over.cliente,
  };
}

describe('rejeicaoPrecisaContexto', () => {
  it('matches exactly cStat 805', () => {
    expect(CSTAT_DESTINATARIO_ISENTO_RECUSADO).toBe('805');
    expect(rejeicaoPrecisaContexto('805')).toBe(true);
  });

  it.each(['804', '8050', '085', ' 805', '805 ', '226', '', null, undefined])(
    'near-miss %j → false',
    (cStat) => {
      expect(rejeicaoPrecisaContexto(cStat)).toBe(false);
    },
  );
});

describe('notificationForNFeError — cStat 805 guidance', () => {
  it('805 + idDest=1 + ISENTO cadastro → past-tense fix-it guidance naming the cliente, linking the cadastro', () => {
    const n = notificationForNFeError(rejeicao('805'), contexto());

    expect(n.title).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
    expect(n.color).toBe('red');
    // The verbatim SEFAZ outcome stays first and copy-pasteable.
    expect(n.message.startsWith('cStat=805: Rejeição: A SEFAZ do destinatário')).toBe(true);
    expect(n.message).toContain(' — A NF-e foi enviada com o cliente ACME LTDA');
    expect(n.message).toContain('foi enviada');
    expect(n.message).toContain('ACME LTDA');
    expect(n.message).toContain('SEFAZ-SP');
    expect(n.message).toContain('operação interna');
    expect(n.message).toContain(IE_SENTINELA.naoContribuinte);
    expect(n.message).toContain('Buscar dados do CNPJ');
    expect(n.message).toContain('consumidor final');
    // Never states today's cadastro as fact.
    expect(n.message).not.toContain('está marcada');
    expect(n.message).not.toContain('interestadual');
    expect(n.link).toEqual({ href: '/clientes/cli-1', label: 'Abrir cadastro de ACME LTDA' });
  });

  it('owner decision: 805 + idDest=2 → interstate guidance for the destinatário UF, never "operação interna"', () => {
    const n = notificationForNFeError(
      rejeicao('805'),
      contexto({ destinatario: destinatario({ idDest: ID_DEST.interestadual, uf: 'MG' }) }),
    );

    expect(n.title).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
    expect(n.message).toContain(
      'a SEFAZ-MG, UF do destinatário, não aceita em operação interestadual',
    );
    expect(n.message).toContain('interestadual');
    expect(n.message).not.toContain('operação interna');
    expect(n.link?.href).toBe('/clientes/cli-1');
  });

  it('805 + idDest=3 (exterior) → the generic toast, no link', () => {
    const n = notificationForNFeError(
      rejeicao('805'),
      contexto({ destinatario: destinatario({ idDest: ID_DEST.exterior }) }),
    );
    expect(n).toStrictEqual(generico('805'));
  });

  it('805 without context → byte-identical to the pre-#852 toast (regression guard)', () => {
    const err = rejeicao('805');
    expect(notificationForNFeError(err)).toStrictEqual(generico('805'));
    expect(notificationForNFeError(err, null)).toStrictEqual(generico('805'));
    expect(notificationForNFeError(err, contexto({ destinatario: null }))).toStrictEqual(
      generico('805'),
    );
  });

  it.each([IND_IE_DEST.naoContribuinte, IND_IE_DEST.contribuinte])(
    'near-miss: 805 whose XML says indIEDest=%s → generic',
    (indIEDest) => {
      const n = notificationForNFeError(
        rejeicao('805'),
        contexto({ destinatario: destinatario({ indIEDest }) }),
      );
      expect(n).toStrictEqual(generico('805'));
    },
  );

  it.each(['804', '8050', '085', ' 805'])(
    'near-miss: cStat %j with a full 805 context → generic',
    (cStat) => {
      expect(notificationForNFeError(rejeicao(cStat), contexto())).toStrictEqual(generico(cStat));
      expect(orientacaoRejeicaoNFe(cStat, contexto())).toBeNull();
    },
  );

  it('regression: cStat 226 with or without a context → the unchanged generic toast', () => {
    const err = new NFeRejectedError('226', 'Rejeição: Código da UF do Emitente diverge', {});
    const esperado = generico('226', 'Rejeição: Código da UF do Emitente diverge');
    expect(notificationForNFeError(err)).toStrictEqual(esperado);
    expect(notificationForNFeError(err, contexto())).toStrictEqual(esperado);
  });

  it('end to end: the context read from a signed homologação NF-e drives the guidance', () => {
    const lido = lerDestinatarioNFe(nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest: 'SP' }));
    const n = notificationForNFeError(rejeicao('805'), contexto({ destinatario: lido }));
    expect(n.title).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
    expect(n.message).toContain('SEFAZ-SP');
    expect(n.message).not.toContain('HOMOLOGACAO');
  });

  describe('the cadastro fold (mirror of the generator ladder, parties.ts)', () => {
    it.each(['ISENTO', ' isento ', 'Isento', 'isento', 'ISENTO  ', 'Ísento'])(
      'equal side: PJ with ie %j still declares ISENTO → corrigirCadastro',
      (ie) => {
        const c = cadastro({ ie });
        expect(cadastroAindaDeclaraIsento(c)).toBe(true);

        const o = orientacaoRejeicaoNFe('805', contexto({ cliente: { id: 'cli-1', cadastro: c } }));
        expect(o?.situacao).toBe('corrigirCadastro');
        expect(o?.cor).toBe('red');
        expect(o?.titulo).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
      },
    );

    it.each([
      'ISENTOS',
      'ISENTO 1',
      'ISENT',
      '123456789',
      'NAO CONTRIBUINTE',
      'Não contribuinte',
      null,
      '',
      '   ',
    ])('near-miss side: PJ with ie %j no longer yields indIEDest=2 → reemitir', (ie) => {
      const c = cadastro({ ie });
      expect(cadastroAindaDeclaraIsento(c)).toBe(false);

      const ctx = contexto({ cliente: { id: 'cli-1', cadastro: c } });
      const o = orientacaoRejeicaoNFe('805', ctx);
      expect(o?.situacao).toBe('reemitir');
      expect(o?.cor).toBe('yellow');

      const n = notificationForNFeError(rejeicao('805'), ctx);
      expect(n.title).toBe('Cadastro do cliente já alterado');
      expect(n.message.startsWith(`cStat=805: ${XMOTIVO_805} — `)).toBe(true);
      expect(n.message).toContain('foi enviada');
      expect(n.message).toContain('emita a NF-e novamente');
      expect(n.message).not.toContain('Corrija o cadastro');
      // The toast stays red either way; yellow is the persistent surfaces' cue.
      expect(n.color).toBe('red');
      expect(n.link).toEqual({ href: '/clientes/cli-1', label: 'Abrir cadastro de ACME LTDA' });
    });

    it.each([TIPO_CLIENTE.pessoaFisica, TIPO_CLIENTE.estrangeiro, null])(
      'near-miss side: tipo %j with ie ISENTO → the generator yields 9 → reemitir',
      (tipo) => {
        const c = cadastro({ tipo, ie: IE_SENTINELA.isento });
        expect(cadastroAindaDeclaraIsento(c)).toBe(false);
        expect(
          orientacaoRejeicaoNFe('805', contexto({ cliente: { id: 'cli-1', cadastro: c } }))
            ?.situacao,
        ).toBe('reemitir');
      },
    );
  });

  it('cadastro null (read failed / doc missing) → past-tense corrigirCadastro, id-only link', () => {
    const n = notificationForNFeError(
      rejeicao('805'),
      contexto({ cliente: { id: 'cli-1', cadastro: null } }),
    );
    expect(n.title).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
    expect(n.message).toContain('A NF-e foi enviada com o cliente deste pedido');
    expect(n.link).toEqual({ href: '/clientes/cli-1', label: 'Abrir cadastro do cliente' });
  });

  it('a blank nome reads as unknown, never as "o cliente " + blank', () => {
    const n = notificationForNFeError(
      rejeicao('805'),
      contexto({ cliente: { id: 'cli-1', cadastro: cadastro({ nome: '   ' }) } }),
    );
    expect(n.message).toContain('o cliente deste pedido');
    expect(n.link?.label).toBe('Abrir cadastro do cliente');
  });

  it('cliente null → "o cliente deste pedido" and no link', () => {
    const n = notificationForNFeError(rejeicao('805'), contexto({ cliente: null }));
    expect(n.title).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
    expect(n.message).toContain('o cliente deste pedido');
    expect(n.link).toBeNull();
  });

  it('uf null → "a SEFAZ do destinatário", never "SEFAZ-null"', () => {
    const interna = notificationForNFeError(
      rejeicao('805'),
      contexto({ destinatario: destinatario({ uf: null }) }),
    );
    expect(interna.message).toContain(
      'o que a SEFAZ do destinatário não aceita em operação interna.',
    );
    expect(interna.message).not.toContain('SEFAZ-null');
    expect(interna.message).not.toContain('undefined');

    const interestadual = notificationForNFeError(
      rejeicao('805'),
      contexto({ destinatario: destinatario({ idDest: ID_DEST.interestadual, uf: null }) }),
    );
    expect(interestadual.message).toContain(
      'o que a SEFAZ do destinatário não aceita em operação interestadual.',
    );
    expect(interestadual.message).not.toContain('SEFAZ-null');
  });
});

describe('notificationForNFeErrorComContexto', () => {
  function loader(ctx: ContextoRejeicaoNFe = contexto()) {
    return vi.fn<CarregarContextoRejeicao>(() => Promise.resolve(ctx));
  }

  it('cStat 226 → the sync mapping, loader NOT called', async () => {
    const carregar = loader();
    const err = new NFeRejectedError('226', 'UF inválida', { ...ALVO });
    await expect(notificationForNFeErrorComContexto(err, carregar)).resolves.toStrictEqual(
      notificationForNFeError(err),
    );
    expect(carregar).not.toHaveBeenCalled();
  });

  it('NFeNetworkError → the sync mapping, loader NOT called', async () => {
    const carregar = loader();
    const err = new NFeNetworkError('Failed to fetch');
    await expect(notificationForNFeErrorComContexto(err, carregar)).resolves.toStrictEqual(
      notificationForNFeError(err),
    );
    expect(carregar).not.toHaveBeenCalled();
  });

  it.each([
    ['no nfeId', { pedidoId: 'ped-1' }],
    ['no pedidoId', { nfeId: 'nfev4-1' }],
    ['an empty nfeId', { pedidoId: 'ped-1', nfeId: '' }],
    ['a numeric nfeId', { pedidoId: 'ped-1', nfeId: 7 }],
    ['a null body', null],
    ['a string body', 'Rejeição'],
  ])('805 whose body has %s → generic, loader NOT called', async (_label, body) => {
    const carregar = loader();
    const n = await notificationForNFeErrorComContexto(rejeicao('805', body), carregar);
    expect(n).toStrictEqual(generico('805'));
    expect(carregar).not.toHaveBeenCalled();
  });

  it('805 with {pedidoId, nfeId} → loader called once with exactly those ids; its context drives the guidance', async () => {
    const carregar = loader();
    const err = rejeicao('805', {
      ...ALVO,
      estado: ESTADO_NFE.rejeitada,
      cStat: '805',
      xMotivo: XMOTIVO_805,
    });

    const n = await notificationForNFeErrorComContexto(err, carregar);

    expect(carregar).toHaveBeenCalledTimes(1);
    expect(carregar).toHaveBeenCalledWith({ pedidoId: 'ped-1', nfeId: 'nfev4-1' });
    expect(n.title).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
    expect(n.message).toContain('ACME LTDA');
    expect(n.link?.href).toBe('/clientes/cli-1');
  });

  it('805 whose loaded context has no readable XML → generic', async () => {
    const carregar = loader(contexto({ destinatario: null }));
    const n = await notificationForNFeErrorComContexto(rejeicao('805'), carregar);
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(n).toStrictEqual(generico('805'));
  });

  it('a loader rejection propagates (the Firestore loader already degrades FirebaseError)', async () => {
    const boom = new TypeError('bug');
    const carregar = vi.fn<CarregarContextoRejeicao>(() => Promise.reject(boom));
    await expect(notificationForNFeErrorComContexto(rejeicao('805'), carregar)).rejects.toBe(boom);
  });
});
