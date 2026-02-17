# Quoomb Web

**A browser-based interactive SQL playground and query interface for Quereus**

Quoomb Web is a modern, React-based web application that provides a full-featured SQL development environment for the Quereus engine. It offers real-time query execution, visual query planning, plugin management, and advanced debugging capabilities—all running entirely in your browser.

## Features

### 🎯 **Interactive SQL Environment**
- **Monaco Editor** — Full-featured code editor with SQL syntax highlighting, autocomplete, and error detection
- **Multi-Tab Interface** — Work with multiple SQL files simultaneously with automatic persistence
- **Live Query Execution** — Execute queries with real-time results and error reporting
- **Query History** — Track and revisit previous queries across sessions

### 📊 **Advanced Query Analysis**
- **Visual Query Plans** — Interactive graphical representation of query execution plans
- **Execution Tracing** — Step-by-step execution visualization with performance metrics
- **Cost Analysis** — Detailed cost estimation and optimization insights
- **Scheduler Programs** — Low-level instruction inspection for deep performance analysis

### 🔌 **Plugin System**
- **Dynamic Loading** — Install virtual table plugins from URLs at runtime
- **Plugin Management** — Browse, configure, and manage installed plugins
- **Configuration Interface** — Visual settings management for plugin parameters
- **Security Sandboxing** — Safe execution of third-party plugins in isolated contexts

### 📁 **Data Management**
- **CSV Import/Export** — Import CSV files with automatic schema detection and type inference
- **File Operations** — Save and load SQL files with keyboard shortcuts (Ctrl+S, Ctrl+O)
- **Schema Browser** — Explore table structures, indexes, and constraints
- **Memory Tables** — Create and manage in-memory tables with full ACID support
- **Session Persistence** — Automatically saves and restores open editor tabs, content, and unsaved changes across page refreshes

### 🎨 **Modern User Experience**
- **Responsive Design** — Works seamlessly on desktop, tablet, and mobile devices
- **Dark/Light Themes** — Automatic theme detection with manual override
- **Split-Panel Layout** — Customizable workspace with resizable panels
- **Keyboard Shortcuts** — Efficient navigation and commands for power users

## Architecture

Quoomb Web follows a modern client-side architecture that leverages Web Workers for database operations and React for the user interface.

### **Core Components**

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser Tab                           │
├─────────────────────────────────────────────────────────────┤
│                    React UI Layer                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   EditorPanel   │  │  ResultsPanel   │  │ QueryPlan   │ │
│  │                 │  │                 │  │   Graph     │ │
│  │  Monaco Editor  │  │  DataGrid       │  │             │ │
│  │  SQL Editing    │  │  CSV Export     │  │ Visualization│ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   Toolbar       │  │  PluginsModal   │  │ HistoryPanel│ │
│  │                 │  │                 │  │             │ │
│  │  Execute        │  │  Plugin Mgmt    │  │ Query Log   │ │
│  │  Export         │  │  Configuration  │  │ Browse      │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    State Management                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ SessionStore    │  │ SettingsStore   │  │ ConfigStore │ │
│  │ (Zustand)       │  │ (Zustand)       │  │ (Zustand)   │ │
│  │                 │  │                 │  │             │ │
│  │ • Tabs          │  │ • Theme         │  │ • Plugin    │ │
│  │ • Query History │  │ • Editor Config │  │   Config    │ │
│  │ • Connection    │  │ • Preferences   │  │ • Autoload  │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                      Comlink Bridge                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Async Proxy Interface                     │ │
│  │                                                        │ │
│  │  executeQuery() → explainPlanGraph() → loadModule()   │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                                │
                                │ Message Passing
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                      Web Worker                            │
├─────────────────────────────────────────────────────────────┤
│                 Quereus Database Engine                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │    SQL Parser   │  │  Query Planner  │  │  Optimizer  │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   Scheduler     │  │   Runtime       │  │   VTables   │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ Memory Tables   │  │  JSON Tables    │  │   Plugins   │ │
│  │                 │  │                 │  │             │ │
│  │ • MVCC          │  │ • json_each()   │  │ • Dynamic   │ │
│  │ • Indexing      │  │ • json_tree()   │  │ • Isolated  │ │
│  │ • Constraints   │  │ • JSONPath      │  │ • Secure    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### **Key Architectural Decisions**

