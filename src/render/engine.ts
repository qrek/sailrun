import * as THREE from 'three';

export interface InputHandler {
  drag?(dx: number, dy: number): void;
  pinch?(ratio: number): void;
  wheel?(dy: number): void;
}

/** Un seul renderer WebGL pour tout le jeu, plus la gestion souris / tactile du canvas. */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly small: boolean;
  w = 1;
  h = 1;
  input: InputHandler | null = null;
  private resizeFns: ((w: number, h: number) => void)[] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    host.appendChild(this.canvas);
    this.small = Math.min(window.innerWidth, window.innerHeight) < 700;
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  onResize(f: (w: number, h: number) => void) {
    this.resizeFns.push(f);
    f(this.w, this.h);
  }

  resize() {
    this.w = Math.max(1, this.host.clientWidth);
    this.h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.w, this.h, false);
    for (const f of this.resizeFns) f(this.w, this.h);
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinchDist = this.spread();
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) this.input?.drag?.(dx, dy);
      else if (this.pointers.size === 2) {
        const d = this.spread();
        if (this.pinchDist > 0 && d > 0) this.input?.pinch?.(this.pinchDist / d);
        this.pinchDist = d;
      }
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.input?.wheel?.(e.deltaY);
      },
      { passive: false },
    );
  }

  private spread(): number {
    const p = [...this.pointers.values()];
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }
}
