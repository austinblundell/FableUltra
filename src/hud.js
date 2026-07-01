// ============================================================================
// hud.js — all DOM UI for FableUltra Basketball.
//
// Self-contained broadcast-package HUD: start menu, scoreboard, shot meter,
// toasts, pause + game-over overlays. Builds every element and injects its
// own <style> tag from the constructor; appends to document.body.
//
// Public API (see main.js):
//   new HUD()
//   hud.onStart = ({quarterMinutes, difficulty}) => {}
//   hud.update(snapshot)
//   hud.showMessage(text, seconds = 2, accentColor)
//   hud.setPaused(bool)
//   hud.showGameOver({homeScore, awayScore, winnerName})
// ============================================================================

import { TEAMS } from './constants.js';

const HOME = TEAMS[0];
const AWAY = TEAMS[1];

const CSS = `
:root {
  --fu-glass: rgba(8, 10, 18, 0.82);
  --fu-border: rgba(255, 255, 255, 0.12);
  --fu-gold: #ffd86b;
  --fu-gold-deep: #e08a1e;
  --fu-home: ${HOME.primary};
  --fu-home2: ${HOME.secondary};
  --fu-away: ${AWAY.primary};
  --fu-away2: ${AWAY.secondary};
}
.fu-root {
  position: fixed; inset: 0; z-index: 100;
  pointer-events: none;
  font-family: 'Arial Black', 'Arial Bold', Arial, Helvetica, sans-serif;
  color: #fff;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
.fu-root * { box-sizing: border-box; }

/* ---- shared glass / skew ---- */
.fu-glass {
  background: var(--fu-glass);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border: 1px solid var(--fu-border);
}
.fu-skew { transform: skewX(-8deg); }
.fu-unskew { transform: skewX(8deg); display: inline-block; }

/* ============================ START SCREEN ============================ */
.fu-start {
  position: absolute; inset: 0;
  pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
  background:
    repeating-linear-gradient(115deg,
      rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 2px,
      transparent 2px, transparent 26px),
    radial-gradient(ellipse at 50% 35%, rgba(28, 40, 78, 0.95) 0%, rgba(6, 8, 15, 0.98) 68%);
  opacity: 1; transition: opacity 0.35s ease;
}
.fu-start.fu-hidden { opacity: 0; pointer-events: none; }
.fu-start-inner {
  display: flex; flex-direction: column; align-items: center;
  gap: 22px; padding: 30px 20px; max-width: 720px; width: 94%;
  max-height: 96vh; overflow-y: auto;
}
.fu-title {
  font-style: italic; font-size: clamp(34px, 5.4vw, 58px);
  letter-spacing: 5px; line-height: 1; text-align: center;
  background: linear-gradient(180deg, #ffe9a8 0%, var(--fu-gold) 45%, var(--fu-gold-deep) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 4px 14px rgba(224, 138, 30, 0.35));
}
.fu-matchup {
  display: flex; align-items: center; gap: 14px;
  font-style: italic; font-size: 17px; letter-spacing: 3px;
  color: rgba(255,255,255,0.9);
}
.fu-chip {
  padding: 5px 14px; font-size: 14px; letter-spacing: 2px;
  border-radius: 3px; box-shadow: 0 2px 10px rgba(0,0,0,0.5);
}
.fu-chip.fu-home { background: var(--fu-home); border-bottom: 3px solid var(--fu-home2); }
.fu-chip.fu-away { background: var(--fu-away); border-bottom: 3px solid var(--fu-away2); color: #fff; }
.fu-vs { color: var(--fu-gold); font-size: 13px; }

.fu-optrow { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.fu-optlabel {
  font-size: 11px; letter-spacing: 4px; color: rgba(255,255,255,0.55);
  font-style: italic;
}
.fu-seg { display: flex; }
.fu-seg button {
  pointer-events: auto; cursor: pointer;
  font: inherit; font-size: 14px; letter-spacing: 2px;
  color: rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--fu-border); border-right-width: 0;
  padding: 9px 20px; transition: background 0.15s, color 0.15s;
}
.fu-seg button:first-child { border-radius: 4px 0 0 4px; }
.fu-seg button:last-child { border-radius: 0 4px 4px 0; border-right-width: 1px; }
.fu-seg button:hover { background: rgba(255,255,255,0.12); color: #fff; }
.fu-seg button.fu-sel {
  background: linear-gradient(180deg, var(--fu-gold), var(--fu-gold-deep));
  color: #161002; border-color: rgba(255, 220, 130, 0.6);
  text-shadow: none;
}

.fu-controls-card {
  border-radius: 6px; padding: 16px 26px;
  display: grid; grid-template-columns: 1fr 1fr; gap: 7px 40px;
  font-size: 12px;
}
.fu-controls-card .fu-ctl { display: flex; justify-content: space-between; gap: 18px; align-items: baseline; }
.fu-controls-card .fu-key {
  color: var(--fu-gold); letter-spacing: 1px; white-space: nowrap;
}
.fu-controls-card .fu-act { color: rgba(255,255,255,0.75); font-weight: normal; font-family: Arial, Helvetica, sans-serif; }

.fu-play {
  pointer-events: auto; cursor: pointer;
  font: inherit; font-style: italic; font-size: 26px; letter-spacing: 8px;
  color: #161002; border: none; border-radius: 6px;
  padding: 16px 74px 16px 82px;
  background: linear-gradient(180deg, #ffe9a8 0%, var(--fu-gold) 40%, var(--fu-gold-deep) 100%);
  box-shadow: 0 6px 22px rgba(224, 138, 30, 0.35), inset 0 1px 0 rgba(255,255,255,0.6);
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
}
.fu-play:hover {
  transform: skewX(-8deg) scale(1.04);
  box-shadow: 0 8px 34px rgba(255, 216, 107, 0.65), inset 0 1px 0 rgba(255,255,255,0.7);
  filter: brightness(1.06);
}
.fu-play:active { transform: skewX(-8deg) scale(0.98); }

/* ============================ SCOREBOARD ============================ */
.fu-board {
  position: absolute; top: 14px; left: 50%;
  transform: translateX(-50%) skewX(-8deg);
  display: none; align-items: stretch; gap: 0;
  border-radius: 5px; overflow: visible;
  box-shadow: 0 6px 24px rgba(0,0,0,0.55);
  transition: opacity 0.3s ease;
}
.fu-board.fu-on { display: flex; }
.fu-board-cell {
  display: flex; align-items: center; padding: 0 14px; height: 46px;
  border-right: 1px solid rgba(255,255,255,0.08);
}
.fu-board-cell:last-child { border-right: none; }
.fu-tab {
  width: 66px; justify-content: center;
  font-size: 16px; letter-spacing: 2px;
}
.fu-tab.fu-home-tab { background: var(--fu-home); border-bottom: 3px solid var(--fu-home2); border-radius: 5px 0 0 5px; }
.fu-tab.fu-away-tab { background: var(--fu-away); border-bottom: 3px solid var(--fu-away2); border-radius: 0 5px 5px 0; }
.fu-score {
  width: 62px; justify-content: center;
  font-size: 25px; font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 6px rgba(0,0,0,0.6);
}
.fu-score .fu-unskew { transition: transform 0.12s ease; }
.fu-score.fu-pop .fu-unskew {
  animation: fu-pop 0.45s cubic-bezier(0.2, 1.6, 0.4, 1);
}
@keyframes fu-pop {
  0% { transform: skewX(8deg) scale(1); }
  30% { transform: skewX(8deg) scale(1.45); color: var(--fu-gold); }
  100% { transform: skewX(8deg) scale(1); }
}
.fu-mid {
  flex-direction: column; justify-content: center; gap: 1px;
  min-width: 96px; text-align: center;
}
.fu-qtr { font-size: 11px; letter-spacing: 3px; color: var(--fu-gold); }
.fu-clock { font-size: 18px; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
.fu-shotclock {
  position: absolute; left: 50%; top: 100%;
  transform: translateX(-50%) translateY(4px);
  width: 46px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; font-variant-numeric: tabular-nums;
  border-radius: 0 0 4px 4px;
  color: #ffb84d;
}
.fu-shotclock.fu-danger {
  color: #ff4d4d; border-color: rgba(255, 77, 77, 0.55);
  animation: fu-scpulse 0.6s ease-in-out infinite;
}
@keyframes fu-scpulse {
  0%, 100% { box-shadow: 0 0 0 rgba(255, 60, 60, 0); }
  50% { box-shadow: 0 0 16px rgba(255, 60, 60, 0.75); }
}
.fu-poss {
  position: absolute; top: 50%; margin-top: -6px;
  width: 0; height: 0;
  border-top: 6px solid transparent; border-bottom: 6px solid transparent;
  opacity: 0; transition: opacity 0.2s ease;
}
.fu-poss.fu-on { opacity: 1; }
.fu-poss-home { left: -16px; border-right: 9px solid var(--fu-gold); }
.fu-poss-away { right: -16px; border-left: 9px solid var(--fu-gold); }

/* ============================ SHOT METER ============================ */
.fu-meter {
  position: absolute; bottom: 60px; left: 50%;
  transform: translateX(-50%);
  width: 26px; height: 180px;
  border-radius: 13px; overflow: hidden;
  display: none;
  box-shadow: 0 4px 18px rgba(0,0,0,0.6);
}
.fu-meter.fu-on { display: block; }
.fu-meter-fill {
  position: absolute; left: 0; right: 0; bottom: 0; height: 0%;
  background: linear-gradient(180deg, #ffd86b 0%, #e08a1e 100%);
  will-change: height;
}
.fu-meter-zone {
  position: absolute; left: 0; right: 0;
  background: rgba(64, 255, 130, 0.42);
  border-top: 1px solid rgba(120, 255, 170, 0.9);
  border-bottom: 1px solid rgba(120, 255, 170, 0.9);
  will-change: top, height;
}
.fu-meter-tick {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: #fff; box-shadow: 0 0 6px rgba(255,255,255,0.9);
  will-change: bottom;
}
.fu-perfect {
  position: absolute; bottom: 250px; left: 50%;
  transform: translateX(-50%) skewX(-8deg);
  font-style: italic; font-size: 24px; letter-spacing: 5px;
  color: #52ff9a; text-shadow: 0 0 14px rgba(80, 255, 150, 0.85);
  opacity: 0; pointer-events: none;
}
.fu-perfect.fu-on { animation: fu-perfect 0.9s ease forwards; }
@keyframes fu-perfect {
  0% { opacity: 0; transform: translateX(-50%) skewX(-8deg) scale(0.6); }
  18% { opacity: 1; transform: translateX(-50%) skewX(-8deg) scale(1.15); }
  40% { transform: translateX(-50%) skewX(-8deg) scale(1); }
  75% { opacity: 1; }
  100% { opacity: 0; transform: translateX(-50%) skewX(-8deg) translateY(-18px); }
}

/* ============================ PLAYER LABEL ============================ */
.fu-player {
  position: absolute; bottom: 18px; left: 18px;
  display: none; align-items: center;
  padding: 8px 18px; border-radius: 4px;
  font-size: 13px; letter-spacing: 1.5px; font-style: italic;
  background: linear-gradient(90deg, var(--fu-home) 0%, rgba(8,10,18,0.85) 90%);
  border: 1px solid var(--fu-border);
  border-left: 4px solid var(--fu-home2);
  box-shadow: 0 4px 14px rgba(0,0,0,0.5);
}
.fu-player.fu-on { display: flex; }

/* ============================ TOASTS ============================ */
.fu-toasts {
  position: absolute; top: 96px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.fu-toast {
  display: flex; align-items: center;
  padding: 9px 26px; border-radius: 4px;
  font-style: italic; font-size: 17px; letter-spacing: 2.5px;
  white-space: nowrap;
  border-left: 5px solid var(--fu-gold);
  box-shadow: 0 6px 20px rgba(0,0,0,0.55);
  transform: skewX(-8deg);
  animation: fu-toast-in 0.28s cubic-bezier(0.2, 1.3, 0.4, 1);
}
.fu-toast.fu-out { animation: fu-toast-out 0.25s ease forwards; }
@keyframes fu-toast-in {
  from { opacity: 0; transform: skewX(-8deg) translateY(-16px) scale(0.9); }
  to { opacity: 1; transform: skewX(-8deg) translateY(0) scale(1); }
}
@keyframes fu-toast-out {
  from { opacity: 1; transform: skewX(-8deg) translateY(0); }
  to { opacity: 0; transform: skewX(-8deg) translateY(-14px); }
}

/* ============================ OVERLAYS ============================ */
.fu-overlay {
  position: absolute; inset: 0;
  display: none; align-items: center; justify-content: center;
  flex-direction: column; gap: 18px;
  background: rgba(4, 6, 12, 0.7);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.fu-overlay.fu-on { display: flex; }
.fu-pause-text {
  font-style: italic; font-size: 40px; letter-spacing: 10px;
  color: #fff; text-shadow: 0 4px 18px rgba(0,0,0,0.8);
}
.fu-pause-sub { font-size: 13px; letter-spacing: 4px; color: rgba(255,255,255,0.55); font-style: italic; }

.fu-go { pointer-events: auto; }
.fu-go-final {
  font-style: italic; font-size: 20px; letter-spacing: 12px;
  color: var(--fu-gold);
}
.fu-go-score {
  display: flex; align-items: center; gap: 26px;
  font-size: 60px; font-variant-numeric: tabular-nums; font-style: italic;
  text-shadow: 0 4px 20px rgba(0,0,0,0.8);
}
.fu-go-score .fu-go-abbr { font-size: 16px; letter-spacing: 3px; padding: 4px 12px; border-radius: 3px; }
.fu-go-dash { font-size: 34px; color: rgba(255,255,255,0.45); }
.fu-go-winner {
  font-style: italic; font-size: 30px; letter-spacing: 5px;
  color: var(--fu-gold);
  text-shadow: 0 0 22px rgba(255, 216, 107, 0.85), 0 0 44px rgba(224, 138, 30, 0.5);
  animation: fu-winglow 1.6s ease-in-out infinite;
}
@keyframes fu-winglow {
  0%, 100% { text-shadow: 0 0 18px rgba(255,216,107,0.7); }
  50% { text-shadow: 0 0 34px rgba(255,216,107,1), 0 0 60px rgba(224,138,30,0.7); }
}
.fu-again {
  pointer-events: auto; cursor: pointer;
  font: inherit; font-style: italic; font-size: 18px; letter-spacing: 5px;
  color: #161002; border: none; border-radius: 5px;
  padding: 13px 44px; margin-top: 10px;
  background: linear-gradient(180deg, #ffe9a8, var(--fu-gold) 40%, var(--fu-gold-deep));
  box-shadow: 0 5px 18px rgba(224, 138, 30, 0.4);
  transform: skewX(-8deg);
  transition: transform 0.12s ease, box-shadow 0.2s ease;
}
.fu-again:hover { transform: skewX(-8deg) scale(1.05); box-shadow: 0 7px 28px rgba(255,216,107,0.6); }
`;

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

