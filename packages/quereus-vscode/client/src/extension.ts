import { ExtensionContext, workspace, Disposable } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { pushSchemaSnapshot, type SchemaSnapshot } from './schema-sync';

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
	const serverModule = context.asAbsolutePath('server/out/server.js');
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--inspect=6009'] } }
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ language: 'quereus-sql' },
			{ language: 'sql' }
		],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*')
		}
	};

	client = new LanguageClient('quereus-sql', 'Quereus SQL', serverOptions, clientOptions);

	context.subscriptions.push(new Disposable(() => { void client?.stop(); }));

	// Start the client and push an initial empty schema snapshot after start
	void (async () => {
		await client!.start();
		const empty: SchemaSnapshot = { tables: [], functions: [] };
		await pushSchemaSnapshot(client!, empty);
	})();
}

export function deactivate(): Thenable<void> | undefined {
	return client?.stop();
}


