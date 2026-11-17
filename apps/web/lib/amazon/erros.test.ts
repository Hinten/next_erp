import { describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ETIQUETA_AMAZON,
  motivoEtiquetaAmazonSchema,
} from '@delfrance/schemas';

import {
  AmazonBackendError,
  AmazonRedeError,
  AmazonRespostaInvalidaError,
  MENSAGEM_ETIQUETA_AMAZON_AGUARDE,
  MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO,
  MENSAGENS_CODIGO_ERRO_AMAZON,
  MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON,
  MENSAGENS_MOTIVO_ETIQUETA_AMAZON,
  ehCodigoErroAmazon,
  ehCodigoErroEtiquetaAmazon,
  mensagemErroAmazon,
  mensagemErroEtiquetaAmazon,
  mensagemHttpAmazon,
  mensagemHttpEtiquetaAmazon,
  repetivelAmazon,
} from './erros';

/**
 * The copy for a failed call to `apps/amazon`, TOTAL over the two code families
 * the conta routes answer with: the routes' own `CODIGO_ERRO_AMAZON`, and
 * `verifyCaller`'s (`auth/…` on a 401, `app/…` on a 500, plus its codeless
 * 401/403).
 *
 * The contract's codes are transcribed LITERALLY below rather than derived from
 * the map under test — deriving them would make the totality test pass for
 * whatever the map happens to contain.
 */
const CODIGOS_DO_CONTRATO = [
  'AMAZON_ID_INVALIDO',
  'AMAZON_CONTA_NAO_ENCONTRADA',
  'AMAZON_CHAMADAS_DESLIGADAS',
  'AMAZON_CONFIG_AUSENTE',
] as const;

const MENSAGEM_DO_BACKEND = 'Frase do backend que não deve aparecer quando há cópia própria.';

function erro(status: number, codigo: string | null, message = MENSAGEM_DO_BACKEND) {
  return new AmazonBackendError(message, status, codigo);
}

describe('MENSAGENS_CODIGO_ERRO_AMAZON — total over the contract', () => {
  it('covers the contract exactly — no code missing, none invented', () => {
    expect(Object.values(CODIGO_ERRO_AMAZON).sort()).toEqual([...CODIGOS_DO_CONTRATO].sort());
    expect(Object.keys(MENSAGENS_CODIGO_ERRO_AMAZON).sort()).toEqual(
      [...CODIGOS_DO_CONTRATO].sort(),
    );
  });

  it.each(CODIGOS_DO_CONTRATO)('gives %s its own pt-BR copy, never the raw code', (codigo) => {
    const copia = mensagemErroAmazon(erro(400, codigo));
    expect(copia.length).toBeGreaterThan(30);
    expect(copia).not.toContain(codigo);
    expect(copia).not.toContain('undefined');
  });

  it('the switch-off copy says nothing was sent and that retrying cannot help by itself', () => {
    const copia = mensagemErroAmazon(erro(503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS));
    expect(copia).toContain('desligada até a virada');
    expect(copia).toContain('Nada foi enviado');
    // Not the backend's sentence: the copy is keyed on the code.
    expect(copia).not.toContain(MENSAGEM_DO_BACKEND);
  });

  it('CONFIG_AUSENTE appends the backend sentence — variable NAMES, which say what to set', () => {
    const copia = mensagemErroAmazon(
      erro(
        500,
        CODIGO_ERRO_AMAZON.CONFIG_AUSENTE,
        'Configuração da Amazon ausente ou inválida neste backend: AMAZON_APPLICATION_ID.',
      ),
    );
    expect(copia).toContain('deploy');
    expect(copia).toContain('AMAZON_APPLICATION_ID');
  });

  it('the near miss: no OTHER code echoes the backend sentence', () => {
    for (const codigo of CODIGOS_DO_CONTRATO.filter((c) => c !== 'AMAZON_CONFIG_AUSENTE')) {
      expect(mensagemErroAmazon(erro(400, codigo))).not.toContain(MENSAGEM_DO_BACKEND);
    }
  });
});

