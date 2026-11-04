/**
 * `incidentesPedidoLi.ts`: tier-0 incidentes at deterministic ids, created
 * once, never blocking, and never raised for a line already bound.
 */
import { describe, expect, it } from 'vitest';
import {
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  classificarIncidenteBloqueante,
  incidenteSchema,
  itemDoPedidoSchema,
  type ItemDoPedido,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  ID_INCIDENTE_LI,
  SUBTIPO_INCIDENTE_LI,
  idIncidenteLinhaLi,
  registrarIncidentesDoPedidoLi,
  type EnderecoNaoPareadoLi,
  type IncidentesDoPedidoLi,
} from './incidentesPedidoLi';

const PEDIDO = 'pedido-inc';
/** A realistic µs instant: the schemas read a small number as another unit. */
const AGORA_US = 1_800_000_000_000_000;

function item(id: string, produtoUid: string | null = null, nome = 'Produto X'): ItemDoPedido {
  return itemDoPedidoSchema.parse({
    produtoUid,
    ordem: 1,
    ensureUniqueId: id,
    mktplaceId: '7001',
    sku: '12345678901234',
    gtin: null,
    nomeDeVenda: nome,
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: 1,
  });
}

function entrada(over: Partial<IncidentesDoPedidoLi> = {}): IncidentesDoPedidoLi {
  return {
    pedidoId: PEDIDO,
    numero: '9001',
    linhasSemProduto: [{ item: item('501'), via: 'unresolved' }],
    jaVinculadas: new Set(),
    multiEnvio: false,
    clienteSemIdentidade: null,
    enderecoNaoPareado: null,
    totaisDivergentes: false,
    nowUs: AGORA_US,
    ...over,
  };
}

const caminho = (id: string) => `pedidos/${PEDIDO}/incidentes/${id}`;

/** The import resolved the buyer's cliente, and the stored fiscal endereço is another's. */
const FISCAL_DE_OUTRO: EnderecoNaoPareadoLi = {
  cliente: 'resolvido',
  enderecos: [{ uso: 'fiscal', donoLegivel: true }],
};

/** The motivo of the one incidente `entrada` raised at `id`. */
async function motivoDe(over: Partial<IncidentesDoPedidoLi>, id: string): Promise<string> {
  const db = new FakeDb();
  await registrarIncidentesDoPedidoLi(asDb(db), entrada({ linhasSemProduto: [], ...over }));
  return db.ler(caminho(id))?.motivoDoIncidente as string;
}

describe('the incidentes of one import', () => {
  it('one row per unbound line and per order-wide problem, at deterministic ids', async () => {
    const db = new FakeDb();
    const criados = await registrarIncidentesDoPedidoLi(
      asDb(db),
      entrada({
        multiEnvio: true,
        clienteSemIdentidade: { comEndereco: false },
        enderecoNaoPareado: FISCAL_DE_OUTRO,
        totaisDivergentes: true,
      }),
    );
    expect(criados.sort()).toEqual(
      [
        idIncidenteLinhaLi('501'),
        ID_INCIDENTE_LI.multiEnvio,
        ID_INCIDENTE_LI.clienteSemIdentidade,
        ID_INCIDENTE_LI.enderecoDeOutroCliente,
        ID_INCIDENTE_LI.totaisDivergentes,
      ].sort(),
    );
    expect(db.ler(caminho(idIncidenteLinhaLi('501')))).toMatchObject({
      subtipo: SUBTIPO_INCIDENTE_LI.produtoNaoVinculado,
      externalId: '7001',
      timestamp: AGORA_US,
      resolucao: null,
    });
    expect(db.ler(caminho(ID_INCIDENTE_LI.multiEnvio))?.subtipo).toBe('li-multi-envio');
    expect(db.ler(caminho(ID_INCIDENTE_LI.enderecoDeOutroCliente))?.subtipo).toBe(
      'li-endereco-de-outro-cliente',
    );
  });

  it('never blocks: tipo and origem are both outros, which both gates refuse', async () => {
    const db = new FakeDb();
    await registrarIncidentesDoPedidoLi(
      asDb(db),
      entrada({ enderecoNaoPareado: FISCAL_DE_OUTRO, totaisDivergentes: true }),
    );
    for (const id of db.idsEm(`pedidos/${PEDIDO}/incidentes`)) {
      const row = db.ler(caminho(id))!;
      expect(row.tipo).toBe(TIPO_INCIDENTE.outros);
      expect(row.origem).toBe(ORIGEM_INCIDENTE.outros);
      expect(classificarIncidenteBloqueante(incidenteSchema.parse(row))).toBeNull();
    }
  });

  it('a redelivery creates nothing and keeps the first timestamp; only ALREADY_EXISTS is swallowed', async () => {
    const db = new FakeDb();
    await registrarIncidentesDoPedidoLi(asDb(db), entrada());
    expect(await registrarIncidentesDoPedidoLi(asDb(db), entrada({ nowUs: AGORA_US + 5 }))).toEqual(
      [],
    );
    expect(db.ler(caminho(idIncidenteLinhaLi('501')))?.timestamp).toBe(AGORA_US);

    const falha = new FakeDb();
    falha.falharEscrita(caminho(idIncidenteLinhaLi('501')), grpc(14, 'UNAVAILABLE'));
    await expect(registrarIncidentesDoPedidoLi(asDb(falha), entrada())).rejects.toMatchObject({
      code: 14,
    });
  });

  it('a line already stored with a produto raises nothing; a bound incoming line raises nothing', async () => {
    const db = new FakeDb();
    const criados = await registrarIncidentesDoPedidoLi(
      asDb(db),
      entrada({
        linhasSemProduto: [
          { item: item('501'), via: 'unresolved' },
          { item: item('502', 'p-1'), via: 'unresolved' },
        ],
        jaVinculadas: new Set(['501']),
      }),
    );
    expect(criados).toEqual([]);
  });

  it('the message names the ambiguity, and a long name is cut so the row always parses', async () => {
    const db = new FakeDb();
    await registrarIncidentesDoPedidoLi(
      asDb(db),
      entrada({
        linhasSemProduto: [{ item: item('501', null, 'N'.repeat(1_990)), via: 'vinculo-ambiguo' }],
      }),
    );
    const motivo = db.ler(caminho(idIncidenteLinhaLi('501')))?.motivoDoIncidente as string;
    expect(motivo).toContain('mais de um');
    expect(motivo.length).toBeLessThan(2_000);
  });
});

