import { createTRPCRouter } from '../init'
import { projectRouter } from './project'
import { deepSearchRouter } from './deepSearch'
import { previewRouter } from './preview'
import { chatRouter } from './chat'
import { graphRouter } from './graph'
import { browserViewRouter } from './browserView'

export const appRouter = createTRPCRouter({
  project: projectRouter,
  deepSearch: deepSearchRouter,
  preview: previewRouter,
  browserView: browserViewRouter,
  chat: chatRouter,
  graph: graphRouter,
})

export type AppRouter = typeof appRouter
