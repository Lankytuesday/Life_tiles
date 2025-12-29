/**
 * Lifetiles Sync Module
 * Handles chrome.storage.sync integration with IndexedDB
 */

const LifetilesSync = (function() {
    const SYNC_KEYS = {
        INITIALIZED: '_syncInitialized',
        SCHEMA_VERSION: '_schemaVersion',
        LAST_MODIFIED: '_lastModified',
        DASHBOARDS: '_dashboards',
        PROJECTS: '_projects',
        TILES: '_tiles'
    };

    const CURRENT_SCHEMA_VERSION = 2; // Bumped for chunking support
    const DEBOUNCE_MS = 2000;
    const QUOTA_WARNING_THRESHOLD = 0.8; // Warn at 80% of quota
    const MAX_SYNC_BYTES = 102400; // 100KB
    const MAX_BYTES_PER_ITEM = 8192; // 8KB per item
    const SAFE_CHUNK_SIZE = 7000; // Leave headroom for JSON overhead

    let debounceTimer = null;
    let syncEnabled = true;
    let lastSyncedTimestamp = null;

    /**
     * Initialize sync - call this on extension load
     * Handles first-run detection and migration
     */
    async function init() {
        try {
            // Check if chrome.storage.sync is available
            if (!chrome?.storage?.sync) {
                console.warn('[Sync] chrome.storage.sync not available');
                syncEnabled = false;
                return { status: 'unavailable' };
            }

            // Debug: show what's currently in sync storage
            const allSyncData = await getSyncStorage(null);
            console.log('[Sync] Current sync storage contents:', allSyncData);

            // Migrate from old format if it exists (single _data key or non-chunked keys)
            if (allSyncData._data) {
                console.log('[Sync] Migrating from old sync format (v1)...');
                const oldData = allSyncData._data;

                // Push using new chunked format
                await pushToSync({
                    dashboards: oldData.dashboards || [],
                    projects: oldData.projects || [],
                    tiles: oldData.tiles || []
                });

                // Remove old key
                await new Promise((resolve) => {
                    chrome.storage.sync.remove('_data', resolve);
                });

                console.log('[Sync] Migration complete');
                return { status: 'migrated' };
            }

            const syncData = await getSyncStorage([SYNC_KEYS.INITIALIZED, SYNC_KEYS.SCHEMA_VERSION, SYNC_KEYS.LAST_MODIFIED]);

            if (!syncData[SYNC_KEYS.INITIALIZED]) {
                // Sync never initialized - check for existing local data
                return await handleFirstRun();
            } else {
                // Sync exists - check schema version and pull
                return await handleExistingSync(syncData);
            }
        } catch (error) {
            console.error('[Sync] Init failed:', error);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Handle first run - either fresh install or upgrade from local-only
     */
    async function handleFirstRun() {
        console.log('[Sync] First run detected');

        const localData = await getLocalData();
        console.log('[Sync] Local data:', localData);

        const hasLocalData = localData.dashboards.length > 0 ||
                            localData.projects.length > 0 ||
                            localData.tiles.length > 0;

        if (hasLocalData) {
            // Upgrade path: push existing local data to sync
            console.log('[Sync] Existing local data found - pushing to sync');
            const pushResult = await pushToSync(localData);
            return { status: 'upgraded', ...pushResult };
        } else {
            // Fresh install: initialize empty sync
            console.log('[Sync] Fresh install - initializing sync');
            try {
                await pushToSync({ dashboards: [], projects: [], tiles: [] });
                return { status: 'initialized' };
            } catch (error) {
                console.error('[Sync] Failed to initialize:', error.message);
                return { status: 'error', error: error.message };
            }
        }
    }

    /**
     * Handle case where sync already exists
     */
    async function handleExistingSync(syncMeta) {
        const schemaVersion = syncMeta[SYNC_KEYS.SCHEMA_VERSION] || 1;

        // Check for schema version mismatch
        if (schemaVersion > CURRENT_SCHEMA_VERSION) {
            console.warn('[Sync] Sync data is from newer extension version');
            return { status: 'version_mismatch', syncVersion: schemaVersion, localVersion: CURRENT_SCHEMA_VERSION };
        }

        // Pull sync data to local
        const pullResult = await pullFromSync();
        lastSyncedTimestamp = syncMeta[SYNC_KEYS.LAST_MODIFIED];

        return { status: 'synced', lastModified: lastSyncedTimestamp, ...pullResult };
    }

    /**
     * Get all relevant data from IndexedDB (excluding favicons)
     */
    async function getLocalData() {
        const db = await initDB();

        const getData = (storeName) => {
            return new Promise((resolve, reject) => {
                const tx = db.transaction([storeName], 'readonly');
                const store = tx.objectStore(storeName);
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        };

        const [dashboards, projects, tiles] = await Promise.all([
            getData('dashboards'),
            getData('projects'),
            getData('tiles')
        ]);

        // Strip any large fields we don't want to sync (e.g., cached data)
        const cleanTiles = tiles.map(({ id, name, url, projectId, dashboardId, order }) => ({
            id, name, url, projectId, dashboardId, order
        }));

        return { dashboards, projects, tiles: cleanTiles };
    }

    /**
     * Chunk an array into pieces that fit within size limit
     */
    function chunkArray(arr, baseKey) {
        const chunks = [];
        let currentChunk = [];
        let currentSize = 2; // Start with "[]"

        for (const item of arr) {
            const itemJson = JSON.stringify(item);
            const itemSize = itemJson.length + 1; // +1 for comma

            if (currentSize + itemSize > SAFE_CHUNK_SIZE && currentChunk.length > 0) {
                // Start new chunk
                chunks.push(currentChunk);
                currentChunk = [item];
                currentSize = 2 + itemJson.length;
            } else {
                currentChunk.push(item);
                currentSize += itemSize;
            }
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        // Convert to keyed object
        const result = {};
        chunks.forEach((chunk, i) => {
            result[`${baseKey}_${i}`] = chunk;
        });
        // Store count for reassembly
        result[`${baseKey}_count`] = chunks.length;

        return result;
    }

    /**
     * Push local data to chrome.storage.sync
     */
    async function pushToSync(data) {
        if (!syncEnabled) {
            return { success: false, reason: 'sync_disabled' };
        }

        try {
            const timestamp = Date.now();

            // First, clear old chunk keys
            const existingKeys = await getSyncStorage(null);
            const keysToRemove = Object.keys(existingKeys).filter(k =>
                k.startsWith('_dashboards_') ||
                k.startsWith('_projects_') ||
                k.startsWith('_tiles_')
            );
            if (keysToRemove.length > 0) {
                await new Promise(resolve => chrome.storage.sync.remove(keysToRemove, resolve));
            }

            // Build payload with chunked data
            const payload = {
                [SYNC_KEYS.INITIALIZED]: true,
                [SYNC_KEYS.SCHEMA_VERSION]: CURRENT_SCHEMA_VERSION,
                [SYNC_KEYS.LAST_MODIFIED]: timestamp,
                ...chunkArray(data.dashboards || [], SYNC_KEYS.DASHBOARDS),
                ...chunkArray(data.projects || [], SYNC_KEYS.PROJECTS),
                ...chunkArray(data.tiles || [], SYNC_KEYS.TILES)
            };

            // Check total quota
            const quotaCheck = await checkQuota(payload);
            if (!quotaCheck.ok) {
                console.warn('[Sync] Total quota would be exceeded:', quotaCheck);
                return { success: false, reason: 'quota_exceeded', ...quotaCheck };
            }

            await setSyncStorage(payload);
            lastSyncedTimestamp = timestamp;

            console.log('[Sync] Push successful, bytes used:', quotaCheck.bytesUsed);
            return { success: true, bytesUsed: quotaCheck.bytesUsed };
        } catch (error) {
            const errorMsg = error?.message || JSON.stringify(error) || String(error);
            console.error('[Sync] Push failed:', errorMsg);
            return { success: false, reason: 'error', error: errorMsg };
        }
    }

    /**
     * Reassemble chunked data from sync storage
     */
    function reassembleChunks(syncData, baseKey) {
        const count = syncData[`${baseKey}_count`];
        if (typeof count !== 'number') {
            // No chunks, maybe old format with single key
            return syncData[baseKey] || [];
        }

        const result = [];
        for (let i = 0; i < count; i++) {
            const chunk = syncData[`${baseKey}_${i}`];
            if (Array.isArray(chunk)) {
                result.push(...chunk);
            }
        }
        return result;
    }

    /**
     * Pull data from chrome.storage.sync to IndexedDB
     */
    async function pullFromSync() {
        if (!syncEnabled) {
            return { success: false, reason: 'sync_disabled' };
        }

        try {
            const syncData = await getSyncStorage(null); // Get all keys

            const data = {
                dashboards: reassembleChunks(syncData, SYNC_KEYS.DASHBOARDS),
                projects: reassembleChunks(syncData, SYNC_KEYS.PROJECTS),
                tiles: reassembleChunks(syncData, SYNC_KEYS.TILES)
            };

            console.log('[Sync] Reassembled data:', {
                dashboards: data.dashboards.length,
                projects: data.projects.length,
                tiles: data.tiles.length
            });

            // Check if there's any data
            if (data.dashboards.length === 0 && data.projects.length === 0 && data.tiles.length === 0) {
                console.log('[Sync] No data in sync storage');
                return { success: true, imported: false };
            }

            // Validate data structure
            if (!isValidSyncData(data)) {
                console.error('[Sync] Corrupt sync data');
                return { success: false, reason: 'corrupt_data' };
            }

            // Import to IndexedDB
            await importToIndexedDB(data);

            console.log('[Sync] Pull successful');
            return { success: true, imported: true, counts: {
                dashboards: data.dashboards.length,
                projects: data.projects.length,
                tiles: data.tiles.length
            }};
        } catch (error) {
            console.error('[Sync] Pull failed:', error);
            return { success: false, reason: 'error', error: error.message };
        }
    }

    /**
     * Import data to IndexedDB (replaces existing data)
     */
    async function importToIndexedDB(data) {
        const db = await initDB();
        const tx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');

        // Clear existing data
        await Promise.all([
            clearStore(tx.objectStore('dashboards')),
            clearStore(tx.objectStore('projects')),
            clearStore(tx.objectStore('tiles'))
        ]);

        // Import new data
        const dashboardStore = tx.objectStore('dashboards');
        const projectStore = tx.objectStore('projects');
        const tileStore = tx.objectStore('tiles');

        for (const dashboard of (data.dashboards || [])) {
            dashboardStore.put(dashboard);
        }
        for (const project of (data.projects || [])) {
            projectStore.put(project);
        }
        for (const tile of (data.tiles || [])) {
            tileStore.put(tile);
        }

        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Clear an object store
     */
    function clearStore(store) {
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Validate sync data structure
     */
    function isValidSyncData(data) {
        if (typeof data !== 'object' || data === null) return false;
        if (!Array.isArray(data.dashboards)) return false;
        if (!Array.isArray(data.projects)) return false;
        if (!Array.isArray(data.tiles)) return false;
        return true;
    }

    /**
     * Check quota before writing
     */
    async function checkQuota(payload) {
        const jsonSize = new Blob([JSON.stringify(payload)]).size;

        if (jsonSize > MAX_SYNC_BYTES) {
            return {
                ok: false,
                bytesUsed: jsonSize,
                maxBytes: MAX_SYNC_BYTES,
                percentUsed: (jsonSize / MAX_SYNC_BYTES * 100).toFixed(1)
            };
        }

        const percentUsed = jsonSize / MAX_SYNC_BYTES;
        return {
            ok: true,
            bytesUsed: jsonSize,
            maxBytes: MAX_SYNC_BYTES,
            percentUsed: (percentUsed * 100).toFixed(1),
            warning: percentUsed >= QUOTA_WARNING_THRESHOLD
        };
    }

    /**
     * Debounced sync - call this after any local data change
     */
    function scheduleSync() {
        if (!syncEnabled) return;

        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(async () => {
            debounceTimer = null;
            const data = await getLocalData();
            const result = await pushToSync(data);

            if (result.warning) {
                console.warn('[Sync] Approaching quota limit:', result.percentUsed + '%');
                // Could dispatch event here for UI to show warning
                dispatchSyncEvent('quota_warning', result);
            }

            dispatchSyncEvent('sync_complete', result);
        }, DEBOUNCE_MS);
    }

    /**
     * Listen for changes from other devices
     */
    function startListening() {
        if (!chrome?.storage?.onChanged) return;

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'sync') return;

            if (changes[SYNC_KEYS.LAST_MODIFIED]) {
                const newTimestamp = changes[SYNC_KEYS.LAST_MODIFIED].newValue;

                // Only pull if change came from another device (different timestamp)
                if (newTimestamp && newTimestamp !== lastSyncedTimestamp) {
                    console.log('[Sync] Remote change detected, pulling...');
                    pullFromSync().then(result => {
                        lastSyncedTimestamp = newTimestamp;
                        dispatchSyncEvent('remote_update', result);
                    });
                }
            }
        });
    }

    /**
     * Dispatch custom events for UI updates
     */
    function dispatchSyncEvent(type, detail) {
        window.dispatchEvent(new CustomEvent('lifetiles-sync', {
            detail: { type, ...detail }
        }));
    }

    /**
     * Get current sync status
     */
    async function getStatus() {
        if (!syncEnabled) {
            return { enabled: false, reason: 'unavailable' };
        }

        try {
            const bytesInUse = await new Promise(resolve => {
                chrome.storage.sync.getBytesInUse(null, resolve);
            });

            return {
                enabled: true,
                bytesUsed: bytesInUse,
                maxBytes: MAX_SYNC_BYTES,
                percentUsed: (bytesInUse / MAX_SYNC_BYTES * 100).toFixed(1),
                lastSynced: lastSyncedTimestamp
            };
        } catch (error) {
            return { enabled: false, reason: 'error', error: error.message };
        }
    }

    /**
     * Force a full sync (manual trigger)
     */
    async function forceSync() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        const data = await getLocalData();
        return await pushToSync(data);
    }

    /**
     * Reset sync (for "start fresh" option)
     */
    async function resetSync() {
        try {
            await new Promise((resolve, reject) => {
                chrome.storage.sync.clear(() => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve();
                });
            });
            lastSyncedTimestamp = null;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Helper: promisified chrome.storage.sync.get
    function getSyncStorage(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.get(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || 'Unknown sync error'));
                } else {
                    resolve(result);
                }
            });
        });
    }

    // Helper: promisified chrome.storage.sync.set
    function setSyncStorage(data) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.set(data, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || 'Unknown sync error'));
                } else {
                    resolve();
                }
            });
        });
    }

    // Public API
    return {
        init,
        scheduleSync,
        startListening,
        getStatus,
        forceSync,
        resetSync,
        pullFromSync
    };
})();
