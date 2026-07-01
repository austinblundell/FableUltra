// ============================================================================
// ai.js — decision making and positioning for all non-user-controlled players.
// Consumed exclusively by game.js. Exports pure-ish update functions that read
// game state and write movement intents onto entities:
//   ent.moveX / ent.moveZ  — desired direction (unit-ish, 0 when idle)
//   ent.moveSpeed          — target max speed (m/s)
//   ent.faceX / ent.faceZ  — world point the entity wants to face
// game.js runs a single accel/friction integrator over those intents.
//
// Interface expected on `game` (see game.js):
//   entities, handler, ball, possession, state, shotClock, diff, audio
//   attackRim(team) / defendRim(team) -> THREE.Vector3 (rim centers)
//   aiAttemptShot(ent, opts), aiPass(passer, receiver), aiStealAttempt(ent)
//   playOneShot(ent, name, opts)
// ============================================================================

import { COURT, PLAYER, isThreePointer } from './constants.js';

// ---- tunables ---------------------------------------------------------------
const SPACING_MIN = 3.0;        // teammates repel inside this range
const CUT_TIME_MIN = 6.0;       // seconds between off-ball cut opportunities
const CUT_TIME_MAX = 9.0;
const CUT_DURATION = 1.9;
const BALLWATCH_DIST = 2.6;     // defender this far from his man = ball watching
const OPEN_SHOT_DIST = 1.8;     // defender beyond this = open
const DRIVE_LANE_WIDTH = 1.15;  // corridor half-width for lane-openness test
const SWIPE_COOLDOWN = 2.6;
const HANDLER_ADVANCE_DIST = 9.6; // beyond this from the rim: bring the ball up
const CLAMP_MARGIN = 0.45;

// ---- module scratch (zero per-frame allocations) ------------------------------
const _spot = { x: 0, z: 0 };

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function clampCourtXZ(o) {
  o.x = clamp(o.x, -COURT.HALF_LENGTH + CLAMP_MARGIN, COURT.HALF_LENGTH - CLAMP_MARGIN);
  o.z = clamp(o.z, -COURT.HALF_WIDTH + CLAMP_MARGIN, COURT.HALF_WIDTH - CLAMP_MARGIN);
}

// Per-entity AI scratch state. Called once at entity creation.
export function initAI(ent) {
  ent.ai = {
    cutT: CUT_TIME_MIN + Math.random() * (CUT_TIME_MAX - CUT_TIME_MIN),
    cutting: false,
    cutX: 0, cutZ: 0, cutDur: 0,
    decideT: Math.random() * 0.3,
    mode: 'probe',          // handler: 'probe' | 'drive' | 'retreat'
    modeT: 0,
    strafe: (ent.idx % 2 === 0) ? 1 : -1,
    strafeT: 1 + Math.random() * 2,
    swipeT: 1 + Math.random() * 2,
    boxX: 0, boxZ: 0, boxSet: false,
  };
}

// Writes a movement intent. Direction is normalized here so callers can pass
// raw deltas.
export function setMove(ent, dx, dz, speed) {
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-5) || !Number.isFinite(len)) {
    ent.moveX = 0; ent.moveZ = 0; ent.moveSpeed = 0;
    return;
  }
  ent.moveX = dx / len;
  ent.moveZ = dz / len;
  ent.moveSpeed = Number.isFinite(speed) ? speed : 0;
}

// Seek a point with arrive damping.
export function seek(ent, tx, tz, speed, arriveR) {
  const dx = tx - ent.pos.x;
  const dz = tz - ent.pos.z;
  const dist = Math.hypot(dx, dz);
  const r = arriveR || 0.9;
  if (dist < 0.12) { setMove(ent, 0, 0, 0); return dist; }
  const s = speed * clamp(dist / r, 0.25, 1);
  setMove(ent, dx, dz, s);
  return dist;
}

// AI locomotion speed for an entity: constants scaled by attribute + AI scale.
export function aiSpeed(ent, base) {
  return base * PLAYER.AI_SPEED_SCALE * (0.9 + 0.2 * (ent.data.speed || 0.5));
}

