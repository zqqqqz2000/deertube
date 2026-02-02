import { z } from 'zod'
import { baseProcedure, createTRPCRouter } from '../init'
import { getPreviewController } from '../preview'

export const previewRouter = createTRPCRouter({
  show: baseProcedure
    .input(
      z.object({
        url: z.string(),
        bounds: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const controller = getPreviewController()
      await controller.show(input.url, input.bounds)
      return { ok: true }
    }),
  hide: baseProcedure.mutation(() => {
    const controller = getPreviewController()
    controller.hide()
    return { ok: true }
  }),
})

export type PreviewRouter = typeof previewRouter
