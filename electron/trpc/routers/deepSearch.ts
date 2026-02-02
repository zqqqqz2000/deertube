import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { baseProcedure, createTRPCRouter } from '../init'
import { ensureProjectStore } from './project'

type TavilySearchResult = {
  title?: string
  url?: string
  content?: string
  raw_content?: string
  snippet?: string
  description?: string
}

async function writeJsonFile(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

async function fetchTavilySearch(query: string, maxResults: number): Promise<TavilySearchResult[]> {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is not set')
  }
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_raw_content: false,
      search_depth: 'advanced',
    }),
  })
  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status}`)
  }
  const data = await response.json()
  const results = Array.isArray(data?.results) ? data.results : []
  return results as TavilySearchResult[]
}

async function fetchJinaReaderMarkdown(url: string): Promise<string> {
  const readerUrl = `https://r.jina.ai/${url}`
  const response = await fetch(readerUrl, {
    headers: {
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Jina reader failed: ${response.status}`)
  }
  const raw = await response.text()
  try {
    const data = JSON.parse(raw)
    if (typeof data === 'string') {
      return data
    }
    if (data?.content) {
      return data.content as string
    }
    if (data?.data?.content) {
      return data.data.content as string
    }
    return JSON.stringify(data, null, 2)
  }
  catch {
    return raw
  }
}

export const deepSearchRouter = createTRPCRouter({
  run: baseProcedure
    .input(
      z.object({
        projectPath: z.string(),
        query: z.string().min(1),
        maxResults: z.number().min(1).max(8).optional(),
        context: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const store = await ensureProjectStore(input.projectPath)
      const maxResults = input.maxResults ?? 5
      const searchItems = await fetchTavilySearch(input.query, maxResults)
      const sources = await Promise.all(
        searchItems.map(async (item) => {
          const pageId = randomUUID()
          const url = item.url ?? ''
          const title = item.title ?? item.description ?? 'Untitled'
          let markdown = item.content ?? item.snippet ?? ''
          if (url) {
            try {
              markdown = await fetchJinaReaderMarkdown(url)
            }
            catch {
              // keep fallback content from search if reader fails
            }
          }
          const metadata = {
            id: pageId,
            title,
            url,
            content: markdown,
            fetchedAt: new Date().toISOString(),
          }
          await writeJsonFile(path.join(store.pagesDir, `${pageId}.json`), metadata)
          return {
            id: pageId,
            title,
            url,
            snippet: markdown.slice(0, 400),
          }
        }),
      )

      const searchId = randomUUID()
      await writeJsonFile(path.join(store.searchesDir, `${searchId}.json`), {
        id: searchId,
        query: input.query,
        sources: sources.map((source) => source.id),
        createdAt: new Date().toISOString(),
      })

      let answer = 'Search completed.'
      if (!process.env.OPENAI_API_KEY) {
        answer =
          'OPENAI_API_KEY is not set. Add it to your environment to enable LLM answers. Search sources were saved.'
      }
      else {
        const contextBlock = input.context
          ? `Context from current graph path:\n${input.context}\n\n`
          : ''
        const context = sources
          .map((source, index) => {
            return `Source ${index + 1}: ${source.title}\n${source.snippet}`
          })
          .join('\n\n')
        try {
          const result = await generateText({
            model: openai('gpt-4o-mini'),
            system:
              'You are a deep-research assistant. Write a concise answer and cite sources by index like [1].',
            prompt: `${contextBlock}Question: ${input.query}\n\n${context}`,
          })
          answer = result.text
        }
        catch {
          answer = 'LLM request failed. Check your API key and network, then retry.'
        }
      }

      return {
        answer,
        sources,
        searchId,
      }
    }),
})

export type DeepSearchRouter = typeof deepSearchRouter