// Nearest opponent distance (horizontal).
export function nearestOpponentDist(ent, game) {
  let best = 99;
  const ents = game.entities;
  for (let i = 0; i < ents.length; i++) {
    const o = ents[i];
    if (o.team === ent.team) continue;
    const d = Math.hypot(o.pos.x - ent.pos.x, o.pos.z - ent.pos.z);
    if (d < best) best = d;
  }
  return best;
}

// The defender matched up on `ent` (opposite roster slot).
export function matchupOf(ent, game) {
  return game.entities[(1 - ent.team) * 5 + ent.idx];
}

// ---- offense spots ------------------------------------------------------------
// Role-based half-court spots relative to the attacked hoop, mirrored by attack
// direction; wing/corner/post sides flip with the ball's z side for spacing.
export function getOffenseSpot(ent, game, out) {
  const s = ent.team === 0 ? 1 : -1;                 // attack direction sign
  const hx = s * COURT.HOOP_X;
  const bz = game.ball ? game.ball.mesh.position.z : 0;
  const side = bz >= 0 ? 1 : -1;
  let dx = 7.6, z = 0;
  switch (ent.idx) {
    case 0: dx = 7.8; z = -0.5 * side; break;        // PG — top of the key
    case 1: dx = 5.4; z = 5.7 * side; break;         // SG — ball-side wing
    case 2: dx = 1.3; z = 6.3 * -side; break;        // SF — weak-side corner
    case 3: dx = 4.9; z = 2.7 * -side; break;        // PF — weak elbow
    case 4: dx = 1.7; z = 2.3 * side; break;         // C  — ball-side low post
  }
  out.x = hx - s * dx;
  out.z = z;
  clampCourtXZ(out);
  return out;
}

// ---- off-ball offense ----------------------------------------------------------
export function updateOffenseOffBall(ent, game, dt) {
  const ai = ent.ai;
  getOffenseSpot(ent, game, _spot);

  // Rim cuts when the defender ball-watches.
  if (ai.cutting) {
    ai.cutDur -= dt;
    const d = Math.hypot(ai.cutX - ent.pos.x, ai.cutZ - ent.pos.z);
    if (ai.cutDur <= 0 || d < 0.7) {
      ai.cutting = false;
      ai.cutT = CUT_TIME_MIN + Math.random() * (CUT_TIME_MAX - CUT_TIME_MIN);
    } else {
      seek(ent, ai.cutX, ai.cutZ, aiSpeed(ent, PLAYER.SPRINT_SPEED) * 0.92, 0.8);
      faceBall(ent, game);
      return;
    }
  } else if (game.state === 'live') {
    ai.cutT -= dt * (0.7 + 0.6 * game.diff.aiReaction);
    if (ai.cutT <= 0) {
      const def = matchupOf(ent, game);
      const defDist = Math.hypot(def.pos.x - ent.pos.x, def.pos.z - ent.pos.z);
      const rim = game.attackRim(ent.team);
      const rimDist = Math.hypot(rim.x - ent.pos.x, rim.z - ent.pos.z);
      if (defDist > BALLWATCH_DIST && rimDist > 4 && Math.random() < 0.75) {
        ai.cutting = true;
        ai.cutDur = CUT_DURATION;
        const s = ent.team === 0 ? 1 : -1;
        ai.cutX = rim.x - s * 1.2;
        ai.cutZ = (Math.random() - 0.5) * 2.4;
        if (Math.random() < 0.35 && game.audio) game.audio.squeak();
      } else {
        ai.cutT = 2.5 + Math.random() * 3;
      }
    }
  }

  // Hold the spot, with spacing repulsion from teammates and the handler.
  let tx = _spot.x, tz = _spot.z;
  const ents = game.entities;
  for (let i = 0; i < ents.length; i++) {
    const o = ents[i];
    if (o === ent || o.team !== ent.team) continue;
    const dx = ent.pos.x - o.pos.x;
    const dz = ent.pos.z - o.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4 && d < SPACING_MIN) {
      const push = (SPACING_MIN - d) * 0.8;
      tx += (dx / d) * push;
      tz += (dz / d) * push;
    }
  }
  tx = clamp(tx, -COURT.HALF_LENGTH + CLAMP_MARGIN, COURT.HALF_LENGTH - CLAMP_MARGIN);
  tz = clamp(tz, -COURT.HALF_WIDTH + CLAMP_MARGIN, COURT.HALF_WIDTH - CLAMP_MARGIN);
  seek(ent, tx, tz, aiSpeed(ent, PLAYER.RUN_SPEED), 1.4);
  faceBall(ent, game);
}

