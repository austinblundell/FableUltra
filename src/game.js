// ============================================================================
// game.js — the 5-on-5 gameplay core: entities, user control, dribbling,
// shooting with a timing meter, passing, steals/blocks, rebounds, possession
// and rules state machine, scoring, clocks/quarters/overtime.
//
// Public API (consumed blind by main.js):
//   new Game({ scene, arena, ball, audio, hud, options })
//   .update(dt, input) .snapshot() .cameraFocus() .over .dispose()
//
// Decision-making / positioning lives in ai.js; this file owns the rules,
// mechanics and the user.
// ============================================================================

import * as THREE from 'three';
import {
  COURT, PLAYER, PHYSICS, RULES, DIFFICULTY, TEAMS, isThreePointer,
} from './constants.js';
import { PlayerModel } from './playerModel.js';
import * as AI from './ai.js';

const G = PHYSICS.GRAVITY;

// ---- tunables ---------------------------------------------------------------
const CHEST_HEIGHT = 1.35;          // pass launch/catch height
const METER_RAMP = 0.85;            // seconds for shot power 0 -> 1
const SWEET_CENTER = 0.78;          // meter sweet-zone center
const SWEET_BASE_WIDTH = 0.14;
const CONTEST_RANGE = 1.6;          // defender inside this contests a shot
const LAYUP_RANGE = 3.2;
const BLOCK_WINDOW = 0.35;          // seconds after launch a block still lands
const STEAL_COOLDOWN = 0.8;
const STAGGER_TIME = 0.6;
const PROTECT_TIME = 0.5;
const DRIBBLE_CYCLE = 0.45;         // seconds per dribble bounce
const DRIBBLE_CYCLE_SPRINT = 0.34;
const REBOUND_HEIGHT = 2.6;         // ball below this = rebound-able
const REBOUND_REACH = 1.1;
const DEADBALL_SCORE = 1.2;         // celebration beat after a made basket
const DEADBALL_PERIOD = 2.4;        // beat between periods
const WATCHDOG_TIME = 4;
const TURN_RATE = 10;               // facing lerp, rad/s
const OOB_MARGIN = 0.05;
const CLAMP_MARGIN = 0.35;
const EXCITE_TAU = 6;

const EMPTY_INPUT = {
  moveX: 0, moveZ: 0, sprint: false, shootHeld: false, shootPressed: false,
  shootReleased: false, passPressed: false, stealPressed: false,
  switchPressed: false, pausePressed: false, anyPressed: false,
};

// ---- module scratch (zero per-frame allocations) -------------------------------
const _anchor = new THREE.Vector3();
const _hold = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _start = new THREE.Vector3();
const _pvel = new THREE.Vector3();
const _spot = { x: 0, z: 0 };