#### **Web Worker Isolation**
The Quereus database engine runs in a dedicated Web Worker, providing several benefits:
- **Non-blocking UI** — Heavy SQL operations don't freeze the interface
- **Memory Isolation** — Database state is separated from UI state
- **Security** — Plugin execution is sandboxed away from main thread
- **Performance** — Leverages browser's multi-threading capabilities

#### **State Management with Zustand**
Three primary stores manage application state:
- **SessionStore** — Active tabs, query history, connection status, sync state
- **SettingsStore** — User preferences, theme, editor configuration, plugin CRUD, storage module
- **ConfigStore** — Quoomb configuration file (`quoomb.config.json`) import/export

#### **Comlink Communication**
Uses Comlink library for seamless async communication between main thread and worker:
- **Type-safe APIs** — Full TypeScript support across worker boundary
- **Promise-based** — Natural async/await patterns
- **Automatic serialization** — Handles complex data structures transparently

#### **Plugin Architecture**
Dynamic plugin loading enables extensible data sources:
- **URL-based loading** — Install plugins from any accessible URL
- **Runtime registration** — Plugins register virtual table modules at runtime
- **Configuration management** — Visual interface for plugin settings
- **Manifest system** — Plugins declare capabilities and requirements

## Getting Started

### Development Setup

```bash
# Clone the repository
git clone https://github.com/gotchoices/quereus.git
cd quereus/packages/quoomb-web

# Install dependencies
yarn install

# Start development server
yarn dev
```

Open your browser to `http://localhost:3000` to access the development environment.

### Building for Production

```bash
# Build optimized bundle
yarn build

# Preview production build
yarn preview

# Build artifacts are in ./dist/
```

### Running Tests

```bash
# Unit tests
yarn test

# End-to-end tests
yarn test:e2e

# Type checking
yarn typecheck
```

## Usage Guide

### **Basic Workflow**

1. **Open Quoomb** in your browser
2. **Create a table** using SQL DDL or CSV import
3. **Write queries** in the Monaco editor with syntax highlighting
4. **Execute** queries using Ctrl+Enter or the toolbar button
5. **Analyze results** in the grid view with export options
6. **Visualize plans** using the query plan graph

### **Working with Data Sources**

#### Memory Tables
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE
) USING memory;

