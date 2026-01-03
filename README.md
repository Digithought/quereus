# Quereus

<img src="packages/quereus/docs/images/Quereus_colored_wide.svg" alt="Quereus Logo" height="150">

A modern, TypeScript-native SQL engine designed for federated query processing with extensible virtual table support.

## Overview

Quereus is a lightweight SQL database engine built from the ground up in TypeScript, inspired by SQLite but optimized for modern JavaScript environments. Unlike traditional databases, Quereus is **virtual table-centric** — all data access happens through pluggable virtual table modules that can connect to any data source: memory, JSON, APIs, files, or custom sources.

**Key Characteristics:**
- 🚀 **Pure TypeScript** — No native dependencies, runs anywhere JS runs
- 🔄 **Async/Await Native** — Built for modern JavaScript with full async support  
- 🧩 **Virtual Table Architecture** — Extensible data access through pluggable modules
- 💾 **Memory-Focused** — Optimized for in-memory operations with optional persistence
- 📊 **Rich SQL Support** — Comprehensive SQL dialect with CTEs, joins, window functions, and more
- 🌐 **Universal Runtime** — Node.js, browsers, workers, edge environments

## Quick Start

### Installation

```bash
npm install quereus
```

### Basic Usage

```typescript
import { Database } from 'quereus';

const db = new Database();

// Create an in-memory table
await db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE
  ) USING memory
`);

// Insert data
await db.exec(`
  INSERT INTO users (name, email) VALUES 
    ('Alice', 'alice@example.com'),
    ('Bob', 'bob@example.com')
`);

// Query data
const users = await db.all('SELECT * FROM users WHERE name LIKE ?', ['A%']);
console.log(users); // [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
```

### Working with JSON Data

```typescript
// Query JSON data directly
await db.exec(`
  CREATE TABLE products 
  USING json_each('[
    {"id": 1, "name": "Laptop", "price": 999},
    {"id": 2, "name": "Mouse", "price": 25}
  ]')
`);

const expensiveProducts = await db.all(`
  SELECT json_extract(value, '$.name') as name,
         json_extract(value, '$.price') as price
  FROM products 
  WHERE json_extract(value, '$.price') > 500
`);
```

## Architecture

Quereus is built around a three-layer architecture:

### 1. **SQL Layer**
- **Parser** — Converts SQL text into Abstract Syntax Trees
- **Planner** — Transforms AST into optimized logical plans  
- **Optimizer** — Converts logical plans to efficient physical execution plans

### 2. **Runtime Layer**
- **Scheduler** — Executes physical plans with dependency management
- **Instructions** — Instruction execution
- **Context System** — Manages row and column references during execution

### 3. **Storage Layer**
- **Virtual Table Interface** — Pluggable data access abstraction
- **Memory Tables** — High-performance in-memory storage with MVCC
- **Store** — Persistent storage with KV/Pair (includes LevelDB and IndexedDB)
- **JSON Tables** — Direct JSON data querying capabilities
- **Custom Modules** — Extensible interface for any data source

## Packages

This repository contains multiple packages:

### Core
- **[`packages/quereus/`](packages/quereus/)** — Core SQL engine and runtime

### Storage
- **[`packages/quereus-store/`](packages/quereus-store/)** — Core store plugin (platform-agnostic interfaces and utilities)
- **[`packages/quereus-plugin-leveldb/`](packages/quereus-plugin-leveldb/)** — LevelDB storage backend for Node.js
- **[`packages/quereus-plugin-indexeddb/`](packages/quereus-plugin-indexeddb/)** — IndexedDB storage backend for browsers

### Sync
- **[`packages/quereus-plugin-sync/`](packages/quereus-plugin-sync/)** — Multi-master CRDT replication plugin

### Tools
- **[`packages/plugin-loader/`](packages/plugin-loader/)** — Dynamic plugin loading system
- **[`packages/quoomb-web/`](packages/quoomb-web/)** — Web-based query interface and visualizer
- **[`packages/quoomb-cli/`](packages/quoomb-cli/)** — Command-line interface
- **[`packages/sample-plugins/`](packages/sample-plugins/)** — Sample plugins for testing and development

## Documentation

### Core Documentation
- **[SQL Reference](packages/quereus/docs/sql.md)** — Comprehensive SQL dialect guide
- **[Built-in Functions](packages/quereus/docs/functions.md)** — Complete function reference
- **[Virtual Tables](packages/quereus/docs/memory-table.md)** — Virtual table system and memory tables
- **[Runtime Architecture](packages/quereus/docs/runtime.md)** — Execution engine internals

### Storage & Sync
- **[Persistent Store](packages/quereus/docs/store.md)** — LevelDB/IndexedDB storage architecture
- **[Store Plugin base README](packages/quereus-store/README.md)** — Quick start and API reference

### Advanced Topics
- **[Query Optimizer](packages/quereus/docs/optimizer.md)** — Query planning and optimization
- **[Usage Examples](packages/quereus/docs/usage.md)** — Practical examples and patterns

## Features

### SQL Capabilities
- **Full SELECT Support** — JOINs, subqueries, CTEs, window functions
- **Data Modification** — INSERT, UPDATE, DELETE with transaction support
- **Schema Operations** — CREATE/DROP tables, indexes, views
- **Advanced Features** — Recursive CTEs, constraints, savepoints

### Virtual Table Ecosystem
- **Memory Tables** — ACID-compliant in-memory storage with indexing
- **JSON Processing** — Native JSON querying with `json_each()` and `json_tree()`
- **Function Tables** — Table-valued functions like `generate_series()`
- **Custom Modules** — Build your own data source integrations

### Performance & Reliability
- **Query Optimization** — Cost-based query planning with join reordering
- **MVCC Transactions** — Multi-version concurrency control for isolation
- **Efficient Execution** — Dependency-aware instruction scheduling
- **Memory Management** — Copy-on-write data structures with automatic cleanup

## Use Cases

Quereus excels in scenarios where you need SQL capabilities without traditional database overhead:

- **Data Analysis** — ETL pipelines, data transformation, reporting
- **Application Logic** — Complex business rules expressed in SQL
- **API Backends** — In-memory caching with SQL query capabilities  
- **Edge Computing** — Lightweight SQL processing in serverless environments
- **Development Tools** — SQL interfaces for configuration, testing, prototyping
- **Embedded Analytics** — SQL queries over application data structures

## Contributing

We welcome contributions! Please see our [development guide](packages/quereus/README.md) for:

- Setting up the development environment
- Running tests and benchmarks  
- Code style and architectural guidelines
- Submitting issues and pull requests

### Development Quick Start

```bash
# Clone the repository
git clone https://github.com/gotchoices/quereus.git
cd quereus

# Install dependencies
yarn install

# Run tests
yarn test

# Build all packages
yarn build
```

## License

MIT License — see [LICENSE](LICENSE) for details.

## Status

Quereus is actively developed and suitable for production use in appropriate scenarios. The core SQL engine and memory table implementation are stable, with ongoing work on:

- Enhanced query optimization capabilities
- Additional virtual table modules  
- Performance improvements and tooling
- Extended SQL standard compliance

For questions, issues, or discussions, please use our [GitHub Issues](https://github.com/your-org/quereus/issues) or [Discussions](https://github.com/your-org/quereus/discussions). 