function clampNum(v, a, b) { return v < a ? a : (v > b ? b : v); }
function fin(v, fallback) { return Number.isFinite(v) ? v : fallback; }

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function formatClock(t) {
  t = Math.max(0, fin(t, 0));
  if (t < 10) return (Math.floor(t * 10) / 10).toFixed(1);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ============================================================================
export class Game {
  constructor({ scene, arena, ball, audio, hud, options }) {
    this.scene = scene;
    this.arena = arena;
    this.ball = ball;
    this.audio = audio;
    this.hud = hud;

    const opts = options || {};
    this.diff = DIFFICULTY[opts.difficulty] || DIFFICULTY.pro;
    this.quarterSeconds = Math.max(30, fin(opts.quarterMinutes, RULES.DEFAULT_QUARTER_MINUTES) * 60);

    // --- score / clock state ---
    this.homeScore = 0;
    this.awayScore = 0;
    this.period = 1;                 // 1..4, then 5+ = overtimes
    this.gameClock = this.quarterSeconds;
    this.shotClock = RULES.SHOT_CLOCK;
    this.over = false;

    // --- possession / flow ---
    this.state = 'inbound';          // 'inbound' | 'live' | 'deadBall' | 'over'
    this.stateT = RULES.INBOUND_PAUSE;
    this.deadNext = 'inbound';       // what follows a deadBall beat
    this.deadTeam = 0;
    this.possession = 0;
    this.handler = null;             // entity holding the ball (or null)
    this.controlled = null;          // user's entity (team 0)
    this.lastTouchTeam = 0;
    this.endPeriodPending = false;

    // --- shot / pass flight state ---
    this.shotWindup = null;          // { ent, blocked }
    this.shotLive = false;
    this.shotTime = 0;
    this.reboundPhase = false;
    this.pendingShot = null;         // { shooter, points, hoopIndex }
    this.passInfo = null;            // { passer, receiver, team, t }
    this._passId = 0;

    // --- user shot meter ---
    this.meter = { active: false, t: 0, power: 0, sweetStart: 0.7, sweetEnd: 0.86 };
    this._meterOut = { power: 0, sweetStart: 0, sweetEnd: 0 };
    this._shotPerfect = false;       // one-frame pulse: last release hit the sweet zone

    // --- presentation ---
    this.excitement = 0.35;
    this.watchdogT = 0;
    this._dribbleT = 0;
    this._focus = new THREE.Vector3(0, 1, 0);
    this._snap = {
      homeScore: 0, awayScore: 0, quarter: 1, clockText: '0:00',
      gameClock: 0, shotClock: 0, possession: 0, userPlayerLabel: '',
      shotMeter: null, shotMeterPerfect: false, excitement: 0.3, over: false,
    };

    // --- entities ---
    this.entities = [];
    this._buildEntities();

    // --- ball callbacks ---
    ball.onScore = (hoopIndex) => { try { this._onScore(hoopIndex); } catch (e) {} };
    ball.onTouchFloor = (speed) => { try { this._onBallFloor(speed); } catch (e) {} };

    this._setupInbound(0, true);
    if (this.hud) this.hud.showMessage('TIP OFF — ' + TEAMS[0].name.toUpperCase() + ' BALL', 2.2, TEAMS[0].secondary);
  }

  // --------------------------------------------------------------------------
  _buildEntities() {
    for (let team = 0; team < 2; team++) {
      const td = TEAMS[team];
      for (let i = 0; i < 5; i++) {
        const pd = td.players[i];
        let model = null;
        try {
          model = new PlayerModel({
            jersey: td.jersey, jerseyTrim: td.jerseyTrim, shorts: td.shorts,
            skin: pd.skin, number: pd.number, name: pd.name, height: pd.height,
          });
          this.scene.add(model.group);
        } catch (e) { model = null; }
        const ent = {
          team, idx: i, data: pd, model,
          pos: new THREE.Vector3((team === 0 ? -1 : 1) * (2 + i), 0, i * 2 - 4),
          vel: new THREE.Vector3(),
          facing: team === 0 ? Math.PI / 2 : -Math.PI / 2,
          moveX: 0, moveZ: 0, moveSpeed: 0,
          faceX: 0, faceZ: 0, hasFace: false,
          sprinting: false,
          busy: false, busyT: 0,
          releaseFn: null, releaseT: 0,
          staggerT: 0, protectT: 0, stealCd: 0,
          animName: '',
          label: '#' + pd.number + ' ' + pd.name,
          _passTry: -1,
        };
        AI.initAI(ent);
        this.entities.push(ent);
      }
    }
    this.controlled = this.entities[0];
  }

  // ---- tiny helpers used by ai.js and internally ------------------------------
  attackRim(team) { return this.arena.hoops[team === 0 ? 1 : 0].rimCenter; }
  defendRim(team) { return this.arena.hoops[team === 0 ? 0 : 1].rimCenter; }
  attackSign(team) { return team === 0 ? 1 : -1; }

  _nearestOfTeam(team, x, z, exclude) {
    let best = null, bd = 1e9;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.team !== team || e === exclude) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.z - z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  _nearestOppDist(ent) {
    let bd = 1e9;
    for (let i = 0; i < this.entities.length; i++) {
      const o = this.entities[i];
      if (o.team === ent.team) continue;
      const d = Math.hypot(o.pos.x - ent.pos.x, o.pos.z - ent.pos.z);
      if (d < bd) bd = d;
    }
    return bd;
  }

  _msg(text, secs, accent) {
    if (this.hud) { try { this.hud.showMessage(text, secs, accent); } catch (e) {} }
  }

  _spike(v) { if (v > this.excitement) this.excitement = Math.min(1, v); }

  // ---- one-shot animation wrapper (resilient to model quirks) ------------------
  playOneShot(ent, name, opts) {
    if (!ent || ent.busy || !ent.model) return false;
    ent.busy = true;
    ent.busyT = 1.7;
    let released = false;
    const releaseFn = opts && opts.onRelease ? opts.onRelease : null;
    const fire = () => {
      if (released) return;
      released = true;
      ent.releaseFn = null;
      if (releaseFn) { try { releaseFn(); } catch (e) {} }
    };
    if (releaseFn) {
      // Fallback: if the model never invokes onRelease, fire it ourselves.
      // Must be strictly later than the latest animation release (the 'shoot'
      // one-shot releases at ~0.52 s) so it never preempts the real one.
      ent.releaseFn = fire;
      ent.releaseT = 0.7;
    }
    try {
      ent.model.setAnimation(name, {
        onRelease: fire,
        onComplete: () => { ent.busy = false; ent.busyT = 0; },
      });
    } catch (e) {
      ent.busy = false; ent.busyT = 0;
      fire();
    }
    return true;
  }

  // ---- possession plumbing -------------------------------------------------------
  _gainPossession(ent) {
    if (!ent || this.over) return;
    const wasShot = this.shotLive;
    const offBoard = wasShot && ent.team === this.possession;
    const rimTouched = !!this.ball.touchedRimSinceLaunch;

    this.handler = ent;
    ent.protectT = Math.max(ent.protectT, 0.25);
    this.lastTouchTeam = ent.team;
    this.passInfo = null;
    this.shotLive = false;
    this.reboundPhase = false;
    this.shotWindup = null;
    this.pendingShot = null;
    this._cancelMeter();
    this._dribbleT = 0.01;
    this.watchdogT = 0;
    if (ent.ai) { ent.ai.mode = 'probe'; ent.ai.decideT = 0.2; }

    this.ball.setHeld(this.ball.mesh.position);

    if (ent.team !== this.possession) {
      this.possession = ent.team;
      this.shotClock = RULES.SHOT_CLOCK;
    } else if (offBoard) {
      if (rimTouched) this.shotClock = Math.max(this.shotClock, 14);
      this._msg('OFFENSIVE REBOUND', 1.6, TEAMS[ent.team].secondary);
      this._spike(0.55);
    }

    // Control follows the ball for the home team; on defense pick nearest.
    if (ent.team === 0) this.controlled = ent;
    else this.controlled = this._nearestOfTeam(0, this.ball.mesh.position.x, this.ball.mesh.position.z) || this.controlled;

    // A rebound after the clock expired ends the period.
    if (this.endPeriodPending) this._endPeriod();
  }

  _cancelMeter() { this.meter.active = false; this.meter.t = 0; this.meter.power = 0; }

  _setupInbound(team, teleport) {
    this.state = 'inbound';
    this.stateT = RULES.INBOUND_PAUSE;
    this.possession = team;
    this.shotClock = RULES.SHOT_CLOCK;
    this.shotLive = false;
    this.reboundPhase = false;
    this.shotWindup = null;
    this.pendingShot = null;
    this.passInfo = null;
    this.endPeriodPending = false;
    this.watchdogT = 0;
    this._cancelMeter();

    const pg = this.entities[team * 5];
    const s = this.attackSign(team);
    pg.pos.set(-s * (COURT.HALF_LENGTH - 3.2), 0, 2.0);
    pg.vel.set(0, 0, 0);
    pg.busy = false; pg.busyT = 0; pg.releaseFn = null;
    this.handler = pg;
    this.lastTouchTeam = team;
    this.ball.setHeld(this.ball.mesh.position);
    this._dribbleT = 0;

    if (teleport) {
      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i];
        if (e === pg) continue;
        if (e.team === team) {
          AI.getOffenseSpot(e, this, _spot);
          e.pos.set(_spot.x - s * 2.0, 0, _spot.z);
        }
        e.vel.set(0, 0, 0);
        e.busy = false; e.busyT = 0; e.releaseFn = null;
      }
      // Defenders between their man and the defended rim.
      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i];
        if (e.team === team) continue;
        const man = this.entities[team * 5 + e.idx];
        const rim = this.defendRim(e.team);
        e.pos.set(
          man.pos.x + (rim.x - man.pos.x) * 0.25,
          0,
          man.pos.z + (rim.z - man.pos.z) * 0.25
        );
      }
    }

    if (team === 0) this.controlled = pg;
    else this.controlled = this._nearestOfTeam(0, pg.pos.x, pg.pos.z) || this.controlled;
  }

  _turnover(msgText, toTeam) {
    if (this.over) return;
    if (this.audio) { try { this.audio.whistle(); } catch (e) {} }
    if (msgText) this._msg(msgText, 1.8, '#ff7b5c');
    this.handler = null;
    if (this.endPeriodPending) { this._endPeriod(); return; }
    this._setupInbound(toTeam, false);
  }

  // ---- scoring -----------------------------------------------------------------
  _onScore(hoopIndex) {
    if (this.over || this.state !== 'live') return;
    const scoringTeam = hoopIndex === 1 ? 0 : 1;
    let points = 2;
    let scorer = null;
    if (this.pendingShot && this.pendingShot.hoopIndex === hoopIndex) {
      points = this.pendingShot.points;
      scorer = this.pendingShot.shooter;
    }
    if (scoringTeam === 0) this.homeScore += points; else this.awayScore += points;

    try { this.arena.hoops[hoopIndex].netImpulse(this.ball.velocity); } catch (e) {}

    const clutch = this.period >= RULES.QUARTERS && this.gameClock < 60 &&
      Math.abs(this.homeScore - this.awayScore) <= 6;
    if (this.audio) {
      try {
        if (scoringTeam === 0) this.audio.cheer(points === 3 || clutch);
        else this.audio.groan();
      } catch (e) {}
    }

    const name = scorer ? scorer.data.name.toUpperCase() : TEAMS[scoringTeam].abbr;
    this._msg(
      (this.endPeriodPending ? 'AT THE BUZZER! +' : '+') + points + '  ' + name,
      2.2, TEAMS[scoringTeam].primary
    );
    this._spike(this.endPeriodPending ? 1 : 0.82 + points * 0.05);

    if (scorer && !scorer.busy && Math.random() < 0.45) this.playOneShot(scorer, 'celebrate');

    this.shotLive = false;
    this.reboundPhase = false;
    this.pendingShot = null;
    this.passInfo = null;
    this.handler = null;
    this.watchdogT = 0;

    if (this.endPeriodPending) { this._endPeriod(); return; }
    this.state = 'deadBall';
    this.stateT = DEADBALL_SCORE;
    this.deadNext = 'inbound';
    this.deadTeam = 1 - scoringTeam;
  }

  _onBallFloor(speed) {
    if (this.over) return;
    const st = this.ball.state;
    if (st === 'SHOT' && this.shotLive) this.reboundPhase = true;  // confirmed miss
    if (st === 'PASS') this.passInfo = null;                        // busted pass -> loose
  }

  // ---- periods -------------------------------------------------------------------
  _endPeriod() {
    this.endPeriodPending = false;
    this.gameClock = 0;
    if (this.audio) { try { this.audio.buzzer(); } catch (e) {} }
    this.handler = null;
    this.ball.drop(this.ball.mesh.position, this.ball.velocity);
    this.shotLive = false;
    this.reboundPhase = false;
    this.shotWindup = null;
    this.pendingShot = null;
    this.passInfo = null;
    this._cancelMeter();

    const isLastReg = this.period >= RULES.QUARTERS;
    if (isLastReg && this.homeScore !== this.awayScore) {
      this._gameOver();
      return;
    }
    if (isLastReg) this._msg('TIED — OVERTIME!', 2.6, '#ffd86b');
    else if (this.period === 2) this._msg('HALFTIME', 2.6, '#ffd86b');
    else this._msg('END OF Q' + this.period, 2.4, '#ffd86b');
    this.state = 'deadBall';
    this.stateT = DEADBALL_PERIOD;
    this.deadNext = 'period';
  }

  _startNextPeriod() {
    this.period++;
    this.gameClock = this.period > RULES.QUARTERS
      ? RULES.OVERTIME_MINUTES * 60
      : this.quarterSeconds;
    const opening = (this.period - 1) % 2 === 0 ? 0 : 1;
    if (this.period > RULES.QUARTERS) this._msg('OVERTIME', 2, '#ffd86b');
    this._setupInbound(opening, true);
  }

  _gameOver() {
    this.over = true;
    this.state = 'over';
    this.excitement = 1;
    if (this.audio) { try { this.audio.buzzer(); this.audio.cheer(true); } catch (e) {} }
    const winner = this.homeScore > this.awayScore ? 0 : 1;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      e.busy = false; e.busyT = 0; e.releaseFn = null;
      e.moveX = 0; e.moveZ = 0; e.moveSpeed = 0;
      this.playOneShot(e, e.team === winner ? 'celebrate' : 'dejected');
    }
    if (this.hud) {
      try {
        this.hud.showGameOver({
          homeScore: this.homeScore,
          awayScore: this.awayScore,
          winnerName: TEAMS[winner].name,
        });
      } catch (e) {}
    }
  }

  // ---- public: snapshot / camera / dispose -------------------------------------------
  snapshot() {
    const s = this._snap;
    s.homeScore = this.homeScore;
    s.awayScore = this.awayScore;
    s.quarter = this.period <= RULES.QUARTERS ? this.period : 'OT';
    s.clockText = formatClock(this.gameClock);
    s.gameClock = Math.max(0, fin(this.gameClock, 0));
    s.shotClock = Math.max(0, fin(this.shotClock, 0));
    s.possession = this.possession;
    s.userPlayerLabel = this.controlled ? this.controlled.label : '';
    if (this.meter.active) {
      const m = this._meterOut;
      m.power = clampNum(fin(this.meter.power, 0), 0, 1);
      m.sweetStart = clampNum(fin(this.meter.sweetStart, 0.7), 0, 1);
      m.sweetEnd = clampNum(fin(this.meter.sweetEnd, 0.86), 0, 1);
      s.shotMeter = m;
    } else {
      s.shotMeter = null;
    }
    s.shotMeterPerfect = this._shotPerfect;
    s.excitement = clampNum(fin(this.excitement, 0.3), 0, 1);
    s.over = this.over;
    return s;
  }

  cameraFocus() {
    const bp = this.ball.mesh.position;
    if (Number.isFinite(bp.x) && Number.isFinite(bp.y) && Number.isFinite(bp.z)) {
      this._focus.copy(bp);
      const rim = this.attackRim(this.possession);
      this._focus.lerp(rim, 0.25);
    }
    if (!Number.isFinite(this._focus.x) || !Number.isFinite(this._focus.y) || !Number.isFinite(this._focus.z)) {
      this._focus.set(0, 1, 0);
    }
    return this._focus;
  }

  dispose() {
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.model && e.model.group) {
        try { this.scene.remove(e.model.group); } catch (err) {}
        try { e.model.dispose(); } catch (err) {} // frees per-player textures/materials
      }
    }
    this.entities.length = 0;
    this.handler = null;
    this.controlled = null;
    this.ball.onScore = null;
    this.ball.onTouchFloor = null;
  }

  // ==========================================================================
  // MAIN UPDATE
  // ==========================================================================
  update(dt, input) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 1 / 30) dt = 1 / 30;
    input = input || EMPTY_INPUT;
    this._shotPerfect = false;         // pulse lasts exactly one snapshot
    if (!this.entities.length) return; // disposed

    this._sanitize();
    this._tickTimers(dt);
    this._updateExcitement(dt);

    if (this.over) {
      this._postUpdate(dt);
      return;
    }

    if (this.state === 'inbound') {
      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i];
        e.moveX = 0; e.moveZ = 0; e.moveSpeed = 0; e.hasFace = false;
        if (e.busy || e.staggerT > 0) continue;
        try { AI.updateInbound(e, this, dt); } catch (err) {}
      }
      this.stateT -= dt;
      if (this.stateT <= 0) {
        this.state = 'live';
        if (this.handler && this.handler.ai) this.handler.ai.decideT = 0.3;
      }
    } else if (this.state === 'deadBall') {
      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i];
        e.moveX = 0; e.moveZ = 0; e.moveSpeed = 0; e.hasFace = false;
      }
      this.stateT -= dt;
      if (this.stateT <= 0) {
        if (this.deadNext === 'period') this._startNextPeriod();
        else this._setupInbound(this.deadTeam, false);
      }
    } else if (this.state === 'live') {
      this._updateLive(dt, input);
    }

    this._postUpdate(dt);
  }

  _tickTimers(dt) {
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.staggerT > 0) e.staggerT -= dt;
      if (e.protectT > 0) e.protectT -= dt;
      if (e.stealCd > 0) e.stealCd -= dt;
      if (e.busy) {
        e.busyT -= dt;
        if (e.busyT <= 0) { e.busy = false; e.busyT = 0; } // watchdog for lost onComplete
      }
      if (e.releaseFn) {
        e.releaseT -= dt;
        if (e.releaseT <= 0) {
          const fn = e.releaseFn;
          e.releaseFn = null;
          try { fn(); } catch (err) {}
        }
      }
    }
  }

  _updateExcitement(dt) {
    let base = 0.25;
    if (!this.over && this.period >= RULES.QUARTERS && this.gameClock < 75) {
      const margin = Math.abs(this.homeScore - this.awayScore);
      if (margin <= 8) base += 0.2 * (1 - margin / 8);
    }
    if (this.over) base = 0.85;
    const k = 1 - Math.exp(-dt / EXCITE_TAU);
    this.excitement += (base - this.excitement) * k;
    if (!Number.isFinite(this.excitement)) this.excitement = base;
  }

  // ---- LIVE PLAY --------------------------------------------------------------
  _updateLive(dt, input) {
    // Game clock — runs only live; buzzer-beater shots are allowed to resolve.
    const shotInAir = this.shotLive || !!this.shotWindup || this.ball.state === 'SHOT';
    if (!this.endPeriodPending) {
      this.gameClock -= dt;
      if (this.gameClock <= 0) {
        this.gameClock = 0;
        if (shotInAir) this.endPeriodPending = true;
        else { this._endPeriod(); return; }
      }
    }

    // Shot clock — frozen while a shot is in flight or winding up.
    if (!shotInAir && !this.endPeriodPending) {
      this.shotClock -= dt;
      if (this.shotClock <= 0) {
        this.shotClock = 0;
        this._turnover('SHOT CLOCK VIOLATION', 1 - this.possession);
        return;
      }
    }

    this._updateControl(input);

    // Movement intents.
    const ballLoose = this._ballIsLoose();
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      e.moveX = 0; e.moveZ = 0; e.moveSpeed = 0; e.hasFace = false;
      if (e === this.controlled) continue;              // user handled below
      if (e.busy || e.staggerT > 0) continue;
      try {
        if (this.shotLive || (this.reboundPhase && this.ball.state === 'SHOT')) {
          AI.updateRebound(e, this, dt);
        } else if (ballLoose) {
          AI.updateLooseChase(e, this, dt);
        } else if (e === this.handler) {
          if (e.team === 1) AI.updateHandlerAI(e, this, dt);
        } else if (e.team === this.possession) {
          AI.updateOffenseOffBall(e, this, dt);
        } else {
          AI.updateDefense(e, this, dt, true);
        }
      } catch (err) {}
      if (this.state !== 'live') return; // an AI decision changed the state
    }

    this._updateUser(dt, input);
    if (this.state !== 'live') return;

    // Flights and scrambles.
    if (this.passInfo) { this._updatePass(dt); if (this.state !== 'live') return; }
    if (this.shotLive) this._updateShotFlight(dt);
    this._updatePickup(dt);
    if (this.state !== 'live') return;

    // Watchdog: never softlock on a dead loose ball.
    if (!this.handler && !this.shotWindup && (this._ballIsLoose() || this.reboundPhase)) {
      this.watchdogT += dt;
      if (this.watchdogT > WATCHDOG_TIME) {
        this.watchdogT = 0;
        if (this.endPeriodPending) { this._endPeriod(); return; }
        if (this.audio) { try { this.audio.whistle(); } catch (e) {} }
        this._setupInbound(this.possession, false);
        return;
      }
    } else {
      this.watchdogT = 0;
    }
  }

  _ballIsLoose() {
    const st = this.ball.state;
    if (st === 'FREE') return true;
    if (st === 'PASS' && !this.passInfo) return true;
    return false;
  }

  // ---- user control routing -----------------------------------------------------
  _updateControl(input) {
    const onOffense = this.possession === 0 && this.handler && this.handler.team === 0;
    if (onOffense) {
      this.controlled = this.handler;
      return;
    }
    const bp = this.ball.mesh.position;
    const loose = this._ballIsLoose() || this.shotLive || this.reboundPhase;
    if (loose) {
      // Nearest home player with hysteresis so control doesn't flicker.
      const near = this._nearestOfTeam(0, bp.x, bp.z);
      if (near && near !== this.controlled) {
        const dNear = Math.hypot(near.pos.x - bp.x, near.pos.z - bp.z);
        const cur = this.controlled;
        const dCur = cur ? Math.hypot(cur.pos.x - bp.x, cur.pos.z - bp.z) : 1e9;
        if (!cur || cur.team !== 0 || dNear + 0.8 < dCur) this.controlled = near;
      }
      if (input.switchPressed) this.controlled = near || this.controlled;
      return;
    }
    // Defense: switch to nearest-to-ball on demand.
    if (input.switchPressed) {
      const near = this._nearestOfTeam(0, bp.x, bp.z);
      if (near) this.controlled = near;
    }
    if (!this.controlled || this.controlled.team !== 0) {
      this.controlled = this._nearestOfTeam(0, bp.x, bp.z) || this.entities[0];
    }
  }

  _updateUser(dt, input) {
    const ent = this.controlled;
    if (!ent) return;
    const hasBall = this.handler === ent;
    const onOffense = this.possession === 0;

    // --- movement ---
    let mx = fin(input.moveX, 0);
    let mz = fin(input.moveZ, 0);
    let len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; len = 1; }
    const sprint = !!input.sprint && len > 0.1;
    ent.sprinting = sprint;

    if (!ent.busy && ent.staggerT <= 0 && len > 0.05) {
      let speed;
      if (hasBall) speed = sprint ? PLAYER.DRIBBLE_SPRINT_SPEED : PLAYER.DRIBBLE_SPEED;
      else if (!onOffense && !sprint) speed = PLAYER.DEFENSE_SPEED;
      else speed = sprint ? PLAYER.SPRINT_SPEED : PLAYER.RUN_SPEED;
      ent.moveX = mx; ent.moveZ = mz; ent.moveSpeed = speed * len;

      // Hard direction change squeak.
      const vl = ent.vel.length();
      if (vl > 3.2) {
        const dot = (ent.vel.x * mx + ent.vel.z * mz) / vl;
        if (dot < -0.25 && Math.random() < dt * 4 && this.audio) {
          try { this.audio.squeak(); } catch (e) {}
        }
      }
    }

    // --- facing ---
    if (hasBall) {
      const rim = this.attackRim(0);
      if (len > 0.2) { ent.faceX = ent.pos.x + mx * 2; ent.faceZ = ent.pos.z + mz * 2; }
      else { ent.faceX = rim.x; ent.faceZ = rim.z; }
      ent.hasFace = true;
    } else if (!onOffense) {
      const target = this.handler || null;
      ent.faceX = target ? target.pos.x : this.ball.mesh.position.x;
      ent.faceZ = target ? target.pos.z : this.ball.mesh.position.z;
      ent.hasFace = true;
    }

    // --- actions ---
    if (hasBall && onOffense) {
      this._updateMeter(ent, dt, input);
      if (input.passPressed && !ent.busy && !this.meter.active) {
        const dirX = len > 0.2 ? mx : Math.sin(ent.facing);
        const dirZ = len > 0.2 ? mz : Math.cos(ent.facing);
        let recv = null;
        try { recv = AI.pickBestReceiver(ent, this, dirX, dirZ); } catch (e) {}
        if (recv) {
          this.playOneShot(ent, 'pass', {
            onRelease: () => this._launchPass(ent, recv),
          });
        }
      }
    } else if (!onOffense) {
      if (input.stealPressed) this._stealAttempt(ent, true);
      if (input.shootPressed) this._blockAttempt(ent);
    }

    // Ball-handler out of bounds (only the user can wander out; AI is clamped).
    if (hasBall && this.state === 'live' &&
        (Math.abs(ent.pos.x) > COURT.HALF_LENGTH + OOB_MARGIN ||
         Math.abs(ent.pos.z) > COURT.HALF_WIDTH + OOB_MARGIN)) {
      ent.pos.x = clampNum(ent.pos.x, -COURT.HALF_LENGTH + 1, COURT.HALF_LENGTH - 1);
      ent.pos.z = clampNum(ent.pos.z, -COURT.HALF_WIDTH + 1, COURT.HALF_WIDTH - 1);
      this._turnover('OUT OF BOUNDS', 1 - ent.team);
    }
  }

  // ---- user shot meter -----------------------------------------------------------
  _updateMeter(ent, dt, input) {
    const m = this.meter;
    if (input.shootPressed && !m.active && !ent.busy) {
      m.active = true;
      m.t = 0;
      m.power = 0;
    }
    if (!m.active) return;

    m.t += dt;
    m.power = m.t <= METER_RAMP
      ? m.t / METER_RAMP
      : Math.max(0, 1 - (m.t - METER_RAMP) / METER_RAMP);

    // Live sweet zone: skill for the zone, shrunk by contest and movement.
    const rim = this.attackRim(0);
    const dist = Math.hypot(rim.x - ent.pos.x, rim.z - ent.pos.z);
    const three = isThreePointer(ent.pos.x, ent.pos.z, rim.x);
    const skill = three ? ent.data.three : (dist < 3 ? ent.data.finishing : ent.data.mid);
    let w = SWEET_BASE_WIDTH * (0.7 + 0.6 * skill) + this.diff.userShotBonus * 0.55;
    const cd = this._nearestOppDist(ent);
    if (cd < CONTEST_RANGE) w *= 0.55 + 0.45 * (cd / CONTEST_RANGE);
    const sp = ent.vel.length();
    w *= 1 - 0.30 * Math.min(1, sp / PLAYER.DRIBBLE_SPRINT_SPEED);
    w = clampNum(w, 0.045, 0.30);
    m.sweetStart = clampNum(SWEET_CENTER - w / 2, 0, 1);
    m.sweetEnd = clampNum(SWEET_CENTER + w / 2, 0, 1);

    const expired = m.t >= METER_RAMP * 2;
    if (input.shootReleased || expired) {
      const power = expired ? 0 : m.power;
      this._releaseUserShot(ent, power);
    }
  }

  _releaseUserShot(ent, power) {
    const m = this.meter;
    const center = (m.sweetStart + m.sweetEnd) / 2;
    const half = Math.max((m.sweetEnd - m.sweetStart) / 2, 0.02);
    const nd = Math.abs(power - center) / half;
    let quality = clampNum(1 - 0.30 * nd, 0, 1);
    const inSweet = power >= m.sweetStart && power <= m.sweetEnd && m.sweetEnd > m.sweetStart;
    this._cancelMeter();
    if (this.handler !== ent || ent.busy) return;
    this._shotPerfect = inSweet;

    const rim = this.attackRim(0);
    const dx = rim.x - ent.pos.x, dz = rim.z - ent.pos.z;
    const dist = Math.hypot(dx, dz);
    let layup = false;
    if (dist < LAYUP_RANGE) {
      const toward = dist > 1e-4 ? (ent.vel.x * dx + ent.vel.z * dz) / dist : 0;
      layup = toward > 0.5 || dist < 2.0;
    }
    if (layup) quality = Math.max(quality, 0.5);

    this.shotWindup = { ent, blocked: false };
    const ok = this.playOneShot(ent, layup ? 'layup' : 'shoot', {
      onRelease: () => this._launchShot(ent, quality, layup, true),
    });
    if (!ok) this.shotWindup = null;
  }

  // ==========================================================================
  // SHOOTING (shared by user and AI)
  // ==========================================================================
  // Called by ai.js for the away handler (and forced heaves).
  aiAttemptShot(ent, opts) {
    if (this.over || this.state !== 'live') return false;
    if (!ent || ent.busy || this.handler !== ent) return false;
    const o = opts || {};
    const rim = this.attackRim(ent.team);
    const dist = Math.hypot(rim.x - ent.pos.x, rim.z - ent.pos.z);
    const layup = !!o.layup && dist < LAYUP_RANGE + 0.4;

    // AI shot quality models release timing: difficulty x skill + noise.
    const three = isThreePointer(ent.pos.x, ent.pos.z, rim.x);
    const skill = three ? ent.data.three : (dist < 3 ? ent.data.finishing : ent.data.mid);
    let quality = 0.30 + 0.45 * this.diff.aiShotSkill * (0.5 + 0.5 * skill)
      + Math.random() * 0.12;
    if (o.forced) quality -= 0.28;
    if (layup) quality = Math.max(quality, 0.5);
    quality = clampNum(quality, 0.05, 0.98);

    this.shotWindup = { ent, blocked: false };
    const ok = this.playOneShot(ent, layup ? 'layup' : 'shoot', {
      onRelease: () => this._launchShot(ent, quality, layup, false),
    });
    if (!ok) this.shotWindup = null;
    return ok;
  }

  _launchShot(ent, quality, isLayup, isUser) {
    const windup = this.shotWindup;
    this.shotWindup = null;
    if (this.over || this.handler !== ent) return;
    this.handler = null;

    // Release point.
    let rp = null;
    try { rp = ent.model ? ent.model.getReleasePoint(_rel) : null; } catch (e) { rp = null; }
    if (!rp || !Number.isFinite(_rel.x) || !Number.isFinite(_rel.y) || !Number.isFinite(_rel.z)) {
      _rel.set(ent.pos.x, 2.05, ent.pos.z);
    }

    // Blocked during the wind-up: fumble the ball instead of launching.
    if (windup && windup.blocked) {
      const rim = this.attackRim(ent.team);
      let ax = ent.pos.x - rim.x, az = ent.pos.z - rim.z;
      const al = Math.hypot(ax, az) || 1;
      _pvel.set((ax / al) * 3 + (Math.random() - 0.5), 0.8, (az / al) * 3 + (Math.random() - 0.5));
      this.ball.drop(_rel, _pvel);
      this.watchdogT = 0;
      return;
    }

    const rim = this.attackRim(ent.team);
    const hoopIndex = ent.team === 0 ? 1 : 0;
    const dist = Math.hypot(rim.x - _rel.x, rim.z - _rel.z);
    const three = isThreePointer(_rel.x, _rel.z, rim.x);
    const points = three ? 3 : 2;

    // Make probability.
    const d = ent.data;
    const skill = three ? d.three : (dist < 3 ? d.finishing : d.mid);
    let base = isLayup ? 0.55 + 0.38 * d.finishing
      : three ? 0.30 + 0.48 * skill
      : 0.40 + 0.50 * skill;
    let p = base * (0.22 + 0.78 * clampNum(quality, 0, 1));
    const cd = this._nearestOppDist(ent);
    if (cd < CONTEST_RANGE) p -= (isLayup ? 0.24 : 0.32) * (1 - cd / CONTEST_RANGE);
    if (dist > 8) p -= (dist - 8) * 0.06;
    if (isUser) p += this.diff.userShotBonus;
    else p *= 0.76;   // tuned: AI hits ~half of its open looks on 'pro'
    p = clampNum(p, 0.02, 0.95);
    const make = Math.random() < p;

    // Target selection.
    const ang = Math.random() * Math.PI * 2;
    if (make) {
      const off = Math.random() * COURT.RIM_RADIUS * 0.4;
      _tgt.set(
        rim.x + Math.cos(ang) * off,
        COURT.RIM_HEIGHT + (isLayup ? 0.12 : 0),
        rim.z + Math.sin(ang) * off
      );
    } else if (quality < 0.35) {
      const r = Math.random();
      if (r < 0.32) {
        // Clank it off the backboard.
        const s = Math.sign(rim.x) || 1;
        _tgt.set(
          s * (COURT.BACKBOARD_X - 0.02),
          COURT.RIM_HEIGHT + 0.35 + Math.random() * 0.45,
          (Math.random() - 0.5) * 0.9
        );
      } else if (r < 0.55) {
        // Airball: short and wide.
        const pull = 0.5 + Math.random() * 0.4;
        _tgt.set(
          rim.x + (_rel.x - rim.x) * (pull * 0.12) + Math.cos(ang) * 0.5,
          COURT.RIM_HEIGHT - 0.15,
          rim.z + (_rel.z - rim.z) * (pull * 0.12) + Math.sin(ang) * 0.5
        );
        _tgt.x += (_rel.x - rim.x) / Math.max(dist, 1) * pull;
        _tgt.z += (_rel.z - rim.z) / Math.max(dist, 1) * pull;
      } else {
        // Short: falls up to 0.45 m in front of the rim.
        const pull = 0.2 + Math.random() * 0.25;
        _tgt.set(
          rim.x + (_rel.x - rim.x) / Math.max(dist, 1) * pull,
          COURT.RIM_HEIGHT,
          rim.z + (_rel.z - rim.z) / Math.max(dist, 1) * pull
        );
      }
    } else {
      // Rim-out: hit the edge of the iron.
      const rr = COURT.RIM_RADIUS * (0.9 + Math.random() * 0.4);
      _tgt.set(rim.x + Math.cos(ang) * rr, COURT.RIM_HEIGHT, rim.z + Math.sin(ang) * rr);
    }

    const apex = Math.max(_rel.y, COURT.RIM_HEIGHT) + 0.9 + 0.055 * dist;
    this.ball.launchShot(_rel, _tgt, apex, { shooter: ent });

    this.pendingShot = { shooter: ent, points, hoopIndex };
    this.shotLive = true;
    this.shotTime = 0;
    this.reboundPhase = false;
    this.lastTouchTeam = ent.team;
    this.watchdogT = 0;
    this._spike(three ? 0.5 : 0.42);
    try { AI.resetBoxOut(this.entities); } catch (e) {}
  }

  _updateShotFlight(dt) {
    if (this.ball.state !== 'SHOT') {
      // Deflected/handled elsewhere.
      if (this.ball.state === 'HELD') { this.shotLive = false; this.reboundPhase = false; }
      return;
    }
    this.shotTime += dt;
    const bp = this.ball.mesh.position;
    const bv = this.ball.velocity;
    if (!this.reboundPhase && this.shotTime > 0.35 && bv.y < 0 && bp.y < REBOUND_HEIGHT) {
      this.reboundPhase = true; // the miss is now a live rebound
    }
  }

  // ==========================================================================
  // PASSING
  // ==========================================================================
  aiPass(passer, receiver) {
    if (this.over || this.state !== 'live') return false;
    if (!passer || passer.busy || this.handler !== passer || !receiver) return false;
    return this.playOneShot(passer, 'pass', {
      onRelease: () => this._launchPass(passer, receiver),
    });
  }

  _launchPass(passer, receiver) {
    if (this.over || this.handler !== passer || !receiver) return;
    this.handler = null;

    _start.set(passer.pos.x, CHEST_HEIGHT, passer.pos.z);
    let dx = receiver.pos.x - _start.x;
    let dz = receiver.pos.z - _start.z;
    let dist = Math.hypot(dx, dz);
    if (!(dist > 0.01)) dist = 0.01;
    const T = clampNum(dist / PLAYER.PASS_SPEED, 0.08, 1.4);

    // Lead the receiver, arrive at chest height (vertical gravity compensation).
    const lx = receiver.pos.x + receiver.vel.x * T;
    const lz = receiver.pos.z + receiver.vel.z * T;
    _pvel.set((lx - _start.x) / T, 0.5 * G * T, (lz - _start.z) / T);
    if (!Number.isFinite(_pvel.x) || !Number.isFinite(_pvel.y) || !Number.isFinite(_pvel.z)) {
      _pvel.set(dx, 0.4, dz);
    }
    this.ball.launchPass(_start, _pvel);

    this._passId++;
    this.passInfo = { passer, receiver, team: passer.team, t: 0 };
    this.lastTouchTeam = passer.team;
    this.watchdogT = 0;
  }

  _updatePass(dt) {
    const pi = this.passInfo;
    if (!pi) return;
    if (this.ball.state !== 'PASS') {
      if (this.ball.state !== 'HELD') this.passInfo = null;
      return;
    }
    pi.t += dt;
    if (pi.t > 3) { this.passInfo = null; return; } // gone loose

    const bp = this.ball.mesh.position;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e === pi.passer && pi.t < 0.25) continue;
      const hd = Math.hypot(e.pos.x - bp.x, e.pos.z - bp.z);
      const vd = Math.abs(bp.y - CHEST_HEIGHT);
      if (vd > 1.0) continue;

      if (e.team === pi.team) {
        if (hd < PLAYER.CATCH_RADIUS) { this.passInfo = null; this._gainPossession(e); return; }
      } else if (e._passTry !== this._passId && hd < 0.7) {
        e._passTry = this._passId;
        // Interceptions: uncommon but real.
        const pInt = 0.06 + 0.18 * this.diff.aiReaction * (0.5 + 0.5 * e.data.defense);
        if (Math.random() < pInt) {
          this.passInfo = null;
          this.playOneShot(e, 'steal');
          this._gainPossession(e);
          this._msg('INTERCEPTED!', 1.8, TEAMS[e.team].primary);
          this._spike(0.65);
          if (this.audio) {
            try { e.team === 0 ? this.audio.cheer(false) : this.audio.groan(); } catch (err) {}
          }
          return;
        } else if (hd < 0.45 && Math.random() < 0.3) {
          // Tipped away.
          _pvel.set((Math.random() - 0.5) * 4, 1.4, (Math.random() - 0.5) * 4);
          this.ball.drop(bp, _pvel);
          this.passInfo = null;
          this.lastTouchTeam = e.team;
          return;
        }
      }
    }
  }

  // ==========================================================================
  // STEALS & BLOCKS
  // ==========================================================================
  aiStealAttempt(ent) { this._stealAttempt(ent, false); }

  _stealAttempt(stealer, isUser) {
    if (this.over || this.state !== 'live') return;
    if (!stealer || stealer.busy || stealer.staggerT > 0 || stealer.stealCd > 0) return;
    const target = this.handler;
    if (!target || target.team === stealer.team) return;

    stealer.stealCd = STEAL_COOLDOWN;
    this.playOneShot(stealer, 'steal');

    const dist = Math.hypot(target.pos.x - stealer.pos.x, target.pos.z - stealer.pos.z);
    if (dist > PLAYER.STEAL_RANGE || target.protectT > 0) return; // whiff

    const handlerSkill = target.data.speed * 0.5 + target.data.mid * 0.25 + target.data.three * 0.25;
    let p = 0.25 + 0.30 * (stealer.data.defense - handlerSkill);
    if (!isUser) p *= 0.55 + 0.45 * this.diff.aiAggression;
    p = clampNum(p, 0.05, 0.55);

    if (Math.random() < p) {
      // Pop the ball loose toward the stealer.
      let nx = stealer.pos.x - target.pos.x, nz = stealer.pos.z - target.pos.z;
      const nl = Math.hypot(nx, nz) || 1;
      _pvel.set((nx / nl) * 2.6 + (Math.random() - 0.5), 1.1, (nz / nl) * 2.6 + (Math.random() - 0.5));
      this.handler = null;
      this._cancelMeter();
      this.shotWindup = null;
      this.ball.drop(this.ball.mesh.position, _pvel);
      this.lastTouchTeam = stealer.team;
      this.watchdogT = 0;
      this._msg('STEAL!', 1.6, TEAMS[stealer.team].primary);
      this._spike(0.6);
      if (this.audio) {
        try { stealer.team === 0 ? this.audio.cheer(false) : this.audio.groan(); } catch (e) {}
      }
    } else {
      stealer.staggerT = STAGGER_TIME;
      target.protectT = PROTECT_TIME;
    }
  }

  _blockAttempt(blocker) {
    if (this.over || this.state !== 'live') return;
    if (!blocker || blocker.busy || blocker.staggerT > 0) return;
    this.playOneShot(blocker, 'block');

    let shooter = null;
    let phase = null;
    if (this.shotWindup && this.shotWindup.ent.team !== blocker.team) {
      shooter = this.shotWindup.ent; phase = 'windup';
    } else if (this.shotLive && this.shotTime < BLOCK_WINDOW && this.pendingShot) {
      shooter = this.pendingShot.shooter; phase = 'flight';
    }
    if (!shooter) return;

    const dist = Math.hypot(shooter.pos.x - blocker.pos.x, shooter.pos.z - blocker.pos.z);
    if (dist > PLAYER.BLOCK_RANGE) return;

    let p = 0.30 + 0.42 * blocker.data.defense;
    if (phase === 'flight') p -= this.shotTime * 1.0;
    p = clampNum(p, 0.05, 0.7);
    if (Math.random() >= p) return;

    if (phase === 'windup') {
      this.shotWindup.blocked = true;
      this.lastTouchTeam = blocker.team;
    } else {
      const bp = this.ball.mesh.position;
      const rim = this.attackRim(shooter.team);
      let nx = bp.x - rim.x, nz = bp.z - rim.z;
      const nl = Math.hypot(nx, nz) || 1;
      _pvel.set((nx / nl) * 4.2 + (Math.random() - 0.5) * 2, 1.6, (nz / nl) * 4.2 + (Math.random() - 0.5) * 2);
      this.ball.drop(bp, _pvel);
      this.shotLive = false;
      this.reboundPhase = false;
      this.pendingShot = null;
      this.lastTouchTeam = blocker.team;
    }
    this._msg('BLOCKED!', 1.8, TEAMS[blocker.team].primary);
    this._spike(0.75);
    if (this.audio) {
      try { blocker.team === 0 ? this.audio.cheer(true) : this.audio.groan(); } catch (e) {}
    }
  }

  // ==========================================================================
  // LOOSE BALLS, REBOUNDS, PICKUPS
  // ==========================================================================
  _updatePickup(dt) {
    const st = this.ball.state;
    const bp = this.ball.mesh.position;
    const rebounding = st === 'SHOT' && this.reboundPhase;
    const loose = this._ballIsLoose() || rebounding;
    if (!loose) return;

    // Loose ball out of bounds -> other team from the last touch.
    if (bp.y < 1.3 &&
        (Math.abs(bp.x) > COURT.HALF_LENGTH + 0.1 || Math.abs(bp.z) > COURT.HALF_WIDTH + 0.1)) {
      this._turnover('OUT OF BOUNDS', 1 - this.lastTouchTeam);
      return;
    }

    if (bp.y > REBOUND_HEIGHT) return;

    // Contest: reach shrinks once the ball is low (it becomes a scoop).
    const high = bp.y > 1.6;
    const reach = high ? REBOUND_REACH : PLAYER.CATCH_RADIUS;
    const speed = this.ball.velocity.length();
    if (high && speed > 7.5) return; // still rocketing off the rim

    let winner = null, bestScore = -1e9;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.staggerT > 0) continue;
      const hd = Math.hypot(e.pos.x - bp.x, e.pos.z - bp.z);
      if (hd > reach) continue;
      const score = (e.data.rebound || 0.4) + Math.random() * 0.3 - hd * 0.25;
      if (score > bestScore) { bestScore = score; winner = e; }
    }
    if (winner) this._gainPossession(winner);
  }

  // ==========================================================================
  // PHYSICAL POST-UPDATE: integrate, collide, clamp, face, animate, hold ball
  // ==========================================================================
  _postUpdate(dt) {
    const ents = this.entities;

    // Integrate intents (accel/friction).
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.busy || e.staggerT > 0) { e.moveX = 0; e.moveZ = 0; e.moveSpeed = 0; }
      const hasInput = (e.moveX * e.moveX + e.moveZ * e.moveZ) > 1e-6 && e.moveSpeed > 0.01;
      const steer = e.sprinting ? 0.7 : 1;                 // sprint = less agile
      const rate = (hasInput ? PLAYER.ACCEL : PLAYER.FRICTION) * steer * dt;
      const tvx = hasInput ? e.moveX * e.moveSpeed : 0;
      const tvz = hasInput ? e.moveZ * e.moveSpeed : 0;
      let dvx = tvx - e.vel.x;
      let dvz = tvz - e.vel.z;
      const dl = Math.hypot(dvx, dvz);
      if (dl > rate && dl > 1e-6) { dvx = dvx / dl * rate; dvz = dvz / dl * rate; }
      e.vel.x += dvx;
      e.vel.z += dvz;
      e.pos.x += e.vel.x * dt;
      e.pos.z += e.vel.z * dt;
    }

    // Soft pairwise collisions.
    const minD = PLAYER.RADIUS * 2;
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const a = ents[i], b = ents[j];
        let dx = b.pos.x - a.pos.x;
        let dz = b.pos.z - a.pos.z;
        let d = Math.hypot(dx, dz);
        if (d >= minD) continue;
        if (d < 1e-4) { dx = 0.01 * (i - j); dz = 0.013; d = Math.hypot(dx, dz); }
        const push = (minD - d) * 0.5;
        dx /= d; dz /= d;
        a.pos.x -= dx * push; a.pos.z -= dz * push;
        b.pos.x += dx * push; b.pos.z += dz * push;
      }
    }

    // Court clamp: everyone stays in bounds except the (user) ball handler,
    // whose out-of-bounds is a rules event handled in _updateUser.
    const userHandler = this.handler && this.handler === this.controlled && this.state === 'live';
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (userHandler && e === this.handler) continue;
      e.pos.x = clampNum(e.pos.x, -COURT.HALF_LENGTH + CLAMP_MARGIN, COURT.HALF_LENGTH - CLAMP_MARGIN);
      e.pos.z = clampNum(e.pos.z, -COURT.HALF_WIDTH + CLAMP_MARGIN, COURT.HALF_WIDTH - CLAMP_MARGIN);
    }

    // Facing, model sync, animation.
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const speed = Math.hypot(e.vel.x, e.vel.z);
      let targetA = e.facing;
      if (e.hasFace) {
        const fx = e.faceX - e.pos.x, fz = e.faceZ - e.pos.z;
        if (fx * fx + fz * fz > 0.01) targetA = Math.atan2(fx, fz);
      } else if (speed > 0.6) {
        targetA = Math.atan2(e.vel.x, e.vel.z);
      }
      const diff = wrapAngle(targetA - e.facing);
      e.facing = wrapAngle(e.facing + diff * Math.min(1, TURN_RATE * dt));
      if (!Number.isFinite(e.facing)) e.facing = 0;

      const model = e.model;
      if (!model) continue;
      model.group.position.set(e.pos.x, 0, e.pos.z);
      model.group.rotation.y = e.facing;

      try {
        model.setMoveSpeed(speed);
        if (!e.busy) {
          let anim;
          const hasBall = this.handler === e;
          if (speed < 0.4) {
            if (hasBall) anim = 'dribbleIdle';
            else if (this._inDefenseStance(e)) anim = 'defense';
            else anim = 'idle';
          } else if (hasBall) {
            anim = 'dribbleRun';
          } else {
            anim = speed > 5.5 ? 'sprint' : 'run';
          }
          if (anim !== e.animName) {
            e.animName = anim;
            model.setAnimation(anim);
          }
        } else {
          e.animName = '';
        }
        model.update(dt);
      } catch (err) {}
    }

    // Hold / dribble the ball.
    if (this.handler) this._syncHeldBall(dt);
  }

  _inDefenseStance(e) {
    if (this.over || e.team === this.possession || !this.handler) return false;
    const man = this.entities[(1 - e.team) * 5 + e.idx];
    if (!man) return false;
    return Math.hypot(man.pos.x - e.pos.x, man.pos.z - e.pos.z) < 3.2;
  }

  _syncHeldBall(dt) {
    const ent = this.handler;
    let ok = false;
    try {
      if (ent.model) { ent.model.getBallAnchor(_anchor); ok = true; }
    } catch (e) { ok = false; }
    if (!ok || !Number.isFinite(_anchor.x) || !Number.isFinite(_anchor.y) || !Number.isFinite(_anchor.z)) {
      _anchor.set(
        ent.pos.x + Math.sin(ent.facing + 0.5) * 0.35,
        0.95,
        ent.pos.z + Math.cos(ent.facing + 0.5) * 0.35
      );
    }

    if (ent.busy || this.state !== 'live') {
      // Wind-ups, celebrations, dead balls: ball stays in the hands.
      this.ball.setHeld(_anchor);
      return;
    }

    // game.js owns the dribble: bounce between the hand anchor and the floor.
    const speed = Math.hypot(ent.vel.x, ent.vel.z);
    const cycle = speed > 5 ? DRIBBLE_CYCLE_SPRINT : DRIBBLE_CYCLE;
    const prevU = this._dribbleT % 1;
    this._dribbleT += dt / cycle;
    if (this._dribbleT > 1e6) this._dribbleT = this._dribbleT % 1;
    const u = this._dribbleT % 1;
    if (prevU < 0.5 && u >= 0.5 && this.audio) {
      try { this.audio.bounce(0.3); } catch (e) {}
    }
    const hi = Math.max(_anchor.y, 0.5);
    const y = PHYSICS.BALL_RADIUS + (hi - PHYSICS.BALL_RADIUS) * Math.abs(Math.cos(Math.PI * u));
    _hold.set(_anchor.x, y, _anchor.z);
    this.ball.setHeld(_hold);
  }

  // ---- NaN protection --------------------------------------------------------------
  _sanitize() {
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.z)) e.pos.set(0, 0, 0);
      e.pos.y = 0;
      if (!Number.isFinite(e.vel.x) || !Number.isFinite(e.vel.z)) e.vel.set(0, 0, 0);
      e.vel.y = 0;
    }
    const bp = this.ball.mesh.position;
    if (!Number.isFinite(bp.x) || !Number.isFinite(bp.y) || !Number.isFinite(bp.z)) {
      bp.set(0, 1, 0);
      this.ball.velocity.set(0, 0, 0);
      if (!this.over && this.state === 'live') {
        if (this.audio) { try { this.audio.whistle(); } catch (e) {} }
        this._setupInbound(this.possession, false);
      }
    }
    if (!Number.isFinite(this.gameClock)) this.gameClock = 0;
    if (!Number.isFinite(this.shotClock)) this.shotClock = RULES.SHOT_CLOCK;
  }
}
