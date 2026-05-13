'use client';

import type { ReactNode } from 'react';
import { AppShell, Burger, Center, Group, Loader, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useRequireAuth } from '@/lib/auth';
import { SidebarNav } from './_components/SidebarNav';
import { TenantBadge } from './_components/TenantBadge';
import { UserMenu } from './_components/UserMenu';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useRequireAuth();
  const [opened, { toggle }] = useDisclosure(false);

  if (loading || !user) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened, desktop: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} size="sm" />
            <Title order={4}>Delfrance</Title>
            <TenantBadge />
          </Group>
          <UserMenu />
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <SidebarNav />
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
