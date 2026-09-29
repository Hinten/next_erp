/**
 * The NF-e refusal table (#1522, step 14) — design D1 §5.2 N1 … N18 in the
 * declared order, with reconcile R-f and the N0 row (the ladder's kinds).
 *
 * Guide 382's seventeen texts are used VERBATIM (they carry no identifier), each
 * paired with the bare and the module-prefixed code. The row-order pins, the
 * TAB-suffixed code, the needles-on-`providerMessage` rule and the rate-limit
 * precedence each have a test that kills their mutant (reconcile §4, 25–29, 32).
 */
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  SHOPEE_UPLOAD_INVOICE_DOC_PATH,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  shopeeErrorFromEnvelope,
  type ShopeeErrorKind,
} from '@delfrance/integrations-shopee';
import { describe, expect, it } from 'vitest';

import { classificarRecusaDeNfe, type ClasseNfe, type MotivoRecusaNfe } from './classificarNfe';
import { MOTIVOS_QUE_AVISAM, MOTIVOS_QUE_CARIMBAM } from './errosNfe';

const OUTRO: ShopeeErrorKind = SHOPEE_ERROR_KIND.other;
const PRONTO = { statusDoPedido: 'READY_TO_SHIP' } as const;
const TRANSITORIO: ClasseNfe = { classe: 'transitorio' };
const SERPRO: ClasseNfe = { classe: 'aguardar-serpro' };

function recusar(motivo: MotivoRecusaNfe): ClasseNfe {
  return { classe: 'recusar', motivo };
}

function ignorar(motivo: 'sem-suporte-a-nfe' | 'pedido-cancelado'): ClasseNfe {
  return { classe: 'ignorar', motivo };
}

function erro(
  code: string,
  providerMessage: string | null,
  kind: ShopeeErrorKind = OUTRO,
): { code: string; kind: ShopeeErrorKind; providerMessage: string | null } {
  return { code, kind, providerMessage };
}

const DESCONHECIDA = recusar('recusa-desconhecida');

interface Caso {
  readonly caso: string;
  readonly codigo: string;
  readonly texto: string;
  readonly esperado: ClasseNfe;
}

/** Guide 382's table, case by case, text verbatim. */
const GUIA_382: readonly Caso[] = [
  {
    caso: '1',
    codigo: 'error_param',
    texto:
      'Wrong parameters, detail: Invalid CNPJ. The access key CNPJ must be the same as the registration..',
    esperado: recusar('cnpj-divergente'),
  },
  {
    caso: '2',
    codigo: 'error_param',
    texto:
      'Wrong parameters, detail: Invalid UF. The access key UF must be the same as the registration..',
    esperado: recusar('uf-divergente'),
  },
  {
    caso: '3',
    codigo: 'error_param',
    texto:
      'Wrong parameters, detail: Invalid State Registration Number. The NF-e State Registration Number must be the same as the registration..',
    esperado: recusar('ie-divergente'),
  },
  {
    caso: '4',
    codigo: 'error_param',
    texto:
      "Wrong parameters, detail: Don't support Invoice Issuer now, please switch Shop Default to upload invoice..",
    esperado: recusar('emissor-shopee'),
  },
  {
    caso: '4 (apóstrofo tipográfico)',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: Don’t support Invoice Issuer now.',
    esperado: recusar('emissor-shopee'),
  },
  {
    caso: '5',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: Invalid NF-e.',
    esperado: SERPRO,
  },
  {
    caso: '6',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: Canceled NF-e.',
    esperado: recusar('nfe-cancelada'),
  },
  {
    caso: '7',
    codigo: 'error_param',
    texto: 'Access Key duplicated, please do not use duplicated Access Key.',
    esperado: { classe: 'ja-anexada', motivo: 'chave-duplicada' },
  },
  {
    caso: '8',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: access_key must be 44 characters in length.',
    esperado: recusar('chave-invalida'),
  },
  {
    caso: '9',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: access_key is a required field.',
    esperado: recusar('chave-invalida'),
  },
  {
    caso: '10',
    codigo: 'error_param',
    texto:
      'Wrong parameters, detail: Invalid issue date. The NF-e issue date cannot be greater than the current date..',
    esperado: recusar('data-de-emissao-invalida'),
  },
  {
    caso: '11',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: The invoice status is invalid to upload invoice data.',
    esperado: ignorar('sem-suporte-a-nfe'),
  },
  {
    caso: '12',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: Invalid access key..',
    esperado: recusar('chave-invalida'),
  },
  {
    caso: '13',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: order_sn is a required field.',
    esperado: recusar('requisicao-invalida'),
  },
  {
    caso: '14',
    codigo: 'error_param',
    texto: 'Invalid NF-e model. Only model 55 is accepted.',
    esperado: recusar('modelo-nao-55'),
  },
  {
    caso: '15',
    codigo: 'error_param',
    texto: 'CFOP invalid, please confirm it',
    esperado: recusar('cfop-nao-aceito'),
  },
  {
    caso: '16',
    codigo: 'upload_invoice_error',
    texto: 'Please upload a valid Invoice XML file',
    esperado: recusar('xml-recusado'),
  },
  {
    caso: '17',
    codigo: 'upload_invoice_error',
    texto: 'File Error',
    esperado: recusar('xml-recusado'),
  },
  {
    caso: 'legado (mesmo pedido)',
    codigo: 'error_param',
    texto: 'Access Key already sent to that order.',
    esperado: { classe: 'ja-anexada', motivo: 'chave-ja-enviada' },
  },
  {
    caso: 'página da api (tipo do file_type)',
    codigo: 'error_param',
    texto: 'Wrong parameters, detail: field file_type type error.',
    esperado: recusar('requisicao-invalida'),
  },
];

