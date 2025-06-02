import { Database } from '@quereus/quereus';
import chalk from 'chalk';
import Table from 'cli-table3';
import * as fs from 'fs/promises';
import * as path from 'path';
import Papa from 'papaparse';
import { dynamicLoadModule, validatePluginUrl } from '@quereus/quereus';
import type { PluginRecord, PluginManifest, SqlValue } from '@quereus/quereus';
import os from 'os';
import crypto from 'crypto';

export class DotCommands {
  constructor(private db: Database) {}

  async handle(command: string, rl: any): Promise<boolean> {
    const parts = command.slice(1).split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        this.printHelp();
        break;
      case 'exit':
      case 'quit':
        rl.close();
        break;
      case 'tables':
        await this.listTables();
        break;
      case 'schema':
        await this.showSchema(args[0]);
        break;
      case 'import':
        await this.importCsv(args[0]);
        break;
      case 'export':
        await this.exportQuery(args[0], args[1]);
        break;
      default:
        return false; // Command not handled
    }
    return true; // Command was handled
  }

  private printHelp(): void {
    console.log(`
Available commands:
  .help                    Show this help message
  .exit, .quit             Exit the REPL
  .tables                  List all tables
  .schema [table]          Show table schema
  .import <file.csv>       Import CSV file as table
  .export <sql> <file>     Export query results to file

Plugin commands:
  .plugin install <url>    Install plugin from URL
  .plugin list            List installed plugins
  .plugin enable <name>   Enable a plugin
  .plugin disable <name>  Disable a plugin
  .plugin remove <name>   Remove a plugin
  .plugin config <name>   Configure a plugin
  .plugin reload <name>   Reload a plugin

SQL commands:
  Enter any SQL statement to execute it

Examples:
  CREATE TABLE users (id INTEGER, name TEXT);
  INSERT INTO users VALUES (1, 'Alice');
  SELECT * FROM users;
  .import data.csv
  .export "SELECT * FROM users" output.json
`);
  }

  async listTables(): Promise<void> {
    try {
      const results = [];
      for await (const row of this.db.eval(`
        SELECT name, type FROM sqlite_schema
        WHERE type IN ('table', 'view')
        ORDER BY name
      `)) {
        results.push(row);
      }

      if (results.length === 0) {
        console.log(chalk.yellow('No tables found'));
        return;
      }

      const table = new Table({
        head: [chalk.cyan('Name'), chalk.cyan('Type')]
      });

      for (const row of results) {
        table.push([String(row.name || ''), String(row.type || '')]);
      }

      console.log(table.toString());
      console.log(chalk.gray(`\n${results.length} table(s)`));
    } catch (error) {
      console.error(chalk.red('Error listing tables:'), error instanceof Error ? error.message : String(error));
    }
  }

  async showSchema(tableName?: string): Promise<void> {
    try {
      if (!tableName) {
        // Show all schemas
        const results = [];
        for await (const row of this.db.eval(`
          SELECT sql FROM sqlite_schema
          WHERE sql IS NOT NULL
          ORDER BY name
        `)) {
          results.push(row);
        }

        if (results.length === 0) {
          console.log(chalk.yellow('No schema found'));
          return;
        }

        for (const row of results) {
          console.log(chalk.white(String(row.sql) + ';'));
        }
      } else {
        // Show specific table schema
        const results = [];
        for await (const row of this.db.eval(`
          SELECT sql FROM sqlite_schema
          WHERE name = ? AND sql IS NOT NULL
        `, [tableName])) {
          results.push(row);
        }

        if (results.length === 0) {
          console.log(chalk.yellow(`Table '${tableName}' not found`));
          return;
        }

        console.log(chalk.white(String(results[0].sql) + ';'));

        // Also show column info
        const columns = [];
        for await (const row of this.db.eval(`PRAGMA table_info(${tableName})`)) {
          columns.push(row);
        }

        if (columns.length > 0) {
          console.log(chalk.gray('\nColumns:'));
          const table = new Table({
            head: [chalk.cyan('Name'), chalk.cyan('Type'), chalk.cyan('NotNull'), chalk.cyan('Default'), chalk.cyan('PK')]
          });

          for (const col of columns) {
            table.push([
              String(col.name || ''),
              String(col.type || 'TEXT'),
              col.notnull ? 'YES' : 'NO',
              String(col.dflt_value || ''),
              col.pk ? 'YES' : 'NO'
            ]);
          }

          console.log(table.toString());
        }
      }
    } catch (error) {
      console.error(chalk.red('Error showing schema:'), error instanceof Error ? error.message : String(error));
    }
  }

  async importCsv(filePath: string): Promise<void> {
    if (!filePath) {
      console.log(chalk.red('Please specify a CSV file path'));
      return;
    }

    try {
      const resolvedPath = path.resolve(filePath);
      const fileContent = await fs.readFile(resolvedPath, 'utf-8');

      // Parse CSV
      const parseResult = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true,
        transform: (value, field) => {
          // Try to convert numbers
          if (value === '') return null;
          const num = Number(value);
          if (!isNaN(num) && value === num.toString()) {
            return num;
          }
          return value;
        }
      });

      if (parseResult.errors.length > 0) {
        console.log(chalk.red('CSV parsing errors:'));
        parseResult.errors.forEach(error => {
          console.log(chalk.red(`  Line ${error.row}: ${error.message}`));
        });
        return;
      }

      if (parseResult.data.length === 0) {
        console.log(chalk.yellow('No data found in CSV file'));
        return;
      }

      // Generate table name from file name
      const tableName = path.basename(filePath, path.extname(filePath))
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^[0-9]/, '_$&'); // Ensure it doesn't start with a number

      // Infer column types from data
      const firstRow = parseResult.data[0] as Record<string, any>;
      const columns = Object.keys(firstRow).map(col => {
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as any)[col]);
        const hasNumbers = sampleValues.some(val => typeof val === 'number');
        const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');

        let type = 'TEXT';
        if (hasNumbers && !hasStrings) {
          type = 'REAL';
        } else if (hasNumbers) {
          type = 'TEXT'; // Mixed, so use TEXT
        }

        return `"${col}" ${type}`;
      });

      // Create table
      const createSql = `CREATE TABLE "${tableName}" (${columns.join(', ')})`;
      await this.db.exec(createSql);

      console.log(chalk.green(`Created table: ${tableName}`));

      // Insert data
      const columnNames = Object.keys(firstRow);
      const placeholders = columnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO "${tableName}" (${columnNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

      const stmt = await this.db.prepare(insertSql);
      let insertCount = 0;

      try {
        for (const row of parseResult.data) {
          const values = columnNames.map(col => (row as any)[col]);
          await stmt.run(values);
          insertCount++;
        }
      } finally {
        await stmt.finalize();
      }

      console.log(chalk.green(`Imported ${insertCount} rows into table '${tableName}'`));
    } catch (error) {
      console.error(chalk.red('Error importing CSV:'), error instanceof Error ? error.message : String(error));
    }
  }

  async exportQuery(sql: string, outputPath: string): Promise<void> {
    if (!sql || !outputPath) {
      console.log(chalk.red('Please specify both SQL query and output file path'));
      console.log(chalk.gray('Usage: .export "SELECT * FROM table" output.json'));
      return;
    }

    try {
      const results = [];
      for await (const row of this.db.eval(sql)) {
        results.push(row);
      }

      const resolvedPath = path.resolve(outputPath);
      const ext = path.extname(resolvedPath).toLowerCase();

      if (ext === '.json') {
        await fs.writeFile(resolvedPath, JSON.stringify(results, null, 2), 'utf-8');
      } else if (ext === '.csv') {
        if (results.length === 0) {
          await fs.writeFile(resolvedPath, '', 'utf-8');
        } else {
          const csv = Papa.unparse(results);
          await fs.writeFile(resolvedPath, csv, 'utf-8');
        }
      } else {
        // Default to JSON
        await fs.writeFile(resolvedPath, JSON.stringify(results, null, 2), 'utf-8');
      }

      console.log(chalk.green(`Exported ${results.length} rows to '${outputPath}'`));
    } catch (error) {
      console.error(chalk.red('Error exporting query:'), error instanceof Error ? error.message : String(error));
    }
  }
}

