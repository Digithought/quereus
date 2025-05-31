# Quereus — TypeScript SQL Query Processor

<img src="packages/quereus/docs/Quereus_colored_wide.svg" alt="Quereus Logo" height="150">

**(Work In Progress - and undergoing Major Refactoring: Titan Project)**

Quereus is a lightweight, query processor, inspired by SQLite but specifically designed for efficient in-memory data processing with a strong emphasis on the **virtual table** interface. It aims to provide rich SQL query and constraint capabilities (joins, aggregates, subqueries, CTEs) over data sources exposed via the virtual table mechanism. Quereus has no persistent file storage, though one could be built as a virtual table module.

## 🚀 Project Status

**Phase 2 Complete**: Core engine with **Project Titan** architecture + full UI ecosystem

- ✅ **Core SQL Engine** — Comprehensive SQL support with virtual tables
- ✅ **CLI REPL** — Interactive terminal interface  
- ✅ **Web Playground** — Browser-based SQL editor with Monaco
- ✅ **Desktop Ready** — Architecture supports Electron/Tauri deployment

## 📁 Monorepo Structure

```text
quereus/
├── packages/
│   ├── quereus/             # @quereus/quereus — Core SQL engine
│   ├── quoomb-cli/          # @quereus/quoomb-cli — Terminal REPL
│   ├── quoomb-web/          # @quereus/quoomb-web — Browser playground  
│   ├── shared-ui/           # @quereus/shared-ui — Shared components
│   └── plugins-samples/     # @quoomb/plugins-samples — Example plugins
├── tsconfig.base.json       # Shared TypeScript configuration
└── package.json             # Yarn workspaces root
```

## 🏗️ Architecture Overview (Titan Project)

Quereus features a new architecture based on partially immutable PlanNodes and an Instruction-based runtime:

1. **SQL Input** → **Parser** (Lexer + AST)
2. **Planner** → Immutable `PlanNode` tree with relational algebra
3. **Runtime** → `Instruction` graph execution with async operations
4. **Virtual Tables** → Core data interface (`MemoryTable`, custom modules)
5. **User-Defined Functions** → Custom JavaScript functions in SQL

### Key Features

- **Virtual Table Centric** — All tables are virtual tables
- **Async Core** — Non-blocking operations with `AsyncIterable<Row>`
- **Key-Based Addressing** — Primary key addressing (no implicit rowid)
- **TypeScript Native** — Full type safety and modern JS features
- **Cross-Platform** — Node.js, browser, React Native support

### Current Implementation Status

**✅ COMPLETE (Titan Architecture):**
- Core `PlanNode` to `Instruction` architecture
- Comprehensive SQL Support (SELECT, DML, aggregation, window functions)
- Emitters and Runtime with proper context management
- Plan Optimization with attribute ID preservation
- Virtual table implementations (`MemoryTable`, `JsonEach`, `JsonTree`)
- Extensive built-in functions and pragmas
- Row-level CHECK constraints

**🔄 IN PROGRESS:**
- Join operations (primary remaining gap)
- Advanced subquery patterns
- Comprehensive testing for Titan architecture

---

# Quoomb — Quereus SQL Playground

> **Quoomb** (Query + Womb) is the official REPL and playground ecosystem for **Quereus**. It provides zero‑install environments for interactive querying, schema exploration, and extension prototyping while remaining 100% embeddable in future shells (VS Code, Electron, Tauri).

## 🎯 Implementation Status

This implementation includes **Phase 0**, **Phase 1**, and **Phase 2** as specified in the architecture plan:

### ✅ Phase 0 — Minimal CLI (`@quereus/quoomb-cli`)
- **REPL with readline interface** — Interactive SQL prompt
- **Dot commands** — `.tables`, `.schema`, `.import`, `.export`  
- **SQL execution** — Direct query execution with results formatting
- **CSV import/export** — File-based data operations
- **Colored output** — Beautiful terminal formatting with chalk

### ✅ Phase 1 — Web Playground MVP (`@quereus/quoomb-web`)
- **React + Monaco editor** — Full SQL editing with syntax highlighting
- **Web Worker isolation** — Quereus engine runs in background thread
- **Split-pane layout** — Editor on top, results below
- **CSV file import** — Drag-and-drop file handling
- **Run button + Shift+Enter** — Multiple execution methods

### ✅ Phase 2 — Rich Panels & Persisted Sessions
- **Multi-tab editor** — Multiple SQL files with tab management
- **Three-panel results** — Results, Plan, Messages tabs
- **Theme system** — Light/dark/auto themes with system detection
- **Settings persistence** — localStorage-based configuration
- **TanStack Table grid** — Sortable, paginated results display
- **Real-time status** — Connection and execution status indicators

## 🛠 Technology Stack

| **Concern**                | **Implementation**                           |
| -------------------------- | -------------------------------------------- |
| **Language**               | TypeScript 5.x                              |
| **Package Manager**        | Yarn workspaces                             |
| **Build (Web)**            | Vite + esbuild                              |
| **UI Framework**           | React 19                                     |
| **Editor**                 | Monaco Editor (VS Code engine)              |
| **State Management**       | Zustand                                      |
| **Data Grid**              | TanStack Table                               |
| **Styling**                | Tailwind CSS + CSS variables                |
| **Worker Communication**   | Comlink (zero-boilerplate RPC)              |
| **CLI Framework**          | Commander.js + chalk                        |

## 🏃‍♂️ Getting Started

