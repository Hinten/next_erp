'use client';

import { useMemo } from 'react';
import { Accordion, Alert, List, Stack } from '@mantine/core';
import type { ProblemaDeEmissao } from '@delfrance/schemas';
import { DadosGeraisSection } from './DadosGeraisSection';
import { IcmsSection } from './IcmsSection';
import { IpiSection } from './IpiSection';
import { IssqnSection } from './IssqnSection';
import { PisCofinsSection } from './PisCofinsSection';
import { RetencaoSection } from './RetencaoSection';
import { RtcSection } from './RtcSection';
import type { ImpostoConfigValue } from './types';

export type { ImpostoConfigValue } from './types';
export { IMPOSTO_CONFIG_KEYS, IMPOSTO_DADOS_GERAIS_KEYS } from './types';

export interface ImpostoConfigEditorProps {
  value: ImpostoConfigValue | null;
  onChange: (next: ImpostoConfigValue) => void;
  /** Show the Dados Gerais (origem/CFOP/NCM/…) section. Default true. Hidden for
   * the operação default tab, where those live in the operação's own Dados Gerais. */
  showDadosGerais?: boolean;
  /** Whether RTC emission is on for the filial (drives an informational hint). */
  emitRtc?: boolean;
  disabled?: boolean;
  /** RHF error node for the imposto blob (keyed by field), if any. */
  errorTree?: unknown;
  /**
   * What the NF-e engine would refuse in this config (#1655) — the HOST
   * computes it with `problemasDeEmissaoDoImposto`, because only the host holds
   * the whole tier doc the engine's tier gate reads (the operação blob handed
   * here has no `origem`). Drives the orange Alert and the inline field errors;
   * blocking the save is the host's save path, not this component.
   */
  problemas?: readonly ProblemaDeEmissao[];
}

const SEM_PROBLEMAS: readonly ProblemaDeEmissao[] = [];

/**
 * Controlled deep tax-config editor — the reusable component behind the operação
 * default, the operação Macros (regraImposto), the produto and the categoria
 * imposto editors. Renders the Simples Nacional surface + Reforma Tributária; it
 * **patches** the blob it's given (never rebuilds), so a config section it
 * doesn't surface (e.g. a Regime Normal ICMS blob) survives a round-trip.
 */
export function ImpostoConfigEditor({
  value,
  onChange,
  showDadosGerais = true,
  emitRtc,
  disabled,
  errorTree,
  problemas = SEM_PROBLEMAS,
}: ImpostoConfigEditorProps) {
  const v = useMemo<ImpostoConfigValue>(() => value ?? {}, [value]);
  const errors = (errorTree ?? {}) as Record<string, unknown>;

  const defaultOpen = useMemo(
    () => (showDadosGerais ? ['dados', 'icms'] : ['icms']),
    [showDadosGerais],
  );

  // Field path → the first message about it, for the sections' inline errors.
  const errosPorCampo = useMemo<ReadonlyMap<string, string>>(() => {
    const erros = new Map<string, string>();
    for (const { campos, mensagem } of problemas) {
      for (const campo of campos) if (!erros.has(campo)) erros.set(campo, mensagem);
    }
    return erros;
  }, [problemas]);

  return (
    <Stack gap="sm">
      {problemas.length > 0 && (
        <Alert color="orange" title="A NF-e recusaria esta configuração">
          <List size="sm" spacing={2}>
            {problemas.map(({ mensagem }) => (
              <List.Item key={mensagem}>{mensagem}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Accordion multiple defaultValue={defaultOpen} variant="separated">
        {showDadosGerais && (
          <Accordion.Item value="dados">
            <Accordion.Control>Dados gerais fiscais</Accordion.Control>
            <Accordion.Panel>
              <DadosGeraisSection
                value={v}
                onChange={onChange}
                disabled={disabled}
                errorNode={errors as Record<string, { message?: string } | undefined>}
              />
            </Accordion.Panel>
          </Accordion.Item>
        )}

        <Accordion.Item value="icms">
          <Accordion.Control>ICMS</Accordion.Control>
          <Accordion.Panel>
            <IcmsSection
              value={v}
              onChange={onChange}
              disabled={disabled}
              errorNode={errors.configuracaoICMS as Record<string, unknown> | undefined}
              errosPorCampo={errosPorCampo}
            />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="pis">
          <Accordion.Control>PIS / COFINS</Accordion.Control>
          <Accordion.Panel>
            <PisCofinsSection
              value={v}
              onChange={onChange}
              disabled={disabled}
              errosPorCampo={errosPorCampo}
            />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="ipi">
          <Accordion.Control>IPI</Accordion.Control>
          <Accordion.Panel>
            <IpiSection value={v} onChange={onChange} disabled={disabled} />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="issqn">
          <Accordion.Control>ISSQN (serviços)</Accordion.Control>
          <Accordion.Panel>
            <IssqnSection value={v} onChange={onChange} disabled={disabled} />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="retencao">
          <Accordion.Control>Retenções</Accordion.Control>
          <Accordion.Panel>
            <RetencaoSection value={v} onChange={onChange} disabled={disabled} />
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="rtc">
          <Accordion.Control>Reforma Tributária (IBS / CBS / IS)</Accordion.Control>
          <Accordion.Panel>
            <RtcSection value={v} onChange={onChange} disabled={disabled} emitRtc={emitRtc} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