export const handleDotCommand = async (
  line: string,
  db: Database,
  readlineInterface: any
): Promise<boolean> => {
  // ... existing commands ...

  if (line.startsWith('.plugin')) {
    await handlePluginCommand(line, db);
    return true;
  }

  // ... rest of existing code ...

  // Return false for unhandled commands
  return false;
};

const handlePluginCommand = async (line: string, db: Database): Promise<void> => {
  const args = line.split(/\s+/).slice(1);
  const subcommand = args[0];

  switch (subcommand) {
    case 'install':
      await installPluginCommand(args.slice(1), db);
      break;
    case 'list':
      await listPluginsCommand();
      break;
    case 'enable':
      await enablePluginCommand(args.slice(1), db);
      break;
    case 'disable':
      await disablePluginCommand(args.slice(1));
      break;
    case 'remove':
      await removePluginCommand(args.slice(1));
      break;
    case 'config':
      await configPluginCommand(args.slice(1), db);
      break;
    case 'reload':
      await reloadPluginCommand(args.slice(1), db);
      break;
    default:
      console.log('Plugin management commands:');
      console.log('  .plugin install <url>     - Install plugin from URL');
      console.log('  .plugin list             - List installed plugins');
      console.log('  .plugin enable <name>    - Enable a plugin');
      console.log('  .plugin disable <name>   - Disable a plugin');
      console.log('  .plugin remove <name>    - Remove a plugin');
      console.log('  .plugin config <name>    - Configure a plugin');
      console.log('  .plugin reload <name>    - Reload a plugin');
      break;
  }
};

