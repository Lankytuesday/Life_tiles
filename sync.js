/**
 * Lifetiles Sync Module
 * Handles chrome.storage.sync integration with IndexedDB
 *
 * Uses LZ compression to fit data into chrome.storage.sync limits
 */

const LifetilesSync = (function() {
    // ============== LZ-String Compression (MIT License) ==============
    const LZ = (function() {
        const f = String.fromCharCode;
        const keyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

        function compressToBase64(input) {
            if (input == null) return "";
            const res = _compress(input, 6, a => keyStrBase64.charAt(a));
            switch (res.length % 4) {
                case 0: return res;
                case 1: return res + "===";
                case 2: return res + "==";
                case 3: return res + "=";
            }
        }

        function decompressFromBase64(input) {
            if (input == null || input === "") return null;
            return _decompress(input.length, 32, index => getBaseValue(keyStrBase64, input.charAt(index)));
        }

        const baseReverseDic = {};
        function getBaseValue(alphabet, character) {
            if (!baseReverseDic[alphabet]) {
                baseReverseDic[alphabet] = {};
                for (let i = 0; i < alphabet.length; i++) {
                    baseReverseDic[alphabet][alphabet.charAt(i)] = i;
                }
            }
            return baseReverseDic[alphabet][character];
        }

        function _compress(uncompressed, bitsPerChar, getCharFromInt) {
            if (uncompressed == null) return "";
            let i, value, context_dictionary = {}, context_dictionaryToCreate = {},
                context_c = "", context_wc = "", context_w = "",
                context_enlargeIn = 2, context_dictSize = 3, context_numBits = 2,
                context_data = [], context_data_val = 0, context_data_position = 0;

            for (let ii = 0; ii < uncompressed.length; ii++) {
                context_c = uncompressed.charAt(ii);
                if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) {
                    context_dictionary[context_c] = context_dictSize++;
                    context_dictionaryToCreate[context_c] = true;
                }
                context_wc = context_w + context_c;
                if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) {
                    context_w = context_wc;
                } else {
                    if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                        if (context_w.charCodeAt(0) < 256) {
                            for (i = 0; i < context_numBits; i++) {
                                context_data_val = (context_data_val << 1);
                                if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                                else { context_data_position++; }
                            }
                            value = context_w.charCodeAt(0);
                            for (i = 0; i < 8; i++) {
                                context_data_val = (context_data_val << 1) | (value & 1);
                                if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                                else { context_data_position++; }
                                value = value >> 1;
                            }
                        } else {
                            value = 1;
                            for (i = 0; i < context_numBits; i++) {
                                context_data_val = (context_data_val << 1) | value;
                                if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                                else { context_data_position++; }
                                value = 0;
                            }
                            value = context_w.charCodeAt(0);
                            for (i = 0; i < 16; i++) {
                                context_data_val = (context_data_val << 1) | (value & 1);
                                if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                                else { context_data_position++; }
                                value = value >> 1;
                            }
                        }
                        context_enlargeIn--;
                        if (context_enlargeIn == 0) { context_enlargeIn = Math.pow(2, context_numBits); context_numBits++; }
                        delete context_dictionaryToCreate[context_w];
                    } else {
                        value = context_dictionary[context_w];
                        for (i = 0; i < context_numBits; i++) {
                            context_data_val = (context_data_val << 1) | (value & 1);
                            if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                            else { context_data_position++; }
                            value = value >> 1;
                        }
                    }
                    context_enlargeIn--;
                    if (context_enlargeIn == 0) { context_enlargeIn = Math.pow(2, context_numBits); context_numBits++; }
                    context_dictionary[context_wc] = context_dictSize++;
                    context_w = String(context_c);
                }
            }
            if (context_w !== "") {
                if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                    if (context_w.charCodeAt(0) < 256) {
                        for (i = 0; i < context_numBits; i++) {
                            context_data_val = (context_data_val << 1);
                            if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                            else { context_data_position++; }
                        }
                        value = context_w.charCodeAt(0);
                        for (i = 0; i < 8; i++) {
                            context_data_val = (context_data_val << 1) | (value & 1);
                            if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                            else { context_data_position++; }
                            value = value >> 1;
                        }
                    } else {
                        value = 1;
                        for (i = 0; i < context_numBits; i++) {
                            context_data_val = (context_data_val << 1) | value;
                            if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                            else { context_data_position++; }
                            value = 0;
                        }
                        value = context_w.charCodeAt(0);
                        for (i = 0; i < 16; i++) {
                            context_data_val = (context_data_val << 1) | (value & 1);
                            if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                            else { context_data_position++; }
                            value = value >> 1;
                        }
                    }
                    context_enlargeIn--;
                    if (context_enlargeIn == 0) { context_enlargeIn = Math.pow(2, context_numBits); context_numBits++; }
                    delete context_dictionaryToCreate[context_w];
                } else {
                    value = context_dictionary[context_w];
                    for (i = 0; i < context_numBits; i++) {
                        context_data_val = (context_data_val << 1) | (value & 1);
                        if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                        else { context_data_position++; }
                        value = value >> 1;
                    }
                }
                context_enlargeIn--;
                if (context_enlargeIn == 0) { context_numBits++; }
            }
            value = 2;
            for (i = 0; i < context_numBits; i++) {
                context_data_val = (context_data_val << 1) | (value & 1);
                if (context_data_position == bitsPerChar - 1) { context_data_position = 0; context_data.push(getCharFromInt(context_data_val)); context_data_val = 0; }
                else { context_data_position++; }
                value = value >> 1;
            }
            while (true) {
                context_data_val = (context_data_val << 1);
                if (context_data_position == bitsPerChar - 1) { context_data.push(getCharFromInt(context_data_val)); break; }
                else { context_data_position++; }
            }
            return context_data.join('');
        }

        function _decompress(length, resetValue, getNextValue) {
            let dictionary = [], enlargeIn = 4, dictSize = 4, numBits = 3,
                entry = "", result = [], i, w, bits, resb, maxpower, power, c,
                data = { val: getNextValue(0), position: resetValue, index: 1 };
            for (i = 0; i < 3; i++) { dictionary[i] = i; }
            bits = 0; maxpower = Math.pow(2, 2); power = 1;
            while (power != maxpower) {
                resb = data.val & data.position; data.position >>= 1;
                if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
                bits |= (resb > 0 ? 1 : 0) * power; power <<= 1;
            }
            switch (bits) {
                case 0:
                    bits = 0; maxpower = Math.pow(2, 8); power = 1;
                    while (power != maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                    c = f(bits); break;
                case 1:
                    bits = 0; maxpower = Math.pow(2, 16); power = 1;
                    while (power != maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                    c = f(bits); break;
                case 2: return "";
            }
            dictionary[3] = c; w = c; result.push(c);
            while (true) {
                if (data.index > length) return "";
                bits = 0; maxpower = Math.pow(2, numBits); power = 1;
                while (power != maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                switch (c = bits) {
                    case 0:
                        bits = 0; maxpower = Math.pow(2, 8); power = 1;
                        while (power != maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                        dictionary[dictSize++] = f(bits); c = dictSize - 1; enlargeIn--; break;
                    case 1:
                        bits = 0; maxpower = Math.pow(2, 16); power = 1;
                        while (power != maxpower) { resb = data.val & data.position; data.position >>= 1; if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); } bits |= (resb > 0 ? 1 : 0) * power; power <<= 1; }
                        dictionary[dictSize++] = f(bits); c = dictSize - 1; enlargeIn--; break;
                    case 2: return result.join('');
                }
                if (enlargeIn == 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
                if (dictionary[c]) { entry = dictionary[c]; } else if (c === dictSize) { entry = w + w.charAt(0); } else { return null; }
                result.push(entry);
                dictionary[dictSize++] = w + entry.charAt(0);
                enlargeIn--;
                if (enlargeIn == 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
                w = entry;
            }
        }

        return { compress: compressToBase64, decompress: decompressFromBase64 };
    })();
    // ============== End LZ-String ==============

    const SYNC_KEY = '_lifetiles'; // Single key for all data
    const CHUNK_SIZE = 7500; // Safe size per chunk
    const DEBOUNCE_MS = 2000;
    const IGNORE_WINDOW_MS = 3000; // Ignore onChanged events for 3s after push
    const QUOTA_BYTES = 102400; // chrome.storage.sync limit (100 KB)
    const QUOTA_WARNING_THRESHOLD = 0.8; // Warn at 80%
    const QUOTA_ERROR_THRESHOLD = 0.95; // Block at 95%

    let debounceTimer = null;
    let syncEnabled = true;
    let lastSyncedTimestamp = null;
    let lastPushTime = 0; // Track when we last pushed to ignore our own changes

    /**
     * Initialize sync
     */
    async function init() {
        try {
            if (!chrome?.storage?.sync) {
                console.warn('[Sync] chrome.storage.sync not available');
                syncEnabled = false;
                return { status: 'unavailable' };
            }

            // Clear any old format keys
            const allKeys = await getSyncStorage(null);
            const oldKeys = Object.keys(allKeys).filter(k =>
                k.startsWith('_dashboards') || k.startsWith('_projects') ||
                k.startsWith('_tiles') || k === '_syncInitialized' ||
                k === '_schemaVersion' || k === '_lastModified' || k === '_data'
            );
            if (oldKeys.length > 0) {
                console.log('[Sync] Cleaning up old format keys:', oldKeys);
                await new Promise(r => chrome.storage.sync.remove(oldKeys, r));
            }

            // Check for existing sync data
            const syncData = await getSyncStorage(null);
            const hasSync = Object.keys(syncData).some(k => k.startsWith(SYNC_KEY));

            console.log('[Sync] Current storage keys:', Object.keys(syncData));

            if (hasSync) {
                // Pull existing sync data
                console.log('[Sync] Found existing sync data, pulling...');
                const result = await pullFromSync();
                return { status: 'synced', ...result };
            } else {
                // Check for local data to push
                const localData = await getLocalData();
                const hasLocal = localData.dashboards.length > 0 ||
                                localData.projects.length > 0 ||
                                localData.tiles.length > 0;

                if (hasLocal) {
                    // Only push if we have substantial data (prevent empty overwrites)
                    const dataSize = JSON.stringify(localData).length;
                    if (dataSize > 500) {
                        console.log(`[Sync] No sync data, pushing local data (${dataSize} bytes)...`);
                        const result = await pushToSync(localData);
                        return { status: 'pushed', ...result };
                    } else {
                        console.log(`[Sync] Local data too small (${dataSize} bytes), skipping auto-push`);
                        console.log('[Sync] Sync data may still be propagating. Use LifetilesSync.forceSync() to push manually.');
                        return { status: 'waiting' };
                    }
                } else {
                    console.log('[Sync] No data anywhere, fresh start');
                    return { status: 'empty' };
                }
            }
        } catch (error) {
            console.error('[Sync] Init failed:', error);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Convert full keys to short keys for sync storage
     * i=id, n=name, u=url, o=order, p=projectId, d=dashboardId
     */
    function toShortKeys(obj, type) {
        if (type === 'dashboard') {
            return { i: obj.id, n: obj.name, o: obj.order };
        } else if (type === 'project') {
            return { i: obj.id, n: obj.name, d: obj.dashboardId, o: obj.order };
        } else if (type === 'tile') {
            return { i: obj.id, n: obj.name, u: obj.url, p: obj.projectId, d: obj.dashboardId, o: obj.order };
        }
        return obj;
    }

    /**
     * Convert short keys back to full keys for IndexedDB
     */
    function toFullKeys(obj, type) {
        if (type === 'dashboard') {
            return { id: obj.i ?? obj.id, name: obj.n ?? obj.name, order: obj.o ?? obj.order };
        } else if (type === 'project') {
            return { id: obj.i ?? obj.id, name: obj.n ?? obj.name, dashboardId: obj.d ?? obj.dashboardId, order: obj.o ?? obj.order };
        } else if (type === 'tile') {
            return { id: obj.i ?? obj.id, name: obj.n ?? obj.name, url: obj.u ?? obj.url, projectId: obj.p ?? obj.projectId, dashboardId: obj.d ?? obj.dashboardId, order: obj.o ?? obj.order };
        }
        return obj;
    }

    /**
     * Get local data from IndexedDB
     */
    async function getLocalData() {
        const db = await initDB();
        const getData = (store) => new Promise((resolve, reject) => {
            const tx = db.transaction([store], 'readonly');
            const req = tx.objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });

        const [dashboards, projects, tiles] = await Promise.all([
            getData('dashboards'),
            getData('projects'),
            getData('tiles')
        ]);

        // Convert to short keys for smaller sync payload
        return {
            dashboards: dashboards.map(d => toShortKeys(d, 'dashboard')),
            projects: projects.map(p => toShortKeys(p, 'project')),
            tiles: tiles.map(t => toShortKeys(t, 'tile'))
        };
    }

    /**
     * Push data to sync storage (compressed + chunked)
     */
    async function pushToSync(data) {
        if (!syncEnabled) return { success: false, reason: 'disabled' };

        try {
            const json = JSON.stringify({
                v: 4, // v4: short keys (i,n,u,o,p,d)
                ts: Date.now(),
                d: data.dashboards,
                p: data.projects,
                t: data.tiles
            });

            const compressed = LZ.compress(json);
            const estimatedSize = compressed.length + 100; // Add overhead for keys
            const percentUsed = estimatedSize / QUOTA_BYTES;

            console.log(`[Sync] Compressed ${json.length} -> ${compressed.length} bytes (${Math.round(compressed.length/json.length*100)}%)`);
            console.log(`[Sync] Quota: ${(estimatedSize/1024).toFixed(1)} KB / ${(QUOTA_BYTES/1024).toFixed(0)} KB (${Math.round(percentUsed*100)}%)`);

            // Check quota thresholds
            if (percentUsed >= QUOTA_ERROR_THRESHOLD) {
                console.error('[Sync] Data too large! Would exceed quota.');
                window.dispatchEvent(new CustomEvent('lifetiles-sync', {
                    detail: { type: 'quota_exceeded', percentUsed: Math.round(percentUsed * 100), size: estimatedSize }
                }));
                return { success: false, reason: 'quota_exceeded', percentUsed: Math.round(percentUsed * 100) };
            }

            if (percentUsed >= QUOTA_WARNING_THRESHOLD) {
                console.warn(`[Sync] Approaching quota limit: ${Math.round(percentUsed * 100)}%`);
                window.dispatchEvent(new CustomEvent('lifetiles-sync', {
                    detail: { type: 'quota_warning', percentUsed: Math.round(percentUsed * 100), size: estimatedSize }
                }));
            }

            // Split into chunks if needed
            const chunks = [];
            for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
                chunks.push(compressed.slice(i, i + CHUNK_SIZE));
            }

            console.log(`[Sync] Split into ${chunks.length} chunk(s)`);

            // Clear old chunks first
            const existing = await getSyncStorage(null);
            const oldChunks = Object.keys(existing).filter(k => k.startsWith(SYNC_KEY));
            if (oldChunks.length > 0) {
                await new Promise(r => chrome.storage.sync.remove(oldChunks, r));
            }

            // Store new chunks
            const payload = { [`${SYNC_KEY}_n`]: chunks.length };
            chunks.forEach((chunk, i) => {
                payload[`${SYNC_KEY}_${i}`] = chunk;
            });

            await setSyncStorage(payload);
            lastSyncedTimestamp = Date.now();
            lastPushTime = Date.now(); // Track push time to ignore our own onChanged events

            console.log('[Sync] Push successful');
            return { success: true, chunks: chunks.length, size: compressed.length, percentUsed: Math.round(percentUsed * 100) };
        } catch (error) {
            const isQuotaError = error.message?.includes('QUOTA') || error.message?.includes('quota');
            console.error('[Sync] Push failed:', error.message);

            if (isQuotaError) {
                window.dispatchEvent(new CustomEvent('lifetiles-sync', {
                    detail: { type: 'quota_exceeded', error: error.message }
                }));
                return { success: false, reason: 'quota_exceeded', error: error.message };
            }

            return { success: false, error: error.message };
        }
    }

    /**
     * Pull data from sync storage
     */
    async function pullFromSync() {
        if (!syncEnabled) return { success: false, reason: 'disabled' };

        try {
            const syncData = await getSyncStorage(null);
            const numChunks = syncData[`${SYNC_KEY}_n`];

            if (typeof numChunks !== 'number' || numChunks === 0) {
                console.log('[Sync] No chunks found');
                return { success: true, imported: false };
            }

            // Reassemble chunks
            let compressed = '';
            for (let i = 0; i < numChunks; i++) {
                const chunk = syncData[`${SYNC_KEY}_${i}`];
                if (!chunk) {
                    console.error(`[Sync] Missing chunk ${i}`);
                    return { success: false, reason: 'missing_chunk', chunk: i };
                }
                compressed += chunk;
            }

            console.log(`[Sync] Reassembled ${numChunks} chunks, ${compressed.length} bytes`);

            // Decompress
            const json = LZ.decompress(compressed);
            if (!json) {
                console.error('[Sync] Decompression failed');
                return { success: false, reason: 'decompress_failed' };
            }

            const data = JSON.parse(json);
            console.log('[Sync] Decompressed data:', {
                version: data.v,
                dashboards: data.d?.length || 0,
                projects: data.p?.length || 0,
                tiles: data.t?.length || 0
            });

            // Import to IndexedDB
            await importToIndexedDB({
                dashboards: data.d || [],
                projects: data.p || [],
                tiles: data.t || []
            });

            lastSyncedTimestamp = data.ts;
            return { success: true, imported: true };
        } catch (error) {
            console.error('[Sync] Pull failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Import data to IndexedDB
     */
    async function importToIndexedDB(data) {
        const db = await initDB();

        // Convert short keys back to full keys (handles both old and new format)
        const dashboards = data.dashboards.map(d => toFullKeys(d, 'dashboard'));
        const projects = data.projects.map(p => toFullKeys(p, 'project'));
        const tiles = data.tiles.map(t => toFullKeys(t, 'tile'));

        // First transaction: clear all stores
        const clearTx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');
        clearTx.objectStore('dashboards').clear();
        clearTx.objectStore('projects').clear();
        clearTx.objectStore('tiles').clear();

        await new Promise((resolve, reject) => {
            clearTx.oncomplete = resolve;
            clearTx.onerror = () => reject(clearTx.error);
        });

        console.log('[Sync] Cleared existing data');

        // Second transaction: add new data
        const addTx = db.transaction(['dashboards', 'projects', 'tiles'], 'readwrite');
        for (const d of dashboards) addTx.objectStore('dashboards').put(d);
        for (const p of projects) addTx.objectStore('projects').put(p);
        for (const t of tiles) addTx.objectStore('tiles').put(t);

        await new Promise((resolve, reject) => {
            addTx.oncomplete = resolve;
            addTx.onerror = () => reject(addTx.error);
        });

        console.log('[Sync] Imported to IndexedDB:', {
            dashboards: dashboards.length,
            projects: projects.length,
            tiles: tiles.length
        });
    }

    /**
     * Schedule a sync (debounced)
     */
    function scheduleSync() {
        if (!syncEnabled) return;
        if (debounceTimer) clearTimeout(debounceTimer);

        debounceTimer = setTimeout(async () => {
            debounceTimer = null;
            const data = await getLocalData();
            const result = await pushToSync(data);
            window.dispatchEvent(new CustomEvent('lifetiles-sync', {
                detail: { type: 'sync_complete', ...result }
            }));
        }, DEBOUNCE_MS);
    }

    /**
     * Listen for remote changes
     */
    function startListening() {
        if (!chrome?.storage?.onChanged) return;

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'sync') return;
            if (changes[`${SYNC_KEY}_n`] || changes[`${SYNC_KEY}_0`]) {
                // Ignore our own changes (within ignore window after push)
                const timeSincePush = Date.now() - lastPushTime;
                if (timeSincePush < IGNORE_WINDOW_MS) {
                    console.log(`[Sync] Ignoring onChanged (our own push ${timeSincePush}ms ago)`);
                    return;
                }

                console.log('[Sync] Remote change detected, pulling...');
                pullFromSync().then(result => {
                    if (result.imported) {
                        window.dispatchEvent(new CustomEvent('lifetiles-sync', {
                            detail: { type: 'remote_update', ...result }
                        }));
                    }
                });
            }
        });
    }

    /**
     * Get sync status
     */
    async function getStatus() {
        if (!syncEnabled) return { enabled: false };
        try {
            const bytes = await new Promise(r => chrome.storage.sync.getBytesInUse(null, r));
            const percentUsed = Math.round((bytes / QUOTA_BYTES) * 100);
            const quotaStatus = percentUsed >= 95 ? 'critical' : percentUsed >= 80 ? 'warning' : 'ok';
            return {
                enabled: true,
                bytesUsed: bytes,
                bytesTotal: QUOTA_BYTES,
                percentUsed,
                quotaStatus,
                lastSynced: lastSyncedTimestamp
            };
        } catch (e) {
            return { enabled: false, error: e.message };
        }
    }

    /**
     * Force sync now
     */
    async function forceSync() {
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        const data = await getLocalData();
        return await pushToSync(data);
    }

    /**
     * Reset sync
     */
    async function resetSync() {
        try {
            const keys = await getSyncStorage(null);
            const syncKeys = Object.keys(keys).filter(k => k.startsWith(SYNC_KEY));
            if (syncKeys.length > 0) {
                await new Promise(r => chrome.storage.sync.remove(syncKeys, r));
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // Helpers
    function getSyncStorage(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.get(keys, result => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(result);
            });
        });
    }

    function setSyncStorage(data) {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.set(data, () => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve();
            });
        });
    }

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
