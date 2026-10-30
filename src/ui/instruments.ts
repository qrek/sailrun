/**
 * Instruments de bord, façon répétiteurs de navigation :
 * - un speedomètre à aiguille (vitesse, vitesse cible de la polaire)
 * - un compas-anémomètre : rose des caps qui tourne sous la ligne de foi, silhouette du bateau,
 *   flèche du vent, secteurs de près bâbord (rouge) et tribord (vert), cap de la route conseillée
 */

const P = (a: number, r: number) => {
  const t = (a * Math.PI) / 180;
  return [r * Math.sin(t), -r * Math.cos(t)];
};
const f = (n: number) => n.toFixed(2);
const arc = (a0: number, a1: number, r: number) => {
  const [x0, y0] = P(a0, r);
  const [x1, y1] = P(a1, r);
  return `M${f(x0)},${f(y0)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0},1 ${f(x1)},${f(y1)}`;
};

export const SPEED_MAX = 35;
const SA0 = -135;
const SA1 = 135;
const speedAngle = (v: number) => SA0 + ((SA1 - SA0) * Math.max(0, Math.min(SPEED_MAX, v))) / SPEED_MAX;

/** Speedomètre : cadran 270°, graduations tous les nœuds, aiguille, valeur numérique au centre. */
export function speedGauge(): string {
  let ticks = '';
  for (let v = 0; v <= SPEED_MAX; v++) {
    const a = speedAngle(v);
    const major = v % 5 === 0;
    const [x0, y0] = P(a, major ? 34 : 37);
    const [x1, y1] = P(a, 41);
    ticks += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" class="${major ? 'tk M' : 'tk'}"/>`;
    if (v % 10 === 0) {
      const [lx, ly] = P(a, 30);
      ticks += `<text x="${f(lx)}" y="${f(ly + 3)}" class="tl">${v}</text>`;
    }
  }
  return `
    <svg class="gauge speedo" viewBox="-50 -50 100 100" role="img" aria-label="Vitesse du bateau">
      <circle r="48" class="bezel"/>
      <circle r="44" class="face"/>
      <path d="${arc(SA0, SA1, 41)}" class="track"/>
      <path d="${arc(SA0, SA1, 41)}" class="prog" pathLength="100" stroke-dasharray="0 100" data-g-prog/>
      ${ticks}
      <g data-g-target><path d="M0,-44 L-3.2,-49 L3.2,-49 Z" class="target"/></g>
      <g data-g-needle><path d="M-1.6,4 L0,-38 L1.6,4 Z" class="needle"/></g>
      <circle r="4.5" class="hub"/>
      <text y="24" class="val" data-spd>0.0</text>
      <text y="32" class="unit">NŒUDS</text>
      <text y="44" class="sub" data-sub>VENT 0 NDS</text>
    </svg>`;
}

export function setSpeed(root: ParentNode, v: number, target: number) {
  const q = (s: string) => root.querySelector(s)!;
  q('[data-g-needle]').setAttribute('transform', `rotate(${speedAngle(v).toFixed(1)})`);
  q('[data-g-target]').setAttribute('transform', `rotate(${speedAngle(target).toFixed(1)})`);
  q('[data-g-prog]').setAttribute('stroke-dasharray', `${((Math.min(SPEED_MAX, v) / SPEED_MAX) * 100).toFixed(1)} 100`);
  q('[data-spd]').textContent = v.toFixed(1);
}