### Prerequisites
- **Node.js** 18+ 
- **Yarn** package manager

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd quereus

# Install dependencies
yarn install

# Build all packages
yarn build
```

### Development

```bash
# Start web development server
yarn dev:web

# Run CLI in development mode  
yarn dev:cli

# Build and run CLI globally
yarn workspace @quereus/quoomb-cli build
npm link packages/quoomb-cli
quoomb
```

### Usage Examples

#### CLI Usage
```bash
$ quoomb
Welcome to Quoomb - Quereus SQL REPL
Type .help for available commands or enter SQL to execute

quoomb> CREATE TABLE users (id INTEGER, name TEXT, email TEXT);
✓ Query executed successfully (15ms)

quoomb> INSERT INTO users VALUES (1, 'Alice', 'alice@example.com');
✓ Query executed successfully (8ms)

quoomb> SELECT * FROM users;
┌────┬───────┬───────────────────┐
│ id │ name  │ email             │
├────┼───────┼───────────────────┤
│ 1  │ Alice │ alice@example.com │
└────┴───────┴───────────────────┘

1 row(s) (12ms)

quoomb> .import data.csv
Created table: data
Imported 1000 rows into table 'data'

quoomb> .export "SELECT * FROM users" output.json
Exported 1 rows to 'output.json'
```

#### Web Usage
1. Navigate to `http://localhost:3000`
2. Write SQL in the Monaco editor
3. Press **Shift+Enter** or click **Execute**
4. View results in the grid below
5. Switch between **Results**, **Plan**, and **Messages** tabs
6. Import CSV files via the toolbar button

## 🏗 Web Worker Architecture
```text
┌─────────────────┐    Comlink RPC    ┌──────────────────┐
│   React App     │ ⟵─────────────⟶   │   Web Worker     │
│                 │                   │                  │
│ • Monaco Editor │                   │ • Quereus Engine │
│ • Result Grid   │                   │ • SQL Execution  │
│ • State (Zustand)│                   │ • CSV Processing │
└─────────────────┘                   └──────────────────┘
```

The Quereus engine runs entirely in a Web Worker, providing:
- **UI responsiveness** — Main thread never blocks
- **Security isolation** — Engine separated from DOM
- **Future extensibility** — Plugin system foundation

### State Management (Zustand)

**Session Store** (`useSessionStore`)
- Database connection state
- Tab management (create, close, switch)
- Query execution and results
- Worker communication

**Settings Store** (`useSettingsStore`)  
- Theme preferences (light/dark/auto)
- Editor configuration (font, line numbers, etc.)
- Execution preferences
- Persistent storage via localStorage

---

## 🔮 Roadmap

### Phase 3 — Extension & Polish
- [ ] **Plugin marketplace** — Load external virtual table modules
- [ ] **Query plan visualization** — SVG tree rendering
- [ ] **Chart panel** — Data visualization
- [ ] **UDF TypeScript editor** — Inline function development

### Phase 4 — Desktop Applications
- [ ] **Electron app** — Desktop version with file system access
- [ ] **Tauri app** — Rust-based lightweight desktop
- [ ] **IPC server mode** — Multi-client architecture

### Phase 5 — Integration & Collaboration
- [ ] **VS Code extension** — Quereus support in VS Code
- [ ] **Jupyter kernel** — Notebook integration
- [ ] **URL session sharing** — Encoded session state
- [ ] **Live collaboration** — Real-time multi-user editing

## 🧪 Features Implemented

### Core Engine
- [x] **Comprehensive SQL** — SELECT, INSERT, UPDATE, DELETE with complex expressions
- [x] **Virtual tables** — Memory tables, JSON processing, custom modules
- [x] **Built-in functions** — Scalar, aggregate, date/time, JSON functions
- [x] **Transactions** — ACID compliance with savepoints
- [x] **User-defined functions** — Custom JavaScript functions in SQL

### Editor Features
- [x] **SQL syntax highlighting** via Monaco
- [x] **Multi-tab editing** with close buttons and dirty indicators
- [x] **Keyboard shortcuts** (Shift+Enter to execute)
- [x] **Selected text execution** — Run highlighted SQL only
- [x] **Customizable fonts and themes**

### Results Display  
- [x] **Paginated data grid** with TanStack Table
- [x] **Sortable columns** — Click headers to sort
- [x] **NULL value display** — Visual distinction
- [x] **Error formatting** — Friendly error messages
- [x] **Execution timing** — Performance metrics

### Data Operations
- [x] **CSV import** — Automatic table creation with type inference
- [x] **JSON/CSV export** — Multiple output formats
- [x] **Schema introspection** — `.tables` and `.schema` commands
- [x] **Query history** — Persistent execution log

### User Experience
- [x] **Dark/light themes** — System preference detection
- [x] **Responsive layout** — Split panes with resize
- [x] **Loading indicators** — Connection and execution status
- [x] **Settings persistence** — Preferences saved locally

## 🤝 Contributing

This project follows the architecture specified in the Quoomb design document. Key principles:

- **TypeScript-first** — Strict typing throughout
- **Single purpose functions** — Expressive over imperative
- **ES Modules** — Always include `.js` in imports  
- **Tab indentation** — Follow `.editorconfig`
- **No superfluous comments** — Self-documenting code

## 📄 License

TBD — See LICENSE file when available.

---

*Crafted with 🐾 by the Quereus team — ready for SQL‑over‑everything!* 
