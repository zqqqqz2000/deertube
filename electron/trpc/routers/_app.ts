import { createTRPCRouter } from '../init'
import { projectRouter } from './project'
import { deepSearchRouter } from './deepSearch'
import { previewRouter } from './preview'

export const appRouter = createTRPCRouter({
  project: projectRouter,
  deepSearch: deepSearchRouter,
  preview: previewRouter,
})

export type AppRouter = typeof appRouter
