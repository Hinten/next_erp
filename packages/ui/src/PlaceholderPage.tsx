'use client';

import type { ReactNode } from 'react';
import { Alert, Stack } from '@mantine/core';
import { PageHeader } from './PageHeader';

export interface PlaceholderPageProps {
  title: string;
  description?: ReactNode;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <Stack>
      <PageHeader title={title} description={description} />
      <Alert color="yellow" title="Em construção">
        Esta tela ainda não foi implementada no rewrite. Ela está listada no menu
        para refletir a paridade com o app Flutter e será desenvolvida em uma
        próxima fase.
      </Alert>
    </Stack>
  );
}
