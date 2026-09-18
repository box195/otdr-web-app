/**
 * Interactive OTDR Waveform Canvas Engine (60fps)
 * Dual A/B Markers, Sub-pixel Rendering, Macrobend Visualizer, Dynamic Zoom/Pan
 */

(function (global) {
  'use strict';

  class OtdrWaveformEngine {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.options = Object.assign({
        theme: 'dark',
        traceColor: '#00f0ff',
        secondaryTraceColor: '#d500f9',
        gridColor: 'rgba(255, 255, 255, 0.08)',
        textColor: '#94a3b8',
        markerAColor: '#00e5ff',
        markerBColor: '#ff9100',
        onMarkerChange: null,
        onHoverEvent: null
      }, options);

      // Data
      this.trace = null;
      this.secondaryTrace = null;
      this.events = [];
      this.summary = null;

      // Viewport in data coordinates
      this.view = {
        minX: 0,
        maxX: 10,
        minY: -70,
        maxY: -10
      };
      // Margins
      this.margin = { top: 40, right: 30, bottom: 40, left: 65 };

      // ViewMode state persistence & lock
      const storage = (typeof window !== 'undefined' && window.localStorage) || (typeof localStorage !== 'undefined' && localStorage);
      this.viewMode = (storage && storage.getItem('otdr_view_mode')) || 'fiber';
      this.lockedXRange = null;
      this.isFullRangeMode = this.viewMode === 'full';

      // Multi-Trace Overlay System (다중 비교 파형)
      this.overlayTraces = new Map(); // id -> { id, name, color, trace, events, summary }
      this.overlayOpacity = 0.75;
      this.overlayColorPalette = [
        '#ff007f', // Neon Pink
        '#00e676', // Bright Lime
        '#d500f9', // Electric Violet
        '#ff9100', // Vivid Amber
        '#00b0ff', // Sky Cyan
        '#ffd600', // Neon Yellow
        '#ff3d00'  // Fiery Orange
      ];

      // Interaction state
      this.isPanning = false;
      this.panStart = { x: 0, y: 0 };
      this.draggedMarker = null; // 'A' or 'B'
      this.mousePos = { x: -1, y: -1 };

      // Markers A & B (in km)
      this.markers = {
        enabled: true,
        a: { km: 0.5, db: -25 },
        b: { km: 2.0, db: -30 }
      };

      this.initEvents();
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.width = rect.width;
      this.height = rect.height;

      this.canvas.width = Math.floor(this.width * this.dpr);
      this.canvas.height = Math.floor(this.height * this.dpr);

      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(this.dpr, this.dpr);

      this.render();
    }

    _getStorage() {
      try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
        if (typeof localStorage !== 'undefined') return localStorage;
      } catch (e) {}
      return null;
    }

    loadTrace(parsedData) {
      if (!parsedData || !parsedData.dataPts) return;

      this.parsedData = parsedData;
      this.trace = parsedData.dataPts.points;
      this.events = (parsedData.keyEvents && parsedData.keyEvents.events) || [];
      this.summary = parsedData.summary || {};

      // Compute bounds
      if (this.trace.length > 0) {
        const lastPt = this.trace[this.trace.length - 1];
        const maxDist = lastPt.distKm;
        
        let minDb = 0;
        let maxDb = -999;
        for (let i = 0; i < this.trace.length; i++) {
          const db = this.trace[i].powerDb;
          if (db < minDb) minDb = db;
          if (db > maxDb) maxDb = db;
        }

        const yPadding = Math.abs(maxDb - minDb) * 0.1 || 5;
        const fiberLen = this.summary.fiberLengthKm || maxDist * 0.7;

        this.view = {
          minX: 0,
          maxX: Math.max(0.3, fiberLen * 1.08),
          minY: minDb - yPadding,
          maxY: maxDb + yPadding
        };
        this.defaultView = {
          minX: 0,
          maxX: Math.max(0.3, fiberLen * 1.08),
          minY: minDb - yPadding,
          maxY: maxDb + yPadding
        };
        this.fullView = {
          minX: 0,
          maxX: Math.max(0.5, maxDist * 1.05),
          minY: minDb - yPadding,
          maxY: maxDb + yPadding
        };

        // Retrieve active viewMode from localStorage (fallback to 'fiber')
        const storage = this._getStorage();
        if (storage) {
          const savedMode = storage.getItem('otdr_view_mode');
          if (savedMode === 'full' || savedMode === 'locked' || savedMode === 'fiber') {
            this.viewMode = savedMode;
          }
        }
        if (!this.viewMode) this.viewMode = 'fiber';

        // Apply whichever viewMode is currently selected
        if (this.viewMode === 'full') {
          this.view = Object.assign({}, this.fullView);
          this.isFullRangeMode = true;
        } else if (this.viewMode === 'locked' && this.lockedXRange) {
          this.view = {
            minX: this.lockedXRange.minX,
            maxX: this.lockedXRange.maxX,
            minY: minDb - yPadding,
            maxY: maxDb + yPadding
          };
          this.isFullRangeMode = false;
        } else {
          // 'fiber' (effective fiber range)
          this.viewMode = 'fiber';
          this.view = Object.assign({}, this.defaultView);
          this.isFullRangeMode = false;
        }

        // Position initial markers: A at 20%, B at true End of Fiber
        this.markers.a.km = fiberLen * 0.2;
        this.markers.b.km = fiberLen;
        this.updateMarkerDb('a');
        this.updateMarkerDb('b');
        this.notifyMarkerChange();
      }

      this.render();
    }

    fitToFiber() {
      this.viewMode = 'fiber';
      this.lockedXRange = null;
      const storage = this._getStorage();
      if (storage) storage.setItem('otdr_view_mode', 'fiber');
      if (!this.trace || this.trace.length === 0) return;
      const fiberLen = (this.summary && this.summary.fiberLengthKm) || this.trace[this.trace.length - 1].distKm;
      this.view.minX = 0;
      this.view.maxX = Math.max(0.3, fiberLen * 1.08);
      this.isFullRangeMode = false;
      this.render();
    }

    fitFullTrace() {
      this.viewMode = 'full';
      this.lockedXRange = null;
      const storage = this._getStorage();
      if (storage) storage.setItem('otdr_view_mode', 'full');
      if (!this.trace || this.trace.length === 0) return;
      const maxDist = this.trace[this.trace.length - 1].distKm;
      this.view.minX = 0;
      this.view.maxX = Math.max(0.5, maxDist * 1.05);
      this.isFullRangeMode = true;
      this.render();
    }

    lockCurrentView() {
      this.viewMode = 'locked';
      this.lockedXRange = { minX: this.view.minX, maxX: this.view.maxX };
      const storage = this._getStorage();
      if (storage) storage.setItem('otdr_view_mode', 'locked');
      this.isFullRangeMode = false;
      this.render();
    }

    resetView() {
      if (this.viewMode === 'full') {
        this.fitFullTrace();
      } else if (this.viewMode === 'locked' && this.lockedXRange) {
        this.view.minX = this.lockedXRange.minX;
        this.view.maxX = this.lockedXRange.maxX;
        this.render();
      } else {
        this.fitToFiber();
      }
    }

    // Overlay Traces Management
    addOverlayTrace(id, name, parsedData) {
      if (!parsedData || !parsedData.dataPts) return null;
      const paletteIdx = this.overlayTraces.size % this.overlayColorPalette.length;
      const color = this.overlayColorPalette[paletteIdx];
      this.overlayTraces.set(id, {
        id,
        name,
        color,
        trace: parsedData.dataPts.points,
        events: (parsedData.keyEvents && parsedData.keyEvents.events) || [],
        summary: parsedData.summary || {}
      });
      this.render();
      return color;
    }

    removeOverlayTrace(id) {
      this.overlayTraces.delete(id);
      this.render();
    }

    clearOverlayTraces() {
      this.overlayTraces.clear();
      this.render();
    }

    setOverlayOpacity(opacity) {
      this.overlayOpacity = Math.max(0.1, Math.min(1.0, opacity));
      this.render();
    }

    loadSecondaryTrace(parsedData) {
      this.secondaryTrace = parsedData ? parsedData.dataPts.points : null;
      this.render();
    }

    clearSecondaryTrace() {
      this.secondaryTrace = null;
      this.render();
    }

    // Coordinate conversions
    toScreenX(km) {
      const plotWidth = this.width - this.margin.left - this.margin.right;
      return this.margin.left + ((km - this.view.minX) / (this.view.maxX - this.view.minX)) * plotWidth;
    }

    toScreenY(db) {
      const plotHeight = this.height - this.margin.top - this.margin.bottom;
      // In OTDR: higher power (less negative dB, e.g. -20) is near the TOP
      return this.margin.top + ((this.view.maxY - db) / (this.view.maxY - this.view.minY)) * plotHeight;
    }

    toDataX(screenX) {
      const plotWidth = this.width - this.margin.left - this.margin.right;
      return this.view.minX + ((screenX - this.margin.left) / plotWidth) * (this.view.maxX - this.view.minX);
    }

    toDataY(screenY) {
      const plotHeight = this.height - this.margin.top - this.margin.bottom;
      return this.view.maxY - ((screenY - this.margin.top) / plotHeight) * (this.view.maxY - this.view.minY);
    }

    getDbAtDistance(km, trace = this.trace) {
      if (!trace || trace.length === 0) return 0;
      if (km <= trace[0].distKm) return trace[0].powerDb;
      if (km >= trace[trace.length - 1].distKm) return trace[trace.length - 1].powerDb;

      // Binary search
      let low = 0, high = trace.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (trace[mid].distKm < km) low = mid + 1;
        else high = mid - 1;
      }
      const idx = Math.min(Math.max(low, 1), trace.length - 1);
      const p1 = trace[idx - 1];
      const p2 = trace[idx];
      const t = (km - p1.distKm) / (p2.distKm - p1.distKm || 1);
      return p1.powerDb + t * (p2.powerDb - p1.powerDb);
    }

    updateMarkerDb(markerKey) {
      const m = this.markers[markerKey];
      m.db = this.getDbAtDistance(m.km);
    }

    notifyMarkerChange() {
      if (typeof this.options.onMarkerChange === 'function') {
        const a = this.markers.a;
        const b = this.markers.b;
        const deltaDistKm = Math.abs(b.km - a.km);
        const deltaDistM = deltaDistKm * 1000;
        const deltaLossDb = Math.abs(b.db - a.db);
        const lossRate = deltaDistKm > 0.001 ? (deltaLossDb / deltaDistKm) : 0;

        this.options.onMarkerChange({
          markerA: { km: Number(a.km.toFixed(4)), db: Number(a.db.toFixed(3)) },
          markerB: { km: Number(b.km.toFixed(4)), db: Number(b.db.toFixed(3)) },
          deltaDistKm: Number(deltaDistKm.toFixed(4)),
          deltaDistM: Number(deltaDistM.toFixed(1)),
          deltaLossDb: Number(deltaLossDb.toFixed(3)),
          lossRateDbPerKm: Number(lossRate.toFixed(3))
        });
      }
    }

    initEvents() {
      const canvas = this.canvas;

      canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Check if clicked near Marker A or B handle
        const aScreenX = this.toScreenX(this.markers.a.km);
        const bScreenX = this.toScreenX(this.markers.b.km);

        if (this.markers.enabled) {
          if (Math.abs(mouseX - aScreenX) <= 12) {
            this.draggedMarker = 'a';
            return;
          }
          if (Math.abs(mouseX - bScreenX) <= 12) {
            this.draggedMarker = 'b';
            return;
          }
        }

        // Otherwise Pan
        this.isPanning = true;
        this.panStart = { x: mouseX, y: mouseY };
        canvas.style.cursor = 'grabbing';
      });

      window.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        this.mousePos = { x: mouseX, y: mouseY };

        if (this.draggedMarker) {
          const dataX = this.toDataX(mouseX);
          const clampedX = Math.max(0, Math.min(this.view.maxX * 1.5, dataX));
          this.markers[this.draggedMarker].km = clampedX;
          this.updateMarkerDb(this.draggedMarker);
          this.notifyMarkerChange();
          this.render();
          return;
        }

        if (this.isPanning) {
          const dx = mouseX - this.panStart.x;
          const dy = mouseY - this.panStart.y;
          this.panStart = { x: mouseX, y: mouseY };

          const plotWidth = this.width - this.margin.left - this.margin.right;
          const plotHeight = this.height - this.margin.top - this.margin.bottom;

          const dataDx = (dx / plotWidth) * (this.view.maxX - this.view.minX);
          const dataDy = (dy / plotHeight) * (this.view.maxY - this.view.minY);

          this.view.minX -= dataDx;
          this.view.maxX -= dataDx;
          this.view.minY += dataDy;
          this.view.maxY += dataDy;

          this.render();
          return;
        }

        // Hover cursor check
        if (this.markers.enabled) {
          const aScreenX = this.toScreenX(this.markers.a.km);
          const bScreenX = this.toScreenX(this.markers.b.km);
          if (Math.abs(mouseX - aScreenX) <= 8 || Math.abs(mouseX - bScreenX) <= 8) {
            canvas.style.cursor = 'col-resize';
          } else {
            canvas.style.cursor = 'crosshair';
          }
        }

        this.checkHoverEvent(mouseX, mouseY);
        this.render();
      });

      window.addEventListener('mouseup', () => {
        this.isPanning = false;
        this.draggedMarker = null;
        canvas.style.cursor = 'default';
      });

      // Mouse Wheel Zoom centered at mouse position
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomFactor = e.deltaY < 0 ? 0.85 : 1.18;

        const focusX = this.toDataX(mouseX);
        const focusY = this.toDataY(mouseY);

        const newRangeX = (this.view.maxX - this.view.minX) * zoomFactor;
        const newRangeY = (this.view.maxY - this.view.minY) * zoomFactor;

        const xRatio = (focusX - this.view.minX) / (this.view.maxX - this.view.minX);
        const yRatio = (focusY - this.view.minY) / (this.view.maxY - this.view.minY);

        this.view.minX = focusX - newRangeX * xRatio;
        this.view.maxX = focusX + newRangeX * (1 - xRatio);
        this.view.minY = focusY - newRangeY * yRatio;
        this.view.maxY = focusY + newRangeY * (1 - yRatio);

        this.render();
      }, { passive: false });

      // Double Click -> Reset View
      canvas.addEventListener('dblclick', () => {
        this.resetView();
      });
    }

    checkHoverEvent(mouseX, mouseY) {
      if (!this.events || this.events.length === 0) return;

      let hovered = null;
      for (const ev of this.events) {
        const sx = this.toScreenX(ev.distKm);
        const evDb = this.getDbAtDistance(ev.distKm);
        const sy = this.toScreenY(evDb);

        if (Math.abs(mouseX - sx) <= 12 && mouseY >= sy - 20 && mouseY <= sy + 40) {
          hovered = ev;
          break;
        }
      }

      if (typeof this.options.onHoverEvent === 'function') {
        this.options.onHoverEvent(hovered);
      }
    }


    setMarkerPosition(key, distKm) {
      if (this.markers[key]) {
        this.markers[key].km = distKm;
        this.updateMarkerDb(key);
        this.notifyMarkerChange();
        this.render();
      }
    }

    toggleMarkers() {
      this.markers.enabled = !this.markers.enabled;
      this.render();
      return this.markers.enabled;
    }

    // MAIN RENDER LOOP
    render() {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Background Gradient
      const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
      bgGrad.addColorStop(0, '#0a0f1d');
      bgGrad.addColorStop(1, '#050811');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // Plot Area Clipping
      const plotX = this.margin.left;
      const plotY = this.margin.top;
      const plotW = w - this.margin.left - this.margin.right;
      const plotH = h - this.margin.top - this.margin.bottom;

      this.drawGrid(ctx, plotX, plotY, plotW, plotH);

      // Clip for waveform rendering
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotX, plotY, plotW, plotH);
      ctx.clip();

      // Shaded Noise Zone if Early Cut / Signal Drop detected
      if (this.summary && this.summary.earlyCut) {
        this.drawCutZone(ctx, plotX, plotY, plotW, plotH);
      }

      // 1. Draw 0.35 dB/km Reference slope line
      this.drawReferenceLine(ctx);

      // 2. Draw Secondary Trace (Legacy comparison)
      if (this.secondaryTrace) {
        this.drawTracePath(ctx, this.secondaryTrace, this.options.secondaryTraceColor, 1.2, true);
      }

      // 2-B. Draw Multi-Trace Overlays (다중 비교 파형 동시 렌더링)
      const hasOverlays = this.overlayTraces && this.overlayTraces.size > 0;
      if (hasOverlays) {
        ctx.save();
        ctx.globalAlpha = this.overlayOpacity;
        for (const item of this.overlayTraces.values()) {
          if (item.trace && item.trace.length > 0) {
            this.drawTracePath(ctx, item.trace, item.color, 1.8, false);
          }
        }
        ctx.restore();
      }

      // 3. Draw Main Waveform Trace (선택 모드/오버레이 활성화 시 동일 투명도 적용)
      if (this.trace) {
        if (hasOverlays) {
          ctx.save();
          ctx.globalAlpha = this.overlayOpacity;
          this.drawTracePath(ctx, this.trace, this.options.traceColor, 2.0, false);
          ctx.restore();
        } else {
          this.drawTracePath(ctx, this.trace, this.options.traceColor, 2.0, false);
        }
      }

      // 4. Draw Event Pins
      this.drawEvents(ctx);

      // 5. Draw Markers A & B
      if (this.markers.enabled) {
        this.drawMarkers(ctx, plotY, plotH);
      }

      ctx.restore();

      // 6. Draw Axes & Labels (outside clip)
      this.drawAxes(ctx, plotX, plotY, plotW, plotH);

      // 7. Draw Crosshair & HUD tooltip
      this.drawCrosshair(ctx, plotX, plotY, plotW, plotH);
    }

    drawGrid(ctx, px, py, pw, ph) {
      ctx.save();
      ctx.strokeStyle = this.options.gridColor;
      ctx.lineWidth = 1;

      // Vertical Grid Lines (Distance)
      const xSpan = this.view.maxX - this.view.minX;
      let xStep = 1.0;
      if (xSpan > 50) xStep = 10.0;
      else if (xSpan > 20) xStep = 5.0;
      else if (xSpan > 8) xStep = 2.0;
      else if (xSpan > 2) xStep = 0.5;
      else if (xSpan > 0.5) xStep = 0.1;
      else xStep = 0.02;

      const firstX = Math.ceil(this.view.minX / xStep) * xStep;
      for (let x = firstX; x <= this.view.maxX; x += xStep) {
        const sx = this.toScreenX(x);
        if (sx >= px && sx <= px + pw) {
          ctx.beginPath();
          ctx.moveTo(sx, py);
          ctx.lineTo(sx, py + ph);
          ctx.stroke();
        }
      }

      // Horizontal Grid Lines (Power dB)
      const ySpan = this.view.maxY - this.view.minY;
      let yStep = 5.0;
      if (ySpan > 60) yStep = 10.0;
      else if (ySpan < 15) yStep = 2.0;
      else if (ySpan < 5) yStep = 0.5;

      const firstY = Math.ceil(this.view.minY / yStep) * yStep;
      for (let y = firstY; y <= this.view.maxY; y += yStep) {
        const sy = this.toScreenY(y);
        if (sy >= py && sy <= py + ph) {
          ctx.beginPath();
          ctx.moveTo(px, sy);
          ctx.lineTo(px + pw, sy);
          ctx.stroke();
        }
      }

      ctx.restore();
    }

    drawAxes(ctx, px, py, pw, ph) {
      ctx.save();
      ctx.fillStyle = this.options.textColor;
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      // Y-axis Labels
      const ySpan = this.view.maxY - this.view.minY;
      let yStep = ySpan > 60 ? 10.0 : (ySpan < 15 ? 2.0 : 5.0);
      const firstY = Math.ceil(this.view.minY / yStep) * yStep;
      for (let y = firstY; y <= this.view.maxY; y += yStep) {
        const sy = this.toScreenY(y);
        if (sy >= py && sy <= py + ph) {
          ctx.fillText(y.toFixed(0) + ' dB', px - 8, sy);
        }
      }

      // X-axis Labels
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xSpan = this.view.maxX - this.view.minX;
      let xStep = xSpan > 50 ? 10 : (xSpan > 20 ? 5 : (xSpan > 8 ? 2 : (xSpan > 2 ? 0.5 : 0.1)));
      const firstX = Math.ceil(this.view.minX / xStep) * xStep;
      for (let x = firstX; x <= this.view.maxX; x += xStep) {
        const sx = this.toScreenX(x);
        if (sx >= px && sx <= px + pw) {
          ctx.fillText(x.toFixed(xStep < 1 ? 2 : 1) + ' km', sx, py + ph + 8);
        }
      }

      // Axis Titles
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'left';
      ctx.fillText('광출력 (dB)', px, py - 18);
      ctx.textAlign = 'right';
      ctx.fillText('광전송 거리 (km)', px + pw, py + ph + 22);

      ctx.restore();
    }

    drawTracePath(ctx, points, color, lineWidth, isSecondary) {
      if (!points || points.length === 0) return;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (!isSecondary) {
        ctx.shadowBlur = 6;
        ctx.shadowColor = color;
      } else {
        ctx.setLineDash([4, 2]);
      }

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        if (pt.distKm < this.view.minX - 0.5) continue;
        if (pt.distKm > this.view.maxX + 0.5) {
          const sx = this.toScreenX(pt.distKm);
          const sy = this.toScreenY(pt.powerDb);
          ctx.lineTo(sx, sy);
          break;
        }

        const sx = this.toScreenX(pt.distKm);
        const sy = this.toScreenY(pt.powerDb);

        if (!started) {
          ctx.moveTo(sx, sy);
          started = true;
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.stroke();

      ctx.restore();
    }

    drawReferenceLine(ctx) {
      if (!this.trace || this.trace.length === 0) return;
      // 0.35 dB/km ideal line from first point
      const p0 = this.trace[0];
      const startDist = p0.distKm;
      const startDb = p0.powerDb;

      ctx.save();
      ctx.strokeStyle = 'rgba(0, 230, 118, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);

      const endDist = this.view.maxX;
      const endDb = startDb - 0.35 * (endDist - startDist);

      ctx.beginPath();
      ctx.moveTo(this.toScreenX(startDist), this.toScreenY(startDb));
      ctx.lineTo(this.toScreenX(endDist), this.toScreenY(endDb));
      ctx.stroke();

      ctx.fillStyle = 'rgba(0, 230, 118, 0.4)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText('0.35 dB/km 표준 기준선', this.toScreenX(startDist + 0.5), this.toScreenY(startDb - 0.35 * 0.5) - 8);

      ctx.restore();
    }

    drawEvents(ctx) {
      if (!this.events) return;

      this.events.forEach((ev) => {
        const sx = this.toScreenX(ev.distKm);
        const evDb = this.getDbAtDistance(ev.distKm);
        const sy = this.toScreenY(evDb);

        let color = '#2979ff'; // Normal splice
        let label = `E${ev.eventNumber}`;
        let badgeW = 36;

        if (ev.isEndOfFiber) {
          color = '#d500f9'; // Clean standard purple End of Fiber
          label = 'END';
          badgeW = 38;
        } else if (ev.spliceLoss >= 0.45 && !ev.isReflective) {
          color = '#ff1744'; // Macrobend
          label = 'BEND';
          badgeW = 42;
        } else if (ev.spliceLoss > 0.15) {
          color = '#ffb300'; // High loss splice
          label = `!${ev.eventNumber}`;
          badgeW = 36;
        }

        ctx.save();

        // Pin vertical dashed line
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, this.margin.top);
        ctx.lineTo(sx, sy);
        ctx.stroke();

        // Pin Head
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.shadowBlur = ev.isEndOfFiber ? 12 : 8;
        ctx.shadowColor = color;
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fill();

        // Pin Badge
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(sx - badgeW / 2, sy - 28, badgeW, 18, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, sx, sy - 19);

        ctx.restore();
      });
    }

    drawMarkers(ctx, py, ph) {
      const markers = [
        { key: 'a', label: 'Marker A', color: this.options.markerAColor, pos: this.markers.a },
        { key: 'b', label: 'Marker B', color: this.options.markerBColor, pos: this.markers.b }
      ];

      markers.forEach(m => {
        const sx = this.toScreenX(m.pos.km);
        const sy = this.toScreenY(m.pos.db);

        ctx.save();

        // Vertical Guide Line
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 2]);
        ctx.shadowBlur = 6;
        ctx.shadowColor = m.color;

        ctx.beginPath();
        ctx.moveTo(sx, py);
        ctx.lineTo(sx, py + ph);
        ctx.stroke();

        // Intersection circle on trace
        ctx.setLineDash([]);
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fill();

        // Top Handle Badge
        ctx.shadowBlur = 4;
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.roundRect(sx - 14, py - 20, 28, 18, 4);
        ctx.fill();

        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.key.toUpperCase(), sx, py - 11);

        ctx.restore();
      });
    }

    drawCrosshair(ctx, px, py, pw, ph) {
      const mx = this.mousePos.x;
      const my = this.mousePos.y;

      if (mx < px || mx > px + pw || my < py || my > py + ph) return;

      const dataX = this.toDataX(mx);
      const dataY = this.toDataY(my);

      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);

      // Vertical line
      ctx.beginPath();
      ctx.moveTo(mx, py);
      ctx.lineTo(mx, py + ph);
      ctx.stroke();

      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(px, my);
      ctx.lineTo(px + pw, my);
      ctx.stroke();

      // Coordinate tooltip badge
      ctx.setLineDash([]);
      const text = `${dataX.toFixed(3)} km | ${dataY.toFixed(2)} dB`;
      ctx.font = '10px "JetBrains Mono", monospace';
      const tw = ctx.measureText(text).width + 14;

      let badgeX = mx + 10;
      if (badgeX + tw > px + pw) badgeX = mx - tw - 10;
      let badgeY = my - 25;
      if (badgeY < py) badgeY = my + 15;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, tw, 20, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#00f0ff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, badgeX + 7, badgeY + 10);

      ctx.restore();
    }
  }

  global.OtdrWaveformEngine = OtdrWaveformEngine;

})(typeof window !== 'undefined' ? window : this);
