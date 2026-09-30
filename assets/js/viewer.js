(function (CM) {
  'use strict';

  // Zoomable, pannable canvas view of the source image with an overlay layer,
  // draggable handles and a pixel loupe.
  //
  // Interaction: wheel zooms around the cursor; dragging empty space pans
  // (left drag, middle drag, or space + drag); a click without movement is
  // reported via onClick; dragging a handle reported by hitTest moves it.

  const DRAG_THRESHOLD = 4;
  const LOUPE_SIZE = 132;
  const LOUPE_ZOOM = 8;

  class Viewer {
    constructor(container, callbacks) {
      this.container = container;
      this.cb = callbacks; // {onClick, hitTest, onHandleDrag, onHandleDrop, onHover, drawOverlay, wantsLoupe}
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'viewer-canvas';
      this.loupe = document.createElement('canvas');
      this.loupe.className = 'viewer-loupe';
      this.loupe.width = this.loupe.height = LOUPE_SIZE;
      // Insert first so overlays already in the container (empty state, drop hint) stay on top.
      container.prepend(this.canvas, this.loupe);
      this.ctx = this.canvas.getContext('2d');
      this.source = null;
      this.scale = 1;
      this.ox = 0;
      this.oy = 0;
      this.pointer = null;
      this.hover = null;
      this.spaceDown = false;
      this.dirty = false;

      new ResizeObserver(() => this.resize()).observe(container);
      this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
      this.canvas.addEventListener('pointercancel', () => (this.pointer = null));
      this.canvas.addEventListener('pointerleave', () => {
        this.hover = null;
        this.cb.onHover?.(null);
        this.requestDraw();
      });
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !isTyping(e)) {
          this.spaceDown = true;
          this.canvas.classList.add('grab');
          e.preventDefault();
        }
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
          this.spaceDown = false;
          this.canvas.classList.remove('grab');
        }
      });
    }

    setSource(canvas, { keepView = false } = {}) {
      this.source = canvas;
      if (!keepView) this.fit();
      this.requestDraw();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = this.container;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      if (!this.fitted && this.source) this.fit();
      this.draw();
    }

    fit() {
      if (!this.source) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (!w || !h) return;
      const pad = 16;
      this.scale = Math.min((w - 2 * pad) / this.source.width, (h - 2 * pad) / this.source.height);
      this.ox = (w - this.source.width * this.scale) / 2;
      this.oy = (h - this.source.height * this.scale) / 2;
      this.fitted = true;
      this.requestDraw();
    }

    zoomBy(factor, sx, sy) {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      sx ??= w / 2;
      sy ??= h / 2;
      const next = Math.min(64, Math.max(0.02, this.scale * factor));
      const f = next / this.scale;
      this.ox = sx - (sx - this.ox) * f;
      this.oy = sy - (sy - this.oy) * f;
      this.scale = next;
      this.requestDraw();
    }

    // Focus the view on an image-space rectangle.
    zoomTo(x0, y0, x1, y1) {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      const pad = 40;
      this.scale = Math.min(64, (w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0));
      this.ox = w / 2 - ((x0 + x1) / 2) * this.scale;
      this.oy = h / 2 - ((y0 + y1) / 2) * this.scale;
      this.requestDraw();
    }

    toImage(sx, sy) {
      return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale };
    }

    toScreen(p) {
      return { x: p.x * this.scale + this.ox, y: p.y * this.scale + this.oy };
    }

    eventPoint(e) {
      const r = this.canvas.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    }

    onWheel(e) {
      e.preventDefault();
      const { sx, sy } = this.eventPoint(e);
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const unit = e.deltaMode === 1 ? 16 : 1;
        this.zoomBy(Math.exp((-e.deltaY * unit) / (e.ctrlKey ? 100 : 400)), sx, sy);
      } else {
        this.ox -= e.deltaX;
        this.requestDraw();
      }
    }

    onPointerDown(e) {
      if (!this.source) return;
      const { sx, sy } = this.eventPoint(e);
      const img = this.toImage(sx, sy);
      const panOnly = e.button === 1 || this.spaceDown;
      if (e.button === 2) return;
      const handle = panOnly ? null : this.cb.hitTest?.(img, 8 / this.scale);
      this.pointer = { id: e.pointerId, sx, sy, ox: this.ox, oy: this.oy, moved: false, handle, panOnly, shift: e.shiftKey, alt: e.altKey };
      this.canvas.setPointerCapture(e.pointerId);
      if (handle) this.canvas.classList.add('dragging');
    }

    onPointerMove(e) {
      if (!this.source) return;
      const { sx, sy } = this.eventPoint(e);
      const img = this.toImage(sx, sy);
      this.hover = { sx, sy, img };
      const p = this.pointer;
      if (p && p.id === e.pointerId) {
        if (!p.moved && Math.hypot(sx - p.sx, sy - p.sy) > DRAG_THRESHOLD) p.moved = true;
        if (p.moved) {
          if (p.handle) {
            this.cb.onHandleDrag?.(p.handle, img, e);
          } else {
            this.ox = p.ox + (sx - p.sx);
            this.oy = p.oy + (sy - p.sy);
            this.canvas.classList.add('grabbing');
          }
        }
      } else {
        const handle = this.cb.hitTest?.(img, 8 / this.scale);
        this.canvas.classList.toggle('over-handle', !!handle);
      }
      this.cb.onHover?.(img);
      this.requestDraw();
    }

    onPointerUp(e) {
      const p = this.pointer;
      if (!p || p.id !== e.pointerId) return;
      this.pointer = null;
      this.canvas.classList.remove('grabbing', 'dragging');
      const { sx, sy } = this.eventPoint(e);
      if (p.handle && p.moved) this.cb.onHandleDrop?.(p.handle);
      else if (!p.moved && !p.panOnly && e.button === 0) this.cb.onClick?.(this.toImage(sx, sy), e);
      this.requestDraw();
    }

    requestDraw() {
      if (this.dirty) return;
      this.dirty = true;
      requestAnimationFrame(() => {
        this.dirty = false;
        this.draw();
      });
    }

    draw() {
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.source) {
        this.loupe.style.display = 'none';
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = this.scale < 2;
      ctx.drawImage(this.source, this.ox, this.oy, this.source.width * this.scale, this.source.height * this.scale);
      this.cb.drawOverlay?.(ctx, this);
      this.drawLoupe();
    }

    drawLoupe() {
      const show = this.hover && (this.pointer?.handle || this.cb.wantsLoupe?.()) && this.scale < LOUPE_ZOOM;
      if (!show) {
        this.loupe.style.display = 'none';
        return;
      }
      const { sx, sy, img } = this.hover;
      const lc = this.loupe.getContext('2d');
      const half = LOUPE_SIZE / 2;
      lc.imageSmoothingEnabled = false;
      lc.fillStyle = '#808080';
      lc.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
      const srcSize = LOUPE_SIZE / LOUPE_ZOOM;
      lc.drawImage(this.source, img.x - srcSize / 2, img.y - srcSize / 2, srcSize, srcSize, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
      lc.strokeStyle = 'rgba(0,0,0,0.8)';
      lc.lineWidth = 3;
      lc.beginPath();
      lc.moveTo(half, 0);
      lc.lineTo(half, LOUPE_SIZE);
      lc.moveTo(0, half);
      lc.lineTo(LOUPE_SIZE, half);
      lc.stroke();
      lc.strokeStyle = 'rgba(255,255,255,0.95)';
      lc.lineWidth = 1;
      lc.stroke();
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      let lx = sx + 24;
      let ly = sy + 24;
      if (lx + LOUPE_SIZE > w) lx = sx - 24 - LOUPE_SIZE;
      if (ly + LOUPE_SIZE > h) ly = sy - 24 - LOUPE_SIZE;
      this.loupe.style.display = 'block';
      this.loupe.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
    }
  }

  function isTyping(e) {
    const t = e.target;
    return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  Object.assign(CM, { Viewer });
})((globalThis.Colormeris ??= {}));
