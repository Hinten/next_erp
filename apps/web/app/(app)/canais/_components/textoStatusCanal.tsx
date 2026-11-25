import { Code } from '@mantine/core';
import type { MarketplaceCapabilities } from '@delfrance/schemas';
import type { ReactElement } from 'react';

type CapsStatusCanal = Pick<MarketplaceCapabilities, 'implementado' | 'channel'>;

export function textoStatusCanal(caps: CapsStatusCanal | null): {
  dica: string;
  alerta: ReactElement | null;
} {
  if (caps === null) {
    return { dica: 'Não é um canal de marketplace (balcão, WhatsApp)', alerta: null };
  }
  if (caps.implementado) {
    return { dica: `Backend: apps/${caps.channel ?? '—'}`, alerta: null };
  }
  if (caps.channel === null) {
    return {
      dica: 'Nenhum backend implementado para este canal ainda',
      alerta: (
        <>
          Não existe backend <Code mx={4}>apps/&lt;canal&gt;</Code> para este canal, então nada é
          publicado, importado nem sincronizado por aqui.
        </>
      ),
    };
  }

  const backend = `apps/${caps.channel}`;
  return {
    dica: `Backend ${backend} em construção — as ações de /produtos (estoque, preços, pausa) ainda não chegam a este canal`,
    alerta: (
      <>
        O backend <Code>{backend}</Code> está em construção, mas o canal ainda não está
        implementado: as ações em massa de /produtos (enviar estoque, enviar preços, pausar
        anúncios) ainda não chegam a ele.
      </>
    ),
  };
}
