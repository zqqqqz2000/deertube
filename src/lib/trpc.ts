import type { AppRouter } from '../../electron/trpc/routers/_app'
import { createTRPCProxyClient } from '@trpc/client'
import { ipcLink } from 'electron-trpc-experimental/renderer'
import superjson from 'superjson'

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
})