/** Compas-anémomètre. */
export function windCompass(): string {
  // rose des caps (elle tourne avec le cap du bateau)
  let rose = '';
  for (let d = 0; d < 360; d += 5) {
    const major = d % 30 === 0;
    const mid = d % 10 === 0;
    const [x0, y0] = P(d, major ? 47 : mid ? 49 : 50.5);
    const [x1, y1] = P(d, 53);
    rose += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" class="${major ? 'tk M' : 'tk'}"/>`;
  }
  const lab: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
  for (let d = 0; d < 360; d += 30) {
    const [x, y] = P(d, 40.5);
    if (!lab[d]) continue;
    const txt = lab[d];
    rose += `<text x="${f(x)}" y="${f(y + 3)}" transform="rotate(${d} ${f(x)} ${f(y)})" class="${lab[d] ? 'cl C' : 'cl'}">${txt}</text>`;
  }
  // secteurs de près : bâbord rouge, tribord vert (fixes, par rapport à l'étrave)
  const sectors = `<path d="${arc(-60, -25, 32)}" class="port"/><path d="${arc(25, 60, 32)}" class="stbd"/><path d="${arc(-25, 25, 32)}" class="nogo"/>`;
  // silhouette de coque vue de dessus, étrave vers le haut
  const hull = '<path d="M0,-21 C6,-13 7.5,-3 7,9 L6.4,17 L-6.4,17 L-7,9 C-7.5,-3 -6,-13 0,-21 Z" class="hull"/><line x1="0" y1="-10" x2="0" y2="13" class="boom" data-boom/><circle cy="-10" r="1.8" class="mast"/>';
  return `
    <svg class="gauge compassg" viewBox="-60 -60 120 120" role="img" aria-label="Compas et vent">
      <circle r="58" class="bezel"/>
      <circle r="54.5" class="face"/>
      <g data-rose>${rose}<g data-wp><path d="M0,-55 L-4,-48.5 L0,-46 L4,-48.5 Z" class="wp"/></g></g>
      <circle r="35" class="inner"/>
      ${sectors}
      ${hull}
      <g data-wind><path d="M0,-34 L0,-22" class="wshaft"/><path d="M-5,-28 L0,-21 L5,-28" class="whead"/></g>
      <path d="M0,-54 L-4.5,-60 L4.5,-60 Z" class="lubber"/>
      <rect x="-14" y="-31" width="28" height="11" rx="2.5" class="lcd"/>
      <text y="-22.6" class="hdg" data-hdg>000°</text>
      <text y="30" class="twa" data-twa>0°</text>
    </svg>`;
}

/** hdg : cap ; twa : angle du vent (négatif = bâbord) ; wp : cap de la route conseillée ou null. */
export function setCompass(root: ParentNode, hdg: number, twa: number, wp: number | null) {
  const q = (s: string) => root.querySelector(s)!;
  q('[data-rose]').setAttribute('transform', `rotate(${(-hdg).toFixed(1)})`);
  q('[data-wind]').setAttribute('transform', `rotate(${twa.toFixed(1)})`);
  const w = q('[data-wp]') as SVGGElement;
  w.style.display = wp === null ? 'none' : '';
  if (wp !== null) w.setAttribute('transform', `rotate(${wp.toFixed(1)})`);
  q('[data-hdg]').textContent = `${String(Math.round(((hdg % 360) + 360) % 360)).padStart(3, '0')}°`;
  const t = q('[data-twa]');
  const a = Math.round(Math.abs(twa));
  t.textContent = `${a}° ${twa < 0 ? 'BÂB' : 'TRI'}`;
  t.setAttribute('class', `twa ${a < 34 ? 'bad' : twa < 0 ? 'p' : 's'}`);
  // la bôme passe du côté sous le vent
  q('[data-boom]').setAttribute('transform', `rotate(${(-Math.sign(twa) * Math.min(80, Math.abs(twa) * 0.5)).toFixed(1)} 0 -10)`);
}

/* ---------- bandeau de cap à faire glisser (comme sur VR) ---------- */

const TAPE_W = 300;
const TAPE_DEG = 90; // degrés visibles sur toute la largeur
const PX = TAPE_W / TAPE_DEG;

export function headingTape(): string {
  return `
    <div class="tape" data-tape role="slider" tabindex="0" aria-label="Cap : glisse pour tourner" aria-valuemin="0" aria-valuemax="359">
      <svg viewBox="0 0 ${TAPE_W} 40" preserveAspectRatio="none" aria-hidden="true"><g data-tape-g></g></svg>
      <span class="tape-mark"></span>
      <span class="tape-val" data-tape-val>000°</span>
    </div>`;
}

const wrap = (d: number) => ((d % 360) + 360) % 360;
const delta = (a: number, b: number) => ((a - b + 540) % 360) - 180;