function faceBall(ent, game) {
  if (game.ball) {
    ent.faceX = game.ball.mesh.position.x;
    ent.faceZ = game.ball.mesh.position.z;
    ent.hasFace = true;
  }
}

// ---- pass target selection (shared by user passes and AI passes) ----------------
// dirX/dirZ: preferred direction (input or facing); may be 0,0.
// Returns the best teammate or null. Never allocates.
export function pickBestReceiver(passer, game, dirX, dirZ) {
  let best = null;
  let bestScore = -1e9;
  const dLen = Math.hypot(dirX, dirZ);
  const hasDir = dLen > 1e-4;
  const s = passer.team === 0 ? 1 : -1;
  const ents = game.entities;
  for (let i = 0; i < ents.length; i++) {
    const mate = ents[i];
    if (mate.team !== passer.team || mate === passer) continue;
    const dx = mate.pos.x - passer.pos.x;
    const dz = mate.pos.z - passer.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.6) continue;
    let score = 0;
    if (hasDir && dist > 1e-4) {
      score += 2.4 * ((dx * dirX + dz * dirZ) / (dist * dLen));
    }
    // Openness: nearest defender to the receiver.
    let openD = 99;
    for (let j = 0; j < ents.length; j++) {
      const o = ents[j];
      if (o.team === passer.team) continue;
      const od = Math.hypot(o.pos.x - mate.pos.x, o.pos.z - mate.pos.z);
      if (od < openD) openD = od;
    }
    score += Math.min(openD, 5) * 0.55;
    // Behind the baseline-extended (deeper than the attacked hoop): risky.
    if (mate.pos.x * s > COURT.HOOP_X - 0.2) score -= 1.6;
    // Very long cross-court passes are risky too.
    if (dist > 10) score -= (dist - 10) * 0.25;
    if (score > bestScore) { bestScore = score; best = mate; }
  }
  return best;
}

// ---- AI ball handler -------------------------------------------------------------
export function updateHandlerAI(ent, game, dt) {
  const ai = ent.ai;
  const rim = game.attackRim(ent.team);
  const dx = rim.x - ent.pos.x;
  const dz = rim.z - ent.pos.z;
  const rimDist = Math.hypot(dx, dz);
  const defDist = nearestOpponentDist(ent, game);
  const d = ent.data;

  ent.faceX = rim.x; ent.faceZ = rim.z; ent.hasFace = true;

  // Bringing the ball up: just advance to the top of the key.
  if (rimDist > HANDLER_ADVANCE_DIST) {
    const s = ent.team === 0 ? 1 : -1;
    seek(ent, rim.x - s * 7.6, dz > 0 ? -0.5 : 0.5, aiSpeed(ent, PLAYER.DRIBBLE_SPRINT_SPEED) * 0.9, 1.2);
    ai.mode = 'probe';
    return;
  }

  if (game.state !== 'live') { seek(ent, ent.pos.x, ent.pos.z, 0, 1); return; }

  // Decision tick.
  ai.decideT -= dt;
  if (ai.decideT <= 0) {
    ai.decideT = (0.25 / Math.max(0.35, game.diff.aiReaction)) * (0.75 + Math.random() * 0.5);
    decideHandler(ent, game, rimDist, defDist);
    if (game.handler !== ent) return; // decision released the ball
  }

  // Execute current mode.
  ai.modeT -= dt;
  if (ai.mode === 'drive') {
    driveSteer(ent, game, rim, dt);
    if (rimDist < 2.7 && !ent.busy) {
      game.aiAttemptShot(ent, { layup: true });
      return;
    }
    if (ai.modeT <= 0) ai.mode = 'probe';
  } else if (ai.mode === 'retreat') {
    const s = ent.team === 0 ? 1 : -1;
    seek(ent, rim.x - s * 8.6, ent.pos.z * 0.5, aiSpeed(ent, PLAYER.DRIBBLE_SPEED), 1.0);
    if (ai.modeT <= 0) ai.mode = 'probe';
  } else {
    // Probe: hold ~7m from the rim, slow lateral strafe.
    ai.strafeT -= dt;
    if (ai.strafeT <= 0) { ai.strafeT = 1.2 + Math.random() * 1.6; ai.strafe = -ai.strafe; }
    const s = ent.team === 0 ? 1 : -1;
    const holdX = rim.x - s * 7.2;
    const holdZ = clamp(ent.pos.z + ai.strafe * 2.2, -6.4, 6.4);
    seek(ent, holdX, holdZ, aiSpeed(ent, PLAYER.DRIBBLE_SPEED) * 0.72, 1.6);
  }
}