describe('classificarRecusaDeNfe — a tabela do guia 382, caso a caso', () => {
  it.each(GUIA_382.flatMap((c) => [c, { ...c, codigo: `order.${c.codigo}` }]))(
    'caso $caso (`$codigo`)',
    ({ codigo, texto, esperado }) => {
      expect(classificarRecusaDeNfe(erro(codigo, texto), PRONTO)).toEqual(esperado);
    },
  );

  it('todo `recusar` da tabela AVISA — e quem carimba é o conjunto, nunca a tabela', () => {
    for (const { codigo, texto } of GUIA_382) {
      const classe = classificarRecusaDeNfe(erro(codigo, texto), PRONTO);
      if (classe.classe === 'recusar') expect(MOTIVOS_QUE_AVISAM.has(classe.motivo)).toBe(true);
    }
  });
});

describe('classificarRecusaDeNfe — N3, o caso 11 dividido pelo status da PRÉ-LEITURA', () => {
  const texto = 'Wrong parameters, detail: The invoice status is invalid to upload invoice data.';

  it.each(['IN_CANCEL', 'CANCELLED'])('`%s` ⇒ ignorar `pedido-cancelado`', (statusDoPedido) => {
    expect(classificarRecusaDeNfe(erro('error_param', texto), { statusDoPedido })).toEqual(
      ignorar('pedido-cancelado'),
    );
  });

  it.each([
    ['pronto para envio', 'READY_TO_SHIP'],
    ['sem status', null],
    ['⛔ QUASE-MISS: `in_cancel` minúsculo (casamento exato)', 'in_cancel'],
  ])('%s ⇒ ignorar `sem-suporte-a-nfe`', (_rotulo, statusDoPedido) => {
    expect(classificarRecusaDeNfe(erro('error_param', texto), { statusDoPedido })).toEqual(
      ignorar('sem-suporte-a-nfe'),
    );
  });
});