/** Redessine le bandeau : graduations, zone face au vent, direction du vent, cap de la route. */
export function setHeadingTape(root: ParentNode, hdg: number, twd: number, wp: number | null) {
  const g = root.querySelector('[data-tape-g]');
  if (!g) return;
  const cx = TAPE_W / 2;
  const x = (deg: number) => cx + delta(deg, hdg) * PX;
  let s = '';
  // face au vent : zone interdite rouge, ±40° autour du vent
  const nx0 = x(twd - 40);
  const nx1 = x(twd + 40);
  if (Math.abs(delta(twd, hdg)) < 90) s += `<rect x="${Math.min(nx0, nx1).toFixed(1)}" y="0" width="${Math.abs(nx1 - nx0).toFixed(1)}" height="40" class="nogo"/>`;
  const start = Math.floor((hdg - TAPE_DEG / 2 - 10) / 5) * 5;
  for (let d = start; d <= hdg + TAPE_DEG / 2 + 10; d += 5) {
    const px = x(d);
    const w = wrap(d);
    const major = w % 10 === 0;
    s += `<line x1="${px.toFixed(1)}" y1="${major ? 22 : 28}" x2="${px.toFixed(1)}" y2="40" class="${major ? 'tk M' : 'tk'}"/>`;
    if (w % 30 === 0) {
      const lab = w === 0 ? 'N' : w === 90 ? 'E' : w === 180 ? 'S' : w === 270 ? 'O' : String(w);
      s += `<text x="${px.toFixed(1)}" y="16" class="${lab.length === 1 ? 'tl C' : 'tl'}">${lab}</text>`;
    }
  }
  // vent : flèche jaune qui pointe vers le bas (d'où il vient)
  if (Math.abs(delta(twd, hdg)) < TAPE_DEG / 2 + 5) {
    const wx = x(twd);
    s += `<path d="M${(wx - 6).toFixed(1)},2 L${(wx + 6).toFixed(1)},2 L${wx.toFixed(1)},11 Z" class="wind"/>`;
  }
  if (wp !== null && Math.abs(delta(wp, hdg)) < TAPE_DEG / 2 + 5) {
    const rx = x(wp);
    s += `<path d="M${rx.toFixed(1)},26 L${(rx + 5).toFixed(1)},32 L${rx.toFixed(1)},38 L${(rx - 5).toFixed(1)},32 Z" class="wp"/>`;
  }
  g.innerHTML = s;
  const v = root.querySelector('[data-tape-val]');
  if (v) v.textContent = `${String(Math.round(wrap(hdg))).padStart(3, '0')}°`;
}

/** Degrés par pixel quand on fait glisser le bandeau (rapporté à la largeur affichée). */
export function tapeDegPerPx(el: HTMLElement): number {
  return TAPE_DEG / Math.max(1, el.getBoundingClientRect().width);
}

/* ---------- silhouettes des voiles ---------- */
export const SAIL_ART: Record<string, string> = {
  // foc : petit triangle plat, au près
  foc: '<path d="M10 52 L 26 6 L 34 52 Z" class="s"/><path d="M8 56 L 52 56" class="d"/><path d="M42 4 L 42 56" class="m"/>',
  // code 0 : grand triangle à la chute arrondie, travers
  code0: '<path d="M6 52 L 30 5 C 36 20, 40 38, 40 52 Z" class="s"/><path d="M4 56 L 52 56" class="d"/><path d="M46 4 L 46 56" class="m"/>',
  // spi : grande bulle devant l'étrave, portant
  spi: '<path d="M18 52 C 0 40, 2 10, 26 5 C 50 8, 50 40, 34 52 Z" class="s"/><path d="M4 56 L 52 56" class="d"/><path d="M46 4 L 46 56" class="m"/>',
};

/* ---------- pilote : cadran « nord en haut », comme la carte ---------- */

/**
 * Cadran du pilote, orienté comme la carte (nord en haut) : le bateau tourne au centre, comme son icône
 * sur la carte. Autour : la couronne des voiles (la meilleure voile pour chaque cap, en couleur, et la zone
 * face au vent en rouge), la flèche du vent, la consigne et la consigne en cours de réglage. Au centre :
 * la vitesse, le cap et l'angle au vent.
 */
