// ============================================================================
// ball.js — the basketball: procedural Spalding-style visuals, full projectile
// physics with rim / backboard / floor collisions, spin, and scoring detection.
//
// Public API (consumed blind by main.js and game.js):
//   new Ball(scene, audio)
//   .mesh .radius .state .velocity .lastShooter .touchedRimSinceLaunch
//   .setHeld(pos) .launchShot(start, target, apexHeight, opts)
//   .launchPass(start, velocity) .drop(pos, vel) .update(dt)
//   .onScore = (hoopIndex) => {}   .onTouchFloor = (speed) => {}
// ============================================================================

import * as THREE from 'three';
import { COURT, PHYSICS } from './constants.js';

const G = PHYSICS.GRAVITY;
const UP = new THREE.Vector3(0, 1, 0);

// Hoop 0 west (-x), hoop 1 east (+x) — matches constants.js header.
const HOOP_SIGNS = [-1, 1];

// Soft invisible arena walls so the ball can never escape the building.
const WALL_X = 19;
const WALL_Z = 12;
const WALL_Y = 14;

// Sound rate limits (seconds).
const RIM_SOUND_GAP = 0.08;
const BOUNCE_SOUND_GAP = 0.06;
const BACKBOARD_SOUND_GAP = 0.08;

// Backboard slab thickness (visual boards are thin; give physics some depth).
const BACKBOARD_DEPTH = 0.14;

// --- module-scope scratch (zero per-frame allocations) ----------------------
const _v = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _rimCenter = new THREE.Vector3();