export class HUD {
  constructor() {
    // Callback assigned by main.js.
    this.onStart = () => {};

    // Selections (defaults per brief).
    this._quarterMinutes = 3;
    this._difficulty = 'pro';

    // Cached previous snapshot values so we only touch the DOM on change.
    this._prev = {
      homeScore: -1, awayScore: -1, quarter: null, clockText: '',
      shotClockText: '', shotClockDanger: null, possession: -1,
      userPlayerLabel: '', meterOn: null, perfect: false,
    };
    this._lastMeter = { power: 0, sweetStart: 0, sweetEnd: 0 };
    this._toastCount = 0;
    this._perfectTimer = 0;

    // ---- style + root ----
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this._root = el('div', 'fu-root', document.body);

    this._buildScoreboard();
    this._buildShotMeter();
    this._buildPlayerLabel();
    this._toasts = el('div', 'fu-toasts', this._root);
    this._buildPause();
    this._buildGameOver();
    this._buildStart(); // last so it stacks on top

    this._showStart();
  }

  // ------------------------------------------------------------ start screen
  _buildStart() {
    const start = el('div', 'fu-start', this._root);
    this._start = start;
    const inner = el('div', 'fu-start-inner', start);

    el('div', 'fu-title', inner, 'FABLEULTRA BASKETBALL');

    const matchup = el('div', 'fu-matchup', inner);
    el('span', 'fu-chip fu-home', matchup, HOME.abbr);
    el('span', null, matchup, HOME.name.toUpperCase());
    el('span', 'fu-vs', matchup, 'VS');
    el('span', null, matchup, AWAY.name.toUpperCase());
    el('span', 'fu-chip fu-away', matchup, AWAY.abbr);

    // Quarter length
    const qRow = el('div', 'fu-optrow', inner);
    el('div', 'fu-optlabel', qRow, 'QUARTER LENGTH');
    const qSeg = el('div', 'fu-seg fu-skew', qRow);
    const qOpts = [1, 2, 3, 5];
    this._qButtons = qOpts.map((min) => {
      const b = el('button', min === this._quarterMinutes ? 'fu-sel' : null, qSeg);
      el('span', 'fu-unskew', b, min + ' MIN');
      b.addEventListener('click', () => {
        this._quarterMinutes = min;
        for (const btn of this._qButtons) btn.classList.toggle('fu-sel', btn === b);
      });
      return b;
    });

    // Difficulty
    const dRow = el('div', 'fu-optrow', inner);
    el('div', 'fu-optlabel', dRow, 'DIFFICULTY');
    const dSeg = el('div', 'fu-seg fu-skew', dRow);
    const dOpts = [['rookie', 'ROOKIE'], ['pro', 'PRO'], ['allstar', 'ALL-STAR']];
    this._dButtons = dOpts.map(([key, label]) => {
      const b = el('button', key === this._difficulty ? 'fu-sel' : null, dSeg);
      el('span', 'fu-unskew', b, label);
      b.addEventListener('click', () => {
        this._difficulty = key;
        for (const btn of this._dButtons) btn.classList.toggle('fu-sel', btn === b);
      });
      return b;
    });

    // Controls card (two columns via grid)
    const card = el('div', 'fu-controls-card fu-glass', inner);
    const controls = [
      ['WASD', 'Move'],
      ['SHIFT', 'Sprint'],
      ['SPACE', 'Shoot / Block (hold + release)'],
      ['E', 'Pass'],
      ['Q', 'Steal'],
      ['TAB', 'Switch player'],
      ['ESC', 'Pause'],
    ];
    for (const [key, act] of controls) {
      const row = el('div', 'fu-ctl', card);
      el('span', 'fu-act', row, act);
      el('span', 'fu-key', row, key);
    }

    // PLAY
    const play = el('button', 'fu-play fu-skew', inner);
    el('span', 'fu-unskew', play, 'PLAY');
    play.addEventListener('click', () => {
      this._hideStart();
      try {
        this.onStart({ quarterMinutes: this._quarterMinutes, difficulty: this._difficulty });
      } catch (e) { /* never let a game-side error break the HUD */ }
    });
  }

