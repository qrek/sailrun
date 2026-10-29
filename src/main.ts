import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow/600-italic.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/barlow-condensed/800-italic.css';
import './style.css';
import { Game } from './game';

const game = new Game(document.getElementById('app')!);
// accès depuis la console pour déboguer : window.game
(window as unknown as { game: Game }).game = game;
