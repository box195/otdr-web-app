/**
 * OTDR PRO 5.0 - Client-side IndexedDB Storage & Offline Bundle Cache
 * Enables 100% serverless execution on GitHub Pages without Python backend.
 * Caches all 383 .SOR binary traces into browser IndexedDB for instant 1ms loading.
 */

(function (global) {
  'use strict';

  const DB_NAME = 'OTDR_DATABASE';
  const DB_VERSION = 1;
  const STORE_NAME = 'sor_blobs';
  const BUNDLE_PATH = 'data/sor_bundle.bin';
  const TOTAL_EXPECTED_FILES = 383;

  let dbInstance = null;
  let isReady = false;
  let isDownloadingBundle = false;
  const readyCallbacks = [];
  const progressCallbacks = [];

  // 1. Open Database
  function openDB() {
    return new Promise((resolve, reject) => {
      if (dbInstance) {
        resolve(dbInstance);
        return;
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('rel_path', 'rel_path', { unique: false });
          store.createIndex('filename', 'filename', { unique: false });
        }
      };

      req.onsuccess = function (e) {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };

      req.onerror = function (e) {
        console.error('IndexedDB open error:', e);
        reject(e.target.error);
      };
    });
  }

  // 2. Count Cached Files
  function getCachedCount() {
    return new Promise(async (resolve) => {
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const countReq = store.count();
        countReq.onsuccess = () => resolve(countReq.result);
        countReq.onerror = () => resolve(0);
      } catch (err) {
        resolve(0);
      }
    });
  }

  // 3. Unpack sor_bundle.bin ArrayBuffer into records
  function unpackBundle(arrayBuffer) {
    const dataView = new DataView(arrayBuffer);
    const magic = String.fromCharCode(
      dataView.getUint8(0), dataView.getUint8(1), dataView.getUint8(2), dataView.getUint8(3),
      dataView.getUint8(4), dataView.getUint8(5), dataView.getUint8(6), dataView.getUint8(7)
    );

    if (magic !== 'OTDRBND1') {
      throw new Error('Invalid bundle magic: ' + magic);
    }

    const numFiles = dataView.getUint32(8, true);
    const tocLen = dataView.getUint32(12, true);

    const tocBytes = new Uint8Array(arrayBuffer, 16, tocLen);
    const tocJson = new TextDecoder('utf-8').decode(tocBytes);
    const tocList = JSON.parse(tocJson);

    const payloadStart = 16 + tocLen;
    const records = [];

    for (let i = 0; i < tocList.length; i++) {
      const item = tocList[i];
      const start = payloadStart + item.offset;
      const fileBytes = arrayBuffer.slice(start, start + item.size);
      records.push({
        id: item.id,
        rel_path: item.rel_path,
        filename: item.filename,
        size: item.size,
        data: fileBytes
      });
    }

    return records;
  }

  // 4. Store Records Batch into IndexedDB
  function saveRecordsBatch(records) {
    return new Promise(async (resolve, reject) => {
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        tx.oncomplete = () => resolve(records.length);
        tx.onerror = (e) => reject(e.target.error);

        for (let i = 0; i < records.length; i++) {
          store.put(records[i]);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  // 5. Download and Cache Bundle
  async function downloadAndCacheBundle() {
    if (isDownloadingBundle) return;
    isDownloadingBundle = true;

    try {
      console.log('⚡ [IndexedDB] sor_bundle.bin 다운로드 시작...');
      notifyProgress(0.1, '선로 데이터 번들 다운로드 중...');

      const response = await fetch(BUNDLE_PATH);
      if (!response.ok) {
        throw new Error('번들 다운로드 실패: HTTP ' + response.status);
      }

      notifyProgress(0.5, '바이너리 데이터 패키지 수신 완료, 캐시 추출 중...');
      const buffer = await response.arrayBuffer();

      notifyProgress(0.8, '383개 광선로 파형 IndexedDB 캐시 적재 중...');
      const records = unpackBundle(buffer);
      await saveRecordsBatch(records);

      isReady = true;
      console.log(`⚡ [IndexedDB] 383개 .SOR 파형 전체 캐시 완료! (총 ${records.length}개 파일 저장됨)`);
      notifyProgress(1.0, `캐시 완료 (${records.length} Files)`);
      notifyReady();
    } catch (err) {
      console.warn('⚠️ [IndexedDB] 번들 자동 캐시 실패 (개별 파일 직접 로딩 모드로 동작):', err);
      notifyProgress(-1, '번들 캐시 실패 (개별 요청 모드)');
    } finally {
      isDownloadingBundle = false;
    }
  }

  // 6. Main Storage Initialization
  async function init() {
    try {
      await openDB();
      const count = await getCachedCount();
      console.log(`⚡ [IndexedDB] 스토리지 초기화 완료. 현재 캐시된 파일 수: ${count} / ${TOTAL_EXPECTED_FILES}`);

      if (count >= TOTAL_EXPECTED_FILES) {
        isReady = true;
        notifyProgress(1.0, `캐시 완료 (${count} Files)`);
        notifyReady();
      } else {
        // Automatically download bundle in background
        downloadAndCacheBundle();
      }
    } catch (err) {
      console.error('IndexedDB init error:', err);
    }
  }

  // 7. Get File ArrayBuffer (Fast Cache Lookup -> Static File Fetch fallback)
  async function getSorBuffer(id, relPath) {
    // 1. Check IndexedDB
    try {
      const db = await openDB();
      const record = await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });

      if (record && record.data) {
        return record.data;
      }
    } catch (e) {
      console.warn('IndexedDB read error for id:', id, e);
    }

    // 2. Fallback: Fetch static individual file from data/
    if (relPath) {
      const normalizedPath = relPath.replace(/\\/g, '/');
      const staticUrl = `data/${normalizedPath}`;
      try {
        const res = await fetch(staticUrl);
        if (res.ok) {
          const ab = await res.arrayBuffer();
          cacheSingleFile(id, relPath, ab);
          return ab;
        }
      } catch (fetchErr) {
        console.warn('Static file fetch failed for:', staticUrl, fetchErr);
      }
    }

    // 3. Fallback: Local python server API if running on http server
    if (typeof window !== 'undefined' && window.location.protocol.startsWith('http') && relPath) {
      try {
        const apiUrl = `/api/file?path=${encodeURIComponent(relPath)}`;
        const res = await fetch(apiUrl);
        if (res.ok) {
          const ab = await res.arrayBuffer();
          cacheSingleFile(id, relPath, ab);
          return ab;
        }
      } catch (apiErr) {
        console.warn('API file fetch failed:', apiErr);
      }
    }

    throw new Error(`파일 바이너리를 불러올 수 없습니다: ${relPath || id}`);
  }

  // Helper to cache a single file
  async function cacheSingleFile(id, relPath, arrayBuffer) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const filename = relPath.split('/').pop().split('\\').pop();
      store.put({
        id: id,
        rel_path: relPath,
        filename: filename,
        size: arrayBuffer.byteLength,
        data: arrayBuffer
      });
    } catch (e) {
      // Ignore cache error
    }
  }

  function notifyReady() {
    readyCallbacks.forEach(cb => cb());
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('otdr-idb-ready', { detail: { count: TOTAL_EXPECTED_FILES } }));
    }
  }

  function notifyProgress(pct, statusText) {
    progressCallbacks.forEach(cb => cb(pct, statusText));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('otdr-idb-progress', { detail: { pct, statusText } }));
    }
  }

  // Export module
  global.OtdrIdbStorage = {
    init,
    openDB,
    getCachedCount,
    getSorBuffer,
    isReady: () => isReady,
    onReady: (cb) => {
      if (isReady) cb();
      else readyCallbacks.push(cb);
    },
    onProgress: (cb) => {
      progressCallbacks.push(cb);
    }
  };

  // Auto-init on script load
  if (typeof window !== 'undefined') {
    init();
  }

})(typeof window !== 'undefined' ? window : this);