describe('classificarRecusaDeNfe — a ORDEM das linhas', () => {
  it('⛔ mutante 25: N10 ANTES de N14 — o texto do modelo contém `invalid nf-e` e NÃO espera a SERPRO', () => {
    const texto = 'Invalid NF-e model. Only model 55 is accepted.';
    expect(texto.toLowerCase()).toContain('invalid nf-e');
    expect(classificarRecusaDeNfe(erro('error_param', texto), PRONTO)).toEqual(
      recusar('modelo-nao-55'),
    );
  });

  it('⛔ mutante 26: N12 × N15 — `field file_type type error` é N15 e `File error.` é N12, nos dois sentidos', () => {
    const doTipo = 'Wrong parameters, detail: field file_type type error.';
    const doArquivo = 'File error.';
    expect(doTipo.toLowerCase()).not.toContain('file error');
    expect(doArquivo.toLowerCase()).not.toContain('file_type');
    expect(classificarRecusaDeNfe(erro('error_param', doTipo), PRONTO)).toEqual(
      recusar('requisicao-invalida'),
    );
    expect(classificarRecusaDeNfe(erro('order.upload_invoice_error', doArquivo), PRONTO)).toEqual(
      recusar('xml-recusado'),
    );
  });

  it('⛔ mutante 27: o MESMO código `upload_invoice_error` com as DUAS frases — arquivo recusa, "try again" é transitório', () => {
    const codigo = 'order.upload_invoice_error';
    expect(classificarRecusaDeNfe(erro(codigo, 'File error.'), PRONTO)).toEqual(
      recusar('xml-recusado'),
    );
    expect(
      classificarRecusaDeNfe(
        erro(codigo, 'Upload invoice failed, please try again later.'),
        PRONTO,
      ),
    ).toEqual(TRANSITORIO);
  });

  it('N1 PRIMEIRO: uma chave duplicada vence qualquer outra agulha no mesmo texto', () => {
    expect(
      classificarRecusaDeNfe(erro('error_param', 'Access Key duplicated. Invalid NF-e.'), PRONTO),
    ).toEqual({ classe: 'ja-anexada', motivo: 'chave-duplicada' });
  });

  it('N1 antes de N2: as duas frases juntas são a chave em OUTRO pedido', () => {
    expect(
      classificarRecusaDeNfe(
        erro('error_param', 'Access Key duplicated, already sent to another order.'),
        PRONTO,
      ),
    ).toEqual({ classe: 'ja-anexada', motivo: 'chave-duplicada' });
  });
});

describe('classificarRecusaDeNfe — o CÓDIGO: aparado e sem o prefixo de módulo', () => {
  it('⛔ mutante 28: o código da página termina em TAB — `order.upload_invoice_error\\t` + "try again" é transitório', () => {
    expect(
      classificarRecusaDeNfe(
        erro('order.upload_invoice_error\t', 'Upload invoice failed, please try again later.'),
        PRONTO,
      ),
    ).toEqual(TRANSITORIO);
  });

  it.each(['source_ip_undeclared', 'common.source_ip_undeclared', ' source_ip_undeclared\t'])(
    'PAR: `%s` ⇒ recusar `ip-nao-declarado`',
    (codigo) => {
      expect(
        classificarRecusaDeNfe(erro(codigo, 'Request Source IP (0.0.0.0) is undeclared'), PRONTO),
      ).toEqual(recusar('ip-nao-declarado'));
    },
  );

  it('⛔ mutante 31: `ip-nao-declarado` AVISA e NÃO carimba — infraestrutura, não esta NF-e', () => {
    expect(MOTIVOS_QUE_AVISAM.has('ip-nao-declarado')).toBe(true);
    expect(MOTIVOS_QUE_CARIMBAM.has('ip-nao-declarado')).toBe(false);
  });

  it('⛔ QUASE-MISS: DOIS segmentos de módulo não são removidos — `a.b.source_ip_undeclared` é desconhecido', () => {
    expect(classificarRecusaDeNfe(erro('a.b.source_ip_undeclared', null), PRONTO)).toEqual(
      DESCONHECIDA,
    );
  });

  it.each([
    [
      '`error_database`',
      'order.error_database',
      'Database connection issue. Please try again later.',
    ],
    ['o erro de token com o erro de digitação da Shopee', 'invalid_acceess_token', null],
    ['o erro de token bem escrito', 'invalid_access_token', null],
  ])('N17: %s é transitório', (_rotulo, codigo, texto) => {
    expect(classificarRecusaDeNfe(erro(codigo, texto), PRONTO)).toEqual(TRANSITORIO);
  });

  it('N17: `kind: transient` (error_server) é transitório', () => {
    expect(
      classificarRecusaDeNfe(
        erro('error_server', 'System error. Please try again later.', SHOPEE_ERROR_KIND.transient),
        PRONTO,
      ),
    ).toEqual(TRANSITORIO);
  });

  it('⛔ QUASE-MISS: "try again" só é transitório no código do upload — em `error_param` é desconhecido', () => {
    expect(classificarRecusaDeNfe(erro('error_param', 'Please try again later.'), PRONTO)).toEqual(
      DESCONHECIDA,
    );
  });

  it('N18: um código que ninguém ensinou, sem frase, é `recusa-desconhecida`', () => {
    expect(classificarRecusaDeNfe(erro('order.error_nunca_visto', null), PRONTO)).toEqual(
      DESCONHECIDA,
    );
  });
});

