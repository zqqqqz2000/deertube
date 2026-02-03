import type { AppRouter } from '../../electron/trpc/routers/_app'
import { createTRPCClient, createTRPCProxyClient } from '@trpc/client'
import { ipcLink } from 'electron-trpc-experimental/renderer'
import superjson from 'superjson'

export const trpcClient = createTRPCClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
})

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
})
