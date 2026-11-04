'use client';

import { Stack, Text } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import type { FieldRenderProps } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { errosPorLinhaDoHorarioLi } from '@/lib/loja-integrada/freteDaConta';
import { HorarioCorteEditor } from '@/app/(app)/logistica/_components/HorarioCorteEditor';
import { FreteDaContaLiAviso } from './FreteDaContaLiAviso';
import { intFreteIdDe, useSemearFreteDaContaLi, type FreteDaContaLi } from './useFreteDaContaLi';

export interface HorarioCorteManagerProps extends FieldRenderProps {
  readonly db: Firestore;
  readonly frete: FreteDaContaLi;
}

/**
 * "Horário de Corte" tab of a Loja Integrada conta: the cut-off schedule of the
 * conta's freight doc (`horarioDeCorte`), edited with the same
 * `HorarioCorteEditor` the `/logistica` screens use (staged row deletion
 * included).
 *
 * The rows get the freight schema's own `horarioDeCorte` rule from the page
 * (`problemasDoFreteDaContaLi`) once the operator CHANGES them: a duplicated
 * weekday then shows here and blocks the save, while a stored list nobody
 * touched — imported shapes included — never blocks a save of the conta. The
 * page's refusal reaches this field as one flat message, so the rows it is
 * about are marked from the same rule (`errosPorLinhaDoHorarioLi`).
 * Editable only with BOTH the conta's write permission and
 * `PERM.frete.write`, and only once the doc is loaded from the server; the
 * conta's "Salvar" writes the change (see `escritasFreteDaContaLi`).
 */
export function HorarioCorteManager({ db, frete, ...campo }: HorarioCorteManagerProps) {
  const { allowed: podeEscreverFrete } = usePermission(PERM.frete.write);
  const semente = useSemearFreteDaContaLi(db, intFreteIdDe(frete));
  const pronto = frete.estado === 'encontrado' && semente.ready;
  const editavel =
    !campo.disabled &&
    podeEscreverFrete &&
    pronto &&
    frete.estado === 'encontrado' &&
    frete.naConsulta;

  return (
    <Stack>
      <FreteDaContaLiAviso frete={frete} semente={semente} />
      {pronto && !podeEscreverFrete && !campo.disabled && (
        <Text size="sm" c="dimmed">
          Somente leitura: editar os horários exige permissão de escrita nas integrações de frete.
        </Text>
      )}
      {pronto && (
        <HorarioCorteEditor
          {...campo}
          errorTree={errosPorLinhaDoHorarioLi(campo.value, campo.errorTree)}
          disabled={!editavel}
        />
      )}
    </Stack>
  );
}
