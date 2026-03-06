# Quereus Promotion Ideas

Strategies for spreading awareness of Quereus and Quereus Sync to developers.

## Core Positioning

**Quereus**: A pure-TypeScript SQL engine — no WASM, no native bindings. Runs natively in the browser, Node.js, React Native, edge workers, and anywhere JS runs. Virtual-table-centric architecture means any data source can become a SQL table.

**Quereus Sync**: Fully opaque CRDT sync that works at the SQL level. Unlike other CRDT systems (Automerge, Yjs, cr-sqlite, etc.), Quereus Sync requires no manual conflict wiring, no special data types in app code, and no schema annotations — just write normal SQL and sync handles the rest. Column-level LWW with hybrid logical clocks, schema migration propagation, and transport-agnostic design.

### What makes Sync different from alternatives

| Feature | Quereus Sync | cr-sqlite | Automerge / Yjs | PowerSync |
|---|---|---|---|---|
| Opaque to app code | Yes — normal SQL, no CRDT types | Partially — requires `crsql_changes` | No — app works with CRDT docs | Partially — requires sync rules |
| Conflict granularity | Column-level LWW | Row/column | Document/field | Row-level |
| Schema sync | DDL propagates automatically | Manual | N/A (no schema) | Manual migration |
| Runtime | Pure JS (any platform) | WASM (SQLite) | JS | WASM (SQLite) |
| Manual steps | None — plug in and go | Setup change tracking | Design CRDT document shapes | Configure sync rules |

## AI-Adjacent Angles

### "SQL engine for AI agents"
AI agents need structured local data. Quereus is an embedded SQL layer that runs directly in the same JS process — no server, no WASM overhead. Demo: an agent using tool calls to query/mutate a local Quereus DB as its working memory.

### RAG with structured data
Most RAG demos use vector DBs exclusively. Show a hybrid: structured relational queries via Quereus alongside vector search. Blog post: "Your RAG pipeline is missing a real database."

### MCP server/tool
Build a Model Context Protocol tool exposing Quereus. Agent developers building MCP toolchains discover it organically.

### Local-first AI apps
Tutorial: Quereus + IndexedDB powering a browser-based AI chat app with structured conversation/session/preference storage, syncing across devices via Quereus Sync.

## Developer Community Channels

### Hacker News "Show HN"
Tight demo with a compelling one-liner: "Show HN: SQL engine that runs natively in JS — no WASM, no native bindings." Focus on the live playground.

### Reddit
r/javascript, r/webdev, r/node, r/reactnative — short posts, same framing. Separate post for Sync with the local-first angle.

### Local-first community
localfirst.fm, lofi.software Discord, local-first meetups. Quereus Sync's fully opaque CRDT approach is a strong differentiator here. Lightning talk material: "What if sync just worked, and your app never had to know?"

### Stack Overflow / GitHub Discussions
Answer questions about "SQLite in the browser," "offline-first database," "embedded SQL in JavaScript," etc.

## Shareable Demos & Content

### Interactive playground
A single web page where anyone can type SQL and see it run in-browser. Strip down quoomb-web to a focused, embeddable demo. This is the single most effective proof point — seeing SQL run live in the browser with no server is compelling.

### "Zero-backend app" tutorial
Quereus + IndexedDB + Sync = real SQL on the client with persistence and multi-device sync, no backend database. Walk through a notes/todo app end to end.

### Edge function demo
Quereus running in a Cloudflare Worker or Deno Deploy, handling SQL queries with no external DB.

### "JOIN across anything" demos
Short posts showing the virtual table system: query a REST API with SQL, JOIN across IndexedDB tables and in-memory data, use SQL to transform JSON. Each is a tweetable demo.

### SQLite comparison post
Honest, focused comparison: what Quereus does differently (pure JS, async, virtual tables, no WASM). Captures "SQLite in the browser" search traffic.

## Content Strategy

### Weekly code snippets
One short post per week showing a specific capability — a clever query, a virtual table trick, a sync demo. Keep it concrete and copy-pasteable.

### "X, but in SQL" series
Surprising things you can do: "Query your REST API with SQL," "Reactive UI updates from SQL triggers," "Schema sync across devices with zero config."

### Contribute to AI framework ecosystems
Submit examples to LangChain, LlamaIndex, Vercel AI SDK showing Quereus as the storage layer for agent memory/state.

### Solve SQLite pain points
Monitor GitHub issues and discussions for SQLite-in-browser complaints (WASM bundle size, no async, sync limitations). Show up with a Quereus solution.

## Low-Effort High-Impact

1. **npm keywords and description** — hit the right search terms (done)
2. **GitHub topics** — add to the repo: `sql`, `database`, `typescript`, `browser-database`, `local-first`, `offline-first`, `crdt`, `sync`, `virtual-table`, `embedded-database`
3. **Playground link in README** — if quoomb-web is deployable, link it prominently
4. **"Awesome" lists** — submit to awesome-javascript, awesome-typescript, awesome-local-first, awesome-offline-first
5. **npm README** — the package README is what shows on npmjs.com; make sure it sells the project in the first few lines