  _showStart() {
    this._start.classList.remove('fu-hidden');
    this._board.classList.remove('fu-on');
    this._player.classList.remove('fu-on');
    this._meter.classList.remove('fu-on');
    this._gameOver.classList.remove('fu-on');
    this._pause.classList.remove('fu-on');
  }

  _hideStart() {
    this._start.classList.add('fu-hidden');
    this._board.classList.add('fu-on');
    // New game: forget last game's scores so the reset to 0 doesn't pop.
    this._prev.homeScore = -1;
    this._prev.awayScore = -1;
  }

  // ------------------------------------------------------------- scoreboard
  _buildScoreboard() {
    const board = el('div', 'fu-board fu-glass', this._root);
    this._board = board;

    const homeTab = el('div', 'fu-board-cell fu-tab fu-home-tab', board);
    el('span', 'fu-unskew', homeTab, HOME.abbr);

    const homeScore = el('div', 'fu-board-cell fu-score', board);
    this._homeScoreEl = el('span', 'fu-unskew', homeScore, '0');
    this._homeScoreCell = homeScore;

    const mid = el('div', 'fu-board-cell fu-mid', board);
    this._qtrEl = el('div', 'fu-qtr', mid, 'Q1');
    this._qtrEl.classList.add('fu-unskew');
    this._clockEl = el('div', 'fu-clock fu-unskew', mid, '0:00');

    const awayScore = el('div', 'fu-board-cell fu-score', board);
    this._awayScoreEl = el('span', 'fu-unskew', awayScore, '0');
    this._awayScoreCell = awayScore;

    const awayTab = el('div', 'fu-board-cell fu-tab fu-away-tab', board);
    el('span', 'fu-unskew', awayTab, AWAY.abbr);

    // shot clock box hanging beneath the center cell
    const sc = el('div', 'fu-shotclock fu-glass', board);
    this._shotClockEl = el('span', 'fu-unskew', sc, '24');
    this._shotClockBox = sc;

    // possession arrows
    this._possHome = el('div', 'fu-poss fu-poss-home', board);
    this._possAway = el('div', 'fu-poss fu-poss-away', board);
  }