export function pilotDial(): string {
  let rose = '';
  for (let d = 0; d < 360; d += 5) {
    const major = d % 30 === 0;
    const mid = d % 10 === 0;
    const [x0, y0] = P(d, major ? 79 : mid ? 82 : 84);
    const [x1, y1] = P(d, 87);
    rose += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" class="${major ? 'tk M' : mid ? 'tk m' : 'tk'}"/>`;
  }
  const lab: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
  for (const d of [0, 90, 180, 270]) {
    const [x, y] = P(d, 71);
    rose += `<text x="${f(x)}" y="${f(y + 4)}" class="cl C">${lab[d]}</text>`;
  }
  // bateau vu du dessus, étrave en haut avant rotation ; la voile d'avant prend la couleur de la voile portée
  const boat = '<g data-pd-boat><path d="M0,-24 C7,-15 8.5,-4 8,9 L7,19 L-7,19 L-8,9 C-8.5,-4 -7,-15 0,-24 Z" class="hull"/><path d="M0,-21 L0,-8" class="fore" data-pd-jib/><line x1="0" y1="-6" x2="0" y2="16" class="boom" data-pd-boom/><circle cy="-6" r="2" class="mast"/></g>';
  return `
    <svg class="pdial nu" viewBox="-100 -100 200 200" data-pdial role="slider" tabindex="0" aria-label="Pilote : glisse sur le cadran pour choisir un nouveau cap">
      <circle r="98" class="bezel"/>
      <circle r="88" class="face"/>
      <g data-pd-sails></g>
      <g data-pd-rose>${rose}</g>
      <circle r="54" class="inner"/>
      <g data-pd-wp><path d="M0,-88 L-4.5,-81 L0,-77 L4.5,-81 Z" class="wp"/></g>
      <g data-pd-proj><line x1="0" y1="-26" x2="0" y2="-86" class="pline"/></g>
      <g data-pd-cur><line x1="0" y1="-26" x2="0" y2="-54" class="cline"/></g>
      <g data-pd-cons><path d="M0,-99 L-7,-88 L0,-80 L7,-88 Z" class="cons"/></g>
      <g data-pd-pend><path d="M0,-99 L-7,-88 L0,-80 L7,-88 Z" class="pend"/></g>
      <g data-pd-wind><path d="M0,-99 L0,-62" class="wshaft"/><path d="M-7,-71 L0,-60 L7,-71" class="whead"/></g>
      <text class="wtxt" data-pd-wtxt></text>
      ${boat}
      <text y="-30" class="spd" data-pd-spd>0,0</text>
      <text y="-21" class="spu">nds</text>
      <text y="34" class="hdg" data-pd-hdg>000°</text>
      <text y="45" class="twa" data-pd-twa>0°</text>
    </svg>`;
}

export interface PilotView {
  hdg: number;
  twd: number;
  twa: number;
  tws: number;
  spd: number;
  /** voile portée (couleur de la voile d'avant sur le bateau) */
  sailColor: string;
  /** meilleure voile pour un angle au vent donné, et la couleur de chaque voile */
  best: (twa: number) => string;
  colors: Record<string, string>;
  /** consigne active (cap) ou null */
  cons: number | null;
  /** consigne en cours de réglage (cap), ou null */
  pending: number | null;
  wp: number | null;
}

const sailKeys = new WeakMap<Element, string>();

