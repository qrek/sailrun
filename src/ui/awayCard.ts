import { Recap, RecapKind } from '../sim/recap';
import { esc } from './dom';
import { fmtDist } from './units';

/** « 40 min », « 7 h 40 », « 3 j 4 h ». */
export function fmtAway(hours: number): string {
  const min = Math.round(hours * 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  if (hours < 48) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
  }
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h ? `${d} j ${h} h` : `${d} j`;
}

const DOT: Record<RecapKind, string> = {
  mark: 'gold',
  checkpoint: 'gold',
  finish: 'gold',
  route: 'warn',
  land: 'bad',
  avarie: 'bad',
  repaired: 'good',
  manoeuvre: '',
  sail: '',
};

/** Les noms en une ligne : « Dalin, Ruyant et 3 autres ». */
function names(list: string[]): string {
  if (list.length <= 3) return list.map(esc).join(', ').replace(/, ([^,]*)$/, ' et $1');
  return `${list.slice(0, 2).map(esc).join(', ')} et ${list.length - 2} autres`;
}

/** Carte « Pendant ton absence », par-dessus la carte ; se ferme d'un geste. */
export function showAwayCard(root: HTMLElement, r: Recap, onNotify?: () => Promise<boolean>) {
  root.querySelector('.away')?.remove();
  const delta = r.rankBefore - r.rankAfter;
  const trend = delta > 0 ? `<span class="aw-delta up">+${delta}</span>` : delta < 0 ? `<span class="aw-delta down">${delta}</span>` : '<span class="aw-delta">=</span>';
  const gain = r.gained >= 0 ? `+${fmtDist(r.gained)}` : `−${fmtDist(-r.gained)}`;
  const el = document.createElement('div');
  el.className = 'away';
  el.innerHTML = `
    <div class="aw-card" role="dialog" aria-labelledby="aw-title">
      <span class="eyebrow">Pendant ton absence · ${fmtAway(r.hours)}</span>
      <div class="aw-rank">
        <b class="num" id="aw-title">${r.rankAfter}<sup>e</sup></b>
        <span class="aw-of">sur ${r.fleet}</span>
        ${trend}
        <small>${delta === 0 ? 'Même place qu’à ton départ' : `${r.rankBefore}<sup>e</sup> quand tu es parti`}</small>
      </div>
      <div class="aw-stats">
        <div><b class="num">${gain}</b><small>vers l’arrivée</small></div>
        <div><b class="num">${r.vmg.toFixed(1).replace('.', ',')} nds</b><small>de moyenne utile</small></div>
      </div>
      ${r.passed.length ? `<p class="aw-line up">Tu as doublé ${names(r.passed)}.</p>` : ''}
      ${r.passedBy.length ? `<p class="aw-line down">${names(r.passedBy)} ${r.passedBy.length > 1 ? 't’ont doublé' : 't’a doublé'}.</p>` : ''}
      ${r.items.length ? `<ul class="aw-items">${r.items.map((i) => `<li><span class="aw-dot ${DOT[i.kind]}"></span>${esc(i.text)}</li>`).join('')}</ul>` : ''}
      <button type="button" class="btn cta" data-aw-go>Reprendre la barre</button>
      ${onNotify ? '<button type="button" class="aw-notify" data-aw-notify>Me prévenir la prochaine fois</button>' : ''}
    </div>`;
  root.appendChild(el);
  const close = () => {
    el.classList.add('out');
    window.removeEventListener('keydown', onKey);
    setTimeout(() => el.remove(), 180);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') close();
  };
  window.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  const go = el.querySelector<HTMLButtonElement>('[data-aw-go]')!;
  go.addEventListener('click', close);
  go.focus();
  const nb = el.querySelector<HTMLButtonElement>('[data-aw-notify]');
  nb?.addEventListener('click', async () => {
    nb.disabled = true;
    const ok = await onNotify!();
    nb.textContent = ok ? 'C’est noté : on te prévient quand ton bateau a besoin de toi' : 'Notifications non activées';
    nb.classList.toggle('ok', ok);
  });
}