describe('classificarRecusaDeNfe — a dobra da FRASE (`providerMessage`)', () => {
  it.each([
    ['maiúsculas e o envelope em caixa alta', 'WRONG PARAMETERS, DETAIL:   INVALID CNPJ..'],
    ['espaços e TAB no meio', 'Invalid\t  CNPJ.'],
    ['espaços em volta', '   Invalid CNPJ.   '],
  ])('PAR: %s ⇒ `cnpj-divergente`', (_rotulo, texto) => {
    expect(classificarRecusaDeNfe(erro('error_param', texto), PRONTO)).toEqual(
      recusar('cnpj-divergente'),
    );
  });

  it('PAR: a chave com espaço ou com sublinhado (casos 1/2 × 8/9) cai em `chave-invalida`', () => {
    for (const texto of ['access key must be 44 characters', 'access_key must be 44 characters']) {
      expect(classificarRecusaDeNfe(erro('error_param', texto), PRONTO)).toEqual(
        recusar('chave-invalida'),
      );
    }
  });

  it.each([
    [
      'com espaço (o texto documentado)',
      'Access Key duplicated, please do not use duplicated Access Key.',
    ],
    ['com sublinhado (a grafia de N13)', 'Wrong parameters, detail: access_key duplicated.'],
    ['com sublinhado e em caixa alta', 'ACCESS_KEY DUPLICATED'],
  ])(
    '⛔ R4-4 — PAR: a chave duplicada %s ⇒ `ja-anexada chave-duplicada` (N1, a leitura decide)',
    (_rotulo, texto) => {
      expect(classificarRecusaDeNfe(erro('error_param', texto), PRONTO)).toEqual({
        classe: 'ja-anexada',
        motivo: 'chave-duplicada',
      });
    },
  );

  it('⛔ R4-4 — N1 com sublinhado AINDA vence as outras agulhas do mesmo texto', () => {
    expect(
      classificarRecusaDeNfe(erro('error_param', 'access_key duplicated. Invalid NF-e.'), PRONTO),
    ).toEqual({ classe: 'ja-anexada', motivo: 'chave-duplicada' });
  });

  it.each([
    ['as palavras coladas', 'accesskeyduplicated'],
    ['um hífen no lugar do espaço', 'access-key duplicated'],
    ['dois separadores', 'access _key duplicated'],
  ])('⛔ QUASE-MISS: %s NÃO é a chave duplicada', (_rotulo, texto) => {
    expect(classificarRecusaDeNfe(erro('error_param', texto), PRONTO)).toEqual(DESCONHECIDA);
  });

  it('⛔ QUASE-MISS: `access-key must be` (hífen) não é `chave-invalida`', () => {
    expect(
      classificarRecusaDeNfe(erro('error_param', 'access-key must be 44 characters'), PRONTO),
    ).toEqual(DESCONHECIDA);
  });
});

