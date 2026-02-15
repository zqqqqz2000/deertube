import { z } from "zod";
import { baseProcedure, createTRPCRouter } from "../init";
import { getCdpBrowserController } from "../../cdp-browser";

const referenceSchema = z.object({
  refId: z.number().int().positive(),
  text: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

export const cdpBrowserRouter = createTRPCRouter({
  open: baseProcedure
    .input(
      z.object({
        url: z.string().min(1),
        reference: referenceSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const controller = getCdpBrowserController();
      return controller.open({
        url: input.url,
        reference: input.reference,
      });
    }),
});

export type CdpBrowserRouter = typeof cdpBrowserRouter;

