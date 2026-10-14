'use client';

import { useMemo } from 'react';
import { Select, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { FreightNotFoundError } from '@delfrance/integrations-freight-br/http-client';
import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import { freightQueryRetry } from '@/lib/freight/queryRetry';
import {
  rotuloServicoMelhorEnvioLi,
  type ServicoMelhorEnvioLi,
} from '@/lib/loja-integrada/freteDaConta';

export interface ServicoMelhorEnvioSelectProps {
  /** The Melhor Envio account the row is mapped to (its `int_frete` doc id). */
  readonly intFreteId: string;
  /** The stored service id (`targetData.id`), or `null`. */
  readonly value: number | null;
  /** The stored `nomeTarget` — kept visible when the list cannot be read. */
  readonly nomeArmazenado: string | null;
  readonly onChange: (servico: ServicoMelhorEnvioLi) => void;
  readonly disabled?: boolean;
  /** Field label; distinct per row so each select is addressable. */
  readonly label: string;
}

/** Never re-asked after a 404: the backend predates the route, and asking again changes nothing. */
function repetir(falhas: number, err: unknown): boolean {
  return !(err instanceof FreightNotFoundError) && freightQueryRetry(falhas, err);
}

/**
 * "Serviço" of a `mapa` row mapped to a Melhor Envio account: the account's
 * carrier services, read through the apps/melhor-envio service-list route (the
 * account's token never reaches the browser).
 *
 * ⚠️ The route may be missing on the backend the browser talks to — the web app
 * and that backend roll out separately — and then answers 404. That, and any
 * other failure, DEGRADES this select instead of breaking the tab: it is
 * disabled, the stored service stays visible under its stored label, and the
 * reason is shown. Since a Melhor Envio target is applied only once a service is
 * picked, a disabled select also blocks pointing a row at a NEW Melhor Envio
 * account until the list can be read.
 */
export function ServicoMelhorEnvioSelect({
  intFreteId,
  value,
  nomeArmazenado,
  onChange,
  disabled,
  label,
}: ServicoMelhorEnvioSelectProps) {
  const client = useFreightClient();
  const servicos = useQuery({
    queryKey: ['me-servicos', intFreteId],
    enabled: client !== null,
    staleTime: 5 * 60_000,
    retry: repetir,
    queryFn: () => client!.servicos(intFreteId),
  });

  const lista = useMemo(() => servicos.data?.servicos ?? [], [servicos.data]);
  const data = useMemo(() => {
    const opcoes = lista.map((s) => ({
      value: String(s.id),
      label: rotuloServicoMelhorEnvioLi(s),
    }));
    if (value !== null && !opcoes.some((o) => o.value === String(value))) {
      opcoes.unshift({ value: String(value), label: nomeArmazenado ?? `Serviço ${value}` });
    }
    return opcoes;
  }, [lista, value, nomeArmazenado]);

  const erro = servicos.error;
  let aviso: string | null = null;
  if (erro !== null) {
    if (erro instanceof FreightNotFoundError) {
      // The route itself missing, or the account doc gone: the same 404 either way.
      aviso =
        'A lista de serviços desta conta do Melhor Envio não foi encontrada no servidor. O serviço salvo continua valendo, mas não é possível escolher outro agora.';
    } else {
      const mensagem = freightErrorMessage(erro);
      // Not a freight failure: a bug, not a degraded backend — surface it.
      if (mensagem === null) throw erro;
      aviso = `Não foi possível carregar os serviços do Melhor Envio: ${mensagem}`;
    }
  }

  return (
    <Stack gap={4}>
      <Select
        label={label}
        placeholder={servicos.isLoading ? 'Carregando serviços…' : 'Selecione o serviço'}
        data={data}
        value={value === null ? null : String(value)}
        onChange={(v) => {
          const escolhido = lista.find((s) => String(s.id) === v);
          if (escolhido) {
            onChange({
              id: escolhido.id,
              name: escolhido.name ?? null,
              company:
                escolhido.company == null
                  ? null
                  : { id: escolhido.company.id, name: escolhido.company.name },
            });
          }
        }}
        disabled={disabled || erro !== null || client === null}
        searchable
        allowDeselect={false}
        nothingFoundMessage="Nenhum serviço encontrado."
      />
      {aviso !== null && (
        <Text size="xs" c="orange">
          {aviso}
        </Text>
      )}
    </Stack>
  );
}