describe('classificarRecusaDeNfe — ⛔ mutante 29: as agulhas leem `providerMessage`, NUNCA o texto formatado', () => {
  it('um erro com `providerMessage: null` cujo texto formatado traz agulhas é `recusa-desconhecida`', () => {
    const err = new ShopeeApiError(
      `Shopee ${SHOPEE_UPLOAD_INVOICE_DOC_PATH} respondeu order.upload_invoice_error (HTTP 200) — ` +
        'Upload invoice failed, please try again later. Invalid NF-e. File error.',
      {
        code: 'order.upload_invoice_error',
        kind: OUTRO,
        httpStatus: 200,
        path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
        providerMessage: null,
      },
    );
    expect(err.message).toContain('upload_invoice');
    expect(err.message).toContain('try again');
    expect(classificarRecusaDeNfe(err, PRONTO)).toEqual(DESCONHECIDA);
  });

  it('o erro de verdade, montado do envelope sem `message`: o caminho e o código não casam nada', () => {
    const err = shopeeErrorFromEnvelope(
      { error: 'order.upload_invoice_error', message: null, request_id: null, warning: null },
      { path: SHOPEE_UPLOAD_INVOICE_DOC_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
    );
    expect(err.message).toContain('upload_invoice');
    expect(classificarRecusaDeNfe(err, PRONTO)).toEqual(DESCONHECIDA);
  });

  it('PAR: o MESMO erro com a frase em `providerMessage` é classificado pela frase', () => {
    const err = shopeeErrorFromEnvelope(
      {
        error: 'order.upload_invoice_error\t',
        message: 'Upload invoice failed, please try again later.',
        request_id: null,
        warning: null,
      },
      { path: SHOPEE_UPLOAD_INVOICE_DOC_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
    );
    expect(classificarRecusaDeNfe(err, PRONTO)).toEqual(TRANSITORIO);
  });

  it("uma frase VAZIA (`''`) também não casa nada", () => {
    expect(classificarRecusaDeNfe(erro('error_param', ''), PRONTO)).toEqual(DESCONHECIDA);
  });
});

describe('classificarRecusaDeNfe — ⛔ mutante 32: N0, as classes da escada NUNCA viram recusa', () => {
  /** A texto que, lido como linha da tabela, esperaria a SERPRO. */
  const TEXTO_DO_CASO_5 = 'Wrong parameters, detail: Invalid NF-e.';
  const base = {
    httpStatus: 200,
    path: SHOPEE_UPLOAD_INVOICE_DOC_PATH,
    providerMessage: TEXTO_DO_CASO_5,
  } as const;

  it.each([
    [
      'um limite de RAJADA',
      new ShopeeRateLimitError('limite', { ...base, code: 'error_rate_limit', kind: 'burst' }),
    ],
    [
      'a cota DIÁRIA',
      new ShopeeRateLimitError('cota', { ...base, code: 'order.error_limit', kind: 'daily' }),
    ],
    [
      'uma autorização morta',
      new ShopeeReauthRequiredError('reauth', {
        ...base,
        code: 'shop_access_expired',
        kind: 'reauth',
      }),
    ],
    [
      'um PARCIAL que copiou `kind: burst` (as classes não são exclusivas)',
      new ShopeeApiPartialError('parcial', {
        ...base,
        code: 'error_rate_limit',
        kind: 'burst',
        parsed: {},
      }),
    ],
  ])('%s ⇒ transitório — antes de qualquer agulha, e nunca um carimbo', (_rotulo, err) => {
    expect(classificarRecusaDeNfe(err, PRONTO)).toEqual(TRANSITORIO);
  });

  it('⛔ QUASE-MISS: o MESMO texto com `kind: other` é a espera da SERPRO (N14)', () => {
    expect(classificarRecusaDeNfe(erro('error_param', TEXTO_DO_CASO_5), PRONTO)).toEqual(SERPRO);
  });

  it('⛔ QUASE-MISS: sem agulha, `kind: other` cai em N18 — que carimba; é por isso que N0 vem antes', () => {
    const classe = classificarRecusaDeNfe(erro('error_rate_limit', null), PRONTO);
    expect(classe).toEqual(DESCONHECIDA);
    expect(MOTIVOS_QUE_CARIMBAM.has('recusa-desconhecida')).toBe(true);
    expect(
      classificarRecusaDeNfe(erro('error_rate_limit', null, SHOPEE_ERROR_KIND.burst), PRONTO),
    ).toEqual(TRANSITORIO);
  });
});