describe("verifyCaller's codes", () => {
  it.each(['auth/id-token-expired', 'auth/id-token-revoked', 'auth/argument-error'])(
    'a 401 coded %s asks the operator to sign in again',
    (codigo) => {
      const copia = mensagemErroAmazon(erro(401, codigo));
      expect(copia).toContain('entre de novo');
      expect(copia).not.toContain(MENSAGEM_DO_BACKEND);
    },
  );

  it('a 500 coded app/… is a server configuration problem, not a session problem', () => {
    const copia = mensagemErroAmazon(erro(500, 'app/invalid-credential'));
    expect(copia).toContain('deploy');
    expect(copia).not.toContain('entre de novo');
  });

  it('the codeless 401 (no Bearer token) is the session copy, from the status', () => {
    expect(mensagemErroAmazon(erro(401, null))).toContain('entre de novo');
  });

  it('the codeless 403 (missing permission) says which permission', () => {
    const copia = mensagemErroAmazon(erro(403, null));
    expect(copia).toContain('permissão');
    expect(copia).toContain('integrações');
  });

  it('⚠️ near miss: a code that merely CONTAINS "auth/" is not a Firebase Auth code', () => {
    expect(mensagemErroAmazon(erro(400, 'AMAZON_X_auth/y'))).toBe(MENSAGEM_DO_BACKEND);
  });
});

describe('codes and bodies this build does not know', () => {
  it("a code a newer backend added shows the backend's own (pt-BR) sentence", () => {
    expect(mensagemErroAmazon(erro(409, 'AMAZON_CODIGO_NOVO'))).toBe(MENSAGEM_DO_BACKEND);
  });

  it('a codeless body falls to the status — never a raw body', () => {
    expect(mensagemErroAmazon(erro(404, null))).toContain('HTTP 404');
    expect(mensagemErroAmazon(erro(502, null))).toContain('HTTP 502');
    expect(mensagemErroAmazon(erro(418, null))).toContain('HTTP 418');
  });

  it('an unreadable 2xx keeps the sentence the client built for it', () => {
    const err = new AmazonRespostaInvalidaError('Frase do cliente.', 200, ['connected']);
    expect(mensagemErroAmazon(err)).toBe('Frase do cliente.');
  });

  it('ehCodigoErroAmazon refuses inherited keys', () => {
    expect(ehCodigoErroAmazon('constructor')).toBe(false);
    expect(ehCodigoErroAmazon('__proto__')).toBe(false);
    expect(ehCodigoErroAmazon(null)).toBe(false);
    expect(ehCodigoErroAmazon(CODIGO_ERRO_AMAZON.ID_INVALIDO)).toBe(true);
  });

  it('mensagemHttpAmazon never prints undefined', () => {
    for (const status of [400, 401, 403, 404, 409, 500, 501, 503, 504]) {
      expect(mensagemHttpAmazon(status)).not.toContain('undefined');
    }
  });
});

describe('repetivelAmazon', () => {
  it('a codeless 5xx may be transient', () => {
    expect(repetivelAmazon(erro(502, null))).toBe(true);
    expect(repetivelAmazon(erro(503, null))).toBe(true);
  });

  it('⚠️ near miss: the switch-off 503 is NOT — it answers the same until someone acts', () => {
    expect(repetivelAmazon(erro(503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS))).toBe(false);
  });

  it('a 501, a 4xx, an Admin init 500 and an unreadable 2xx are never repeatable', () => {
    expect(repetivelAmazon(erro(501, null))).toBe(false);
    expect(repetivelAmazon(erro(404, null))).toBe(false);
    expect(repetivelAmazon(erro(500, 'app/invalid-credential'))).toBe(false);
    expect(repetivelAmazon(new AmazonRespostaInvalidaError('x', 200, []))).toBe(false);
  });

  it('⚠️ an unreadable answer is never repeatable WHATEVER its status (narrowed first)', () => {
    // A 5xx-looking status is what a codeless base error retries on, so only
    // the subclass check can answer `false` here — a 200 cannot tell the two
    // orders apart.
    expect(repetivelAmazon(new AmazonRespostaInvalidaError('x', 503, []))).toBe(false);
    expect(mensagemErroAmazon(new AmazonRespostaInvalidaError('Frase do cliente.', 503, []))).toBe(
      'Frase do cliente.',
    );
  });
});

