'use client';

import { Alert, Button, Group, Text } from '@mantine/core';
import type { ProblemaDeEmissao } from '@delfrance/schemas';

/** One per-operação row of a produto/categoria Impostos tab. */
export interface LinhaDeOperacao {
  operacaoId: string;
  nome: string;
  problemas: readonly ProblemaDeEmissao[];
}

export interface OperacoesComProblemasProps {
  linhas: readonly LinhaDeOperacao[];
  /** The operação whose row the editor is showing — its problems are shown there. */
  ativa: string | null;
  onSelecionar: (operacaoId: string) => void;
}

/**
 * The produto and categoria Impostos tabs show ONE operação's row at a time,
 * but their save refuses EVERY reachable row the NF-e engine would refuse
 * (#1655) — including a stored one on an operação nobody opened. This names
 * those other rows, each as a button that switches the editor to it, so the
 * operator can find what blocks the save. Renders nothing when no other row
 * has a problem.
 */
export function OperacoesComProblemas({ linhas, ativa, onSelecionar }: OperacoesComProblemasProps) {
  const outras = linhas.filter((l) => l.operacaoId !== ativa && l.problemas.length > 0);
  if (outras.length === 0) return null;
  return (
    <Alert color="orange" title="Outras operações que a NF-e recusaria">
      <Text size="sm">
        A configuração destas operações impede salvar. Selecione uma para corrigi-la:
      </Text>
      <Group gap="xs" mt="xs">
        {outras.map((l) => (
          <Button
            key={l.operacaoId}
            size="compact-sm"
            variant="subtle"
            color="orange"
            title={l.problemas.map((p) => p.mensagem).join('\n')}
            onClick={() => onSelecionar(l.operacaoId)}
          >
            {l.nome}
          </Button>
        ))}
      </Group>
    </Alert>
  );
}