  // ------------------------------------------------------------- shot meter
  _buildShotMeter() {
    const meter = el('div', 'fu-meter fu-glass', this._root);
    this._meter = meter;
    this._meterZone = el('div', 'fu-meter-zone', meter);
    this._meterFill = el('div', 'fu-meter-fill', meter);
    this._meterTick = el('div', 'fu-meter-tick', meter);
    this._perfect = el('div', 'fu-perfect', this._root, 'PERFECT');
  }

  // ----------------------------------------------------------- player label
  _buildPlayerLabel() {
    this._player = el('div', 'fu-player', this._root);
    this._playerText = el('span', 'fu-unskew', this._player, '');
    this._player.classList.add('fu-skew');
  }

  // ----------------------------------------------------------------- pause
  _buildPause() {
    const p = el('div', 'fu-overlay', this._root);
    this._pause = p;
    el('div', 'fu-pause-text', p, 'PAUSED');
    el('div', 'fu-pause-sub', p, 'PRESS ESC TO RESUME');
  }

  // -------------------------------------------------------------- game over
  _buildGameOver() {
    const g = el('div', 'fu-overlay fu-go', this._root);
    this._gameOver = g;
    el('div', 'fu-go-final', g, 'FINAL');

    const score = el('div', 'fu-go-score', g);
    const ha = el('span', 'fu-go-abbr', score, HOME.abbr);
    ha.style.background = HOME.primary;
    ha.style.borderBottom = '3px solid ' + HOME.secondary;
    this._goHome = el('span', null, score, '0');
    el('span', 'fu-go-dash', score, '—');
    this._goAway = el('span', null, score, '0');
    const aa = el('span', 'fu-go-abbr', score, AWAY.abbr);
    aa.style.background = AWAY.primary;
    aa.style.borderBottom = '3px solid ' + AWAY.secondary;

    this._goWinner = el('div', 'fu-go-winner', g, '');

    const again = el('button', 'fu-again', g);
    el('span', 'fu-unskew', again, 'PLAY AGAIN');
    again.addEventListener('click', () => {
      this._gameOver.classList.remove('fu-on');
      this._showStart();
    });
  }

