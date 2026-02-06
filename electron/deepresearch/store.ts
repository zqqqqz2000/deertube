import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type DeepResearchExtractionInput,
  type DeepResearchFinalizeInput,
  type DeepResearchPersistenceAdapter,
  type DeepResearchResolvedReference,
  type DeepResearchSearchRecord,
  parseDeepResearchRefUri,
} from "../../src/shared/deepresearch";
import { ensureProjectStore } from "../trpc/routers/project";

interface DeepResearchPaths {
  rootDir: string;
  pagesDir: string;
  searchesDir: string;
}

interface StoredPageMeta {
  version: 1;
  projectId: string;
  searchId: string;
  pageId: string;
  query: string;
  url: string;
  title?: string;
  fetchedAt: string;
  lineCount: number;
  markdownFile: string;
}

interface StoredExtraction {
  version: 1;
  projectId: string;
  searchId: string;
  pageId: string;
  query: string;
  url: string;
  broken: boolean;
  lineCount: number;
  ranges: { start: number; end: number }[];
  selections: { start: number; end: number; text: string }[];
  rawModelOutput: string;
  extractedAt: string;
}

const MARKDOWN_FILENAME = "jina.md";
const PAGE_META_FILENAME = "meta.json";
const EXTRACTION_FILENAME = "extraction.json";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const splitLines = (value: string): string[] => value.split(/\r?\n/);

const asSafeId = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "");

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writeJsonFile = async (filePath: string, data: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
};

const getDeepResearchPaths = async (projectPath: string): Promise<DeepResearchPaths> => {
  const store = await ensureProjectStore(projectPath);
  const rootDir = path.join(store.baseDir, "deepresearch");
  const pagesDir = path.join(rootDir, "pages");
  const searchesDir = path.join(rootDir, "searches");
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.mkdir(searchesDir, { recursive: true });
  return {
    rootDir,
    pagesDir,
    searchesDir,
  };
};

export const buildDeepResearchProjectId = (projectPath: string): string => {
  const digest = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  return `p_${digest}`;
};

export function createDeepResearchPersistenceAdapter(projectPath: string): DeepResearchPersistenceAdapter {
  const projectId = buildDeepResearchProjectId(projectPath);

  return {
    projectId,
    async createSearchSession(query: string) {
      const paths = await getDeepResearchPaths(projectPath);
      const searchId = `s_${asSafeId(randomUUID())}`;
      const createdAt = new Date().toISOString();
      const initialRecord: DeepResearchSearchRecord = {
        version: 1,
        projectId,
        searchId,
        query,
        createdAt,
        completedAt: createdAt,
        llmPrompt: "",
        llmConclusionRaw: "",
        llmConclusionLinked: "",
        references: [],
      };
      await writeJsonFile(path.join(paths.searchesDir, `${searchId}.json`), initialRecord);
      return { searchId, createdAt };
    },
    async savePage(input) {
      const paths = await getDeepResearchPaths(projectPath);
      const pageId = `p_${asSafeId(randomUUID())}`;
      const pageDir = path.join(paths.pagesDir, pageId);
      await fs.mkdir(pageDir, { recursive: true });
      const lineCount = splitLines(input.markdown).length;
      const pageMeta: StoredPageMeta = {
        version: 1,
        projectId,
        searchId: input.searchId,
        pageId,
        query: input.query,
        url: input.url,
        title: input.title,
        fetchedAt: input.fetchedAt,
        lineCount,
        markdownFile: MARKDOWN_FILENAME,
      };
      await fs.writeFile(path.join(pageDir, MARKDOWN_FILENAME), input.markdown, "utf-8");
      await writeJsonFile(path.join(pageDir, PAGE_META_FILENAME), pageMeta);
      return { pageId, lineCount };
    },
    async saveExtraction(input: DeepResearchExtractionInput) {
      const paths = await getDeepResearchPaths(projectPath);
      const pageDir = path.join(paths.pagesDir, input.pageId);
      await fs.mkdir(pageDir, { recursive: true });
      const payload: StoredExtraction = {
        version: 1,
        projectId,
        searchId: input.searchId,
        pageId: input.pageId,
        query: input.query,
        url: input.url,
        broken: input.broken,
        lineCount: input.lineCount,
        ranges: input.ranges,
        selections: input.selections,
        rawModelOutput: input.rawModelOutput,
        extractedAt: input.extractedAt,
      };
      await writeJsonFile(path.join(pageDir, EXTRACTION_FILENAME), payload);
    },
    async finalizeSearch(input: DeepResearchFinalizeInput) {
      const paths = await getDeepResearchPaths(projectPath);
      const searchPath = path.join(paths.searchesDir, `${input.searchId}.json`);
      const payload: DeepResearchSearchRecord = {
        version: 1,
        projectId,
        searchId: input.searchId,
        query: input.query,
        createdAt: input.createdAt,
        completedAt: input.completedAt,
        llmPrompt: input.llmPrompt,
        llmConclusionRaw: input.llmConclusionRaw,
        llmConclusionLinked: input.llmConclusionLinked,
        references: input.references,
      };
      await writeJsonFile(searchPath, payload);
    },
  };
}

export async function resolveDeepResearchReference(
  projectPath: string,
  uri: string,
): Promise<DeepResearchResolvedReference | null> {
  const parsedUri = parseDeepResearchRefUri(uri);
  if (!parsedUri) {
    return null;
  }
  if (!SAFE_ID_PATTERN.test(parsedUri.searchId)) {
    return null;
  }

  const projectId = buildDeepResearchProjectId(projectPath);
  if (parsedUri.projectId !== projectId) {
    return null;
  }

  const paths = await getDeepResearchPaths(projectPath);
  const searchPath = path.join(paths.searchesDir, `${parsedUri.searchId}.json`);
  const record = await readJsonFile<DeepResearchSearchRecord>(searchPath);
  if (!record || !Array.isArray(record.references)) {
    return null;
  }

  const reference = record.references.find((item) => item.refId === parsedUri.refId);
  if (!reference) {
    return null;
  }
  if (!isRecord(reference)) {
    return null;
  }

  return {
    projectId,
    searchId: parsedUri.searchId,
    refId: reference.refId,
    uri: reference.uri,
    query: record.query,
    pageId: reference.pageId,
    url: reference.url,
    title: reference.title,
    startLine: reference.startLine,
    endLine: reference.endLine,
    text: reference.text,
  };
}
