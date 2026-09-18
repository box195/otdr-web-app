/**
 * OTDR PRO 5.0 - Main Application Controller
 * Connects SorParser, WaveformEngine, Diagnostics, and DatasetIndex
 */

(function () {
  'use strict';

  let currentParsedData = null;
  let currentFileMeta = null;
  let waveformEngine = null;
  let activeFilter = 'all';

  // DOM Elements
  const traceCanvas = document.getElementById('traceCanvas');
  const fileTreeContainer = document.getElementById('fileTreeContainer');
  const searchInput = document.getElementById('searchInput');
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');

  // Header Telemetry Elements
  const chipWavelength = document.getElementById('chipWavelength');
  const chipLength = document.getElementById('chipLength');
  const chipTotalLoss = document.getElementById('chipTotalLoss');
  const chipLossRate = document.getElementById('chipLossRate');
  const chipOrl = document.getElementById('chipOrl');
  const chipVerdict = document.getElementById('chipVerdict');

  // Marker Telemetry Elements
  const markerADist = document.getElementById('markerADist');
  const markerADb = document.getElementById('markerADb');
  const markerBDist = document.getElementById('markerBDist');
  const markerBDb = document.getElementById('markerBDb');
  const deltaDistKm = document.getElementById('deltaDistKm');
  const deltaDistM = document.getElementById('deltaDistM');
  const deltaLossDb = document.getElementById('deltaLossDb');
  const deltaSlopeRate = document.getElementById('deltaSlopeRate');

  // Sidebar Tabs & Content
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  // Diagnostics DOM
  const scoreGaugeRing = document.getElementById('scoreGaugeRing');
  const scoreVerdict = document.getElementById('scoreVerdict');
  const scoreGrade = document.getElementById('scoreGrade');
  const diagAlertsContainer = document.getElementById('diagAlertsContainer');
  const macrobendContainer = document.getElementById('macrobendContainer');
  const recommendationsList = document.getElementById('recommendationsList');
  const eventTableBody = document.getElementById('eventTableBody');

  // Metadata Grid Elements
  const metaOtdrModel = document.getElementById('metaOtdrModel');
  const metaOtdrSn = document.getElementById('metaOtdrSn');
  const metaDateTime = document.getElementById('metaDateTime');
  const metaIor = document.getElementById('metaIor');
  const metaPulse = document.getElementById('metaPulse');
  const metaAvgTime = document.getElementById('metaAvgTime');
  const metaBc = document.getElementById('metaBc');
  const metaFiberType = document.getElementById('metaFiberType');
  const metaSwVersion = document.getElementById('metaSwVersion');

  // Report Modal Elements
  const reportModal = document.getElementById('reportModal');
  const btnExportReport = document.getElementById('btnExportReport');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const btnCancelModal = document.getElementById('btnCancelModal');
  const btnPrintReport = document.getElementById('btnPrintReport');

  // Initialize
  function init() {
    initWaveformEngine();
    initDatasetTree();
    initKeyboardNavigation();
    initFilters();
    initDragAndDrop();
    initToolbar();
    initTabs();
    initReportModal();

    // Sync initial toolbar mode from engine/localStorage
    const initialMode = waveformEngine ? waveformEngine.viewMode : 'fiber';
    const btnFitFiber = document.getElementById('btnFitFiber');
    const btnResetView = document.getElementById('btnResetView');
    const btnLockZoom = document.getElementById('btnLockZoom');
    if (btnFitFiber && btnResetView) {
      btnFitFiber.classList.toggle('active', initialMode === 'fiber');
      btnResetView.classList.toggle('active', initialMode === 'full');
      if (btnLockZoom) btnLockZoom.classList.toggle('active', initialMode === 'locked');
    }

    // Initialize IndexedDB Cache Status Badge
    initIdbBadge();

    // Auto-load first sample file if available
    autoLoadInitialSample();
  }

  // Keyboard navigation for file items (ArrowUp / ArrowDown)
  function initKeyboardNavigation() {
    window.addEventListener('keydown', (e) => {
      // Ignore if typing inside searchInput or textarea
      if (e.target && (e.target.id === 'searchInput' || e.target.tagName === 'TEXTAREA')) {
        return;
      }

      const reportModal = document.getElementById('reportModal');
      if (reportModal && reportModal.classList.contains('open')) {
        return;
      }

      // Spacebar toggle for overlay checkbox of active file
      const isSpace = e.key === ' ' || e.code === 'Space';
      if (isSpace) {
        const currentActive = fileTreeContainer.querySelector('.file-item.active');
        if (currentActive) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          const cb = currentActive.querySelector('.file-overlay-checkbox');
          if (cb) {
            cb.checked = !cb.checked;
            const id = cb.dataset.id;
            const rel = cb.dataset.rel;
            handleToggleOverlay(id, rel, cb.checked);
          }
          return;
        }
      }

      const isDown = e.key === 'ArrowDown' || e.code === 'ArrowDown';
      const isUp = e.key === 'ArrowUp' || e.code === 'ArrowUp';

      if (isDown || isUp) {
        const allFiles = Array.from(fileTreeContainer.querySelectorAll('.file-item'));
        if (allFiles.length === 0) return;

        // Prevent default browser scrolling with highest priority
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // If searchInput has focus, blur it
        if (searchInput && document.activeElement === searchInput) {
          searchInput.blur();
        }

        // Get visible files (those whose parent branch-group is open, or in flat list)
        const visibleFiles = allFiles.filter(el => {
          const bg = el.closest('.branch-group');
          return !bg || bg.classList.contains('open');
        });

        const listToUse = visibleFiles.length > 0 ? visibleFiles : allFiles;
        const currentActive = fileTreeContainer.querySelector('.file-item.active');
        let currentIndex = currentActive ? listToUse.indexOf(currentActive) : -1;

        let targetItem = null;

        if (isDown) {
          if (currentIndex === -1) {
            targetItem = listToUse[0];
          } else if (currentIndex + 1 < listToUse.length) {
            targetItem = listToUse[currentIndex + 1];
          } else {
            // At the end of open items, try opening next branch group if available
            const rawIdx = allFiles.indexOf(currentActive);
            if (rawIdx !== -1 && rawIdx + 1 < allFiles.length) {
              const nextEl = allFiles[rawIdx + 1];
              const parentBranch = nextEl.closest('.branch-group');
              if (parentBranch) parentBranch.classList.add('open');
              targetItem = nextEl;
            } else {
              targetItem = listToUse[listToUse.length - 1];
            }
          }
        } else if (isUp) {
          if (currentIndex === -1) {
            targetItem = listToUse[0];
          } else if (currentIndex - 1 >= 0) {
            targetItem = listToUse[currentIndex - 1];
          } else {
            // At the top of open items, try navigating to previous in allFiles
            const rawIdx = allFiles.indexOf(currentActive);
            if (rawIdx !== -1 && rawIdx - 1 >= 0) {
              const prevEl = allFiles[rawIdx - 1];
              const parentBranch = prevEl.closest('.branch-group');
              if (parentBranch) parentBranch.classList.add('open');
              targetItem = prevEl;
            } else {
              targetItem = listToUse[0];
            }
          }
        }

        if (targetItem) {
          const parentGroup = targetItem.closest('.branch-group');
          if (parentGroup && !parentGroup.classList.contains('open')) {
            parentGroup.classList.add('open');
          }
          
          allFiles.forEach(f => f.classList.remove('active'));
          targetItem.classList.add('active');
          targetItem.setAttribute('tabindex', '-1');
          targetItem.focus();

          const id = targetItem.dataset.id;
          const rel = targetItem.dataset.rel;
          loadFileById(id, rel);

          targetItem.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
      }
    }, true); // useCapture: true to preempt native scroll
  }

  // 1. Initialize Waveform Engine
  function initWaveformEngine() {
    waveformEngine = new OtdrWaveformEngine(traceCanvas, {
      onMarkerChange: handleMarkerChange,
      onHoverEvent: handleHoverEvent
    });

    window.addEventListener('resize', () => {
      waveformEngine.resize();
    });
  }

  // 2. Handle Marker Telemetry Updates
  function handleMarkerChange(data) {
    markerADist.textContent = `${data.markerA.km.toFixed(3)} km`;
    markerADb.textContent = `${data.markerA.db.toFixed(2)} dB`;
    markerBDist.textContent = `${data.markerB.km.toFixed(3)} km`;
    markerBDb.textContent = `${data.markerB.db.toFixed(2)} dB`;

    deltaDistKm.textContent = `${data.deltaDistKm.toFixed(3)} km`;
    deltaDistM.textContent = `(${data.deltaDistM.toFixed(0)} m)`;
    deltaLossDb.textContent = `${data.deltaLossDb.toFixed(2)} dB`;
    deltaSlopeRate.textContent = `${data.lossRateDbPerKm.toFixed(3)} dB/km`;

    if (data.lossRateDbPerKm > 0.38) {
      deltaSlopeRate.style.color = 'var(--accent-crimson)';
    } else if (data.lossRateDbPerKm > 0.30) {
      deltaSlopeRate.style.color = 'var(--accent-amber)';
    } else {
      deltaSlopeRate.style.color = 'var(--accent-green)';
    }
  }

  function handleHoverEvent(event) {
    // If hovering over an event, highlight corresponding row in table
    const rows = eventTableBody.querySelectorAll('tr');
    rows.forEach(r => r.classList.remove('active-event'));

    if (event) {
      const targetRow = eventTableBody.querySelector(`tr[data-event-num="${event.eventNumber}"]`);
      if (targetRow) {
        targetRow.classList.add('active-event');
        targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  // 3. Initialize Dataset Tree
  function initDatasetTree() {
    const dataIndex = window.OTDR_DATASET_INDEX || window.DATASET_INDEX;
    if (dataIndex && dataIndex.items && dataIndex.items.length > 0) {
      renderTree(dataIndex.items);
      return;
    }

    // Safe fallback via HTTP fetch
    fetch('dataset_index.json')
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(data => {
        window.OTDR_DATASET_INDEX = window.DATASET_INDEX = data;
        renderTree(data.items);
        if (!currentParsedData) {
          autoLoadInitialSample();
        }
      })
      .catch(err => {
        console.error('Failed to load dataset index:', err);
        fileTreeContainer.innerHTML = '<div style="padding: 14px; color: var(--accent-crimson); font-size: 12px; line-height: 1.5;">데이터셋 인덱스를 불러올 수 없습니다.<br><button onclick="location.reload()" class="btn btn-sm" style="margin-top: 8px;">새로고침 (F5)</button></div>';
      });
  }

  function updateFilterCounts(items) {
    const cAll = items.length;
    const cPass = items.filter(it => it.status === 'pass').length;
    const cSpliceWarn = items.filter(it => it.status === 'splice_warn' || it.status === 'warn').length;
    const cSpliceRisk = items.filter(it => it.status === 'splice_risk').length;
    const cBending = items.filter(it => it.status === 'bending').length;
    const cDefect = items.filter(it => it.status === 'defect').length;
    const cUnclass = items.filter(it => it.status === 'unclassified').length;

    const elAll = document.getElementById('countAll');
    const elPass = document.getElementById('countPass');
    const elSpliceWarn = document.getElementById('countSpliceWarn');
    const elSpliceRisk = document.getElementById('countSpliceRisk');
    const elBending = document.getElementById('countBending');
    const elDefect = document.getElementById('countDefect');
    const elUnclass = document.getElementById('countUnclass');
    const badge = document.getElementById('batchCountBadge');

    if (elAll) elAll.textContent = cAll;
    if (elPass) elPass.textContent = cPass;
    if (elSpliceWarn) elSpliceWarn.textContent = cSpliceWarn;
    if (elSpliceRisk) elSpliceRisk.textContent = cSpliceRisk;
    if (elBending) elBending.textContent = cBending;
    if (elDefect) elDefect.textContent = cDefect;
    if (elUnclass) elUnclass.textContent = cUnclass;
    if (badge) badge.textContent = `${cAll} Files`;
  }

  function renderTree(items) {
    updateFilterCounts(items);
    const filterQuery = searchInput.value.trim().toLowerCase();

    // Helper for status pill class
    function getItemPillClass(item) {
      if (item.status === 'pass') return 'pill-pass';
      if (item.status === 'splice_warn' || item.status === 'warn') return 'pill-splice_warn';
      if (item.status === 'splice_risk') return 'pill-splice_risk';
      if (item.status === 'bending') return 'pill-bending';
      if (item.status === 'defect') return 'pill-defect';
      if (item.status === 'unclassified') return 'pill-unclassified';
      return 'pill-pass';
    }

    // Filter items
    const filtered = items.filter(item => {
      // Status filter
      if (activeFilter === 'pass' && item.status !== 'pass') return false;
      if (activeFilter === 'splice_warn' && item.status !== 'splice_warn' && item.status !== 'warn') return false;
      if (activeFilter === 'splice_risk' && item.status !== 'splice_risk') return false;
      if (activeFilter === 'bending' && item.status !== 'bending') return false;
      if (activeFilter === 'defect' && item.status !== 'defect') return false;
      if (activeFilter === 'unclassified' && item.status !== 'unclassified') return false;

      // Text filter
      if (filterQuery) {
        const matchName = item.filename.toLowerCase().includes(filterQuery);
        const matchBranch = item.branch.toLowerCase().includes(filterQuery);
        const matchFolder = (item.subfolder || '').toLowerCase().includes(filterQuery);
        return matchName || matchBranch || matchFolder;
      }
      return true;
    });

    if (filtered.length === 0) {
      fileTreeContainer.innerHTML = '<div style="padding: 14px; color: var(--text-dim); text-align: center;">일치하는 측정 파일이 없습니다.</div>';
      return;
    }

    let html = '';

    if (activeFilter === 'all') {
      // Group by branch with folder accordion (sorted by filename inside each branch)
      const groups = {};
      filtered.forEach(item => {
        if (!groups[item.branch]) {
          groups[item.branch] = [];
        }
        groups[item.branch].push(item);
      });

      const branchNames = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ko'));
      branchNames.forEach((bName, idx) => {
        const bItems = groups[bName];
        // Sort files alphabetically/numerically by filename
        bItems.sort((a, b) => a.filename.localeCompare(b.filename, 'ko', { numeric: true }));

        const isOpen = idx === 0 || filterQuery.length > 0;

        html += `
          <div class="branch-group ${isOpen ? 'open' : ''}" data-branch="${bName}">
            <div class="branch-header" onclick="this.parentElement.classList.toggle('open')">
              <span class="branch-name">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                ${bName}
              </span>
              <span class="branch-count">${bItems.length}</span>
            </div>
            <div class="branch-files">
              ${bItems.map(item => {
                let lenBadge = item.length_km > 0 ? `${item.length_km}km` : '';
                return `
                <div class="file-item" data-id="${item.id}" data-rel="${item.rel_path}">
                  <div style="display: flex; align-items: center; gap: 4px; overflow: hidden;">
                    <input type="checkbox" class="file-overlay-checkbox" data-id="${item.id}" data-rel="${item.rel_path}" title="비교 파형으로 겹쳐보기" ${waveformEngine && waveformEngine.overlayTraces.has(item.id) ? 'checked' : ''} />
                    <span class="file-item-pill ${getItemPillClass(item)}"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${item.status_reason || item.filename}">${item.filename}</span>
                  </div>
                  <span style="font-size: 10px; color: var(--text-dim);">${lenBadge}</span>
                </div>
              `}).join('')}
            </div>
          </div>
        `;
      });
    } else {
      // Flat list for filtered tabs (이름순 정렬, 폴더 없이 전체 직접 표시)
      filtered.sort((a, b) => a.filename.localeCompare(b.filename, 'ko', { numeric: true }));

      let filterLabel = '전체';
      if (activeFilter === 'pass') filterLabel = '정상 심선 (시방서 적합)';
      else if (activeFilter === 'splice_warn' || activeFilter === 'warn') filterLabel = '주의 심선 (접속손실 점검)';
      else if (activeFilter === 'splice_risk') filterLabel = '접속위험 심선 (시방서 위반 재시공)';
      else if (activeFilter === 'bending') filterLabel = '벤딩 심선 (심선 꺾임/곡률반경 미달)';
      else if (activeFilter === 'defect') filterLabel = '불량 심선 (치명적 결함/재시공)';
      else if (activeFilter === 'unclassified') filterLabel = '미분류 심선 (검토 대상)';

      html += `
        <div style="padding: 8px 12px; font-size: 11px; color: var(--text-dim); border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
          <span>${filterLabel} ${filtered.length}개 (이름순)</span>
          <span style="font-size: 10px; opacity: 0.7;">단일 목록</span>
        </div>
        <div class="file-list-flat">
          ${filtered.map(item => {
            let lenBadge = item.length_km > 0 ? `${item.length_km}km` : '';
            return `
            <div class="file-item" data-id="${item.id}" data-rel="${item.rel_path}">
              <div style="display: flex; align-items: center; gap: 4px; overflow: hidden;">
                <input type="checkbox" class="file-overlay-checkbox" data-id="${item.id}" data-rel="${item.rel_path}" title="비교 파형으로 겹쳐보기" ${waveformEngine && waveformEngine.overlayTraces.has(item.id) ? 'checked' : ''} />
                <span class="file-item-pill ${getItemPillClass(item)}"></span>
                <div style="display: flex; flex-direction: column; overflow: hidden; min-width: 0;">
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500;" title="${item.status_reason || item.filename}">${item.filename}</span>
                  <span style="font-size: 10px; color: var(--text-dim); opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.branch}</span>
                </div>
              </div>
              <span style="font-size: 10px; color: var(--text-dim); flex-shrink: 0;">${lenBadge}</span>
            </div>
          `}).join('')}
        </div>
      `;
    }

    fileTreeContainer.innerHTML = html;

    // Attach click handlers on file items
    const fileElements = fileTreeContainer.querySelectorAll('.file-item');
    fileElements.forEach(el => {
      el.addEventListener('click', (e) => {
        // If clicking on the checkbox itself, don't trigger main file load
        if (e.target.classList.contains('file-overlay-checkbox')) return;
        if (searchInput) searchInput.blur();
        fileElements.forEach(f => f.classList.remove('active'));
        el.classList.add('active');
        el.setAttribute('tabindex', '-1');
        el.focus();
        const id = el.dataset.id;
        const rel = el.dataset.rel;
        loadFileById(id, rel);
      });
    });

    // Attach change handlers on overlay checkboxes
    const checkboxes = fileTreeContainer.querySelectorAll('.file-overlay-checkbox');
    checkboxes.forEach(cb => {
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const id = cb.dataset.id;
        const rel = cb.dataset.rel;
        handleToggleOverlay(id, rel, cb.checked);
      });
    });
  }

  // 4. File Loading Strategy (IndexedDB Cache -> Static data/ fetch -> Embedded Base64 / Local Server)
  async function loadFileById(id, relPath) {
    const dataIndex = window.OTDR_DATASET_INDEX || window.DATASET_INDEX;
    const itemMeta = dataIndex && dataIndex.items ? dataIndex.items.find(it => it.id === id) : null;
    currentFileMeta = itemMeta;
    const fname = itemMeta ? itemMeta.filename : '측정파일.SOR';

    // 1. Check IndexedDB storage (Primary: 0~1ms instant retrieval)
    if (window.OtdrIdbStorage) {
      try {
        const buffer = await window.OtdrIdbStorage.getSorBuffer(id, relPath);
        if (buffer) {
          processSorBuffer(buffer, fname);
          return;
        }
      } catch (idbErr) {
        console.warn('IndexedDB buffer load error, falling back:', idbErr);
      }
    }

    // 2. Check if embedded in Base64
    if (dataIndex && dataIndex.embedded_samples && dataIndex.embedded_samples[id]) {
      const base64 = dataIndex.embedded_samples[id].base64;
      const arrayBuffer = base64ToArrayBuffer(base64);
      processSorBuffer(arrayBuffer, fname);
      return;
    }

    // 3. Fallback: Fetch static individual file from data/
    if (relPath) {
      const staticUrl = `data/${relPath.replace(/\\/g, '/')}`;
      try {
        const res = await fetch(staticUrl);
        if (res.ok) {
          const ab = await res.arrayBuffer();
          processSorBuffer(ab, fname);
          return;
        }
      } catch (e) {
        // Continue to server fallback
      }
    }

    // 4. Fallback: Local python server if running on http
    if (window.location.protocol.startsWith('http') && relPath) {
      const apiUrl = `/api/file?path=${encodeURIComponent(relPath)}`;
      fetch(apiUrl)
        .then(res => {
          if (!res.ok) throw new Error('서버 응답 오류: ' + res.status);
          return res.arrayBuffer();
        })
        .then(buffer => {
          processSorBuffer(buffer, fname);
        })
        .catch(err => {
          console.warn('API fetch failed:', err);
          showToast('해당 파일의 바이너리를 로드하려면 상단 [파일 열기]로 선택해주세요.', 'warning');
        });
    } else {
      showToast(`[${fname}]을 로드하려면 [파일 열기] 버튼으로 해당 파일을 선택해주세요.`, 'info');
    }
  }

  function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Multi-Trace Overlay Handlers (다중 파형 겹쳐보기)
  async function handleToggleOverlay(id, relPath, isAdd) {
    if (!isAdd) {
      waveformEngine.removeOverlayTrace(id);
      updateOverlayControlBar();
      return;
    }

    const dataIndex = window.OTDR_DATASET_INDEX || window.DATASET_INDEX;
    const itemMeta = dataIndex && dataIndex.items ? dataIndex.items.find(it => it.id === id) : null;
    const fname = itemMeta ? itemMeta.filename : '비교파형';

    try {
      let buffer = null;
      if (window.OtdrIdbStorage) {
        buffer = await window.OtdrIdbStorage.getSorBuffer(id, relPath);
      } else if (dataIndex && dataIndex.embedded_samples && dataIndex.embedded_samples[id]) {
        buffer = base64ToArrayBuffer(dataIndex.embedded_samples[id].base64);
      } else if (relPath) {
        const res = await fetch(`data/${relPath.replace(/\\/g, '/')}`);
        if (res.ok) buffer = await res.arrayBuffer();
      }

      if (buffer) {
        const parsed = SorParser.parse(buffer);
        const color = waveformEngine.addOverlayTrace(id, fname, parsed);
        updateOverlayControlBar();
        showToast(`[${fname}] 비교 파형 추가됨`, 'info');
        return;
      }
    } catch (e) {
      console.warn('Overlay load error:', e);
    }

    // Fallback to local server if available
    if (window.location.protocol.startsWith('http') && relPath) {
      const apiUrl = `/api/file?path=${encodeURIComponent(relPath)}`;
      fetch(apiUrl)
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.arrayBuffer();
        })
        .then(buffer => {
          const parsed = SorParser.parse(buffer);
          const color = waveformEngine.addOverlayTrace(id, fname, parsed);
          updateOverlayControlBar();
          showToast(`[${fname}] 비교 파형 추가됨`, 'info');
        })
        .catch(err => {
          console.error('Failed to load overlay trace:', err);
          showToast('해당 파일 바이너리를 불러올 수 없습니다.', 'warning');
          const cb = fileTreeContainer.querySelector(`.file-overlay-checkbox[data-id="${id}"]`);
          if (cb) cb.checked = false;
        });
    } else {
      showToast(`로컬 파일 비교는 상단 [파일 열기]로 추가해주세요.`, 'info');
      const cb = fileTreeContainer.querySelector(`.file-overlay-checkbox[data-id="${id}"]`);
      if (cb) cb.checked = false;
    }
  }

  function updateOverlayControlBar() {
    const bar = document.getElementById('overlayControlBar');
    const container = document.getElementById('overlayChipsContainer');
    if (!bar || !container) return;

    if (!waveformEngine || waveformEngine.overlayTraces.size === 0) {
      bar.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    bar.style.display = 'flex';
    let html = '';
    for (const [id, item] of waveformEngine.overlayTraces.entries()) {
      html += `
        <div class="overlay-chip" style="border-color: ${item.color}80;">
          <span class="overlay-chip-dot" style="background: ${item.color}; box-shadow: 0 0 6px ${item.color};"></span>
          <span style="font-weight: 500;">${item.name}</span>
          <span class="overlay-chip-close" data-id="${id}" title="비교 해제">✕</span>
        </div>
      `;
    }
    container.innerHTML = html;

    // Attach click to close buttons
    container.querySelectorAll('.overlay-chip-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.id;
        waveformEngine.removeOverlayTrace(targetId);
        const cb = fileTreeContainer.querySelector(`.file-overlay-checkbox[data-id="${targetId}"]`);
        if (cb) cb.checked = false;
        updateOverlayControlBar();
      });
    });
  }

  // Process and render parsed SOR
  function processSorBuffer(arrayBuffer, filename = 'OTDR_Trace.SOR') {
    try {
      const parsed = SorParser.parse(arrayBuffer);
      currentParsedData = parsed;

      // Update Waveform Canvas
      waveformEngine.loadTrace(parsed);

      // Sync viewMode switch buttons to current engine state
      const btnFitFiber = document.getElementById('btnFitFiber');
      const btnResetView = document.getElementById('btnResetView');
      const btnLockZoom = document.getElementById('btnLockZoom');
      if (btnFitFiber && btnResetView) {
        const mode = waveformEngine.viewMode || 'fiber';
        btnFitFiber.classList.toggle('active', mode === 'fiber');
        btnResetView.classList.toggle('active', mode === 'full');
        if (btnLockZoom) btnLockZoom.classList.toggle('active', mode === 'locked');
      }

      // Run Diagnostics
      const diagResult = Diagnostics.analyze(parsed);

      // Check if this file is in dataIndex, if not add it dynamically
      const dataIndex = window.OTDR_DATASET_INDEX || window.DATASET_INDEX;
      if (dataIndex && dataIndex.items) {
        let existing = dataIndex.items.find(it => it.filename === filename || (currentFileMeta && it.id === currentFileMeta.id));
        if (!existing) {
          const newId = `upload_${Date.now()}`;
          existing = {
            id: newId,
            rel_path: filename,
            branch: "신규 업로드",
            subfolder: "신규 업로드",
            filename: filename,
            size: arrayBuffer.byteLength,
            wavelength: parsed.summary.wavelength,
            pulse_width: parsed.summary.pulseWidth,
            length_km: parsed.summary.fiberLengthKm,
            total_loss: parsed.summary.totalLossDb,
            loss_rate: parsed.summary.avgLossRate,
            events_count: (parsed.keyEvents && parsed.keyEvents.events) ? parsed.keyEvents.events.length : 0,
            status: diagResult.status,
            status_reason: (diagResult.defects && diagResult.defects[0]) || (diagResult.warnings && diagResult.warnings[0]) || diagResult.overallVerdict
          };
          dataIndex.items.unshift(existing);
          currentFileMeta = existing;
          renderTree(dataIndex.items);
        } else if (!currentFileMeta) {
          currentFileMeta = existing;
        }
      }

      // Update UI components
      updateHeaderTelemetry(parsed, diagResult, filename);
      updateCanvasActiveFileBadge(parsed, diagResult, filename);
      updateDiagnosticsPanel(diagResult);
      updateEventTable(parsed, diagResult);
      updateMetadataGrid(parsed);

      showToast(`'${filename}' 파형 분석 완료`, 'success');
    } catch (e) {
      console.error('SOR 파싱 실패:', e);
      alert('SOR 파일 파싱 중 오류가 발생했습니다: ' + e.message);
    }
  }

  // 5. Update Header Telemetry
  function updateHeaderTelemetry(parsed, diag, filename) {
    const sum = parsed.summary;

    chipWavelength.textContent = `${sum.wavelength} nm`;
    chipLength.textContent = `${sum.fiberLengthKm.toFixed(3)} km`;
    if (sum.isEndAdjusted) {
      chipLength.title = `실선로 종단 거리: ${sum.fiberLengthKm.toFixed(3)} km (헤더 기록치: ${sum.rawLengthKm.toFixed(3)} km)`;
    } else {
      chipLength.title = `선로 종단 거리: ${sum.fiberLengthKm.toFixed(3)} km`;
    }
    chipTotalLoss.textContent = `${sum.totalLossDb.toFixed(2)} dB`;
    chipLossRate.textContent = `${sum.avgLossRate.toFixed(3)} dB/km`;
    chipOrl.textContent = `${sum.orlDb.toFixed(1)} dB`;

    // Loss rate highlight class
    chipLossRate.className = 'telemetry-val ' + (
      sum.avgLossRate <= 0.30 ? 'highlight-green' : (sum.avgLossRate <= 0.38 ? 'highlight-amber' : 'highlight-crimson')
    );

    // Quality verdict badge (Consistent 6-state grading)
    const itemStatus = (currentFileMeta && currentFileMeta.status) || diag.status;
    const reason = (currentFileMeta && currentFileMeta.status_reason) || (diag.defects && diag.defects[0]) || (diag.risks && diag.risks[0]) || (diag.macrobends && diag.macrobends[0] && diag.macrobends[0].recommendation) || (diag.warnings && diag.warnings[0]) || diag.overallVerdict;

    if (itemStatus === 'unclassified') {
      chipVerdict.textContent = '미분류 (검토)';
      chipVerdict.className = 'status-badge status-unclassified';
      chipVerdict.title = reason;
    } else if (itemStatus === 'pass') {
      chipVerdict.textContent = '정상 (Pass)';
      chipVerdict.className = 'status-badge status-pass';
      chipVerdict.title = reason;
    } else if (itemStatus === 'splice_warn' || itemStatus === 'warn') {
      chipVerdict.textContent = '접속주의 (Caution)';
      chipVerdict.className = 'status-badge status-splice_warn';
      chipVerdict.title = reason;
    } else if (itemStatus === 'splice_risk') {
      chipVerdict.textContent = '접속위험 (Risk)';
      chipVerdict.className = 'status-badge status-splice_risk';
      chipVerdict.title = reason;
    } else if (itemStatus === 'bending') {
      chipVerdict.textContent = '벤딩 (Bending)';
      chipVerdict.className = 'status-badge status-bending';
      chipVerdict.title = reason;
    } else if (itemStatus === 'defect') {
      chipVerdict.textContent = '치명적 불량 (Defect)';
      chipVerdict.className = 'status-badge status-defect';
      chipVerdict.title = reason;
    } else {
      chipVerdict.textContent = diag.overallVerdict;
      chipVerdict.className = `status-badge ${diag.verdictClass}`;
      chipVerdict.title = reason;
    }
  }

  // Update Canvas Floating Active File Badge
  function updateCanvasActiveFileBadge(parsed, diag, filename) {
    const badge = document.getElementById('canvasActiveFileBadge');
    if (!badge) return;

    const dot = document.getElementById('canvasFileDot');
    const branchEl = document.getElementById('canvasBranchName');
    const nameEl = document.getElementById('canvasFileName');
    const lenEl = document.getElementById('canvasFileLengthBadge');

    badge.style.display = 'flex';

    const meta = currentFileMeta;
    if (branchEl) {
      branchEl.textContent = meta && meta.branch ? meta.branch : '계측 파형';
    }
    if (nameEl) {
      const displayName = (meta && meta.filename) ? meta.filename : filename;
      nameEl.textContent = displayName;
      nameEl.title = displayName;
    }
    if (lenEl) {
      const km = (parsed && parsed.summary && parsed.summary.fiberLengthKm) || (meta ? meta.length_km : 0);
      lenEl.textContent = `${km.toFixed(3)} km`;
    }
    if (dot) {
      dot.className = 'active-file-dot';
      const st = meta ? meta.status : (diag ? diag.status : null);
      if (st === 'unclassified') {
        dot.classList.add('dot-unclassified');
      } else if (st === 'splice_warn' || st === 'warn') {
        dot.classList.add('dot-splice_warn');
      } else if (st === 'splice_risk') {
        dot.classList.add('dot-splice_risk');
      } else if (st === 'bending') {
        dot.classList.add('dot-bending');
      } else if (st === 'defect') {
        dot.classList.add('dot-defect');
      }
    }
  }

  // 6. Update Diagnostics Tab
  function updateDiagnosticsPanel(diag) {
    scoreGaugeRing.textContent = diag.score;
    scoreGaugeRing.style.borderColor = diag.badgeColor;
    scoreGaugeRing.style.color = diag.badgeColor;
    scoreGaugeRing.style.boxShadow = `0 0 12px ${diag.badgeColor}40`;

    scoreVerdict.textContent = diag.overallVerdict;
    scoreVerdict.style.color = diag.badgeColor;
    scoreGrade.textContent = `평균 손실률: ${diag.lossRateGrade}`;

    // Issues list
    if (diag.issues.length === 0) {
      diagAlertsContainer.innerHTML = `
        <div class="alert-box alert-success">
          <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <div class="alert-content">
            <strong>선로 상태 우수</strong>
            <div>0.35 dB/km 이하 기준 만족 및 단선·매크로벤딩 이상 징후 없음.</div>
          </div>
        </div>
      `;
    } else {
      diagAlertsContainer.innerHTML = diag.issues.map(iss => `
        <div class="alert-box alert-${iss.severity === 'danger' ? 'danger' : 'warning'}">
          <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <div class="alert-content">
            <strong>${iss.title}</strong>
            <div>${iss.description}</div>
          </div>
        </div>
      `).join('');
    }

    // Macrobending Container
    if (diag.macrobends.length === 0) {
      macrobendContainer.innerHTML = `<div style="font-size: 11px; color: var(--text-dim); padding: 6px 0;">감지된 꺾임/압착 손실 지점이 없습니다 (안정).</div>`;
    } else {
      macrobendContainer.innerHTML = diag.macrobends.map(mb => `
        <div style="background: rgba(168, 85, 247, 0.08); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 6px; padding: 8px 10px; margin-bottom: 6px;">
          <div style="font-weight: 700; color: #a855f7; font-size: 11px;">지점: ${mb.distKm.toFixed(3)} km (손실: ${mb.lossDb.toFixed(2)} dB)</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${mb.recommendation}</div>
        </div>
      `).join('');
    }

    // Recommendations List
    const recs = [];
    if (diag.score >= 85) {
      recs.push('현재 광통신망 전송 선로 품질이 매우 양호하여 추가 정비 불필요.');
      recs.push('차기 정기 점검 주기(월 1회) 준수.');
    } else {
      if (diag.highLossSplices > 0) {
        recs.push(`고손실 접속점(${diag.highLossSplices}개소) 광케이블 접속함체 재융착 점검 권장.`);
      }
      if (diag.macrobends.length > 0) {
        recs.push('매크로벤딩 지점 트레이 곡률반경(R > 30mm) 확보 및 바인더 타이 압착 완화.');
      }
      if (diag.lossRateStatus === 'fail') {
        recs.push('광선로 과다 감쇄 구간에 대한 긴급 광레벨 측정 및 광심선 교체 검토.');
      }
    }
    recommendationsList.innerHTML = recs.map(r => `<li>${r}</li>`).join('');
  }

  // 7. Update Event Table
  function updateEventTable(parsed, diag) {
    const events = (parsed.keyEvents && parsed.keyEvents.events) || [];

    if (events.length === 0) {
      eventTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px;">이벤트가 없습니다.</td></tr>`;
      return;
    }

    eventTableBody.innerHTML = events.map(ev => {
      let statusTag = '<span style="color: var(--accent-green); font-weight: 600;">정상</span>';

      if (ev.isEndOfFiber) {
        statusTag = '<span style="color: var(--accent-purple); font-weight: 700;">종단 (End)</span>';
      } else if (ev.isReflective) {
        if (ev.spliceLoss >= 5.00) {
          statusTag = '<span style="color: #ef4444; font-weight: 700;">커넥터 폭락</span>';
        } else if (ev.spliceLoss > 1.00) {
          statusTag = '<span style="color: #f97316; font-weight: 700;">커넥터 위험</span>';
        } else if (ev.spliceLoss > 0.50) {
          statusTag = '<span style="color: #f59e0b; font-weight: 600;">커넥터 주의</span>';
        }
      } else {
        if (ev.spliceLoss >= 3.00) {
          statusTag = '<span style="color: #ef4444; font-weight: 700;">급격 파단 (Defect)</span>';
        } else if (ev.spliceLoss >= 2.00) {
          statusTag = '<span style="color: #a855f7; font-weight: 700;">꺾임 (Bending)</span>';
        } else if (ev.spliceLoss > 0.40) {
          statusTag = '<span style="color: #f97316; font-weight: 700;">접속 위험</span>';
        } else if (ev.spliceLoss > 0.15) {
          statusTag = '<span style="color: #f59e0b; font-weight: 600;">접속 주의</span>';
        }
      }

      return `
        <tr data-event-num="${ev.eventNumber}" onclick="window.focusEventLocation(${ev.distKm})">
          <td style="font-weight: 700;">#${ev.eventNumber}</td>
          <td>${ev.distKm.toFixed(3)}</td>
          <td style="${ev.spliceLoss > 0.15 ? 'color: var(--accent-amber); font-weight: 600;' : ''}">${ev.spliceLoss.toFixed(2)}</td>
          <td>${ev.reflLoss !== 0 ? ev.reflLoss.toFixed(1) : '-'}</td>
          <td>${ev.eventTypeDesc}</td>
          <td>${statusTag}</td>
        </tr>
      `;
    }).join('');
  }

  window.focusEventLocation = function (distKm) {
    if (waveformEngine) {
      waveformEngine.setMarkerPosition('a', distKm);
      waveformEngine.view.minX = Math.max(0, distKm - 0.8);
      waveformEngine.view.maxX = distKm + 0.8;
      waveformEngine.render();
    }
  };

  // 8. Update Metadata Grid
  function updateMetadataGrid(parsed) {
    const sup = parsed.supParams || {};
    const fxd = parsed.fxdParams || {};
    const gen = parsed.genParams || {};

    metaOtdrModel.textContent = `${sup.supplier || 'YOKOGAWA'} ${sup.otdrModel || 'AQ7270'}`;
    metaOtdrSn.textContent = sup.otdrSn || '91L946170';
    metaDateTime.textContent = fxd.dateTimeStr || '2026-04-07 19:54:09';
    metaIor.textContent = fxd.ior ? fxd.ior.toFixed(5) : '1.46820';
    metaPulse.textContent = fxd.pulseWidth ? `${fxd.pulseWidth} ns` : '100 ns';
    metaAvgTime.textContent = fxd.avgTimeSec ? `${fxd.avgTimeSec} s` : '30.0 s';
    metaBc.textContent = fxd.backscatterCoef ? `${fxd.backscatterCoef.toFixed(1)} dB` : '-82.0 dB';
    metaFiberType.textContent = gen.fiberTypeDesc || 'ITU-T G.652';
    metaSwVersion.textContent = sup.swVersion || '3.04 (AQ7270 OS)';
  }

  // 9. Filters & Search Handlers
  function initFilters() {
    searchInput.addEventListener('input', () => {
      const dataIndex = window.OTDR_DATASET_INDEX || window.DATASET_INDEX;
      if (dataIndex) renderTree(dataIndex.items);
    });

    const filterChips = document.querySelectorAll('.filter-chip');
    filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        if (chip.id === 'filterAll') activeFilter = 'all';
        else if (chip.id === 'filterPass') activeFilter = 'pass';
        else if (chip.id === 'filterSpliceWarn') activeFilter = 'splice_warn';
        else if (chip.id === 'filterSpliceRisk') activeFilter = 'splice_risk';
        else if (chip.id === 'filterBending') activeFilter = 'bending';
        else if (chip.id === 'filterDefect') activeFilter = 'defect';
        else if (chip.id === 'filterUnclass') activeFilter = 'unclassified';

        const dataIndex = window.OTDR_DATASET_INDEX || window.DATASET_INDEX;
        if (dataIndex) renderTree(dataIndex.items);
      });
    });
  }

  // 10. Drag & Drop & Local File Picker
  function initDragAndDrop() {
    const btnOpenLocal = document.getElementById('btnOpenLocal');
    btnOpenLocal.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleLocalFile(e.target.files[0]);
      }
    });

    dropZone.addEventListener('click', () => {
      fileInput.click();
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleLocalFile(e.dataTransfer.files[0]);
      }
    });

    // Also support dropping anywhere on the window
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', (e) => {
      if (e.target === dropZone || dropZone.contains(e.target)) return;
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleLocalFile(e.dataTransfer.files[0]);
      }
    });
  }

  function handleLocalFile(file) {
    if (!file.name.toLowerCase().endsWith('.sor')) {
      alert('OTDR 측정 파일(.SOR)만 지원됩니다.');
      return;
    }

    const reader = new FileReader();
    reader.onload = function (evt) {
      const buffer = evt.target.result;
      processSorBuffer(buffer, file.name);
    };
    reader.readAsArrayBuffer(file);
  }

  // 11. Canvas Toolbar Handlers
  function initToolbar() {
    document.getElementById('btnZoomIn').addEventListener('click', () => {
      const centerX = (waveformEngine.view.minX + waveformEngine.view.maxX) / 2;
      const spanX = (waveformEngine.view.maxX - waveformEngine.view.minX) * 0.75;
      waveformEngine.view.minX = centerX - spanX / 2;
      waveformEngine.view.maxX = centerX + spanX / 2;
      waveformEngine.render();
    });

    document.getElementById('btnZoomOut').addEventListener('click', () => {
      const centerX = (waveformEngine.view.minX + waveformEngine.view.maxX) / 2;
      const spanX = (waveformEngine.view.maxX - waveformEngine.view.minX) * 1.35;
      waveformEngine.view.minX = centerX - spanX / 2;
      waveformEngine.view.maxX = centerX + spanX / 2;
      waveformEngine.render();
    });

    const btnFitFiber = document.getElementById('btnFitFiber');
    const btnResetView = document.getElementById('btnResetView');
    const btnLockZoom = document.getElementById('btnLockZoom');

    btnFitFiber.addEventListener('click', () => {
      waveformEngine.viewMode = 'fiber';
      if (typeof localStorage !== 'undefined') localStorage.setItem('otdr_view_mode', 'fiber');
      waveformEngine.fitToFiber();
      btnFitFiber.classList.add('active');
      btnResetView.classList.remove('active');
      if (btnLockZoom) btnLockZoom.classList.remove('active');
      showToast('유효 선로 모드 고정 (파일 변경 시 0~종단 구간 유지)', 'info');
    });

    btnResetView.addEventListener('click', () => {
      waveformEngine.viewMode = 'full';
      if (typeof localStorage !== 'undefined') localStorage.setItem('otdr_view_mode', 'full');
      waveformEngine.fitFullTrace();
      btnResetView.classList.add('active');
      btnFitFiber.classList.remove('active');
      if (btnLockZoom) btnLockZoom.classList.remove('active');
      showToast('전체 레인지 모드 고정 (파일 변경 시 전체 계측 구간 유지)', 'info');
    });

    if (btnLockZoom) {
      btnLockZoom.addEventListener('click', () => {
        waveformEngine.viewMode = 'locked';
        if (typeof localStorage !== 'undefined') localStorage.setItem('otdr_view_mode', 'locked');
        waveformEngine.lockCurrentView();
        btnLockZoom.classList.add('active');
        btnFitFiber.classList.remove('active');
        btnResetView.classList.remove('active');
        showToast('현재 축적 고정 (다른 파일을 열어도 현재 화면 확대 비율 100% 유지)', 'info');
      });
    }

    // Overlay Opacity Slider
    const overlayOpacitySlider = document.getElementById('overlayOpacitySlider');
    const overlayOpacityVal = document.getElementById('overlayOpacityVal');
    if (overlayOpacitySlider && overlayOpacityVal) {
      overlayOpacitySlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        overlayOpacityVal.textContent = `${val}%`;
        waveformEngine.setOverlayOpacity(val / 100);
      });
    }

    // Clear All Overlay Button
    const btnClearAllOverlay = document.getElementById('btnClearAllOverlay');
    if (btnClearAllOverlay) {
      btnClearAllOverlay.addEventListener('click', () => {
        waveformEngine.clearOverlayTraces();
        const checkboxes = fileTreeContainer.querySelectorAll('.file-overlay-checkbox');
        checkboxes.forEach(cb => { cb.checked = false; });
        updateOverlayControlBar();
        showToast('모든 비교 파형이 해제되었습니다.', 'info');
      });
    }

    const btnToggleMarkers = document.getElementById('btnToggleMarkers');
    btnToggleMarkers.addEventListener('click', () => {
      const enabled = waveformEngine.toggleMarkers();
      btnToggleMarkers.classList.toggle('active', enabled);
    });

    document.getElementById('btnSnapshot').addEventListener('click', () => {
      exportCanvasSnapshot();
    });
  }

  function exportCanvasSnapshot() {
    const dataUrl = traceCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    const name = currentFileMeta ? currentFileMeta.filename.replace(/\.sor/i, '') : 'OTDR_Waveform';
    a.download = `${name}_snapshot.png`;
    a.click();
    showToast('파형 스냅샷 이미지가 다운로드되었습니다.', 'success');
  }

  // 12. Tabs Handler
  function initTabs() {
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.dataset.tab;
        document.getElementById(targetId).classList.add('active');
      });
    });
  }

  // 13. Printable Report Modal
  function initReportModal() {
    btnExportReport.addEventListener('click', () => {
      if (!currentParsedData) {
        alert('먼저 광선로 측정 파일(.SOR)을 로드해주세요.');
        return;
      }
      populateReportSheet();
      reportModal.classList.add('open');
    });

    btnCloseModal.addEventListener('click', () => {
      reportModal.classList.remove('open');
    });

    btnCancelModal.addEventListener('click', () => {
      reportModal.classList.remove('open');
    });

    btnPrintReport.addEventListener('click', () => {
      window.print();
    });
  }

  function populateReportSheet() {
    if (!currentParsedData) return;

    const sum = currentParsedData.summary;
    const fxd = currentParsedData.fxdParams || {};
    const events = (currentParsedData.keyEvents && currentParsedData.keyEvents.events) || [];
    const diag = Diagnostics.analyze(currentParsedData);

    const filename = currentFileMeta ? currentFileMeta.filename : '광1.SOR';
    const branch = currentFileMeta ? currentFileMeta.branch : '경기광주영업소';

    document.getElementById('repRouteName').textContent = `${branch} - ${filename}`;
    document.getElementById('repDate').textContent = fxd.dateTimeStr || '2026-04-07 19:54:09';
    document.getElementById('repWavePulse').textContent = `${sum.wavelength} nm / ${sum.pulseWidth} ns`;
    document.getElementById('repLength').textContent = `${sum.fiberLengthKm.toFixed(3)} km (${sum.fiberLengthM} m)`;
    document.getElementById('repTotalLoss').textContent = `${sum.totalLossDb.toFixed(2)} dB`;
    document.getElementById('repLossRate').textContent = `${sum.avgLossRate.toFixed(3)} dB/km`;
    document.getElementById('repOrl').textContent = `${sum.orlDb.toFixed(1)} dB`;

    const seal = document.getElementById('reportVerdictSeal');
    seal.textContent = diag.overallVerdict;
    seal.style.color = diag.badgeColor;
    seal.style.borderColor = diag.badgeColor;

    // Draw preview waveform to report canvas
    const repCanvas = document.getElementById('reportPreviewCanvas');
    const repCtx = repCanvas.getContext('2d');
    repCanvas.width = repCanvas.clientWidth * (window.devicePixelRatio || 1);
    repCanvas.height = repCanvas.clientHeight * (window.devicePixelRatio || 1);
    repCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    // Copy waveform trace to report canvas
    repCtx.fillStyle = '#0a0f1d';
    repCtx.fillRect(0, 0, repCanvas.clientWidth, repCanvas.clientHeight);
    if (currentParsedData.dataPts && currentParsedData.dataPts.points.length > 0) {
      const pts = currentParsedData.dataPts.points;
      const minX = 0;
      const maxX = pts[pts.length - 1].distKm * 1.05;
      const minY = -65;
      const maxY = -10;

      repCtx.strokeStyle = '#00f0ff';
      repCtx.lineWidth = 1.5;
      repCtx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = (pts[i].distKm / maxX) * repCanvas.clientWidth;
        const y = ((maxY - pts[i].powerDb) / (maxY - minY)) * repCanvas.clientHeight;
        if (i === 0) repCtx.moveTo(x, y);
        else repCtx.lineTo(x, y);
      }
      repCtx.stroke();
    }

    // Populate Report Event Table
    const repTableBody = document.getElementById('reportEventTableBody');
    repTableBody.innerHTML = events.slice(0, 10).map(ev => `
      <tr>
        <td style="font-weight: 700;">#${ev.eventNumber}</td>
        <td>${ev.distKm.toFixed(3)} km</td>
        <td>${ev.spliceLoss.toFixed(2)} dB</td>
        <td>${ev.reflLoss !== 0 ? ev.reflLoss.toFixed(1) + ' dB' : '-'}</td>
        <td>${ev.eventTypeDesc}</td>
        <td style="font-weight: 600; color: ${ev.spliceLoss > 0.15 ? '#b91c1c' : '#15803d'}">
          ${ev.spliceLoss > 0.15 ? '주의 (초과)' : '정상'}
        </td>
      </tr>
    `).join('');

    // Opinion Text
    const opText = document.getElementById('reportOpinionText');
    if (diag.score >= 80) {
      opText.textContent = `본 회선(${filename})의 계측 데이터는 평균 감쇄율 ${sum.avgLossRate.toFixed(3)} dB/km로 한국도로공사 ITS 유지보수 기준(0.35 dB/km 이하)을 완전히 충족하며, 전송 선로 품질이 매우 우수합니다.`;
    } else {
      opText.textContent = `본 회선(${filename})은 평균 감쇄율이 ${sum.avgLossRate.toFixed(3)} dB/km 또는 이상 접속점/매크로벤딩 의심 지점이 감지되어 현장 선로 점검 및 접속함체 확인이 요구됩니다.`;
    }
  }

  // Toast notification
  function showToast(msg, type = 'info') {
    let toast = document.getElementById('appToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'appToast';
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.95);
        color: #fff;
        border: 1px solid rgba(0, 240, 255, 0.4);
        padding: 8px 18px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        z-index: 2000;
        transition: all 0.3s ease;
        pointer-events: none;
      `;
      document.body.appendChild(toast);
    }

    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
    }, 2800);
  }

  // Auto load first sample
  function autoLoadInitialSample() {
    const dataIndex = window.OTDR_DATASET_INDEX || window.DATASET_INDEX;
    if (dataIndex && dataIndex.items && dataIndex.items.length > 0) {
      const first = dataIndex.items[0];
      loadFileById(first.id, first.rel_path);
    }
  }

  // IndexedDB Cache Status Badge Controller
  function initIdbBadge() {
    const idbBadge = document.getElementById('idbStatusBadge');
    if (!idbBadge) return;

    function updateBadge(ready, text) {
      if (ready) {
        idbBadge.textContent = '⚡ 383개 캐시 완료';
        idbBadge.style.background = 'rgba(16, 185, 129, 0.18)';
        idbBadge.style.color = '#10b981';
        idbBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        idbBadge.title = '전체 383개 선로 파형이 브라우저 IndexedDB에 저장되어 서버 없이 즉시 로딩됩니다.';
      } else {
        idbBadge.textContent = text || '⚡ 캐시 로드 중...';
        idbBadge.style.background = 'rgba(0, 240, 255, 0.15)';
        idbBadge.style.color = 'var(--accent-cyan)';
        idbBadge.style.borderColor = 'rgba(0, 240, 255, 0.3)';
      }
    }

    if (window.OtdrIdbStorage && window.OtdrIdbStorage.isReady()) {
      updateBadge(true);
    }

    window.addEventListener('otdr-idb-ready', () => updateBadge(true));
    window.addEventListener('otdr-idb-progress', (e) => {
      if (e.detail && e.detail.pct >= 1.0) {
        updateBadge(true);
      } else if (e.detail && e.detail.statusText) {
        updateBadge(false, `⚡ ${e.detail.statusText}`);
      }
    });

    idbBadge.addEventListener('click', () => {
      if (window.OtdrIdbStorage) {
        window.OtdrIdbStorage.getCachedCount().then(c => {
          showToast(`IndexedDB 현재 캐시: ${c} / 383개 파형 저장됨 (Zero-Server)`, 'info');
        });
      }
    });
  }

  // Start app on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
