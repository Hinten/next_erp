'use client';

import { notifications } from '@mantine/notifications';
import type { AvisoDimensoes } from '@delfrance/schemas';

/**
 * Tell the operator when the estimated box is not shippable as-is (#371).
 *
 * Shared by BOTH paths that build a Volume — the activation seed
 * (`seedVolumePadrao`, via `FreteTab`) and `VolumesEditor`'s "+ Novo volume"
 * button. They produce the same box, so they must explain it the same way;
 * having only one of them warn meant an operator who added the volume by hand
 * got a clamped, possibly-unshippable box with no indication.
 *
 * `semDimensoes` is deliberately silent: no produto in the pedido carries
 * dimensions, which is the common case today and not something the operator can
 * act on from the Frete tab.
 */
export function notificarAvisoDimensoes(aviso: AvisoDimensoes | null | undefined): void {
  if (aviso === 'excedeu60') {
    notifications.show({
      color: 'yellow',
      title: 'Volume acima de 60cm',
      message:
        'O volume estimado passa de 60cm em algum lado — a maioria das transportadoras cobra adicional. Considere dividir o pedido.',
    });
    return;
  }
  if (aviso === 'excedeuLimiteLegal') {
    notifications.show({
      color: 'orange',
      title: 'Volume acima do limite dos Correios',
      message:
        'O pedido não cabe em um único volume dentro do limite dos Correios (100cm por lado, 200cm somados). As medidas foram limitadas — divida o pedido em mais volumes.',
    });
  }
}