INSERT INTO users (name, email) VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com');
```

#### JSON Data
```sql
CREATE TABLE api_data USING json_each('
  [
    {"id": 1, "product": "Laptop", "price": 999},
    {"id": 2, "product": "Mouse", "price": 25}
  ]
');

SELECT 
  json_extract(value, '$.product') as product,
  json_extract(value, '$.price') as price
FROM api_data
WHERE json_extract(value, '$.price') > 100;
```

#### CSV Import
1. Click the **Import** button in the toolbar
2. Select or drag-and-drop a CSV file
3. Preview the data and adjust column types
4. Specify table name and click **Import**

### **Plugin Management**

#### Installing Plugins
1. Open **Settings** (⚙️ icon in toolbar)
2. Click **"Manage Plugins"**
3. Enter plugin URL (e.g., from GitHub raw file)
4. Click **"Install"** and wait for loading
5. Configure plugin settings if needed

#### Example Plugin Installation
```
Plugin URL: https://raw.githubusercontent.com/gotchoices/quereus/main/packages/sample-plugins/json-table/index.js
```

Once installed, create tables using the plugin:
```sql
CREATE TABLE external_data USING json_table(
  'https://api.github.com/repos/gotchoices/quereus/issues',
  '$.items[*]'
);
```

### **Advanced Features**

#### Query Plan Visualization
1. Write your SQL query in the editor
2. Click **"Explain"** in the toolbar
3. View the **Query Plan Graph** tab
4. Hover over nodes to see cost estimates and details
5. Use **"Explain with Actual"** to see runtime statistics

#### Execution Tracing  
1. Open the **Execution Trace** tab
2. Execute a query with complex operations
3. Step through execution phases
4. Analyze performance bottlenecks
5. View instruction-level details

#### Keyboard Shortcuts
- **Ctrl+Enter** — Execute selected query or current statement
- **Ctrl+S** — Save current tab to file
- **Ctrl+O** — Open SQL file from disk
- **Ctrl+/** — Toggle line comment
- **F5** — Refresh table list
- **Escape** — Cancel running query

## Configuration

### **Application Settings**
Access via Settings modal (⚙️ icon):

- **Theme** — Light, Dark, or Auto (follows system)
- **Editor Settings** — Font size, word wrap, minimap
- **Query Settings** — Auto-execute, result limits
- **Advanced** — Debug mode, performance monitoring

### **Session Persistence**
Quoomb Web automatically persists the following data across browser sessions:

- **Open Tabs** — All editor tabs with their names and active state
- **Editor Content** — SQL code in each tab, including unsaved changes
- **Dirty State** — Remembers which tabs have unsaved modifications (shown with • indicator)
- **Query History** — Query metadata including SQL text, execution time, and errors (limited to last 50). Result data is not persisted to avoid storage quota issues.
- **UI State** — Active tab, selected result panel, and query execution state

**Storage Location**: Data is stored in browser localStorage under the key `quoomb-session`. Query result sets are intentionally excluded from persistence to prevent localStorage quota errors when working with large datasets.

**Privacy**: All persistence happens locally in your browser. No data is sent to external servers.

### **Plugin Configuration**
Each plugin can expose configuration options:

- **Connection settings** — URLs, authentication, timeouts
- **Data options** — Filtering, transformation, caching
- **Performance** — Memory limits, batch sizes
- **Behavior** — Error handling, retry policies

## Plugin Development

Quoomb Web supports dynamic loading of virtual table plugins. Plugins are JavaScript modules that register new data sources.

### **Plugin Structure**

```javascript
// plugin-manifest.json
export const manifest = {
  name: "my-plugin",
  version: "1.0.0",
  description: "Connects to external API",
  author: "Your Name",
  vtabModules: [{
    name: "my_table",
    description: "Virtual table for API data"
  }],
  settings: [{
    key: "api_endpoint",
    label: "API Endpoint",
    type: "text",
    default: "https://api.example.com"
  }]
};

// Registration function
export async function register(quereus, config) {
  // Register virtual table module
  const module = new MyTableModule(config);
  quereus.registerModule('my_table', module);
  
  return manifest;
}
```

### **Development Workflow**

1. **Create plugin** following the manifest structure
2. **Host plugin** on a publicly accessible URL
3. **Install in Quoomb** using the plugin manager
4. **Test functionality** with CREATE TABLE statements
5. **Configure settings** through the UI
6. **Debug issues** using browser developer tools

For detailed plugin development guidance, see the [sample plugins](../sample-plugins/) directory.

## Browser Support

Quoomb Web requires modern browser features:

- **ES2022** — Native async/await, optional chaining
- **Web Workers** — Background thread execution
- **IndexedDB** — Local storage for persistence
- **Fetch API** — HTTP requests for plugin loading
- **FileReader API** — CSV file import

**Supported Browsers:**
- Chrome 90+
- Firefox 88+  
- Safari 14+
- Edge 90+

## Performance Considerations

### **Memory Management**
- **Query results** are held in memory; limit large result sets
- **History** is persisted locally; clear periodically for performance
- **Plugins** may have their own memory requirements

### **Network Usage**
- **Plugin loading** requires internet access for external modules
- **API plugins** may make frequent HTTP requests
- **CSV import** loads entire file into memory

### **Optimization Tips**
- Use **LIMIT** clauses for large datasets
- **Index** frequently queried columns in memory tables
- **Close unused tabs** to free memory
- **Clear history** periodically to reduce storage

## Contributing

We welcome contributions to Quoomb Web! Areas for improvement include:

- **New plugin integrations** — Data sources, APIs, formats
- **UI/UX enhancements** — Better visualizations, accessibility
- **Performance optimizations** — Faster rendering, memory efficiency
- **Feature additions** — Query builders, data modeling tools

### **Development Guidelines**

- **TypeScript** — All code must be properly typed
- **React** — Use modern hooks and functional components
- **Testing** — Unit tests for utilities, E2E tests for workflows
- **Accessibility** — Follow WCAG guidelines
- **Performance** — Profile and optimize hot paths

See the main [Contributing Guide](../../README.md#contributing) for more details.

## License

MIT License — see [LICENSE](../../LICENSE) for details. 
