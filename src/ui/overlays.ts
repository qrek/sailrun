import { Race } from '../sim/race';
import { esc, fmtDuration, q } from './dom';
import { fmtDist } from './units';

/** Panneau « comment jouer », affiché au premier départ. */
export function showIntro(root: HTMLElement, raceName: string, onGo: () => void) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `
    <div class="panel" role="dialog" aria-labelledby="intro-title">
      <span class="eyebrow">${esc(raceName)}</span>
      <h1 id="intro-title">Comment on joue</h1>
      <ul>
        <li><b>Barre</b> avec <span class="kbd">←</span> <span class="kbd">→</span> ou les flèches à l’écran. Le cadran montre d’où vient le vent (flèche jaune). Face au vent (zone rouge), le bateau n’avance pas.</li>
        <li><b>Cap ou Angle</b> : en « Cap », le bateau garde sa direction. En « Angle », il garde son angle au vent et suit les bascules. Le pointillé blanc montre où tu seras dans 2, 5, 12 et 24 h.</li>
        <li><b>Trois voiles</b> : Foc au près, Code 0 au travers, Spi au portant. L’étoile indique la meilleure. En « Auto », elles changent toutes seules. Le bouton polaire explique pourquoi.</li>
        <li><b>Prévisions</b> : fais glisser le curseur au-dessus de la barre pour voir le vent des 5 prochains jours. Le rond jaune montre où sera ton bateau.</li>
        <li><b>Énergie</b> : sous 25 %, ton skipper est épuisé et le bateau va 12 % moins vite. Une sieste de 2 h le remet d’aplomb, mais pendant qu’il dort personne ne règle les voiles : choisis un moment où le vent est stable.</li>
        <li><b>Immersif</b> (touche <span class="kbd">I</span>) : la caméra descend au ras de l’eau, près de ton bateau. On revient à la carte avec 3D.</li>
        <li><b>Perdu ?</b> « Suivre la route » confie la barre au pilote, qui suit la route conseillée (les points jaunes).</li>
      </ul>
      <div class="actions"><button type="button" class="btn cta" data-go>Larguer les amarres</button></div>
    </div>`;
  root.appendChild(el);
  const go = q<HTMLButtonElement>(el, '[data-go]');
  go.focus();
  go.addEventListener('click', () => {
    el.remove();
    onGo();
  });
}

/** Résultats quand le joueur franchit la ligne. */
export function showFinish(root: HTMLElement, race: Race, onMenu: () => void, onWatch: () => void) {
  const order = race.standings();
  const me = order.indexOf(race.player);
  const dur = race.player.finished ?? race.t;
  const el = document.createElement('div');
  el.className = 'overlay';
  const rows = order
    .map((b, i) => {
      const g = b.finished !== null ? fmtDuration(b.finished) : `à ${fmtDist(race.remaining(b))}`;
      return `<li class="${b.isPlayer ? 'me' : ''}"><span class="dot" style="background: ${b.color}"></span><span>${i + 1}. ${esc(b.isPlayer ? 'Toi' : b.name)}</span><span class="g">${g}</span></li>`;
    })
    .join('');
  el.innerHTML = `
    <div class="panel" role="dialog" aria-labelledby="fin-title">
      <span class="eyebrow">Arrivée à ${esc(race.def.to)}</span>
      <h1 id="fin-title">${me === 0 ? 'Victoire !' : `${me + 1}<sup>e</sup> à l’arrivée`}</h1>
      <p>${esc(race.def.name)} bouclé en ${fmtDuration(dur)} de course.</p>
      <ol class="results">${rows}</ol>
      <div class="actions">
        <button type="button" class="btn cta" data-port>Retour au port</button>
        <button type="button" class="btn ghost" data-watch>Regarder la fin</button>
      </div>
    </div>`;
  root.appendChild(el);
  q(el, '[data-port]').addEventListener('click', () => {
    el.remove();
    onMenu();
  });
  q(el, '[data-watch]').addEventListener('click', () => {
    el.remove();
    onWatch();
  });
}
