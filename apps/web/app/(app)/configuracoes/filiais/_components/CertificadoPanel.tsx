'use client';

/**
 * "Certificado Digital" tab content for one Filial — uploads the filial's A1
 * certificate (.pfx/.p12) so its NF-e are signed with the right CNPJ.
 *
 * The PFX bytes + password go straight to the apps/nfe upload endpoint over
 * HTTPS (never to Firestore from the client); the server encrypts the private
 * key at rest and returns only public metadata. This panel reads that metadata
 * back from the filial doc (`filial.certificado`) to show the status badge.
 */
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  FileInput,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDoc } from 'firebase/firestore';

import { PERM } from '@delfrance/auth';
import { NFeHttpError, NFeNetworkError } from '@delfrance/integrations-nfe/http-provider';
import type { CertificadoFilialInfo } from '@delfrance/schemas';

import { usePermission } from '@/lib/auth';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';

/** Read a File's bytes as base64 (browser-safe — no Buffer). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Badge color + label from a cert's notAfter (válido / vence em N dias / expirado). */
function certStatus(notAfter: string): { color: string; label: string } {
  const daysLeft = Math.floor((new Date(notAfter).getTime() - Date.now()) / 86_400_000);
  if (daysLeft < 0) return { color: 'red', label: 'Expirado' };
  if (daysLeft <= 30) return { color: 'yellow', label: `Vence em ${daysLeft} dia(s)` };
  return { color: 'green', label: 'Válido' };
}

export function CertificadoPanel({ filialId }: { filialId: string }) {
  const db = getFirebaseFirestore();
  const queryClient = useQueryClient();
  const client = useNFeClient();
  const { allowed: canWrite } = usePermission(PERM.configuracoes.write);

  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');

  const filialQuery = useQuery({
    queryKey: ['filial', filialId],
    queryFn: async () => {
      const snap = await getDoc(filialCollection.docRef(db, {}, filialId));
      return snap.exists() ? snap.data() : null;
    },
  });

  const certificado: CertificadoFilialInfo | null = filialQuery.data?.certificado ?? null;

  const upload = useMutation({
    mutationFn: async () => {
      if (!client || !file) return;
      const pfxBase64 = await fileToBase64(file);
      await client.uploadCertificado(filialId, pfxBase64, password, file.name);
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Certificado enviado com sucesso.' });
      setFile(null);
      setPassword('');
      void queryClient.invalidateQueries({ queryKey: ['filial', filialId] });
    },
    onError: (err) => {
      // A wrong password / malformed PFX / CNPJ mismatch comes back as an
      // NFeHttpError (422) — show its message; network errors likewise.
      if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
        notifications.show({ color: 'red', title: 'Falha no envio', message: err.message });
        return;
      }
      throw err;
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await client.deleteCertificado(filialId);
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Certificado removido.' });
      void queryClient.invalidateQueries({ queryKey: ['filial', filialId] });
    },
    onError: (err) => {
      if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
        notifications.show({ color: 'red', title: 'Falha ao remover', message: err.message });
        return;
      }
      throw err;
    },
  });

  if (filialQuery.isLoading) return <Loader size="sm" />;
  if (filialQuery.isError) {
    return (
      <Alert color="red" title="Falha ao carregar a filial">
        {filialQuery.error instanceof Error ? filialQuery.error.message : 'Erro desconhecido'}
      </Alert>
    );
  }

  return (
    <Stack gap="lg" maw={640}>
      {certificado ? (
        <Card withBorder padding="md">
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Group gap="sm">
                <Text fw={500}>{certificado.subjectCommonName}</Text>
                <Badge color={certStatus(certificado.notAfter).color} variant="light">
                  {certStatus(certificado.notAfter).label}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed">
                CNPJ: {certificado.cnpj}
              </Text>
              <Text size="sm" c="dimmed">
                Válido até {new Date(certificado.notAfter).toLocaleString('pt-BR')}
              </Text>
              <Text size="xs" c="dimmed">
                Arquivo: {certificado.filename} — enviado em{' '}
                {new Date(certificado.uploadedAt).toLocaleString('pt-BR')}
              </Text>
            </Stack>
            <Button
              color="red"
              variant="light"
              size="compact-sm"
              onClick={() => remove.mutate()}
              loading={remove.isPending}
              disabled={!canWrite || !client}
            >
              Remover
            </Button>
          </Group>
        </Card>
      ) : (
        <Alert color="gray" title="Sem certificado">
          Esta filial ainda não tem um certificado digital A1. Envie o arquivo .pfx/.p12 abaixo para
          habilitar a emissão de NF-e com o CNPJ desta filial.
        </Alert>
      )}

      <Stack gap="xs">
        <Title order={5}>{certificado ? 'Substituir certificado' : 'Enviar certificado'}</Title>
        <FileInput
          label="Arquivo do certificado (A1)"
          description="Formato .pfx ou .p12 emitido pela sua AC (ICP-Brasil)."
          placeholder="Selecione o arquivo…"
          accept=".pfx,.p12"
          value={file}
          onChange={setFile}
          disabled={!canWrite}
          clearable
        />
        <PasswordInput
          label="Senha do certificado"
          description="Usada apenas para abrir o arquivo no envio — não é armazenada."
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          disabled={!canWrite}
        />
        <Group>
          <Button
            onClick={() => upload.mutate()}
            loading={upload.isPending}
            disabled={!canWrite || !client || !file}
          >
            Enviar certificado
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}
