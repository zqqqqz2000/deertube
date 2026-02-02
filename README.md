# Deertube DeepSearch (Electron)

Electron + React Flow knowledge graph for deep search. Users pick a project folder, ask questions on nodes, and the app stores sources + answers inside the project directory.

## Features
- Project picker with recent projects list and delete.
- Full-screen React Flow graph.
- Ask on a selected node; new questions become children of the selected node.
- Context is built from the path root → selected node and fed into the LLM prompt.
- Tavily search integration for web results.
- Jina Reader converts source pages to Markdown and stores content, URL, title, and metadata.
- LLM responses via Vercel AI SDK (OpenAI provider).
- Hover a source node to preview the URL in an Electron WebContentsView.
- State persisted in the project folder under `.deertube/`.

## Data Storage
Each project directory gets:
```
.deertube/
  state.json
  pages/
  searches/
```
- `state.json`: graph nodes/edges + timestamps
- `pages/`: per-source JSON (Markdown content, title, url)
- `searches/`: per-search JSON (query + source ids)

## Tech Stack
- Electron
- React + React Flow
- tRPC over `electron-trpc-experimental`
- Vercel AI SDK
- Tailwind CSS

## Environment Variables
Create these in your shell before running:
```
TAVILY_API_KEY=...
OPENAI_API_KEY=...
```

## Dev
```
bun i
bun run dev
```

## Build
```
bun run build
```

## Notes
- The initial empty project auto-creates a root question node so you can start asking immediately.
- Source previews appear on hover (WebContentsView).