  // ============================================================ public API
  update(snapshot) {
    if (!snapshot) return;
    const p = this._prev;

    // scores (with pop)
    const hs = snapshot.homeScore | 0;
    if (hs !== p.homeScore) {
      this._homeScoreEl.textContent = String(hs);
      if (p.homeScore >= 0) this._popScore(this._homeScoreCell);
      p.homeScore = hs;
    }
    const as = snapshot.awayScore | 0;
    if (as !== p.awayScore) {
      this._awayScoreEl.textContent = String(as);
      if (p.awayScore >= 0) this._popScore(this._awayScoreCell);
      p.awayScore = as;
    }

    // quarter + clock
    const q = snapshot.quarter;
    if (q !== p.quarter) {
      this._qtrEl.textContent = (typeof q === 'number') ? 'Q' + q : String(q ?? '');
      p.quarter = q;
    }
    const ct = snapshot.clockText || '0:00';
    if (ct !== p.clockText) {
      this._clockEl.textContent = ct;
      p.clockText = ct;
    }

    // shot clock
    let sc = snapshot.shotClock;
    if (typeof sc !== 'number' || !isFinite(sc)) sc = 0;
    if (sc < 0) sc = 0;
    const scText = sc < 5 ? (Math.ceil(sc * 10) / 10).toFixed(1) : String(Math.ceil(sc));
    if (scText !== p.shotClockText) {
      this._shotClockEl.textContent = scText;
      p.shotClockText = scText;
    }
    const danger = sc < 5 && sc > 0;
    if (danger !== p.shotClockDanger) {
      this._shotClockBox.classList.toggle('fu-danger', danger);
      p.shotClockDanger = danger;
    }

    // possession arrows
    const poss = snapshot.possession;
    if (poss !== p.possession) {
      this._possHome.classList.toggle('fu-on', poss === 0);
      this._possAway.classList.toggle('fu-on', poss === 1);
      p.possession = poss;
    }

    // player label
    const label = snapshot.userPlayerLabel || '';
    if (label !== p.userPlayerLabel) {
      this._playerText.textContent = label ? 'YOU: ' + label : '';
      this._player.classList.toggle('fu-on', !!label);
      p.userPlayerLabel = label;
    }

    // shot meter
    const m = snapshot.shotMeter;
    const meterOn = !!m;
    if (meterOn) {
      let power = +m.power; if (!isFinite(power)) power = 0;
      power = power < 0 ? 0 : (power > 1 ? 1 : power);
      let s0 = +m.sweetStart; if (!isFinite(s0)) s0 = 0;
      let s1 = +m.sweetEnd; if (!isFinite(s1)) s1 = 0;
      s0 = s0 < 0 ? 0 : (s0 > 1 ? 1 : s0);
      s1 = s1 < s0 ? s0 : (s1 > 1 ? 1 : s1);

      const lm = this._lastMeter;
      if (power !== lm.power) {
        const pct = (power * 100).toFixed(1) + '%';
        this._meterFill.style.height = pct;
        this._meterTick.style.bottom = pct;
        lm.power = power;
      }
      if (s0 !== lm.sweetStart || s1 !== lm.sweetEnd) {
        this._meterZone.style.top = ((1 - s1) * 100).toFixed(1) + '%';
        this._meterZone.style.height = ((s1 - s0) * 100).toFixed(1) + '%';
        lm.sweetStart = s0;
        lm.sweetEnd = s1;
      }
    }
    if (meterOn !== p.meterOn) {
      this._meter.classList.toggle('fu-on', meterOn);
      p.meterOn = meterOn;
    }

    // PERFECT flash: driven by the game's release result (snapshot pulse),
    // not inferred from the meter vanishing (which also happens on steals).
    const perfect = !!snapshot.shotMeterPerfect;
    if (perfect && !p.perfect) this._flashPerfect();
    p.perfect = perfect;

    // game over hides the live scoreboard extras but the overlay itself is
    // driven by showGameOver(); nothing more to do here.
  }

