'use client';

import type { ReactNode } from 'react';
import { Alert, Tabs } from '@mantine/core';

import { NfeConfigPanel } from './NfeConfigPanel';
import { CertificadoPanel } from './CertificadoPanel';

/**
 * Tab shell shared by the Filial create and edit pages, porting the
 * `rightMenu` of the Flutter `FilialCadastroPage`
 * (`.old/lib/grupoEconomico/pages/filiaisTableView.dart`): a single page that
 * serves both flows with the same Dados / Configurações NFe / Certificado
 * Digital navigation.
 *
 * The "Dados" panel content is supplied by the caller. The NFe panel shows
 * the per-filial NF-e config (contingency switch + SEFAZ status checks) when
 * a `filialId` is available (edit page); the create page has no id yet, so
 * it keeps a save-first hint. The Certificado panel is still a placeholder.
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
    </Tabs>
  );
}
