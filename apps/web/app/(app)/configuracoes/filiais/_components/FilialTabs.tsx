'use client';

import type { ReactNode } from 'react';
import { Alert, Tabs } from '@mantine/core';

import { NfeConfigPanel } from './NfeConfigPanel';
import { CertificadoPanel } from './CertificadoPanel';
import { SimplesNacionalPanel } from './SimplesNacionalPanel';

/**
 * Tab shell shared by the Filial create and edit pages, porting the
 * `rightMenu` of the Flutter `FilialCadastroPage`
 * (`.old/lib/grupoEconomico/pages/filiaisTableView.dart`): a single page that
 * serves both flows with the same navigation.
 *
 * The "Dados" panel content is supplied by the caller. The NFe panel shows the
 * per-filial NF-e config (contingency switch + SEFAZ status checks); the
 * Certificado panel is still a placeholder; and the Simples Nacional panel
 * carries the fiscal-regime config plus the monthly apuração's result (#1491).
 *
 * The three id-bound panels all render only when a `filialId` exists (the edit
 * page); the create page has none yet, so each keeps a save-first hint.
 * Tabs keep their default `keepMounted` (true) so the form keeps unsaved
 * input when the user peeks at the other tabs — matching the Flutter
 * `AutomaticKeepAlive`.
 */
export function FilialTabs({ children, filialId }: { children: ReactNode; filialId?: string }) {
  return (
    <Tabs defaultValue="dados">
      <Tabs.List>
        <Tabs.Tab value="dados">Dados</Tabs.Tab>
        <Tabs.Tab value="nfe">Configurações NFe</Tabs.Tab>
        <Tabs.Tab value="certificado">Certificado Digital</Tabs.Tab>
        <Tabs.Tab value="simples">Simples Nacional</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="dados" pt="md">
        {children}
      </Tabs.Panel>

      <Tabs.Panel value="nfe" pt="md">
        {filialId ? (
          <NfeConfigPanel filialId={filialId} />
        ) : (
          <Alert color="blue" title="Salve a filial primeiro">
            A configuração de NF-e (status SEFAZ + contingência) fica disponível depois que a filial
            é salva.
          </Alert>
        )}
      </Tabs.Panel>

      <Tabs.Panel value="certificado" pt="md">
        {filialId ? (
          <CertificadoPanel filialId={filialId} />
        ) : (
          <Alert color="blue" title="Salve a filial primeiro">
            O envio do certificado digital A1 (.pfx/.p12) fica disponível depois que a filial é
            salva.
          </Alert>
        )}
      </Tabs.Panel>

      <Tabs.Panel value="simples" pt="md">
        {filialId ? (
          <SimplesNacionalPanel filialId={filialId} />
        ) : (
          <Alert color="blue" title="Salve a filial primeiro">
            A configuração do Simples Nacional (anexo, alíquota e apuração mensal) fica disponível
            depois que a filial é salva.
          </Alert>
        )}
      </Tabs.Panel>
    </Tabs>
  );
}