  showMessage(text, seconds = 2, accentColor) {
    if (!this._toasts) return;
    // stack max 2: drop the oldest
    while (this._toasts.children.length >= 2) {
      this._toasts.removeChild(this._toasts.firstChild);
    }
    const toast = el('div', 'fu-toast fu-glass', this._toasts);
    el('span', 'fu-unskew', toast, String(text ?? ''));
    if (accentColor) toast.style.borderLeftColor = accentColor;
    const life = Math.max(0.3, +seconds || 2) * 1000;
    setTimeout(() => {
      if (!toast.parentNode) return;
      toast.classList.add('fu-out');
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 260);
    }, life);
  }

  setPaused(paused) {
    this._pause.classList.toggle('fu-on', !!paused);
  }

  showGameOver({ homeScore, awayScore, winnerName } = {}) {
    this._goHome.textContent = String(homeScore ?? 0);
    this._goAway.textContent = String(awayScore ?? 0);
    this._goWinner.textContent = winnerName
      ? String(winnerName).toUpperCase() + ' WINS'
      : 'TIE GAME';
    this._pause.classList.remove('fu-on');
    this._meter.classList.remove('fu-on');
    this._prev.meterOn = false;
    this._gameOver.classList.add('fu-on');
  }

  // ============================================================== internals
  _popScore(cell) {
    cell.classList.remove('fu-pop');
    // force reflow so re-adding restarts the animation
    void cell.offsetWidth;
    cell.classList.add('fu-pop');
  }

  _flashPerfect() {
    this._perfect.classList.remove('fu-on');
    void this._perfect.offsetWidth;
    this._perfect.classList.add('fu-on');
  }
}