function decideHandler(ent, game, rimDist, defDist) {
  const ai = ent.ai;
  const d = ent.data;
  const diff = game.diff;

  // Never hold with the clock dying: force a heave.
  if (game.shotClock < 3) {
    game.aiAttemptShot(ent, { forced: true, layup: rimDist < 3.2 });
    return;
  }

  const beyondArc = isThreePointer(ent.pos.x, ent.pos.z, game.attackRim(ent.team).x);
  const open = defDist > OPEN_SHOT_DIST;

  // (a) SHOOT when open in a good zone.
  if (open) {
    if (rimDist < 3.0 && Math.random() < 0.85) {
      game.aiAttemptShot(ent, { layup: true });
      return;
    }
    if (beyondArc && d.three > 0.7 && rimDist < 8.8 && Math.random() < 0.62) {
      game.aiAttemptShot(ent, {});
      return;
    }
    if (!beyondArc && rimDist > 3 && rimDist < 6.2 && d.mid > 0.6 && Math.random() < 0.42) {
      game.aiAttemptShot(ent, {});
      return;
    }
  }

  // (b) DRIVE when the lane is open enough.
  const lane = laneOpenness(ent, game);
  const driveWish = 0.42 * diff.aiAggression + 0.30 * d.speed;
  if (lane > 0.55 && Math.random() < driveWish + 0.25) {
    ai.mode = 'drive';
    ai.modeT = 0.9 + Math.random() * 0.7;
    if (Math.random() < 0.4 && game.audio) game.audio.squeak();
    return;
  }

  // (c) PASS to the best-open teammate (kickouts when pressured / collapsing).
  const recv = pickBestReceiver(ent, game, 0, 0);
  if (recv) {
    let recvOpen = 99;
    const ents = game.entities;
    for (let j = 0; j < ents.length; j++) {
      const o = ents[j];
      if (o.team === ent.team) continue;
      const od = Math.hypot(o.pos.x - recv.pos.x, o.pos.z - recv.pos.z);
      if (od < recvOpen) recvOpen = od;
    }
    const pressured = defDist < 1.25;
    const passWish = pressured ? 0.8 : (recvOpen > defDist + 1.2 ? 0.5 : 0.16);
    if (Math.random() < passWish) {
      game.aiPass(ent, recv);
      return;
    }
  }

  // (d) probe or retreat under pressure.
  if (defDist < 1.0 && Math.random() < 0.6) {
    ai.mode = 'retreat';
    ai.modeT = 0.6 + Math.random() * 0.5;
  } else {
    ai.mode = 'probe';
  }
}

// 0..1: how clear the corridor to the rim is.
function laneOpenness(ent, game) {
  const rim = game.attackRim(ent.team);
  const dx = rim.x - ent.pos.x;
  const dz = rim.z - ent.pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return 1;
  const nx = dx / len, nz = dz / len;
  let blockers = 0;
  const ents = game.entities;
  for (let i = 0; i < ents.length; i++) {
    const o = ents[i];
    if (o.team === ent.team) continue;
    const ox = o.pos.x - ent.pos.x;
    const oz = o.pos.z - ent.pos.z;
    const along = ox * nx + oz * nz;
    if (along < 0.3 || along > len) continue;
    const perp = Math.abs(ox * -nz + oz * nx);
    if (perp < DRIVE_LANE_WIDTH) blockers += 1 - perp / DRIVE_LANE_WIDTH;
  }
  return clamp(1 - blockers * 0.6, 0, 1);
}