// ----------------------------------------------------------------------------
// Procedural ball texture: 1024x512 equirect, pebbled orange leather with
// classic black seams.
// ----------------------------------------------------------------------------
function createBallTexture() {
  const w = 1024, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Base leather, then a vertical shading pass so the poles read darker.
  ctx.fillStyle = '#c96322';
  ctx.fillRect(0, 0, w, h);
  const grad2 = ctx.createLinearGradient(0, 0, 0, h);
  grad2.addColorStop(0.0, 'rgba(60,25,5,0.35)');
  grad2.addColorStop(0.22, 'rgba(0,0,0,0)');
  grad2.addColorStop(0.5, 'rgba(255,190,120,0.10)');
  grad2.addColorStop(0.78, 'rgba(0,0,0,0)');
  grad2.addColorStop(1.0, 'rgba(60,25,5,0.35)');
  ctx.fillStyle = grad2;
  ctx.fillRect(0, 0, w, h);

  // Pebbled leather: dense stipple noise, light and dark grains.
  for (let i = 0; i < 15000; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = 0.6 + Math.random() * 1.5;
    const light = Math.random() > 0.5;
    const a = 0.05 + Math.random() * 0.12;
    ctx.fillStyle = light
      ? `rgba(255,200,150,${a.toFixed(3)})`
      : `rgba(70,30,8,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Seams. Equirect: u along x (longitude), v along y (latitude).
  const seam = (draw) => {
    // Darker halo under the seam, then the seam channel itself.
    ctx.strokeStyle = 'rgba(40,15,4,0.55)';
    ctx.lineWidth = 15;
    ctx.lineCap = 'round';
    draw();
    ctx.strokeStyle = '#181008';
    ctx.lineWidth = 8;
    draw();
  };

  // 1) Equator seam.
  seam(() => {
    ctx.beginPath();
    ctx.moveTo(-8, h / 2);
    ctx.lineTo(w + 8, h / 2);
    ctx.stroke();
  });

  // 2) Two great circles through the poles => 4 vertical lines (and the wrap
  //    duplicate at x = w so the texture tiles seamlessly).
  seam(() => {
    ctx.beginPath();
    for (const fx of [0, 0.25, 0.5, 0.75, 1.0]) {
      ctx.moveTo(fx * w, -8);
      ctx.lineTo(fx * w, h + 8);
    }
    ctx.stroke();
  });

  // 3) The two characteristic curved seams (one per hemisphere). In equirect
  //    they read as sinusoids that hug the equator between the vertical seams.
  const curve = (mid, amp, phase) => {
    ctx.beginPath();
    for (let i = -4; i <= w + 4; i += 4) {
      const u = i / w;
      const y = mid + amp * Math.cos(4 * Math.PI * u + phase);
      if (i === -4) ctx.moveTo(i, y); else ctx.lineTo(i, y);
    }
    ctx.stroke();
  };
  seam(() => curve(h * 0.27, h * 0.14, 0));
  seam(() => curve(h * 0.73, h * 0.14, Math.PI));

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// Small tileable noise canvas used as a bump map for the pebbling.
function createBumpTexture() {
  const s = 256;
  const canvas = document.createElement('canvas');
  canvas.width = s; canvas.height = s;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 3500; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 0.7 + Math.random() * 1.4;
    const v = Math.random() > 0.5 ? 200 : 60;
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 2);
  return tex;
}

// ----------------------------------------------------------------------------
export class Ball {
  constructor(scene, audio) {
    this.audio = audio || null;
    this.radius = PHYSICS.BALL_RADIUS;
    this.state = 'HELD';
    this.velocity = new THREE.Vector3();
    this.lastShooter = null;
    this.touchedRimSinceLaunch = false;

    // Assignable callbacks.
    this.onScore = () => {};
    this.onTouchFloor = () => {};

    // --- visuals ---
    this.mesh = new THREE.Group();
    const geo = new THREE.SphereGeometry(this.radius, 48, 32);
    const mat = new THREE.MeshStandardMaterial({
      map: createBallTexture(),
      bumpMap: createBumpTexture(),
      bumpScale: 0.6,
      roughness: 0.62,
      metalness: 0.0,
    });
    this._sphere = new THREE.Mesh(geo, mat);
    this._sphere.castShadow = true;
    this._sphere.receiveShadow = false;
    this.mesh.add(this._sphere);
    this.mesh.position.set(0, this.radius, 0);
    scene.add(this.mesh);

    // Soft contact-shadow blob on the floor (fades/shrinks with height so the
    // ball reads as grounded even where shadow maps are unavailable).
    {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      const grad = ctx.createRadialGradient(32, 32, 3, 32, 32, 31);
      grad.addColorStop(0, 'rgba(0,0,0,0.4)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
      const blobGeo = new THREE.CircleGeometry(this.radius * 1.5, 20);
      blobGeo.rotateX(-Math.PI / 2);
      this._blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1,
      }));
      this._blob.position.y = 0.011;
      this._blob.renderOrder = 1;
      scene.add(this._blob);
    }

    // --- internal physics state ---
    this._scored = false;
    this._resting = false;
    this._spinAxis = new THREE.Vector3(0, 0, -1);
    this._spinSpeed = 0;

    // Sound rate-limit timers.
    this._rimSoundT = 0;
    this._bounceSoundT = 0;
    this._boardSoundT = 0;
  }

  // --- state transitions ------------------------------------------------------

  setHeld(pos) {
    this.state = 'HELD';
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
      this.mesh.position.copy(pos);
    }
    this.velocity.set(0, 0, 0);
    this._resting = false;
  }

  // Ballistic solve: leave `start`, peak near absolute height `apexHeight`,
  // land exactly at `target` under gravity (ignoring drag, which is tiny).
  launchShot(start, target, apexHeight, opts) {
    this.lastShooter = (opts && opts.shooter !== undefined) ? opts.shooter : null;
    this.touchedRimSinceLaunch = false;
    this._scored = false;
    this._resting = false;
    this.state = 'SHOT';
    this.mesh.position.copy(start);

    const h = Math.max(
      Number.isFinite(apexHeight) ? apexHeight : 0,
      Math.max(start.y, target.y) + 0.05
    );
    const vy0 = Math.sqrt(Math.max(0, 2 * G * (h - start.y)));
    const t1 = vy0 / G;
    const t2 = Math.sqrt(Math.max(0, 2 * (h - target.y) / G));
    let T = t1 + t2;
    if (!Number.isFinite(T) || T < 1e-3) T = 1e-3;

    const vx = (target.x - start.x) / T;
    const vz = (target.z - start.z) / T;
    // First-order compensation for linear air drag so the ball still arrives
    // at the target: over flight time T the drag integrates to roughly a
    // velocity scale of (1 - k*T/2), so boost by the inverse.
    const dragComp = 1 + PHYSICS.AIR_DRAG * T * 0.5;
    this.velocity.set(
      (Number.isFinite(vx) ? vx : 0) * dragComp,
      (Number.isFinite(vy0) ? vy0 : 0) * dragComp,
      (Number.isFinite(vz) ? vz : 0) * dragComp
    );

    // Backspin: axis = up x velocity (top of ball rotates away from travel).
    _axis.crossVectors(UP, this.velocity);
    if (_axis.lengthSq() > 1e-8) this._spinAxis.copy(_axis.normalize());
    this._spinSpeed = 14 + this.velocity.length() * 0.9;
  }

  launchPass(start, velocity) {
    this.state = 'PASS';
    this._scored = false;
    this._resting = false;
    if (start) this.mesh.position.copy(start);
    if (velocity) this.velocity.copy(velocity);
    this._sanitize();
    _axis.crossVectors(UP, this.velocity);
    if (_axis.lengthSq() > 1e-8) this._spinAxis.copy(_axis.normalize());
    this._spinSpeed = this.velocity.length() * 2.0;
  }

  drop(pos, vel) {
    this.state = 'FREE';
    this._scored = false;
    this._resting = false;
    if (pos) this.mesh.position.copy(pos);
    if (vel) this.velocity.copy(vel); else this.velocity.set(0, 0, 0);
    this._sanitize();
  }

  // --- per-frame update (called only by main.js) --------------------------------

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 1 / 20) dt = 1 / 20;

    this._rimSoundT -= dt;
    this._bounceSoundT -= dt;
    this._boardSoundT -= dt;

    if (this.state === 'HELD') {
      // Gentle spin decay while held (game.js drives the position).
      this._spinSpeed *= Math.exp(-4 * dt);
      this._applySpin(dt);
      this._updateBlob();
      return;
    }

    this._sanitize();

    // Substep so the fastest shots can't tunnel through the rim tube.
    const speed = this.velocity.length();
    let steps = Math.ceil((speed * dt) / (COURT.RIM_TUBE * 2)) + 1;
    if (steps < 2) steps = 2;
    if (steps > 12) steps = 12;
    const sdt = dt / steps;

    for (let i = 0; i < steps; i++) this._substep(sdt);

    // Spin: in flight proportional to speed with backspin axis; when rolling,
    // match a rolling contact and damp.
    const pos = this.mesh.position;
    const rolling = this._resting || (pos.y <= this.radius + 0.01 && Math.abs(this.velocity.y) < 0.3);
    _v.set(this.velocity.x, 0, this.velocity.z);
    const hSpeed = _v.length();
    if (rolling) {
      if (hSpeed > 0.03) {
        // Rolling axis is velocity x up; angular speed = v / r.
        _axis.crossVectors(_v, UP);
        if (_axis.lengthSq() > 1e-8) this._spinAxis.copy(_axis.normalize());
        this._spinSpeed = hSpeed / this.radius;
      } else {
        this._spinSpeed *= Math.exp(-6 * dt);
      }
    } else {
      // Keep the launch backspin axis; scale gently with current speed.
      const target = 10 + this.velocity.length() * 0.8;
      this._spinSpeed += (target - this._spinSpeed) * Math.min(1, dt * 3);
    }
    this._applySpin(dt);
    this._updateBlob();
  }

  // --- internals ---------------------------------------------------------------

  _updateBlob() {
    const b = this._blob;
    if (!b) return;
    const p = this.mesh.position;
    b.position.x = p.x;
    b.position.z = p.z;
    const h = Math.max(0, p.y - this.radius);
    const s = 1 + h * 0.5;
    b.scale.set(s, 1, s);
    b.material.opacity = Math.max(0.12, 1 - h * 0.18);
    // Hide when the ball leaves the floor area (over the stands etc.).
    b.visible = Math.abs(p.x) < 15 && Math.abs(p.z) < 8.3;
  }

  _applySpin(dt) {
    if (this._spinSpeed < 1e-4) return;
    if (this._spinAxis.lengthSq() < 1e-8) return;
    _quat.setFromAxisAngle(this._spinAxis, this._spinSpeed * dt);
    this._sphere.quaternion.premultiply(_quat);
  }

  _sanitize() {
    const p = this.mesh.position;
    const v = this.velocity;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      p.set(0, this.radius + 1, 0);
    }
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      v.set(0, 0, 0);
    }
    // Hard speed cap: nothing in a basketball game moves at 40 m/s.
    if (v.lengthSq() > 1600) v.setLength(40);
  }

  _substep(dt) {
    const pos = this.mesh.position;
    const v = this.velocity;

    // Gravity + simple linear air drag.
    if (!this._resting) v.y -= G * dt;
    const drag = 1 - PHYSICS.AIR_DRAG * dt;
    if (drag > 0) v.multiplyScalar(drag);

    const prevY = pos.y;

    // Integrate.
    pos.x += v.x * dt;
    pos.y += v.y * dt;
    pos.z += v.z * dt;

    // Scoring: downward crossing of the rim plane inside the cylinder. Only
    // clean crossings count — the ball must fit through without touching the
    // rim tube (center offset < RIM_RADIUS - ball radius), otherwise the same
    // substep's rim collision could still rattle it out after we scored.
    if (!this._scored && v.y < 0 && prevY > COURT.RIM_HEIGHT && pos.y <= COURT.RIM_HEIGHT) {
      const scoreR = COURT.RIM_RADIUS - this.radius;
      for (let hi = 0; hi < 2; hi++) {
        const hx = HOOP_SIGNS[hi] * COURT.HOOP_X;
        const dx = pos.x - hx;
        const dz = pos.z;
        if (dx * dx + dz * dz < scoreR * scoreR) {
          this._scored = true;
          if (this.touchedRimSinceLaunch) this._sfx('netSwish');
          else this._sfx('swish');
          try { this.onScore(hi); } catch (e) { /* never let game logic kill physics */ }
          break;
        }
      }
    }

    // Rim collisions (both hoops).
    for (let hi = 0; hi < 2; hi++) this._collideRim(hi, pos, v);

    // Backboards (both ends).
    for (let hi = 0; hi < 2; hi++) this._collideBackboard(hi, pos, v);

    // Floor.
    this._collideFloor(pos, v, dt);

    // Soft arena walls — the ball can never leave the building.
    this._collideWalls(pos, v);
  }

  _collideRim(hoopIndex, pos, v) {
    const s = HOOP_SIGNS[hoopIndex];
    _rimCenter.set(s * COURT.HOOP_X, COURT.RIM_HEIGHT, 0);

    // Cheap broad phase.
    if (Math.abs(pos.y - COURT.RIM_HEIGHT) > 0.6) return;
    const bx = pos.x - _rimCenter.x;
    const bz = pos.z - _rimCenter.z;
    if (bx * bx + bz * bz > 1.0) return;

    // Closest point on the horizontal rim circle to the ball center.
    // The tube center circle sits at RIM_RADIUS (inner) + RIM_TUBE, matching
    // the arena torus (arena.js builds it with that major radius).
    const ringR = COURT.RIM_RADIUS + COURT.RIM_TUBE;
    const hLen = Math.sqrt(bx * bx + bz * bz);
    if (hLen < 1e-6) return; // dead-center over the axis: clean drop-through
    _closest.set(
      _rimCenter.x + (bx / hLen) * ringR,
      COURT.RIM_HEIGHT,
      _rimCenter.z + (bz / hLen) * ringR
    );

    _normal.subVectors(pos, _closest);
    const dist = _normal.length();
    const minDist = this.radius + COURT.RIM_TUBE;
    if (dist >= minDist) return;

    if (dist < 1e-6) _normal.copy(UP); else _normal.divideScalar(dist);

    // Push out.
    pos.x = _closest.x + _normal.x * minDist;
    pos.y = _closest.y + _normal.y * minDist;
    pos.z = _closest.z + _normal.z * minDist;

    // Reflect the approaching component.
    const vn = v.dot(_normal);
    if (vn < 0) {
      v.addScaledVector(_normal, -(1 + PHYSICS.RIM_RESTITUTION) * vn);
      // Light tangential scrub so the ball doesn't ping around forever.
      v.multiplyScalar(0.97);
      if (this._rimSoundT <= 0 && -vn > 0.6) {
        this._rimSoundT = RIM_SOUND_GAP;
        this._sfx('rim');
      }
    }
    this.touchedRimSinceLaunch = true;
  }

  _collideBackboard(hoopIndex, pos, v) {
    const s = HOOP_SIGNS[hoopIndex];
    const yBot = COURT.BACKBOARD_BOTTOM;
    const yTop = COURT.BACKBOARD_BOTTOM + COURT.BACKBOARD_HEIGHT;
    const halfW = COURT.BACKBOARD_WIDTH / 2;
    const r = this.radius;

    if (pos.y < yBot - r || pos.y > yTop + r) return;
    if (Math.abs(pos.z) > halfW + r) return;

    const sx = pos.x * s; // ball x in "toward this backboard" space
    const front = COURT.BACKBOARD_X; // front face (faces mid-court)
    const back = COURT.BACKBOARD_X + BACKBOARD_DEPTH;

    // Front face hit: ball moving away from mid-court into the board.
    if (sx + r > front && sx < front + BACKBOARD_DEPTH * 0.5 && v.x * s > 0) {
      // Only a solid face hit if the center is inside the board silhouette
      // (edge grazes are handled leniently as face hits too — feels better).
      pos.x = s * (front - r);
      v.x = -v.x * PHYSICS.BACKBOARD_RESTITUTION;
      v.y *= 0.94;
      v.z *= 0.94;
      if (this._boardSoundT <= 0 && Math.abs(v.x) > 0.4) {
        this._boardSoundT = BACKBOARD_SOUND_GAP;
        this._sfx('backboard');
      }
      return;
    }
    // Back face (rare — ball floated behind the board): push it back out.
    if (sx - r < back && sx > back - BACKBOARD_DEPTH * 0.5 && v.x * s < 0) {
      pos.x = s * (back + r);
      v.x = -v.x * PHYSICS.BACKBOARD_RESTITUTION;
    }
  }

  _collideFloor(pos, v, dt) {
    const r = this.radius;
    if (pos.y > r) { this._resting = false; return; }

    pos.y = r;
    if (v.y < 0) {
      const impact = -v.y;
      v.y = impact * PHYSICS.FLOOR_RESTITUTION;

      // Kill tiny bounces -> settle into a roll.
      if (v.y < 0.55) {
        v.y = 0;
        this._resting = true;
      }

      // Horizontal scrub on each bounce.
      v.x *= 0.985;
      v.z *= 0.985;

      if (impact > 0.35) {
        if (this._bounceSoundT <= 0) {
          this._bounceSoundT = BOUNCE_SOUND_GAP;
          const intensity = Math.min(1, impact / 9);
          this._sfx('bounce', intensity);
        }
        try { this.onTouchFloor(impact); } catch (e) { /* guard */ }
      }
    }

    if (this._resting) {
      v.y = 0;
      // Rolling friction.
      const f = Math.exp(-1.6 * dt);
      v.x *= f;
      v.z *= f;
      if (v.x * v.x + v.z * v.z < 0.0016) { v.x = 0; v.z = 0; }
    }
  }

  _collideWalls(pos, v) {
    if (pos.x > WALL_X) { pos.x = WALL_X; if (v.x > 0) v.x = -v.x * 0.4; }
    else if (pos.x < -WALL_X) { pos.x = -WALL_X; if (v.x < 0) v.x = -v.x * 0.4; }
    if (pos.z > WALL_Z) { pos.z = WALL_Z; if (v.z > 0) v.z = -v.z * 0.4; }
    else if (pos.z < -WALL_Z) { pos.z = -WALL_Z; if (v.z < 0) v.z = -v.z * 0.4; }
    if (pos.y > WALL_Y) { pos.y = WALL_Y; if (v.y > 0) v.y = -v.y * 0.4; }
  }

  _sfx(name, arg) {
    const a = this.audio;
    if (!a) return;
    try {
      if (typeof a[name] === 'function') a[name](arg);
    } catch (e) { /* audio must never break physics */ }
  }
}