describe('the operator-facing text says what is TRUE of this pedido', () => {
  const ENDERECO = ID_INCIDENTE_LI.enderecoDeOutroCliente;
  const IDENTIDADE = ID_INCIDENTE_LI.clienteSemIdentidade;

  it('no identity: “sem endereço” only when the pedido holds none', async () => {
    const sem = await motivoDe({ clienteSemIdentidade: { comEndereco: false } }, IDENTIDADE);
    expect(sem).toContain('ficou sem cliente e sem endereço.');
    const com = await motivoDe({ clienteSemIdentidade: { comEndereco: true } }, IDENTIDADE);
    expect(com).toContain('ficou sem cliente.');
    expect(com).not.toContain('sem endereço');
  });

  it('the buyer’s cliente resolved beside another’s endereço: the cliente was withheld, and the text says so', async () => {
    const motivo = await motivoDe({ enderecoNaoPareado: FISCAL_DE_OUTRO }, ENDERECO);
    expect(motivo).toContain('Pedido 9001');
    expect(motivo).toContain('o endereço fiscal é de outro cliente, e não do cliente do comprador');
    expect(motivo).toContain(
      'não vinculou o cliente do comprador ao pedido nem definiu a transportadora do frete',
    );
  });

  it('NEAR-MISS: a STORED cliente beside another’s endereço — none was withheld, so the text never says one was', async () => {
    const motivo = await motivoDe(
      { enderecoNaoPareado: { ...FISCAL_DE_OUTRO, cliente: 'armazenado' } },
      ENDERECO,
    );
    expect(motivo).toContain('o endereço fiscal é de outro cliente, e não do cliente do pedido');
    expect(motivo).not.toContain('não vinculou');
    expect(motivo).toContain('não definiu a transportadora do frete');
  });

  it('an owner nobody can read is never called “another cliente”', async () => {
    const motivo = await motivoDe(
      {
        enderecoNaoPareado: {
          cliente: 'armazenado',
          enderecos: [{ uso: 'entrega', donoLegivel: false }],
        },
      },
      ENDERECO,
    );
    expect(motivo).toContain(
      'não foi possível identificar de qual cliente é o endereço de entrega',
    );
    expect(motivo).not.toContain('de outro cliente');
  });

  it('each endereço with its own reason, fiscal first', async () => {
    const motivo = await motivoDe(
      {
        enderecoNaoPareado: {
          cliente: 'armazenado',
          enderecos: [
            { uso: 'fiscal', donoLegivel: true },
            { uso: 'entrega', donoLegivel: false },
          ],
        },
      },
      ENDERECO,
    );
    expect(motivo).toContain(
      'o endereço fiscal é de outro cliente, e não do cliente do pedido; não foi possível ' +
        'identificar de qual cliente é o endereço de entrega.',
    );
  });

  it.each([
    ['ausente', 'o pedido está sem cliente'],
    ['ilegivel', 'o cliente do pedido não pôde ser identificado'],
  ] as const)(
    'no cliente to compare with (%s): no “other” cliente is named, and none was withheld',
    async (cliente, esperado) => {
      const motivo = await motivoDe(
        {
          enderecoNaoPareado: {
            cliente,
            enderecos: [
              { uso: 'fiscal', donoLegivel: true },
              { uso: 'entrega', donoLegivel: true },
            ],
          },
        },
        ENDERECO,
      );
      expect(motivo).toContain(
        `${esperado}, então não foi possível conferir a quem pertence o endereço fiscal e o ` +
          'endereço de entrega.',
      );
      expect(motivo).not.toContain('de outro cliente');
      expect(motivo).not.toContain('não vinculou');
    },
  );
});
