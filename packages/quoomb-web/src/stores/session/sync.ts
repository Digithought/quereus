import type { SyncStatus, SyncEvent } from '../../worker/types.js';
import { useSettingsStore } from '../settingsStore.js';
import type { StoreSet, StoreGet } from './types.js';

export function createSyncActions(set: StoreSet, get: StoreGet) {
	return {
		setSyncStatus: (status: SyncStatus) => {
			set({ syncStatus: status });
		},

		addSyncEvent: (event: SyncEvent) => {
			set((state) => ({
				syncEvents: [event, ...state.syncEvents].slice(0, 100), // Keep last 100 events
			}));
		},

		clearSyncEvents: () => {
			set({ syncEvents: [] });
		},

		connectSync: async () => {
			const { api } = get();
			if (!api) {
				throw new Error('Database not connected');
			}

			const { syncUrl, syncDatabaseId, storageModule } = useSettingsStore.getState();

			// Ensure sync module is enabled
			if (storageModule !== 'sync') {
				throw new Error('Sync module is not enabled. Enable it in Settings > Storage.');
			}

			// Validate databaseId format
			if (!syncDatabaseId || syncDatabaseId.trim() === '') {
				throw new Error('Database ID is required. Please set it in Settings > Sync (default: local-s1).');
			}

			// Validate format: accountId-{s|d}# or accountId-acc
			const parts = syncDatabaseId.split('-');
			if (parts.length !== 2) {
				throw new Error('Invalid Database ID format. Must be: accountId-s# or accountId-d# or accountId-acc (e.g., local-s1)');
			}

			const [accountId, dbPart] = parts;
			if (!accountId) {
				throw new Error('Invalid Database ID: account ID cannot be empty');
			}

			if (dbPart !== 'acc') {
				const typeChar = dbPart[0];
				if (typeChar !== 's' && typeChar !== 'd') {
					throw new Error('Invalid Database ID: type must be "s" (scenario), "d" (dynamics), or "acc" (account)');
				}
				const numStr = dbPart.slice(1);
				const num = parseInt(numStr, 10);
				if (isNaN(num) || num < 1) {
					throw new Error('Invalid Database ID: number must be a positive integer (e.g., s1, d5)');
				}
			}

			set({ syncStatus: { status: 'connecting' } });

			try {
				await api.connectSync(syncUrl, syncDatabaseId);
				set({ syncStatus: { status: 'syncing', progress: 0 } });
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Connection failed';
				set({ syncStatus: { status: 'error', message } });
				throw error;
			}
		},

		disconnectSync: async () => {
			const { api } = get();
			if (!api) return;

			try {
				await api.disconnectSync();
			} finally {
				set({ syncStatus: { status: 'disconnected' } });
			}
		},
	};
}
