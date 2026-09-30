import type { Pedido } from '@delfrance/schemas';
import {
  aplicarPlanoDeCopiaDeEndereco,
  buildEnderecoCopyOps,
  enderecoCopyReadPaths,
  type PedidoEnderecoCopyPlan,
} from './enderecoCopy';
import { PEDIDO_COUNTER_PATH, mintNumeros, operacaoNumeroPrefix } from './numero';
import type { PedidoDataPort } from './port';

/** Create a numbered pedido and any confirmed address copies atomically. */
export async function criarPedidoComNumero(
  port: PedidoDataPort,
  args: {
    values: Pedido;
    operacaoNome: string | null;
    enderecoCopyPlan?: PedidoEnderecoCopyPlan | null;
  },
): Promise<{ id: string; numero: string }> {
  const pedidoId = port.newId();
  const values = aplicarPlanoDeCopiaDeEndereco(args.values, args.enderecoCopyPlan);
  const prefix = operacaoNumeroPrefix(args.operacaoNome);
  let numero = '';

  await port.transact({
    reads: [PEDIDO_COUNTER_PATH, ...enderecoCopyReadPaths(args.enderecoCopyPlan)],
    apply(docs) {
      const { numeros, counterOp } = mintNumeros(docs.get(PEDIDO_COUNTER_PATH) ?? null, [prefix]);
      numero = numeros[0] ?? '';
      return [
        counterOp,
        ...buildEnderecoCopyOps(args.enderecoCopyPlan, docs, port.now()),
        {
          type: 'set',
          path: `pedidos/${pedidoId}`,
          data: {
            ...(values as unknown as Record<string, unknown>),
            numero,
            timestamp: values.timestamp ?? port.now(),
          },
        },
      ];
    },
  });
  return { id: pedidoId, numero };
}
