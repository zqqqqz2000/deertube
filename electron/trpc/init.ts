import type { IpcMainInvokeEvent } from 'electron'
import { initTRPC } from '@trpc/server'
import superjson from 'superjson'

export function createTRPCContext(opts: { event: IpcMainInvokeEvent }) {
  return {
    event: opts.event,
  }
}

export type Context = Awaited<ReturnType<typeof createTRPCContext>>

const t = initTRPC
  .context<Context>()
  .create({ isServer: true, transformer: superjson })

export const createTRPCRouter = t.router
export const baseProcedure = t.procedure
