import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RACES, RHUM } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { Race, clearRace, loadEntry, loadRace, loadTraining, saveRace } from '../src/sim/race';

/** localStorage en mémoire (les tests tournent hors navigateur). */
class Mem {
  m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const training = RACES.find((r) => !r.fleet)!;

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new Mem();
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('une participation par course officielle', () => {
  it('une course d’entraînement n’efface pas la Route du Rhum', () => {
    const rhum = new Race(RHUM, DEFAULT_SETUP);
    saveRace(rhum);
    clearRace(); // ce que fait un nouveau départ d'entraînement
    saveRace(new Race(training, DEFAULT_SETUP));
    expect(loadEntry(RHUM.id)?.raceId).toBe(RHUM.id);
    expect(loadTraining()?.raceId).toBe(training.id);
  });

  it('l’ancienne sauvegarde de la Route du Rhum passe à sa place à elle', () => {
    const rhum = new Race(RHUM, DEFAULT_SETUP);
    localStorage.setItem('sailgame.race.v1', JSON.stringify(rhum.serialize()));
    expect(loadEntry(RHUM.id)?.raceId).toBe(RHUM.id);
    expect(loadTraining()).toBeNull();
    expect(loadRace()?.raceId).toBe(RHUM.id);
  });

  it('à l’arrivée, la participation reste (marquée arrivée) et n’est plus proposée à la reprise générale', () => {
    const rhum = new Race(RHUM, DEFAULT_SETUP);
    rhum.player.finished = 240;
    saveRace(rhum);
    expect(loadEntry(RHUM.id)?.boats.find((b) => b.isPlayer)?.finished).toBe(240);
    expect(loadRace()).toBeNull();
  });
});