// Steering toward the rim with simple perpendicular avoidance of defenders.
function driveSteer(ent, game, rim, dt) {
  let dx = rim.x - ent.pos.x;
  let dz = rim.z - ent.pos.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-4) { dx /= len; dz /= len; }
  const px = -dz, pz = dx;   // unit perpendicular to the drive line
  let ax = dx, az = dz;
  const ents = game.entities;
  for (let i = 0; i < ents.length; i++) {
    const o = ents[i];
    if (o.team === ent.team) continue;
    const ox = o.pos.x - ent.pos.x;
    const oz = o.pos.z - ent.pos.z;
    const d = Math.hypot(ox, oz);
    if (d > 1e-4 && d < 1.6) {
      // Steer perpendicular, away from the side the defender occupies.
      const side = (ox * px + oz * pz) >= 0 ? -1 : 1;
      const w = (1.6 - d) / 1.6;
      ax += px * side * w * 1.3;
      az += pz * side * w * 1.3;
    }
  }
  setMove(ent, ax, az, aiSpeed(ent, PLAYER.DRIBBLE_SPRINT_SPEED));
}

// ---- defense -----------------------------------------------------------------------
export function updateDefense(ent, game, dt, allowActions) {
  const ai = ent.ai;
  const man = matchupOf(ent, game);
  const rim = game.defendRim(ent.team);
  const manHasBall = game.handler === man;
  const diff = game.diff;

  ai.swipeT -= dt;

  // Stance point: on the segment man -> defended rim.
  let gap = manHasBall ? 1.1 : 2.0 + (1 - diff.aiAggression) * 1.4;
  let tx, tz;
  let refX = man.pos.x, refZ = man.pos.z;

  // Help defense: a driving handler beat his man into our key — nearest big helps.
  const handler = game.handler;
  if (handler && handler.team !== ent.team && handler !== man && (ent.idx === 3 || ent.idx === 4)) {
    const hd = Math.hypot(handler.pos.x - rim.x, handler.pos.z - rim.z);
    const guardD = Math.hypot(matchupOf(handler, game).pos.x - handler.pos.x,
                              matchupOf(handler, game).pos.z - handler.pos.z);
    if (hd < 5.2 && guardD > 2.0) {
      refX = handler.pos.x; refZ = handler.pos.z;
      gap = 1.3;
    }
  }

  const ddx = rim.x - refX;
  const ddz = rim.z - refZ;
  const dLen = Math.hypot(ddx, ddz);
  if (dLen > 1e-4) {
    const g = Math.min(gap, dLen * 0.85);
    tx = refX + (ddx / dLen) * g;
    tz = refZ + (ddz / dLen) * g;
  } else {
    tx = refX; tz = refZ;
  }
  tx = clamp(tx, -COURT.HALF_LENGTH + CLAMP_MARGIN, COURT.HALF_LENGTH - CLAMP_MARGIN);
  tz = clamp(tz, -COURT.HALF_WIDTH + CLAMP_MARGIN, COURT.HALF_WIDTH - CLAMP_MARGIN);

  seek(ent, tx, tz, aiSpeed(ent, PLAYER.DEFENSE_SPEED) * (manHasBall ? 1.06 : 1.0), 0.55);

  // Face the man (or the ball if he's far).
  ent.faceX = refX; ent.faceZ = refZ; ent.hasFace = true;

  if (!allowActions || game.state !== 'live' || ent.busy) return;

  const manDist = Math.hypot(man.pos.x - ent.pos.x, man.pos.z - ent.pos.z);

  // Contest a shot from my man.
  if (game.shotWindup && game.shotWindup.ent === man && manDist < 2.3) {
    game.playOneShot(ent, 'block');
    return;
  }

  // Occasional steal swipe on the handler.
  if (manHasBall && manDist < PLAYER.STEAL_RANGE + 0.1 && ai.swipeT <= 0) {
    ai.swipeT = SWIPE_COOLDOWN + Math.random() * 2;
    if (Math.random() < 0.30 * diff.aiAggression) {
      game.aiStealAttempt(ent);
    }
  }
}