export function setPilotDial(root: ParentNode, v: PilotView) {
  const q = (s: string) => root.querySelector(s) as SVGGElement | null;
  const rot = (sel: string, a: number | null) => {
    const g = q(sel);
    if (!g) return;
    g.style.display = a === null ? 'none' : '';
    if (a !== null) g.setAttribute('transform', `rotate(${a.toFixed(1)})`);
  };
  rot('[data-pd-boat]', v.hdg);
  rot('[data-pd-cur]', v.pending === null ? v.hdg : null);
  rot('[data-pd-wind]', v.twd);
  rot('[data-pd-wp]', v.wp);
  rot('[data-pd-cons]', v.cons);
  rot('[data-pd-pend]', v.pending);
  rot('[data-pd-proj]', v.pending);
  // couronne des voiles : pour chaque cap, la voile qui va le mieux ; en rouge, là où on ne remonte pas
  const sg = q('[data-pd-sails]');
  if (sg) {
    const key = `${Math.round(v.twd / 2)}.${Math.round(v.tws)}`;
    if (sailKeys.get(sg) !== key) {
      sailKeys.set(sg, key);
      let out = '';
      let start = 0;
      let prev = '';
      const kind = (h: number) => {
        const twa = ((v.twd - h + 540) % 360) - 180;
        return Math.abs(twa) < 38 ? 'nogo' : v.best(twa);
      };
      for (let a = 0; a <= 360; a += 3) {
        const k = a === 360 ? '' : kind(a);
        if (k !== prev) {
          if (prev) out += `<path d="${arc(start, a, 62)}" class="${prev === 'nogo' ? 'ngs' : 'ss'}" style="stroke: ${prev === 'nogo' ? '' : v.colors[prev]}"/>`;
          start = a;
          prev = k;
        }
      }
      sg.innerHTML = out;
    }
  }
  const wt = q('[data-pd-wtxt]');
  if (wt) {
    const [x, y] = P(v.twd, 56);
    wt.setAttribute('x', f(x));
    wt.setAttribute('y', f(y + 3));
    wt.textContent = `${Math.round(v.tws)}`;
  }
  const sp = root.querySelector('[data-pd-spd]');
  if (sp) sp.textContent = v.spd.toFixed(1).replace('.', ',');
  const h = root.querySelector('[data-pd-hdg]');
  if (h) h.textContent = `${String(Math.round((((v.pending ?? v.hdg) % 360) + 360) % 360)).padStart(3, '0')}°`;
  const t = root.querySelector('[data-pd-twa]');
  if (t) {
    const a = Math.round(Math.abs(v.twa));
    const pace = a < 38 ? 'FACE AU VENT' : a < 60 ? 'AU PRÈS' : a < 110 ? 'TRAVERS' : a < 150 ? 'LARGUE' : 'ARRIÈRE';
    t.textContent = `${a}° ${v.twa < 0 ? 'BÂB' : 'TRI'} · ${pace}`;
    t.setAttribute('class', `twa ${a < 38 ? 'bad' : v.twa < 0 ? 'p' : 's'}`);
  }
  // la bôme et la voile d'avant passent sous le vent
  const side = -Math.sign(v.twa || 1);
  const boom = root.querySelector('[data-pd-boom]');
  if (boom) boom.setAttribute('transform', `rotate(${(side * Math.min(80, Math.abs(v.twa) * 0.5)).toFixed(1)} 0 -6)`);
  const jib = root.querySelector('[data-pd-jib]') as SVGPathElement | null;
  if (jib) {
    const k = side * Math.min(9, 2 + Math.abs(v.twa) * 0.06);
    jib.setAttribute('d', `M0,-21 Q${f(k * 1.6)},-14 ${f(k)},-6`);
    jib.style.stroke = v.sailColor;
  }
}

/** Angle (°, 0 = haut, sens horaire) du pointeur par rapport au centre du cadran. */
export function dialAngle(el: Element, x: number, y: number): number {
  const r = el.getBoundingClientRect();
  const dx = x - (r.left + r.width / 2);
  const dy = y - (r.top + r.height / 2);
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/* ---------- recouvrement des voiles : quelle voile pour quel angle ---------- */

/** Bande 30°→180° colorée par la meilleure voile à la force de vent actuelle, et l'angle du bateau. */
export function crossoverSvg(best: (twa: number) => string, colors: Record<string, string>, twa: number, pending: number | null): string {
  const W = 300;
  const x = (a: number) => ((a - 30) / 150) * W;
  let s = '';
  let start = 30;
  let cur = best(30);
  const seg = (a0: number, a1: number, id: string) => {
    s += `<rect x="${x(a0).toFixed(1)}" y="8" width="${(x(a1) - x(a0)).toFixed(1)}" height="14" fill="${colors[id]}" class="band"/>`;
  };
  for (let a = 32; a <= 180; a += 2) {
    const b = best(a);
    if (b !== cur) {
      seg(start, a, cur);
      start = a;
      cur = b;
    }
  }
  seg(start, 180, cur);
  // zone morte
  s += `<rect x="0" y="8" width="${x(38).toFixed(1)}" height="14" class="dead"/>`;
  for (const a of [30, 60, 90, 120, 150, 180]) s += `<line x1="${x(a).toFixed(1)}" y1="22" x2="${x(a).toFixed(1)}" y2="27" class="tk"/><text x="${x(a).toFixed(1)}" y="35" class="tl">${a}°</text>`;
  const m = (a: number, cls: string) => {
    const xx = x(Math.max(30, Math.min(180, Math.abs(a))));
    s += `<path d="M${xx.toFixed(1)},6 L${(xx - 5).toFixed(1)},0 L${(xx + 5).toFixed(1)},0 Z" class="${cls}"/><line x1="${xx.toFixed(1)}" y1="6" x2="${xx.toFixed(1)}" y2="24" class="${cls}-l"/>`;
  };
  if (pending !== null) m(pending, 'pm');
  m(twa, 'cm');
  return `<svg viewBox="-6 -2 ${W + 12} 38" class="xover" aria-hidden="true">${s}</svg>`;
}
