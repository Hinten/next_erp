import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import {
  CODIGO_ERRO_LI,
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  MOTIVO_ROTA_ETIQUETA_LI,
  type RespostaRotaEtiquetaLi,
} from '@delfrance/schemas';

const h = vi.hoisted(() => ({ getDoc: vi.fn(), docRef: vi.fn() }));
vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  getDoc: h.getDoc,
}));
vi.mock('@/lib/data/intFreteCollection', () => ({
  intFreteCollection: {
    docRef: (_db: unknown, _params: unknown, id: string) => ({
      withConverter: () => h.docRef(id),
    }),
  },
}));

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
} from './client';
import {
  MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI,
  preverRotaEtiquetaLi,
  preverRotaEtiquetaLiCom,
  rotearEtiquetaLi,
} from './rotaEtiqueta';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

/**
 * The web half of the Loja Integrada label routing (master plan step 15):
 * `rotearEtiquetaLi` turns every answer of the `PUT …/rota-etiqueta` route into
 * the operator's copy, and `preverRotaEtiquetaLi` asks the SAME pure questions
 * the route asks (the shared resolver in `@delfrance/schemas`), read-only, so
 * the checkout can warn before the stock leaves.
 */

const ROTA = {
  integracaoFreteOuterRef: 'documents/int_frete/mot-1',
  externalOptionId: null,
  integracaoTargetOuterRef: null,
  estado: ESTADO_FRETE.checkFinalizado,
} as const;

const roteado = (
  tipo: 'roteado' | 'ja-roteado',
  alvoTipo: (typeof INTEGRACAO_FRETE)[keyof typeof INTEGRACAO_FRETE] = INTEGRACAO_FRETE.motoboy,
  nome: string | null = 'Motoboy Centro',
): RespostaRotaEtiquetaLi =>
  ({ tipo, alvo: { id: 'mot-1', tipo: alvoTipo, nome }, rota: ROTA }) as RespostaRotaEtiquetaLi;

const rotear = (r: () => Promise<RespostaRotaEtiquetaLi>) => {
  const rotearEtiqueta = vi.fn(r);
  return { client: lojaIntegradaClientFalso({ rotearEtiqueta }), rotearEtiqueta };
};