// ---- rebounding / shot-in-flight positioning -----------------------------------------
export function updateRebound(ent, game, dt) {
  const ai = ent.ai;
  const ball = game.ball;
  const rim = game.attackRim(game.possession); // rim being shot at
  const crash = (ent.data.rebound > 0.45) ||
    Math.hypot(ent.pos.x - rim.x, ent.pos.z - rim.z) < 4.5;

  if (crash) {
    if (!ai.boxSet) {
      ai.boxSet = true;
      // Spot between the rim and where the ball is heading, fanned per player.
      const a = (ent.idx * 2.4) + (ent.team === 0 ? 0.7 : -0.7);
      const r = 1.15 + (1 - (ent.data.rebound || 0.5)) * 0.9;
      ai.boxX = rim.x + Math.cos(a) * r;
      ai.boxZ = rim.z + Math.sin(a) * r * 1.4;
      ai.boxX = clamp(ai.boxX, -COURT.HALF_LENGTH + CLAMP_MARGIN, COURT.HALF_LENGTH - CLAMP_MARGIN);
      ai.boxZ = clamp(ai.boxZ, -COURT.HALF_WIDTH + CLAMP_MARGIN, COURT.HALF_WIDTH - CLAMP_MARGIN);
    }
    // Once the ball is low, chase it directly.
    const bp = ball.mesh.position;
    if (bp.y < 2.4) {
      seek(ent, bp.x, bp.z, aiSpeed(ent, PLAYER.RUN_SPEED) * (0.85 + 0.3 * ent.data.rebound), 0.35);
    } else {
      seek(ent, ai.boxX, ai.boxZ, aiSpeed(ent, PLAYER.RUN_SPEED), 0.7);
    }
    ent.faceX = bp.x; ent.faceZ = bp.z; ent.hasFace = true;
  } else {
    // Guards leak toward the midcourt side for transition safety.
    const s = ent.team === 0 ? 1 : -1;
    seek(ent, -s * 2.5, ent.idx === 0 ? 0 : (ent.idx % 2 ? 3 : -3), aiSpeed(ent, PLAYER.RUN_SPEED) * 0.8, 1.6);
    faceBall(ent, game);
  }
}

export function resetBoxOut(entities) {
  for (let i = 0; i < entities.length; i++) entities[i].ai.boxSet = false;
}

// ---- loose ball scramble ---------------------------------------------------------------
// The nearest two of each team chase; the rest fall back to spots / stance.
export function updateLooseChase(ent, game, dt) {
  const bp = game.ball.mesh.position;
  const myDist = Math.hypot(ent.pos.x - bp.x, ent.pos.z - bp.z);
  let closer = 0;
  const ents = game.entities;
  for (let i = 0; i < ents.length; i++) {
    const o = ents[i];
    if (o === ent || o.team !== ent.team) continue;
    const d = Math.hypot(o.pos.x - bp.x, o.pos.z - bp.z);
    if (d < myDist) closer++;
  }
  if (closer < 2) {
    const tx = clamp(bp.x, -COURT.HALF_LENGTH + CLAMP_MARGIN, COURT.HALF_LENGTH - CLAMP_MARGIN);
    const tz = clamp(bp.z, -COURT.HALF_WIDTH + CLAMP_MARGIN, COURT.HALF_WIDTH - CLAMP_MARGIN);
    seek(ent, tx, tz, aiSpeed(ent, PLAYER.SPRINT_SPEED) * 0.92, 0.3);
    ent.faceX = bp.x; ent.faceZ = bp.z; ent.hasFace = true;
  } else if (ent.team === game.possession) {
    updateOffenseOffBall(ent, game, dt);
  } else {
    updateDefense(ent, game, dt, false);
  }
}

// ---- inbound jog targets ------------------------------------------------------------------
export function updateInbound(ent, game, dt) {
  if (ent === game.handler) {
    setMove(ent, 0, 0, 0);
    const rim = game.attackRim(ent.team);
    ent.faceX = rim.x; ent.faceZ = rim.z; ent.hasFace = true;
    return;
  }
  if (ent.team === game.possession) {
    getOffenseSpot(ent, game, _spot);
    // During the inbound, pull spots back toward midcourt so the break-out
    // reads like a real possession starting.
    const s = ent.team === 0 ? 1 : -1;
    const tx = _spot.x - s * 1.5;
    seek(ent, tx, _spot.z, aiSpeed(ent, PLAYER.RUN_SPEED) * 0.85, 1.2);
    faceBall(ent, game);
  } else {
    updateDefense(ent, game, dt, false);
  }
}
