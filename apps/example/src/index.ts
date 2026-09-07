/* eslint-disable no-console -- demo CLI: stdout is the interface */
/**
 * Delfrance OSS demo — minimal showcase that exercises every public
 * surface a contributor would touch to build an ERP feature on top of
 * the framework, without depending on Firebase or any apps/ subapp.
 *
 * Run it locally:
 *   pnpm --filter @delfrance/example demo
 *
 * What it demonstrates:
 * 1. Schemas — parse + validate.
 * 2. Money / Address / Documents primitives.
 * 3. Permission helpers — check claim against required bit.
 */

import { format, money, add, formatReais } from '@delfrance/core/money';
import { brDocumentProvider } from '@delfrance/core/documents';
import { clienteSchema, produtoSchema, pedidoSchema, pedidoTotal } from '@delfrance/schemas';
import { PERM, hasPerm } from '@delfrance/auth';

function section(label: string) {
  console.log(`\n=== ${label} ===`);
}

async function main() {
  section('1. Schemas');
  const cliente = clienteSchema.parse({
    nome: 'Maria Silva',
    cpf_cnpj: '52998224725',
    email: 'maria@example.com',
    tipo: '0',
  });
  console.log(
    'cliente:',
    cliente.nome,
    '·',
    brDocumentProvider.formatIndividual(cliente.cpf_cnpj!),
  );

  const produto = produtoSchema.parse({
    nome: 'Camiseta básica',
    sku: 'CB-001',
    pesoLiquidoKg: 0.2,
  });
  console.log('produto:', produto.nome, '· SKU', produto.sku);

  const pedido = pedidoSchema.parse({
    estado: 'pago',
    integracaoPedidoOuterRef: 'documents/integracao/balcao',
    numero: 'D-001',
    itens: {
      [produto.sku!]: [
        {
          ordem: 1,
          precoDeVenda: 49.9,
          descontoUnitario: 0,
          quantidade: 2,
          nomeDeVenda: produto.nome,
        },
      ],
    },
  });
  const total = pedidoTotal(pedido);
  console.log('pedido', pedido.numero, '· total:', formatReais(total));

  section('2. Money primitives');
  const a = money(1250); // R$ 12,50
  const b = money(750); // R$ 7,50
  console.log('add:', format(add(a, b)));

  section('3. Permission claim check');
  const granted = (PERM.cliente.read | PERM.cliente.write).toString();
  console.log('can read cliente?', hasPerm(granted, PERM.cliente.read));
  console.log('can delete cliente?', hasPerm(granted, PERM.cliente.delete));

  section('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
