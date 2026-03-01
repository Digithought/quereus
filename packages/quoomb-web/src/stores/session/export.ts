import type { StoreSet, StoreGet } from './types.js';
import { formatRowsAsCSV } from '../../utils/csv.js';
import { downloadBlob } from '../../utils/download.js';

export function createExportActions(set: StoreSet, get: StoreGet) {
	return {
		exportResultsAsCSV: () => {
			const { queryHistory, activeResultId } = get();
			const activeResult = queryHistory.find(result => result.id === activeResultId);

			if (!activeResult?.results || activeResult.results.length === 0) {
				alert('No results to export');
				return;
			}

			const csvContent = formatRowsAsCSV(activeResult.results);
			downloadBlob(csvContent, `query-results-${new Date().getTime()}.csv`, 'text/csv;charset=utf-8;');
		},

		exportResultsAsJSON: () => {
			const { queryHistory, activeResultId } = get();
			const activeResult = queryHistory.find(result => result.id === activeResultId);

			if (!activeResult?.results || activeResult.results.length === 0) {
				alert('No results to export');
				return;
			}

			const exportData = {
				query: activeResult.sql,
				executedAt: activeResult.timestamp.toISOString(),
				executionTime: activeResult.executionTime,
				rowCount: activeResult.results.length,
				results: activeResult.results
			};

			const jsonContent = JSON.stringify(exportData, null, 2);
			downloadBlob(jsonContent, `query-results-${new Date().getTime()}.json`, 'application/json;charset=utf-8;');
		},

		saveTabAsFile: async (tabId?: string) => {
			const { activeTabId, tabs } = get();
			const resolvedId = tabId ?? activeTabId;
			const tab = tabs.find(t => t.id === resolvedId);

			if (!tab) {
				throw new Error(resolvedId ? 'No such tab' : 'No active tab to save');
			}

			let fileName = tab.name;

			// Ensure file has .sql extension if it doesn't already have one
			if (!fileName.toLowerCase().endsWith('.sql') && !fileName.toLowerCase().endsWith('.txt')) {
				fileName = fileName.replace(/\.[^/.]+$/, '') + '.sql';
			}

			downloadBlob(tab.content, fileName, 'text/plain');

			// Mark tab as clean after saving
			set((state) => ({
				...state,
				tabs: state.tabs.map(t =>
					t.id === resolvedId
						? { ...t, isDirty: false }
						: t
				),
			}));
		},

		loadSQLFile: () => {
			return new Promise<void>((resolve, reject) => {
				const input = document.createElement('input');
				input.type = 'file';
				input.accept = '.sql,.txt';
				input.style.visibility = 'hidden';

				input.onchange = (event) => {
					const file = (event.target as HTMLInputElement).files?.[0];
					if (!file) {
						resolve();
						return;
					}

					const reader = new FileReader();
					reader.onload = (e) => {
						try {
							const content = e.target?.result as string;
							const fileName = file.name;

							// Create a new tab with the file content
							const { createTab, updateTabContent } = get();
							const newTabId = createTab(fileName);
							updateTabContent(newTabId, content);

							// Mark tab as clean since it's just loaded
							set((state) => ({
								...state,
								tabs: state.tabs.map(tab =>
									tab.id === newTabId
										? { ...tab, isDirty: false }
										: tab
								),
							}));

							resolve();
						} catch (error) {
							reject(new Error(`Failed to read file: ${error instanceof Error ? error.message : error}`));
						}
					};

					reader.onerror = () => {
						reject(new Error('Failed to read file'));
					};

					reader.readAsText(file);
				};

				input.oncancel = () => {
					resolve(); // User cancelled, not an error
				};

				document.body.appendChild(input);
				input.click();
				document.body.removeChild(input);
			});
		},
	};
}
