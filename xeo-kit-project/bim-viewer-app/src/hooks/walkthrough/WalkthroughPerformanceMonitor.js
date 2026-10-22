/**
 * Developer-only renderer telemetry for HCI's Phase 0 performance baseline.
 * Enable the floating HUD with ?perf=1, or press F9 on the walkthrough page.
 * Latest samples are also available in the browser console as window.__HCI_PERF__.
 */
export class WalkthroughPerformanceMonitor {
  constructor(renderer, container) {
    this.renderer = renderer;
    this.container = container;
    this.enabled = false;
    this.overlay = null;
    this.frameTimes = [];
    this.framesSinceSample = 0;
    this.lastSampleAt = performance.now();
    this.lastConsoleAt = 0;
    this.latest = null;
    this.modelMetrics = {
      nodeCount: 0,
      meshInstances: 0,
      uniqueGeometries: 0,
      sourceVertices: 0,
      sourceTriangles: 0,
      materialCount: 0,
      sourceTextureCount: 0,
      estimatedDecodedTextureBytes: 0,
      visibleMeshInstances: 0,
    };
    this.loadInfo = {};
    this.id = `hci-perf-${Math.random().toString(36).slice(2)}`;
    this.onKeyDown = (event) => {
      if (event.code === 'F9') {
        event.preventDefault();
        this.setEnabled(!this.enabled);
      }
    };
    window.addEventListener('keydown', this.onKeyDown);
    this.setEnabled(new URLSearchParams(window.location.search).get('perf') === '1');
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled && !this.overlay) {
      const overlay = document.createElement('pre');
      overlay.dataset.hciPerfOverlay = this.id;
      Object.assign(overlay.style, {
        position: 'fixed',
        right: '12px',
        top: '88px',
        zIndex: '2147483000',
        margin: '0',
        padding: '12px 14px',
        minWidth: '260px',
        maxWidth: 'min(390px, 45vw)',
        maxHeight: '55vh',
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,.18)',
        borderRadius: '10px',
        background: 'rgba(11,16,30,.92)',
        color: '#d8f9e7',
        boxShadow: '0 10px 34px rgba(0,0,0,.25)',
        font: '11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
        backdropFilter: 'blur(10px)',
      });
      document.body.appendChild(overlay);
      this.overlay = overlay;
      if (this.latest) this._renderOverlay();
    } else if (!this.enabled && this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    if (this.latest) this._publish(this.latest);
  }

  setLoadInfo(info) {
    this.loadInfo = { ...this.loadInfo, ...(info || {}) };
    if (this.latest) {
      this.latest = { ...this.latest, load: this.loadInfo };
      this._publish(this.latest);
      this._renderOverlay();
    }
  }

  setModel(model) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const metrics = {
      nodeCount: 0,
      meshInstances: 0,
      uniqueGeometries: 0,
      sourceVertices: 0,
      sourceTriangles: 0,
      materialCount: 0,
      sourceTextureCount: 0,
      estimatedDecodedTextureBytes: 0,
      visibleMeshInstances: 0,
    };
    model?.traverse?.((object) => {
      metrics.nodeCount += 1;
      if (!object.isMesh || !object.geometry) return;
      metrics.meshInstances += 1;
      if (object.visible) metrics.visibleMeshInstances += 1;
      geometries.add(object.geometry);
      const position = object.geometry.attributes?.position;
      const count = Number(position?.count || 0);
      metrics.sourceVertices += count;
      const indices = object.geometry.index;
      metrics.sourceTriangles += Math.floor(Number(indices?.count || count) / 3);
      const materialList = Array.isArray(object.material) ? object.material : [object.material];
      materialList.forEach((material) => {
        if (!material) return;
        materials.add(material);
        for (const value of Object.values(material)) {
          if (!value?.isTexture) continue;
          textures.add(value);
        }
      });
    });
    metrics.uniqueGeometries = geometries.size;
    metrics.materialCount = materials.size;
    metrics.sourceTextureCount = textures.size;
    for (const texture of textures) {
      const image = texture.image || texture.source?.data;
      const width = Number(image?.width || image?.videoWidth || 0);
      const height = Number(image?.height || image?.videoHeight || 0);
      if (width > 0 && height > 0) metrics.estimatedDecodedTextureBytes += width * height * 4;
    }
    this.modelMetrics = metrics;
    const jobPath = this.loadInfo.jobId ? `/jobs/${encodeURIComponent(this.loadInfo.jobId)}/output.glb` : '/output.glb';
    const outputEntry = performance.getEntriesByType('resource')
      .filter((entry) => String(entry.name).includes(jobPath))
      .slice(-1)[0];
    this.setLoadInfo({
      outputGlbTransferBytes: Number(outputEntry?.transferSize || 0) || null,
      outputGlbDecodedBytes: Number(outputEntry?.decodedBodySize || 0) || null,
    });
  }

  recordFrame(frameTimeMs) {
    this.frameTimes.push(Math.max(0, Number(frameTimeMs) || 0));
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    this.framesSinceSample += 1;
    const now = performance.now();
    const elapsed = now - this.lastSampleAt;
    if (elapsed < 1000) return;

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const meanFrameMs = this.frameTimes.length
      ? this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length
      : 0;
    const p95Index = sorted.length ? Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1) : 0;
    const info = this.renderer?.info;
    const canvas = this.renderer?.domElement;
    const latest = {
      timestamp: new Date().toISOString(),
      fps: Number((this.framesSinceSample * 1000 / elapsed).toFixed(1)),
      frameTimeMs: {
        average: Number(meanFrameMs.toFixed(2)),
        p95: Number((sorted[p95Index] || 0).toFixed(2)),
        max: Number((sorted[sorted.length - 1] || 0).toFixed(2)),
      },
      render: {
        drawCalls: Number(info?.render?.calls || 0),
        triangles: Number(info?.render?.triangles || 0),
        points: Number(info?.render?.points || 0),
        lines: Number(info?.render?.lines || 0),
      },
      gpuResources: {
        geometries: Number(info?.memory?.geometries || 0),
        textures: Number(info?.memory?.textures || 0),
        shaderPrograms: Number(info?.programs?.length || 0),
        estimatedDecodedTextureMiB: Number((this.modelMetrics.estimatedDecodedTextureBytes / 1048576).toFixed(2)),
      },
      model: { ...this.modelMetrics },
      viewport: {
        width: Number(canvas?.width || 0),
        height: Number(canvas?.height || 0),
        devicePixelRatio: Number(this.renderer?.getPixelRatio?.() || window.devicePixelRatio || 1),
      },
      load: { ...this.loadInfo },
    };
    this.latest = latest;
    this.lastSampleAt = now;
    this.framesSinceSample = 0;
    this._publish(latest);
    if (this.enabled) {
      this._renderOverlay();
      if (now - this.lastConsoleAt > 5000) {
        console.info('[HCI Perf] runtime sample', latest);
        this.lastConsoleAt = now;
      }
    }
  }

  _publish(snapshot) {
    window.__HCI_PERF__ = snapshot;
  }

  _renderOverlay() {
    if (!this.overlay || !this.latest) return;
    const s = this.latest;
    const fmt = (bytes) => bytes == null ? 'n/a' : `${(Number(bytes) / 1048576).toFixed(2)} MiB`;
    this.overlay.textContent = [
      'HCI PERFORMANCE · F9 toggles HUD',
      `FPS ${s.fps} | frame avg ${s.frameTimeMs.average} ms | p95 ${s.frameTimeMs.p95} ms`,
      `Draw calls ${s.render.drawCalls} | triangles ${s.render.triangles.toLocaleString()}`,
      `GPU geoms ${s.gpuResources.geometries} | textures ${s.gpuResources.textures} | programs ${s.gpuResources.shaderPrograms}`,
      `Model nodes ${s.model.nodeCount} | meshes ${s.model.meshInstances} | unique geo ${s.model.uniqueGeometries}`,
      `Source verts ${s.model.sourceVertices.toLocaleString()} | source tris ${s.model.sourceTriangles.toLocaleString()}`,
      `Materials ${s.model.materialCount} | textures ${s.model.sourceTextureCount} | decoded tex est ${s.gpuResources.estimatedDecodedTextureMiB} MiB`,
      `DPR ${s.viewport.devicePixelRatio} | canvas ${s.viewport.width}×${s.viewport.height}`,
      `GLB transfer ${fmt(s.load.outputGlbTransferBytes)} | navmesh ${fmt(s.load.navigationMeshBytes)}`,
      `job ${s.load.jobId || 'unknown'} | samples update every 1 s`,
    ].join('\n');
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    this.overlay?.remove();
    this.overlay = null;
    if (window.__HCI_PERF__ === this.latest) delete window.__HCI_PERF__;
  }
}