describe('rotearEtiquetaLi — the route call, mapped to the operator copy', () => {
  it('sends the escolha as the body, and a success names the target and its tipo', async () => {
    const { client, rotearEtiqueta } = rotear(async () => roteado('roteado'));

    const r = await rotearEtiquetaLi(client, 'ped-1', 'mot-1');

    expect(rotearEtiqueta).toHaveBeenCalledWith('ped-1', { escolha: 'mot-1' });
    expect(r).toEqual({
      tipo: 'roteado',
      alvo: { id: 'mot-1', tipo: INTEGRACAO_FRETE.motoboy, nome: 'Motoboy Centro' },
      rota: ROTA,
      mensagem: 'Transportadora definida: Motoboy Centro (Motoboy).',
    });
  });

  it('`ja-roteado` is a success too, with the same copy and no second call', async () => {
    const { client, rotearEtiqueta } = rotear(async () => roteado('ja-roteado'));

    const r = await rotearEtiquetaLi(client, 'ped-1', null);

    expect(rotearEtiqueta).toHaveBeenCalledTimes(1);
    expect(rotearEtiqueta).toHaveBeenCalledWith('ped-1', { escolha: null });
    expect(r.tipo).toBe('ja-roteado');
    expect(r.mensagem).toBe('Transportadora definida: Motoboy Centro (Motoboy).');
  });

  it('EQUAL pair: fob and retirada say the label is printed at the checkout; NEAR-MISS: motoboy and Melhor Envio do not', async () => {
    for (const tipo of [INTEGRACAO_FRETE.fob, INTEGRACAO_FRETE.retiradaNaLoja]) {
      const { client } = rotear(async () => roteado('roteado', tipo, 'Alvo'));
      const r = await rotearEtiquetaLi(client, 'ped-1', null);
      expect(r.mensagem, tipo).toMatch(/A etiqueta é impressa no checkout\.$/);
    }
    for (const tipo of [INTEGRACAO_FRETE.motoboy, INTEGRACAO_FRETE.melhorEnvios]) {
      const { client } = rotear(async () => roteado('roteado', tipo, 'Alvo'));
      const r = await rotearEtiquetaLi(client, 'ped-1', null);
      expect(r.mensagem, tipo).not.toContain('checkout');
    }
  });

  it('a target with no nome is named by its id', async () => {
    const { client } = rotear(async () => roteado('roteado', INTEGRACAO_FRETE.motoboy, null));

    expect((await rotearEtiquetaLi(client, 'ped-1', null)).mensagem).toBe(
      'Transportadora definida: mot-1 (Motoboy).',
    );
  });

  it.each(Object.values(MOTIVO_ROTA_ETIQUETA_LI))(
    'the refusal %s carries its own copy, never the bare code',
    async (motivo) => {
      const { client } = rotear(async () => ({ tipo: 'recusado', motivo }));

      const r = await rotearEtiquetaLi(client, 'ped-1', null);

      expect(r).toEqual({
        tipo: 'recusado',
        motivo,
        mensagem: MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[motivo],
      });
      expect(r.mensagem).not.toContain(motivo);
    },
  );

  it('a refusal code a newer backend added still reads as a refusal, with neutral copy', async () => {
    const { client } = rotear(async () => ({ tipo: 'recusado', motivo: 'motivo-novo' }));

    const r = await rotearEtiquetaLi(client, 'ped-1', null);

    expect(r.tipo).toBe('recusado');
    expect(r.mensagem).toBe(
      'A transportadora deste pedido não pôde ser definida (motivo-novo). Recarregue a página e tente de novo.',
    );
  });

  it('pins the §4.7 copy of the motivos an operator meets most', () => {
    expect(MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.semMapeamento]).toBe(
      'Esta forma de envio não está mapeada para uma transportadora. Mapeie-a na conta Loja ' +
        'Integrada (aba Mapeamento do Frete) ou escolha a transportadora deste pedido.',
    );
    expect(MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago]).toBe(
      'Só é possível definir a transportadora de um pedido Pago.',
    );
    expect(MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.alvoAusente]).not.toBe(
      MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.alvoInativo],
    );
  });

  describe('every failure is an error OUTCOME with its own copy — never a throw', () => {
    const casos: ReadonlyArray<[string, unknown, string, string]> = [
      [
        'a 403',
        new LojaIntegradaClientHttpError('x', 403, null),
        'sem-permissao',
        'Você não tem permissão para definir a transportadora deste pedido.',
      ],
      [
        'pedidoNaoEncontrado',
        new LojaIntegradaClientHttpError('x', 404, CODIGO_ERRO_LI.pedidoNaoEncontrado),
        'nao-encontrado',
        'Pedido não encontrado.',
      ],
      [
        'rotaEmConflito',
        new LojaIntegradaClientHttpError('x', 503, CODIGO_ERRO_LI.rotaEmConflito),
        'conflito',
        'O pedido foi alterado por outra ação ao mesmo tempo. Tente de novo.',
      ],
      [
        'a 404 without an envelope (an older backend)',
        new LojaIntegradaClientHttpError('x', 404, null),
        'indisponivel',
        'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
      ],
      [
        'a bare 502',
        new LojaIntegradaClientHttpError('x', 502, null),
        'indisponivel',
        'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
      ],
      [
        'an unreadable 2xx',
        new LojaIntegradaClientRespostaInvalidaError('x', 200, ['tipo']),
        'indisponivel',
        'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
      ],
      [
        'the network',
        new LojaIntegradaClientNetworkError(),
        'indisponivel',
        'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
      ],
      [
        'the deadline',
        new LojaIntegradaClientTempoEsgotadoError(),
        'indisponivel',
        'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
      ],
      [
        'the session',
        new FirebaseError('auth/network-request-failed', 'x'),
        'sessao',
        'Não foi possível confirmar a sua sessão. Recarregue a página e tente de novo.',
      ],
    ];
    it.each(casos)('%s', async (_nome, err, causa, mensagem) => {
      const { client } = rotear(() => Promise.reject(err));

      await expect(rotearEtiquetaLi(client, 'ped-1', null)).resolves.toEqual({
        tipo: 'erro',
        causa,
        mensagem,
      });
    });

    it('⚠️ NEAR-MISS: a 403 from the backend is the permission copy, NEVER its raw message', async () => {
      const { client } = rotear(() =>
        Promise.reject(new LojaIntegradaClientHttpError('Forbidden: d_frete', 403, null)),
      );

      const r = await rotearEtiquetaLi(client, 'ped-1', null);

      expect(r.mensagem).not.toContain('Forbidden');
    });

    it('no client is the "não respondeu" outcome, with no call', async () => {
      await expect(rotearEtiquetaLi(null, 'ped-1', null)).resolves.toEqual({
        tipo: 'erro',
        causa: 'indisponivel',
        mensagem:
          'O serviço da Loja Integrada não respondeu ou está desatualizado. Tente de novo em instantes.',
      });
    });

    it('anything else is rethrown (rule 6)', async () => {
      const bug = new RangeError('bug');
      const { client } = rotear(() => Promise.reject(bug));

      await expect(rotearEtiquetaLi(client, 'ped-1', null)).rejects.toBe(bug);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                              The read-only preview                          */
/* -------------------------------------------------------------------------- */

const CONTA_REF = 'documents/integracao/c1';
const DOC_LI_ID = 'li-c1';
const ENDERECO = 'documents/clientes/cli-1/enderecos/e1';

const MAPA = [
  {
    nomeOriginal: 'PAC',
    idOriginal: '141909---PAC',
    observacao: null,
    nomeTarget: 'Melhor Envio',
    targetData: { id: 1 },
    integracaoUid: 'me-1',
    targetTipoIntegracao: INTEGRACAO_FRETE.melhorEnvios,
  },
  {
    nomeOriginal: 'Motoboy',
    idOriginal: '141910---MOTO',
    observacao: null,
    nomeTarget: 'Motoboy Centro',
    targetData: null,
    integracaoUid: 'mot-1',
    targetTipoIntegracao: INTEGRACAO_FRETE.motoboy,
  },
];

const DOCS: Record<string, unknown> = {
  [DOC_LI_ID]: {
    tipo: INTEGRACAO_FRETE.lojaIntegrada,
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: CONTA_REF,
    mapa: MAPA,
  },
  'me-1': { tipo: INTEGRACAO_FRETE.melhorEnvios, ativo: true, nome: 'Melhor Envio' },
  'mot-1': { tipo: INTEGRACAO_FRETE.motoboy, ativo: true, nome: 'Motoboy Centro' },
};

function pedidoNoDocLi(forma: { id: number; code: string }, frete: Record<string, unknown> = {}) {
  return {
    estado: ESTADO_PEDIDO.pago,
    integracaoPedidoOuterRef: CONTA_REF,
    freteInicial: {
      integracaoFreteOuterRef: `documents/int_frete/${DOC_LI_ID}`,
      externalOptionData: forma,
      externalOptionId: null,
      integracaoTargetOuterRef: null,
      enderecoFreteOuterReference: ENDERECO,
      printLabelId: null,
      modalidade: '0',
      ...frete,
    },
  };
}

describe('preverRotaEtiquetaLiCom — the route’s questions, asked read-only', () => {
  let lidos: string[];
  const ler = (docs: Record<string, unknown> = DOCS) =>
    vi.fn(async (id: string) => {
      lidos.push(id);
      return docs[id] ?? null;
    });

  beforeEach(() => {
    lidos = [];
  });

  it('a mapped Melhor Envio method resolves to its target and service, reading the LI doc then the target', async () => {
    const r = await preverRotaEtiquetaLiCom(ler(), pedidoNoDocLi({ id: 141909, code: 'PAC' }));

    expect(r).toEqual({
      tipo: 'rota',
      alvoId: 'me-1',
      tipoAlvo: INTEGRACAO_FRETE.melhorEnvios,
      externalOptionId: '1',
    });
    expect(lidos).toEqual([DOC_LI_ID, 'me-1']);
  });

  it('EQUAL pair: the method id as a decimal string decides the SAME row', async () => {
    const r = await preverRotaEtiquetaLiCom(
      ler(),
      pedidoNoDocLi({ id: '141909' as never, code: 'PAC' }),
    );

    expect(r).toMatchObject({ tipo: 'rota', alvoId: 'me-1' });
  });

  it('⚠️ NEAR-MISS: the same id under another code is NOT mapped — never the sibling row', async () => {
    const r = await preverRotaEtiquetaLiCom(ler(), pedidoNoDocLi({ id: 141909, code: 'SEDEX' }));

    expect(r).toEqual({
      tipo: 'recusa',
      motivo: MOTIVO_ROTA_ETIQUETA_LI.semMapeamento,
      mensagem: MENSAGEM_MOTIVO_ROTA_ETIQUETA_LI[MOTIVO_ROTA_ETIQUETA_LI.semMapeamento],
    });
  });

  it('a pedido already on a target is `ja-roteado`, with ONE read and no guard', async () => {
    const r = await preverRotaEtiquetaLiCom(ler(), {
      ...pedidoNoDocLi({ id: 141910, code: 'MOTO' }),
      estado: ESTADO_PEDIDO.carrinho,
      freteInicial: {
        ...pedidoNoDocLi({ id: 141910, code: 'MOTO' }).freteInicial,
        integracaoFreteOuterRef: 'documents/int_frete/mot-1',
      },
    });

    expect(r).toEqual({ tipo: 'ja-roteado', tipoAlvo: INTEGRACAO_FRETE.motoboy });
    expect(lidos).toEqual(['mot-1']);
  });

  it('EQUAL pair: the freight ref in bare form names the SAME Loja Integrada doc', async () => {
    const r = await preverRotaEtiquetaLiCom(
      ler(),
      pedidoNoDocLi(
        { id: 141910, code: 'MOTO' },
        { integracaoFreteOuterRef: `int_frete/${DOC_LI_ID}` },
      ),
    );

    expect(r).toMatchObject({ tipo: 'rota', alvoId: 'mot-1' });
    expect(lidos[0]).toBe(DOC_LI_ID);
  });

  it('⚠️ NEAR-MISS: a ref naming no int_frete doc (another collection, a sub-path, a naked id, none, a missing doc) is `sem-rota-li`, with no read of another collection', async () => {
    for (const ref of [
      null,
      'documents/clientes/x',
      `documents/int_frete/${DOC_LI_ID}/sub/x`,
      // The LI doc's own id, naked: not a ref, so nothing is read for it.
      DOC_LI_ID,
      'documents/int_frete/nao-existe',
    ]) {
      lidos = [];
      const pedido = pedidoNoDocLi({ id: 141910, code: 'MOTO' }, { integracaoFreteOuterRef: ref });
      const r = await preverRotaEtiquetaLiCom(ler(), pedido);
      expect(r, String(ref)).toMatchObject({
        tipo: 'recusa',
        motivo: MOTIVO_ROTA_ETIQUETA_LI.semRotaLi,
      });
      expect(
        lidos.every((id) => !id.includes('/')),
        String(ref),
      ).toBe(true);
      expect(lidos, String(ref)).not.toContain('x');
    }
  });

  it('⚠️ NEAR-MISS: the LI doc of ANOTHER conta, or an inactive one, refuses `doc-li-divergente`', async () => {
    for (const docLi of [
      {
        ...(DOCS[DOC_LI_ID] as object),
        contaLojaIntegradaEnviosOuterRef: 'documents/integracao/c2',
      },
      { ...(DOCS[DOC_LI_ID] as object), ativo: false },
    ]) {
      const r = await preverRotaEtiquetaLiCom(
        ler({ ...DOCS, [DOC_LI_ID]: docLi }),
        pedidoNoDocLi({ id: 141910, code: 'MOTO' }),
      );
      expect(r).toMatchObject({ tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.docLiDivergente });
    }
  });

  it('EQUAL pair: the pedido’s bare conta ref is the same conta', async () => {
    const r = await preverRotaEtiquetaLiCom(ler(), {
      ...pedidoNoDocLi({ id: 141910, code: 'MOTO' }),
      integracaoPedidoOuterRef: 'integracao/c1',
    });

    expect(r).toMatchObject({ tipo: 'rota', alvoId: 'mot-1' });
  });

  it('the pedido guard runs before any target read: not paid, a bought label, no freight', async () => {
    const casos = [
      [{ estado: ESTADO_PEDIDO.carrinho }, MOTIVO_ROTA_ETIQUETA_LI.estadoNaoPago],
      [{ frete: { printLabelId: 'lbl-1' } }, MOTIVO_ROTA_ETIQUETA_LI.etiquetaJaComprada],
      [{ frete: { modalidade: '9' } }, MOTIVO_ROTA_ETIQUETA_LI.semFrete],
    ] as const;
    for (const [mudanca, motivo] of casos) {
      lidos = [];
      const base = pedidoNoDocLi(
        { id: 141910, code: 'MOTO' },
        'frete' in mudanca ? mudanca.frete : {},
      );
      const pedido = 'estado' in mudanca ? { ...base, estado: mudanca.estado } : base;
      const r = await preverRotaEtiquetaLiCom(ler(), pedido);
      expect(r, motivo).toMatchObject({ tipo: 'recusa', motivo });
      expect(lidos, motivo).toEqual([DOC_LI_ID]);
    }
  });

  it('no endereço: a motoboy target refuses `sem-endereco`', async () => {
    const r = await preverRotaEtiquetaLiCom(
      ler(),
      pedidoNoDocLi({ id: 141910, code: 'MOTO' }, { enderecoFreteOuterReference: null }),
    );

    expect(r).toMatchObject({ tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.semEndereco });
  });

  it('a stored override is read first, and the method row is read for its service rule', async () => {
    const r = await preverRotaEtiquetaLiCom(
      ler(),
      pedidoNoDocLi(
        { id: 141909, code: 'PAC' },
        { integracaoTargetOuterRef: 'documents/int_frete/me-1' },
      ),
    );

    expect(r).toEqual({
      tipo: 'rota',
      alvoId: 'me-1',
      tipoAlvo: INTEGRACAO_FRETE.melhorEnvios,
      externalOptionId: '1',
    });
    // The row's target IS the override here, so it is read once.
    expect(lidos).toEqual([DOC_LI_ID, 'me-1']);
  });

  it('⚠️ NEAR-MISS: an override pointing at a motoboy while the row is Melhor Envio reads BOTH docs', async () => {
    const r = await preverRotaEtiquetaLiCom(
      ler(),
      pedidoNoDocLi(
        { id: 141909, code: 'PAC' },
        { integracaoTargetOuterRef: 'documents/int_frete/mot-1' },
      ),
    );

    expect(r).toMatchObject({ tipo: 'rota', alvoId: 'mot-1', externalOptionId: null });
    expect(lidos).toEqual([DOC_LI_ID, 'mot-1', 'me-1']);
  });

  it('a mapped target that no longer exists refuses with its own motivo', async () => {
    const { 'mot-1': _sumiu, ...semMotoboy } = DOCS;
    const r = await preverRotaEtiquetaLiCom(
      ler(semMotoboy),
      pedidoNoDocLi({ id: 141910, code: 'MOTO' }),
    );

    expect(r).toMatchObject({ tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.alvoAusente });
  });

  it('the LI doc’s RAW mapa reaches the resolver: a non-list mapa is `mapa-invalido`, never empty', async () => {
    const r = await preverRotaEtiquetaLiCom(
      ler({ ...DOCS, [DOC_LI_ID]: { ...(DOCS[DOC_LI_ID] as object), mapa: { x: 1 } } }),
      pedidoNoDocLi({ id: 141910, code: 'MOTO' }),
    );

    expect(r).toMatchObject({ tipo: 'recusa', motivo: MOTIVO_ROTA_ETIQUETA_LI.mapaInvalido });
  });
});

describe('preverRotaEtiquetaLi — bound to Firestore, RAW reads by id', () => {
  beforeEach(() => {
    h.getDoc.mockReset();
    h.docRef.mockReset();
    h.docRef.mockImplementation((id: string) => ({ id }));
    h.getDoc.mockImplementation(async (ref: { id: string }) => ({ data: () => DOCS[ref.id] }));
  });

  it('reads each doc through the int_frete handle, unconverted', async () => {
    const r = await preverRotaEtiquetaLi({} as never, pedidoNoDocLi({ id: 141910, code: 'MOTO' }));

    expect(r).toMatchObject({ tipo: 'rota', alvoId: 'mot-1' });
    expect(h.docRef.mock.calls.map((c) => c[0])).toEqual([DOC_LI_ID, 'mot-1']);
  });
});