const getPluginsFilePath = (): string => {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.quoomb');
  return path.join(configDir, 'plugins.json');
};

const loadPlugins = async (): Promise<PluginRecord[]> => {
  try {
    const filePath = getPluginsFilePath();
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is invalid, return empty array
    return [];
  }
};

const savePlugins = async (plugins: PluginRecord[]): Promise<void> => {
  const filePath = getPluginsFilePath();
  const configDir = path.dirname(filePath);

  // Ensure config directory exists
  try {
    await fs.mkdir(configDir, { recursive: true });
  } catch (error) {
    // Directory already exists
  }

  await fs.writeFile(filePath, JSON.stringify(plugins, null, 2));
};

const installPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin install <url>');
    return;
  }

  const url = args[0];

  if (!validatePluginUrl(url)) {
    console.log('Error: Invalid plugin URL. Must be https:// or file:// URL ending in .js or .mjs');
    return;
  }

  try {
    console.log(`Installing plugin from ${url}...`);

    // Try to load the plugin
    const manifest = await dynamicLoadModule(url, db, {});

    // Load existing plugins
    const plugins = await loadPlugins();

    // Check if already installed
    const existing = plugins.find(p => p.url === url);
    if (existing) {
      console.log(`Plugin from ${url} is already installed`);
      return;
    }

    // Create plugin record
    const pluginRecord: PluginRecord = {
      id: crypto.randomUUID(),
      url,
      enabled: true,
      manifest,
      config: {},
    };

    // Add to list and save
    plugins.push(pluginRecord);
    await savePlugins(plugins);

    console.log(`Successfully installed plugin: ${manifest?.name || 'Unknown'}`);
    if (manifest?.description) {
      console.log(`  ${manifest.description}`);
    }
    if (manifest?.version) {
      console.log(`  Version: ${manifest.version}`);
    }
  } catch (error) {
    console.log(`Error installing plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const listPluginsCommand = async (): Promise<void> => {
  const plugins = await loadPlugins();

  if (plugins.length === 0) {
    console.log('No plugins installed');
    return;
  }

  console.log('Installed plugins:');
  for (const plugin of plugins) {
    const status = plugin.enabled ? '✓' : '✗';
    const name = plugin.manifest?.name || 'Unknown';
    const version = plugin.manifest?.version || '';
    console.log(`  ${status} ${name} ${version ? `(v${version})` : ''}`);
    console.log(`    ${plugin.url}`);
    if (plugin.manifest?.description) {
      console.log(`    ${plugin.manifest.description}`);
    }
    console.log();
  }
};

const enablePluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin enable <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  if (plugin.enabled) {
    console.log(`Plugin '${name}' is already enabled`);
    return;
  }

  try {
    // Load the plugin
    const manifest = await dynamicLoadModule(plugin.url, db, plugin.config);

    // Update plugin record
    plugin.enabled = true;
    if (manifest) {
      plugin.manifest = manifest;
    }

    await savePlugins(plugins);
    console.log(`Enabled plugin: ${name}`);
  } catch (error) {
    console.log(`Error enabling plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const disablePluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin disable <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  if (!plugin.enabled) {
    console.log(`Plugin '${name}' is already disabled`);
    return;
  }

  plugin.enabled = false;
  await savePlugins(plugins);
  console.log(`Disabled plugin: ${name}`);
  console.log('Note: Plugin will be unloaded on next restart');
};

const removePluginCommand = async (args: string[]): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin remove <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const pluginIndex = plugins.findIndex(p => p.manifest?.name === name);

  if (pluginIndex === -1) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  plugins.splice(pluginIndex, 1);
  await savePlugins(plugins);
  console.log(`Removed plugin: ${name}`);
};

const configPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin config <name> [key=value ...]');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  if (args.length === 1) {
    // Show current configuration
    console.log(`Configuration for ${name}:`);
    if (!plugin.manifest?.settings?.length) {
      console.log('  No configuration options available');
      return;
    }

    for (const setting of plugin.manifest.settings) {
      const value = plugin.config[setting.key] ?? setting.default ?? '';
      console.log(`  ${setting.key}: ${value} (${setting.type})`);
      if (setting.help) {
        console.log(`    ${setting.help}`);
      }
    }
    return;
  }

  // Update configuration
  const configUpdates: Record<string, SqlValue> = {};
  for (let i = 1; i < args.length; i++) {
    const [key, ...valueParts] = args[i].split('=');
    if (!key || valueParts.length === 0) {
      console.log(`Invalid config format: ${args[i]}. Use key=value`);
      continue;
    }

    const value = valueParts.join('=');
    const setting = plugin.manifest?.settings?.find((s: any) => s.key === key);

    if (!setting) {
      console.log(`Unknown setting: ${key}`);
      continue;
    }

    // Parse value according to type
    let parsedValue: SqlValue;
    switch (setting.type) {
      case 'number':
        parsedValue = Number(value);
        if (isNaN(parsedValue)) {
          console.log(`Invalid number value for ${key}: ${value}`);
          continue;
        }
        break;
      case 'boolean':
        parsedValue = value.toLowerCase() === 'true';
        break;
      default:
        parsedValue = value;
    }

    configUpdates[key] = parsedValue;
  }

  // Update plugin config
  plugin.config = { ...plugin.config, ...configUpdates };
  await savePlugins(plugins);

  // Reload plugin if enabled
  if (plugin.enabled) {
    try {
      await dynamicLoadModule(plugin.url, db, plugin.config);
      console.log(`Updated configuration and reloaded plugin: ${name}`);
    } catch (error) {
      console.log(`Configuration updated but failed to reload plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(`Updated configuration for plugin: ${name}`);
  }
};

const reloadPluginCommand = async (args: string[], db: Database): Promise<void> => {
  if (args.length === 0) {
    console.log('Usage: .plugin reload <name>');
    return;
  }

  const name = args[0];
  const plugins = await loadPlugins();
  const plugin = plugins.find(p => p.manifest?.name === name);

  if (!plugin) {
    console.log(`Plugin '${name}' not found`);
    return;
  }

  if (!plugin.enabled) {
    console.log(`Plugin '${name}' is disabled`);
    return;
  }

  try {
    const manifest = await dynamicLoadModule(plugin.url, db, plugin.config);

    // Update manifest if it changed
    if (manifest) {
      plugin.manifest = manifest;
      await savePlugins(plugins);
    }

    console.log(`Reloaded plugin: ${name}`);
  } catch (error) {
    console.log(`Error reloading plugin: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

// Update the startup function to load enabled plugins
export const loadEnabledPlugins = async (db: Database): Promise<void> => {
  const plugins = await loadPlugins();
  const enabledPlugins = plugins.filter(p => p.enabled);

  for (const plugin of enabledPlugins) {
    try {
      const manifest = await dynamicLoadModule(plugin.url, db, plugin.config);

      // Update manifest if it changed
      if (manifest && (!plugin.manifest || plugin.manifest.version !== manifest.version)) {
        plugin.manifest = manifest;
        await savePlugins(plugins);
      }
    } catch (error) {
      console.log(`Warning: Failed to load plugin ${plugin.manifest?.name || plugin.url}: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Disable the plugin if it failed to load
      plugin.enabled = false;
      await savePlugins(plugins);
    }
  }
};