describe('the classes', () => {
  it('AmazonRespostaInvalidaError IS an AmazonBackendError (catch sites narrow to the base)', () => {
    const err = new AmazonRespostaInvalidaError('x', 200, ['a']);
    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err.codigo).toBeNull();
    expect(err.campos).toEqual(['a']);
    expect(err.name).toBe('AmazonRespostaInvalidaError');
  });

  it("AmazonRedeError's message is fixed; the transport's text stays on `cause`", () => {
    const causa = new TypeError('net::ERR_CONNECTION_REFUSED 10.0.0.1');
    const err = new AmazonRedeError(causa);
    expect(err.message).toBe('Falha de rede ao contatar o backend da Amazon.');
    expect(err.message).not.toContain('10.0.0.1');
    expect(err.cause).toBe(causa);
    expect(err).not.toBeInstanceOf(AmazonBackendError);
  });

  it('`motivo` is null unless given, and carried verbatim when it is (a plain string)', () => {
    expect(new AmazonBackendError('x', 409, 'C').motivo).toBeNull();
    expect(new AmazonBackendError('x', 409, 'C', [], 'um-slug-novo').motivo).toBe('um-slug-novo');
    expect(new AmazonRespostaInvalidaError('x', 200, []).motivo).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/*                 The Easy Ship label route's copy (step 15)                */
/* ------------------------------------------------------------------------ */

/**
 * Every row TRANSCRIBED, never derived from the maps under test: a row edited,
 * dropped or swapped there reds here. The code table is the route's contract
 * (`CODIGO_ERRO_ETIQUETA_AMAZON`); its status column is ILLUSTRATIVE — a coded
 * answer's copy never reads the status, which the table's own test asserts by
 * swapping it.
 */
const COPIA_DO_CODIGO_ETIQUETA: ReadonlyArray<readonly [string, number, string]> = [
  [
    'AMAZON_ETIQUETA_CORPO_INVALIDO',
    400,
    'O backend da Amazon recusou o pedido de etiqueta como inválido; nada foi enviado à Amazon. ' +
      'Atualize a página e, se continuar, avise o suporte.',
  ],
  [
    'AMAZON_ETIQUETA_PEDIDO_NAO_ENCONTRADO',
    404,
    'O backend da Amazon não encontrou este pedido; nada foi enviado à Amazon. Atualize a ' +
      'página e confira o pedido.',
  ],
  [
    'AMAZON_ETIQUETA_SEM_PERMISSAO',
    403,
    'A coleta deste pedido ainda não foi agendada na Amazon, e agendar exige a permissão de ' +
      'escrita de frete. Peça a alguém com essa permissão para imprimir a etiqueta.',
  ],
  [
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    409,
    'A etiqueta deste pedido não pode ser impressa pelo ERP agora; nada foi enviado à Amazon. ' +
      'Confira o pedido na Seller Central.',
  ],
  [
    'AMAZON_ETIQUETA_AGUARDANDO_NFE',
    409,
    'A Amazon ainda não aceitou a NF-e deste pedido, e a etiqueta só sai depois do aceite. ' +
      'Confira o aviso de NF-e do pedido.',
  ],
  [
    'AMAZON_ETIQUETA_RECUSADA',
    409,
    'A Amazon recusou agendar a coleta deste pedido; nada foi impresso. Confira o pedido na ' +
      'Seller Central.',
  ],
  [
    'AMAZON_ETIQUETA_INDISPONIVEL',
    502,
    'A Amazon não entregou uma etiqueta utilizável para este pedido — imprima-a pela Seller ' +
      'Central.',
  ],
  [
    'AMAZON_ETIQUETA_AMAZON_INDISPONIVEL',
    503,
    'A Amazon não respondeu a tempo. Aguarde cerca de 1 minuto e reimprima pela lista de pedidos.',
  ],
  [
    'AMAZON_ETIQUETA_CONTA_INDISPONIVEL',
    503,
    'A conta Amazon deste pedido não pode ser usada agora (desativada, desconectada ou com a ' +
      'autorização pendente). Confira a conta em Canais e, até lá, imprima a etiqueta pela ' +
      'Seller Central.',
  ],
  [
    'AMAZON_ETIQUETA_DESLIGADA',
    503,
    'A impressão de etiquetas da Amazon pelo ERP está desligada para este pedido. Imprima a ' +
      'etiqueta pela Seller Central.',
  ],
];

const SAIDA_SELLER_CENTRAL =
  'agende a coleta na Seller Central; depois a reimpressão pelo ERP funciona.';

/**
 * Every motivo, the 409 code that answers it, and its sentence — transcribed.
 * The code column is the route's: the NF-e waits ride `AGUARDANDO_NFE`, Amazon's
 * refusals of the schedule `RECUSADA`, every other refusal `NAO_ELEGIVEL`.
 */
const COPIA_DO_MOTIVO_ETIQUETA: ReadonlyArray<readonly [string, string, string]> = [
  [
    'nao-amazon',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido não está ligado a uma conta Amazon no ERP, então a etiqueta não sai por esta ' +
      'integração. Confira o pedido.',
  ],
  [
    'outra-integradora',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'O frete deste pedido não está com a Amazon (outra integração de frete, ou nenhuma). ' +
      'Confira o frete do pedido.',
  ],
  [
    'pedido-bloqueado',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido está retido com erro no ERP, e a etiqueta não sai pelo ERP enquanto ele ' +
      'estiver assim. Imprima a etiqueta pela Seller Central.',
  ],
  [
    'mercadoria-fora',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'O frete deste pedido diz que a mercadoria já saiu, e a etiqueta não é reimpressa pelo ERP. ' +
      'Se ainda precisar dela, imprima pela Seller Central.',
  ],
  [
    'pedido-cancelado',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido foi cancelado. Não envie a mercadoria.',
  ],
  [
    'pedido-pendente',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido ainda está pendente na Amazon, e a etiqueta só sai depois que a Amazon liberar ' +
      'o envio.',
  ],
  [
    'cancelamento-solicitado',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'O comprador pediu o cancelamento deste pedido. Responda à solicitação na Seller Central ' +
      'antes de enviar a mercadoria.',
  ],
  [
    'nao-dba',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido não usa a coleta da Amazon (Delivery by Amazon), então a etiqueta não sai por ' +
      'esta integração.',
  ],
  [
    'ja-enviado',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'A Amazon diz que este pedido já foi enviado, e a etiqueta não é reimpressa pelo ERP. Se ' +
      'ainda precisar dela, imprima pela Seller Central.',
  ],
  [
    'status-pedido-inesperado',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'A Amazon devolveu este pedido num status que o ERP não reconhece. Imprima a etiqueta pela ' +
      'Seller Central.',
  ],
  [
    'pacote-desconhecido',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'A Amazon devolveu um pacote deste pedido num estado que o ERP não reconhece. Imprima a ' +
      'etiqueta pela Seller Central.',
  ],
  [
    'coleta-cancelada',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'A Amazon cancelou a coleta deste pedido. Reagende a coleta e imprima a etiqueta pela ' +
      'Seller Central.',
  ],
  [
    'marketplace-estrangeiro',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido é de um marketplace da Amazon fora do Brasil, então a etiqueta não sai por ' +
      'esta integração.',
  ],
  [
    'nf-nao-requerida',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'A Amazon marcou este pedido como sem NF-e exigida, e o ERP só agenda a coleta depois que a ' +
      `Amazon aceita a NF-e: ${SAIDA_SELLER_CENTRAL}`,
  ],
  [
    'nfe-ambigua',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido tem mais de uma NF-e de venda autorizada, e o ERP não agenda a coleta assim. ' +
      `Veja o aviso de NF-e do pedido e ${SAIDA_SELLER_CENTRAL}`,
  ],
  [
    'nfe-substituta',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'Este pedido tem uma NF-e de venda cancelada ao lado da autorizada, e o ERP não agenda a ' +
      'coleta nesse caso. Confira na Seller Central qual NF-e a Amazon tem (se for a cancelada, ' +
      `envie a autorizada por lá) e só então ${SAIDA_SELLER_CENTRAL}`,
  ],
  [
    'nfe-cancelada',
    'AMAZON_ETIQUETA_NAO_ELEGIVEL',
    'A NF-e de venda deste pedido foi cancelada, e o ERP não agenda a coleta nesse caso. ' +
      `Emita a NF-e substituta, envie-a pela Seller Central e só então ${SAIDA_SELLER_CENTRAL}`,
  ],
  [
    'dimensoes-ausentes',
    'AMAZON_ETIQUETA_RECUSADA',
    'A Amazon recusou agendar a coleta: faltam dimensões ou peso no anúncio do produto. ' +
      'Corrija o anúncio na Seller Central e reimprima pela lista de pedidos.',
  ],
  [
    'agendamento-recusado',
    'AMAZON_ETIQUETA_RECUSADA',
    'A Amazon recusou agendar a coleta deste pedido. Confira o pedido e a coleta na Seller ' +
      'Central.',
  ],
  [
    'nfe-em-processamento',
    'AMAZON_ETIQUETA_AGUARDANDO_NFE',
    'A Amazon ainda está processando a NF-e deste pedido (costuma levar alguns minutos). ' +
      'Aguarde e reimprima pela lista de pedidos.',
  ],
  [
    'nfe-recusada-pela-amazon',
    'AMAZON_ETIQUETA_AGUARDANDO_NFE',
    'A Amazon recusou a NF-e deste pedido. Veja o aviso de NF-e do pedido e confira o pedido ' +
      'na Seller Central.',
  ],
  [
    'nfe-nao-enviada',
    'AMAZON_ETIQUETA_AGUARDANDO_NFE',
    'A Amazon não recebeu a NF-e deste pedido. Veja o aviso de NF-e do pedido e confira o ' +
      'pedido na Seller Central.',
  ],
];

const NEUTRA = 'A Amazon recusou a etiqueta deste pedido — confira o pedido na Seller Central.';

/** The three codes whose answer carries a `motivo` — transcribed. */
const CODIGOS_409 = [
  'AMAZON_ETIQUETA_NAO_ELEGIVEL',
  'AMAZON_ETIQUETA_AGUARDANDO_NFE',
  'AMAZON_ETIQUETA_RECUSADA',
] as const;

/** "Try again" in any spelling the copy could use — never after a timeout, a 5xx or a cut call. */
const TENTE_DE_NOVO = /tente|novamente|de novo/i;

/** A map's OWN entry for a key read off a transcribed table (`undefined` when absent). */
function porChave(mapa: Readonly<Record<string, string>>, chave: string): string | undefined {
  return Object.hasOwn(mapa, chave) ? mapa[chave] : undefined;
}

function erroEtiqueta(status: number, codigo: string | null, motivo: string | null = null) {
  return new AmazonBackendError(MENSAGEM_DO_BACKEND, status, codigo, [], motivo);
}

describe('MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON — every code of the label route, pinned', () => {
  it('covers the contract exactly — no code missing, none invented', () => {
    const transcritos = COPIA_DO_CODIGO_ETIQUETA.map(([codigo]) => codigo).sort();
    expect(Object.values(CODIGO_ERRO_ETIQUETA_AMAZON).sort()).toEqual(transcritos);
    expect(Object.keys(MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON).sort()).toEqual(transcritos);
  });

  it.each(COPIA_DO_CODIGO_ETIQUETA)(
    '%s with no motivo gives exactly its own sentence, whatever the status',
    (codigo, status, frase) => {
      expect(porChave(MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON, codigo)).toBe(frase);
      expect(mensagemErroEtiquetaAmazon(erroEtiqueta(status, codigo))).toBe(frase);
      // The status is illustrative: the same code under another one reads the same.
      expect(mensagemErroEtiquetaAmazon(erroEtiqueta(418, codigo))).toBe(frase);
    },
  );

  it('no code sentence repeats another, echoes the backend sentence or shows the raw code', () => {
    const frases = COPIA_DO_CODIGO_ETIQUETA.map(([, , frase]) => frase);
    expect(new Set(frases).size).toBe(frases.length);
    for (const [codigo, status] of COPIA_DO_CODIGO_ETIQUETA) {
      const copia = mensagemErroEtiquetaAmazon(erroEtiqueta(status, codigo));
      expect(copia).not.toContain(MENSAGEM_DO_BACKEND);
      expect(copia).not.toContain(codigo);
    }
  });

  it('⚠️ no label sentence, code or motivo, ever says "tente de novo" / "novamente"', () => {
    for (const frase of [
      ...Object.values(MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON),
      ...Object.values(MENSAGENS_MOTIVO_ETIQUETA_AMAZON),
      MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO,
    ]) {
      expect(frase).not.toMatch(TENTE_DE_NOVO);
    }
  });

  it('AMAZON_INDISPONIVEL asks for a WAIT of about a minute and a reprint from the list', () => {
    const copia = mensagemErroEtiquetaAmazon(
      erroEtiqueta(503, CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL),
    );
    expect(copia).toBe(MENSAGEM_ETIQUETA_AMAZON_AGUARDE);
    expect(copia).toContain('Aguarde cerca de 1 minuto');
    expect(copia).toContain('reimprima pela lista de pedidos');
    expect(copia).not.toMatch(TENTE_DE_NOVO);
  });

  it('INDISPONIVEL names Seller Central as the fallback', () => {
    expect(
      mensagemErroEtiquetaAmazon(erroEtiqueta(502, CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL)),
    ).toContain('Seller Central');
  });
});

describe('MENSAGENS_MOTIVO_ETIQUETA_AMAZON — every motivo of a 409, pinned', () => {
  it('covers motivoEtiquetaAmazonSchema exactly — no motivo missing, none invented', () => {
    const transcritos = COPIA_DO_MOTIVO_ETIQUETA.map(([motivo]) => motivo).sort();
    expect([...motivoEtiquetaAmazonSchema.options].sort()).toEqual(transcritos);
    expect(Object.keys(MENSAGENS_MOTIVO_ETIQUETA_AMAZON).sort()).toEqual(transcritos);
  });

  it.each(COPIA_DO_MOTIVO_ETIQUETA)(
    '%s under %s gives exactly its own sentence',
    (motivo, codigo, frase) => {
      expect(porChave(MENSAGENS_MOTIVO_ETIQUETA_AMAZON, motivo)).toBe(frase);
      expect(mensagemErroEtiquetaAmazon(erroEtiqueta(409, codigo, motivo))).toBe(frase);
    },
  );

  it('every motivo sentence is its own: none repeats another, a code sentence or the neutral one', () => {
    const motivos = COPIA_DO_MOTIVO_ETIQUETA.map(([, , frase]) => frase);
    expect(new Set(motivos).size).toBe(motivos.length);
    const outras = new Set([...COPIA_DO_CODIGO_ETIQUETA.map(([, , frase]) => frase), NEUTRA]);
    for (const frase of motivos) expect(outras.has(frase)).toBe(false);
  });

  it('AGUARDANDO_NFE: only `nfe-em-processamento` asks for a wait and a reprint', () => {
    const processando = mensagemErroEtiquetaAmazon(
      erroEtiqueta(409, CODIGO_ERRO_ETIQUETA_AMAZON.AGUARDANDO_NFE, 'nfe-em-processamento'),
    );
    expect(processando).toMatch(/aguarde/i);
    expect(processando).toContain('reimprima pela lista de pedidos');
  });

  it.each(['nfe-recusada-pela-amazon', 'nfe-nao-enviada'])(
    '⚠️ AGUARDANDO_NFE + %s never yields the wait copy: it sends the operator to the NF-e aviso',
    (motivo) => {
      const copia = mensagemErroEtiquetaAmazon(
        erroEtiqueta(409, CODIGO_ERRO_ETIQUETA_AMAZON.AGUARDANDO_NFE, motivo),
      );
      expect(copia).not.toMatch(/aguarde/i);
      expect(copia).not.toMatch(/reimprima/i);
      expect(copia).toContain('aviso de NF-e do pedido');
    },
  );

  it.each(['nfe-substituta', 'nfe-cancelada'])(
    '%s names the exit: agende a coleta na Seller Central, then the ERP reprint works',
    (motivo) => {
      const copia = mensagemErroEtiquetaAmazon(
        erroEtiqueta(409, CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL, motivo),
      );
      expect(copia).toContain('agende a coleta na Seller Central');
      expect(copia).toContain('depois a reimpressão pelo ERP funciona');
    },
  );

  it.each([
    ['nfe-substituta', 'envie a autorizada'],
    ['nfe-cancelada', 'envie-a pela Seller Central'],
  ])(
    '⚠️ %s puts the NF-e step BEFORE the Seller Central schedule (a cancelled note must not ride the pickup)',
    (motivo, passoDaNota) => {
      const copia = mensagemErroEtiquetaAmazon(
        erroEtiqueta(409, CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL, motivo),
      );
      const nota = copia.indexOf(passoDaNota);
      expect(nota).toBeGreaterThanOrEqual(0);
      expect(nota).toBeLessThan(copia.indexOf('agende a coleta na Seller Central'));
    },
  );

  it('coleta-cancelada sends the reschedule AND the print to Seller Central, promising no ERP reprint', () => {
    const copia = mensagemErroEtiquetaAmazon(
      erroEtiqueta(409, CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL, 'coleta-cancelada'),
    );
    expect(copia).toContain('imprima a etiqueta pela Seller Central');
    expect(copia).not.toMatch(/reimpress|reimprima/i);
  });

  it('dimensoes-ausentes names the listing fix AND the reprint from the order list', () => {
    const copia = mensagemErroEtiquetaAmazon(
      erroEtiqueta(409, CODIGO_ERRO_ETIQUETA_AMAZON.RECUSADA, 'dimensoes-ausentes'),
    );
    expect(copia).toContain('Corrija o anúncio');
    expect(copia).toContain('reimprima pela lista de pedidos');
  });

  it.each(CODIGOS_409)(
    'an UNKNOWN motivo slug under %s gives the neutral sentence — never a status, never the slug',
    (codigo) => {
      for (const slug of ['motivo-de-um-backend-novo', 'NFE-AMBIGUA', 'nfe-ambigua ', '']) {
        const copia = mensagemErroEtiquetaAmazon(erroEtiqueta(409, codigo, slug));
        expect(copia, JSON.stringify(slug)).toBe(NEUTRA);
      }
      // Inherited keys of a plain object are not motivos.
      for (const slug of ['__proto__', 'constructor', 'toString']) {
        expect(mensagemErroEtiquetaAmazon(erroEtiqueta(409, codigo, slug))).toBe(NEUTRA);
      }
    },
  );

  it('NEAR-MISS: a KNOWN motivo never gives the neutral sentence, under any of the three codes', () => {
    expect(MENSAGEM_MOTIVO_ETIQUETA_AMAZON_DESCONHECIDO).toBe(NEUTRA);
    for (const codigo of CODIGOS_409) {
      for (const [motivo] of COPIA_DO_MOTIVO_ETIQUETA) {
        expect(mensagemErroEtiquetaAmazon(erroEtiqueta(409, codigo, motivo))).not.toBe(NEUTRA);
      }
    }
  });

  it('NEAR-MISS: a motivo on a code that carries none is ignored — the code decides', () => {
    expect(
      mensagemErroEtiquetaAmazon(
        erroEtiqueta(503, CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL, 'nfe-ambigua'),
      ),
    ).toBe(MENSAGEM_ETIQUETA_AMAZON_AGUARDE);
    expect(
      mensagemErroEtiquetaAmazon(
        erroEtiqueta(502, CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL, 'um-slug-novo'),
      ),
    ).toBe(MENSAGENS_CODIGO_ERRO_ETIQUETA_AMAZON[CODIGO_ERRO_ETIQUETA_AMAZON.INDISPONIVEL]);
  });
});

describe('mensagemErroEtiquetaAmazon — the other families, then the codeless answers', () => {
  it("the read switch's reused code gets the conta panel's switch-off copy PLUS the Seller Central exit", () => {
    const copia = mensagemErroEtiquetaAmazon(
      erroEtiqueta(503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS),
    );
    expect(copia).toBe(
      'A integração com a Amazon fica desligada até a virada: até a migração para este sistema ' +
        '(ou por configuração do backend), nenhuma chamada à Amazon é feita. Nada foi enviado à ' +
        'Amazon nem salvo. Se a migração já ocorreu, avise o suporte. Enquanto isso, imprima a ' +
        'etiqueta pela Seller Central.',
    );
    // The conta panel's own sentence is untouched: only the label call adds the exit.
    expect(MENSAGENS_CODIGO_ERRO_AMAZON[CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS]).not.toContain(
      'etiqueta',
    );
  });

  it("verifyCaller's coded answers: auth/… is the session copy, app/… the deploy copy", () => {
    expect(mensagemErroEtiquetaAmazon(erroEtiqueta(401, 'auth/id-token-expired'))).toContain(
      'entre de novo',
    );
    expect(mensagemErroEtiquetaAmazon(erroEtiqueta(500, 'app/invalid-credential'))).toContain(
      'deploy',
    );
  });

  it("a code this build does not know shows the backend's own sentence", () => {
    expect(mensagemErroEtiquetaAmazon(erroEtiqueta(409, 'AMAZON_ETIQUETA_NOVO'))).toBe(
      MENSAGEM_DO_BACKEND,
    );
  });

  it('an unreadable 2xx keeps the sentence the client built for it', () => {
    expect(
      mensagemErroEtiquetaAmazon(new AmazonRespostaInvalidaError('Frase do cliente.', 200, [])),
    ).toBe('Frase do cliente.');
  });

  it.each([500, 501, 502, 503, 504])(
    '⚠️ a CODELESS %i never says "novamente" and asks for the wait (a call may still run at Amazon)',
    (status) => {
      const copia = mensagemErroEtiquetaAmazon(erroEtiqueta(status, null));
      expect(copia).toBe(MENSAGEM_ETIQUETA_AMAZON_AGUARDE);
      expect(copia).toMatch(/aguarde/i);
      expect(copia).not.toMatch(TENTE_DE_NOVO);
      // The control: the conta routes' status copy DOES say it — the copy the
      // label call must never borrow.
      expect(mensagemHttpAmazon(status)).toMatch(/novamente/);
    },
  );

  it('a codeless 403 names the frete permission, never the integrações one', () => {
    const copia = mensagemErroEtiquetaAmazon(erroEtiqueta(403, null));
    expect(copia).toContain('permissão de frete');
    expect(copia).not.toContain('integrações');
  });

  it('a codeless 401 is the session copy; a codeless 404 or 418 names the status and Seller Central', () => {
    expect(mensagemErroEtiquetaAmazon(erroEtiqueta(401, null))).toContain('entre de novo');
    for (const status of [404, 418]) {
      const copia = mensagemErroEtiquetaAmazon(erroEtiqueta(status, null));
      expect(copia).toContain(`HTTP ${String(status)}`);
      expect(copia).toContain('Seller Central');
      expect(copia).not.toMatch(TENTE_DE_NOVO);
    }
  });

  it('a codeless 404 says the label ROUTE did not answer; NEAR-MISS: a codeless 418 does not', () => {
    expect(mensagemErroEtiquetaAmazon(erroEtiqueta(404, null))).toBe(
      'O backend da Amazon não respondeu pela rota de etiqueta (HTTP 404). Imprima a etiqueta ' +
        'pela Seller Central e avise o suporte.',
    );
    expect(mensagemErroEtiquetaAmazon(erroEtiqueta(418, null))).not.toContain('rota de etiqueta');
  });

  it('mensagemHttpEtiquetaAmazon never prints undefined', () => {
    for (const status of [400, 401, 403, 404, 409, 500, 501, 503, 504]) {
      expect(mensagemHttpEtiquetaAmazon(status)).not.toContain('undefined');
    }
  });

  it('ehCodigoErroEtiquetaAmazon: the label codes only — not the conta codes, not inherited keys', () => {
    expect(ehCodigoErroEtiquetaAmazon(CODIGO_ERRO_ETIQUETA_AMAZON.DESLIGADA)).toBe(true);
    expect(ehCodigoErroEtiquetaAmazon(CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS)).toBe(false);
    expect(ehCodigoErroEtiquetaAmazon('constructor')).toBe(false);
    expect(ehCodigoErroEtiquetaAmazon('__proto__')).toBe(false);
    expect(ehCodigoErroEtiquetaAmazon(null)).toBe(false);
  });
});
