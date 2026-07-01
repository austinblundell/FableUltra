// ============================================================================
// playerModel.js — procedural NBA player: rig, uniform look, and a fully
// procedural skeletal animation system (looped gaits + one-shot actions).
//
// Rig conventions (model faces +Z locally; game sets group.rotation.y):
//   • Limb bones (arms/legs) extend along local -Y from their joint group.
//     For those bones, rotation.x < 0 swings the limb FORWARD (+Z),
//     rotation.x > 0 swings it BACKWARD (-Z).
//   • Spine/neck/head bones point +Y, so rotation.x > 0 leans/nods FORWARD.
//   • The character's LEFT side is +X, RIGHT side is -X.
//   • Jumps in one-shots translate the inner `rig` group on Y — the outer
//     `group` (owned by game.js) always stays at y = 0.
//
// Poses are flat Float32Array channel buffers (17 joints × XYZ euler + pelvis
// offset XYZ + rig jump Y = 55 channels). Loops and one-shots write target
// buffers; transitions crossfade over ~0.12 s. No per-frame allocations.
// ============================================================================

import * as THREE from 'three';
import { PLAYER } from './constants.js';

// ---------------------------------------------------------------------------
// Channel layout
// ---------------------------------------------------------------------------
const J_PELVIS = 0, J_SPINE = 3, J_CHEST = 6, J_NECK = 9, J_HEAD = 12,
      J_SHL = 15, J_ELL = 18, J_HAL = 21,      // left shoulder / elbow / hand
      J_SHR = 24, J_ELR = 27, J_HAR = 30,      // right shoulder / elbow / hand
      J_HIL = 33, J_KNL = 36, J_FOL = 39,      // left hip / knee / foot
      J_HIR = 42, J_KNR = 45, J_FOR = 48;      // right hip / knee / foot
const C_PX = 51, C_PY = 52, C_PZ = 53, C_RIGY = 54;
const NCH = 55;
const NJ = 17;

const FADE_TIME = 0.12;
const TWO_PI = Math.PI * 2;

// Neutral base pose every state builds on.
const BASE = new Float32Array(NCH);
BASE[J_SHL + 2] = 0.14;  BASE[J_SHR + 2] = -0.14;   // arms slightly out
BASE[J_ELL] = -0.28;     BASE[J_ELR] = -0.28;       // soft elbow bend
BASE[J_HIL] = -0.06;     BASE[J_HIR] = -0.06;       // athletic micro-crouch
BASE[J_KNL] = 0.11;      BASE[J_KNR] = 0.11;
BASE[J_FOL] = -0.05;     BASE[J_FOR] = -0.05;

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function sm01(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
function seg(u, a, b) { return sm01((u - a) / (b - a)); }
function fire(cb) {
  if (typeof cb === 'function') {
    try { cb(); } catch (e) { console.error('PlayerModel callback error:', e); }
  }
}

// Module-scope temps (zero per-frame allocation).
const _fallbackV = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Shared geometry / material caches — ten players share almost everything.
// Dimensions are bucketed to 5 mm so similar heights share geometry.
// ---------------------------------------------------------------------------
const _geoCache = new Map();
const _matCache = new Map();

function _bucket(v) { return Math.max(0.004, Math.round(v * 200) / 200); }

function capsuleGeo(radius, length) {
  const r = _bucket(radius), l = _bucket(Math.max(0.01, length));
  const key = 'c' + r.toFixed(3) + '_' + l.toFixed(3);
  let g = _geoCache.get(key);
  if (!g) { g = new THREE.CapsuleGeometry(r, l, 4, 10); _geoCache.set(key, g); }
  return g;
}
function sphereGeo(radius) {
  const r = _bucket(radius);
  const key = 's' + r.toFixed(3);
  let g = _geoCache.get(key);
  if (!g) { g = new THREE.SphereGeometry(r, 14, 10); _geoCache.set(key, g); }
  return g;
}
function boxGeo(w, h, d) {
  const key = 'b' + _bucket(w).toFixed(3) + '_' + _bucket(h).toFixed(3) + '_' + _bucket(d).toFixed(3);
  let g = _geoCache.get(key);
  if (!g) { g = new THREE.BoxGeometry(_bucket(w), _bucket(h), _bucket(d)); _geoCache.set(key, g); }
  return g;
}
function cylGeo(radius, height) {
  const r = _bucket(radius), hh = _bucket(height);
  const key = 'y' + r.toFixed(3) + '_' + hh.toFixed(3);
  let g = _geoCache.get(key);
  if (!g) { g = new THREE.CylinderGeometry(r, r, hh, 12); _geoCache.set(key, g); }
  return g;
}
// Soft contact-shadow blob shared by all players: guarantees grounding even
// on hardware where shadow maps are unavailable or disabled.
let _blobTex = null, _blobGeo = null, _blobMat = null;
function blobShadowMesh() {
  if (!_blobTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(0.65, 'rgba(0,0,0,0.20)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    _blobTex = new THREE.CanvasTexture(c);
    _blobGeo = new THREE.CircleGeometry(0.42, 24);
    _blobGeo.rotateX(-Math.PI / 2);
    _blobMat = new THREE.MeshBasicMaterial({
      map: _blobTex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1,
    });
  }
  const m = new THREE.Mesh(_blobGeo, _blobMat);
  m.position.y = 0.012;
  m.renderOrder = 1;
  return m;
}

let _planeGeo = null;
function planeGeo() {
  if (!_planeGeo) _planeGeo = new THREE.PlaneGeometry(1, 1);
  return _planeGeo;
}

function stdMat(hex, roughness = 0.75, metalness = 0.0) {
  const key = hex + ':' + roughness + ':' + metalness;
  let m = _matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness, metalness });
    _matCache.set(key, m);
  }
  return m;
}
function darken(hex, f) {
  const c = new THREE.Color(hex).multiplyScalar(f);
  return '#' + c.getHexString();
}

const HAIR_COLORS = ['#171310', '#0d0c0b', '#2a1d12', '#221b16'];

// ---------------------------------------------------------------------------
// Jersey number / name canvas texture (per player, disposed with the model)
// ---------------------------------------------------------------------------
function makeNumberTexture(number, name, trim, isBack) {
  if (typeof document === 'undefined') return null;
  const size = isBack ? 256 : 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const num = String(number);
  const stroke = 'rgba(0,0,0,0.38)';
  if (isBack) {
    // Surname above (drop the "D. " initial), big number below — like a real kit.
    const nm = String(name || '').toUpperCase().replace(/^[A-Z]\.\s*/, '');
    ctx.font = '700 30px Arial, sans-serif';
    const w = ctx.measureText(nm).width || 1;
    ctx.save();
    if (w > 218) { ctx.translate(128, 0); ctx.scale(218 / w, 1); ctx.translate(-128, 0); }
    ctx.lineWidth = 5; ctx.strokeStyle = stroke; ctx.strokeText(nm, 128, 44);
    ctx.fillStyle = trim; ctx.fillText(nm, 128, 44);
    ctx.restore();
    ctx.font = '900 148px "Arial Black", Arial, sans-serif';
    ctx.lineWidth = 10; ctx.strokeStyle = stroke; ctx.strokeText(num, 128, 158);
    ctx.fillStyle = trim; ctx.fillText(num, 128, 158);
  } else {
    ctx.font = '900 84px "Arial Black", Arial, sans-serif';
    ctx.lineWidth = 7; ctx.strokeStyle = stroke; ctx.strokeText(num, 64, 66);
    ctx.fillStyle = trim; ctx.fillText(num, 64, 66);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ===========================================================================
// LOOPED POSE FUNCTIONS — write target channel values into `out`.
// ===========================================================================

function poseIdle(m, out) {
  out.set(BASE);
  const t = m._idleT, sd = m._seed;
  const br = Math.sin(t * 1.9 + sd);                  // breathing
  out[J_CHEST] += 0.02 * br;
  out[C_PY] += -0.006 + 0.005 * br;
  const w = Math.sin(t * 0.45 + sd);                  // slow weight shift
  out[C_PX] += 0.022 * w;
  out[J_PELVIS + 2] += 0.035 * w;
  out[J_SPINE + 2] += -0.03 * w;
  out[J_SHL] += 0.03 * Math.sin(t * 0.8 + sd);
  out[J_SHR] += 0.03 * Math.sin(t * 0.8 + 1.3 + sd);
  // Occasional phase-hashed head glance (players desync via seed).
  const n = Math.sin(t * 0.23 + sd) * Math.sin(t * 0.31 + sd * 2 + 1.7);
  const turn = sm01((n - 0.45) / 0.35);
  out[J_HEAD + 1] += 0.55 * turn * Math.sin(t * 0.05 + sd * 6);
  out[J_HEAD] += 0.03 * Math.sin(t * 0.7 + sd);
}

function poseRunCore(m, out, sprint) {
  out.set(BASE);
  const norm = clamp(m._speed / PLAYER.RUN_SPEED, 0, 1.4);
  const amp = 0.35 + 0.75 * Math.min(norm, 1) + sprint * 0.18;
  const ph = m._runPhase;
  const sL = Math.sin(ph);
  const lean = (0.12 + 0.14 * sprint) * clamp(norm, 0.35, 1.2);
  out[J_SPINE] += lean * 0.6;
  out[J_CHEST] += lean * 0.45;
  out[J_HEAD] += -lean * 0.7;                          // eyes stay level
  // Legs: counter-phase hip swing, knee folds during recovery swing.
  const hipAmp = (0.5 + 0.16 * sprint) * amp;
  out[J_HIL] += -hipAmp * sL;
  out[J_HIR] += hipAmp * sL;
  const kneeAmp = (1.05 + 0.5 * sprint) * amp;
  let vL = Math.sin(ph - 2.2);  vL = vL > 0 ? vL * vL : 0;
  let vR = -Math.sin(ph - 2.2); vR = vR > 0 ? vR * vR : 0;
  out[J_KNL] += 0.15 * amp + kneeAmp * vL;
  out[J_KNR] += 0.15 * amp + kneeAmp * vR;
  out[J_FOL] = -(out[J_HIL] + out[J_KNL]) * 0.55;
  out[J_FOR] = -(out[J_HIR] + out[J_KNR]) * 0.55;
  // Pelvis bob (2× stride), roll and yaw with chest counter-rotation.
  out[C_PY] += -0.018 * amp + 0.028 * amp * Math.sin(2 * ph + 0.9);
  out[J_PELVIS + 2] += 0.05 * amp * sL;
  out[J_PELVIS + 1] += 0.09 * amp * sL;
  out[J_CHEST + 1] += -0.13 * amp * sL;
  // Arms drive opposite the legs, elbows pumping.
  const armAmp = (0.45 + 0.3 * sprint) * amp;
  out[J_SHL] += armAmp * sL;
  out[J_SHR] += -armAmp * sL;
  out[J_ELL] = -(0.8 + 0.45 * amp) + 0.22 * armAmp * sL;
  out[J_ELR] = -(0.8 + 0.45 * amp) - 0.22 * armAmp * sL;
  out[J_HAL] += 0.15 * armAmp * sL;
  out[J_HAR] += -0.15 * armAmp * sL;
}
function poseRun(m, out) { poseRunCore(m, out, 0); }
function poseSprint(m, out) { poseRunCore(m, out, 1); }

// Right arm pumping a dribble at ~hip height, wrist leading the ball.
function dribbleArm(m, out) {
  const d = m._dribblePhase;
  const pump = Math.sin(d);
  out[J_SHR] = -0.38 + 0.16 * pump;
  out[J_SHR + 1] = 0;
  out[J_SHR + 2] = -0.10;
  out[J_ELR] = -0.95 + 0.42 * pump;
  out[J_HAR] = -0.20 + 0.55 * Math.sin(d + 0.7);
}

function poseDribbleIdle(m, out) {
  out.set(BASE);
  const d = m._dribblePhase, t = m._time, sd = m._seed;
  out[J_HIL] += -0.42;  out[J_HIR] += -0.40;
  out[J_HIL + 2] += 0.14;  out[J_HIR + 2] += -0.14;
  out[J_KNL] += 0.62;  out[J_KNR] += 0.58;
  out[J_FOL] = -(out[J_HIL] + out[J_KNL]) * 0.9;
  out[J_FOR] = -(out[J_HIR] + out[J_KNR]) * 0.9;
  out[C_PY] += -0.10 + 0.012 * Math.sin(d);
  out[J_SPINE] += 0.24;
  out[J_CHEST] += 0.08;
  out[J_HEAD] += -0.22;                                // eyes up-court
  out[J_PELVIS + 1] += 0.06 * Math.sin(t * 0.9 + sd);
  // Off arm shields the ball.
  out[J_SHL] = -0.55;  out[J_SHL + 2] = 0.5;
  out[J_ELL] = -1.15;  out[J_HAL] = -0.2;
  dribbleArm(m, out);
}

function poseDribbleRun(m, out) {
  poseRunCore(m, out, 0);
  out[J_SPINE] += 0.06;
  out[J_SHL] *= 1.15;                                  // bigger off-arm swing
  dribbleArm(m, out);
}

function poseDefense(m, out) {
  out.set(BASE);
  const b = m._defPhase;
  const bob = Math.sin(b);
  out[J_HIL] += -0.55;  out[J_HIR] += -0.55;
  out[J_HIL + 2] += 0.30;  out[J_HIR + 2] += -0.30;    // wide stance
  out[J_KNL] += 0.95 + 0.06 * bob;
  out[J_KNR] += 0.95 - 0.06 * bob;
  out[J_FOL] = -(out[J_HIL] + out[J_KNL]) * 0.85;
  out[J_FOR] = -(out[J_HIR] + out[J_KNR]) * 0.85;
  out[J_FOL + 2] = -0.22;  out[J_FOR + 2] = 0.22;      // keep soles flat
  out[C_PY] += -0.16 + 0.015 * Math.sin(2 * b);
  out[C_PX] += 0.05 * bob;                             // lateral shuffle sway
  out[J_SPINE] += 0.30;
  out[J_CHEST] += 0.04;
  out[J_HEAD] += -0.28;
  out[J_SHL] = -0.3;  out[J_SHL + 2] = 1.15 + 0.07 * bob;
  out[J_SHR] = -0.3;  out[J_SHR + 2] = -1.15 + 0.07 * bob;
  out[J_ELL] = -0.5;  out[J_ELR] = -0.5;
  out[J_HAL] = -0.2;  out[J_HAR] = -0.2;
}

// ===========================================================================
// ONE-SHOT POSE FUNCTIONS — parametric keyframe curves over u ∈ [0,1].
// The vertical jump for shoot/layup/block is added centrally (air window).
// ===========================================================================

function poseShoot(m, u, out) {
  out.set(BASE);
  const dip = seg(u, 0, 0.24);
  const ext = seg(u, 0.30, 0.46);
  const raise = seg(u, 0.10, 0.44);
  const flick = seg(u, 0.50, 0.62);
  const settle = seg(u, 0.78, 1.0);
  const land = seg(u, 0.84, 0.92) * (1 - seg(u, 0.92, 1.0));
  const crouch = dip * (1 - ext);
  const airHold = ext * (1 - settle);
  // Legs: dip, extend through the jump, absorb the landing.
  const hipX = -0.75 * crouch - 0.35 * land - 0.10 * airHold;
  out[J_HIL] += hipX;  out[J_HIR] += hipX;
  const kneeX = 1.15 * crouch + 0.28 * airHold + 0.6 * land;
  out[J_KNL] += kneeX;  out[J_KNR] += kneeX;
  out[J_FOL] = -(out[J_HIL] + out[J_KNL]) * 0.8 + 0.35 * airHold; // toes point
  out[J_FOR] = out[J_FOL];
  out[C_PY] += -0.16 * crouch - 0.08 * land;
  out[J_SPINE] += 0.22 * crouch - 0.06 * airHold;
  out[J_CHEST] += 0.10 * crouch - 0.04 * airHold;
  out[J_HEAD] += -0.30 * raise * (1 - settle);         // eyes on the rim
  // Shooting arm (right): gather, raise, elbow extension + wrist flick at apex.
  let shr = lerp(BASE[J_SHR], -2.85, raise);
  shr = lerp(shr, -1.15, settle);
  out[J_SHR] = shr;
  out[J_SHR + 2] = lerp(BASE[J_SHR + 2], -0.04, raise);
  let elr = lerp(BASE[J_ELR], -1.95, raise);
  elr = lerp(elr, -0.35, seg(u, 0.42, 0.58));
  elr = lerp(elr, -0.6, settle);
  out[J_ELR] = elr;
  let har = 0.9 * raise;                               // cocked wrist
  har = lerp(har, -1.05, flick);                       // gooseneck follow-through
  har = lerp(har, -0.2, settle);
  out[J_HAR] = har;
  // Guide arm (left) peels off after release.
  let shl = lerp(BASE[J_SHL], -2.35, raise);
  shl = lerp(shl, -0.9, seg(u, 0.60, 0.85));
  out[J_SHL] = shl;
  out[J_SHL + 2] = lerp(BASE[J_SHL + 2], 0.18, raise);
  let ell = lerp(BASE[J_ELL], -1.35, raise);
  ell = lerp(ell, -0.5, seg(u, 0.60, 0.85));
  out[J_ELL] = ell;
}

function poseLayup(m, u, out) {
  out.set(BASE);
  const gather = seg(u, 0, 0.22);
  const drive = seg(u, 0.16, 0.40);
  const reach = seg(u, 0.32, 0.56);
  const tuckOut = seg(u, 0.60, 0.88);
  const settle = seg(u, 0.82, 1);
  const kd = drive * (1 - tuckOut);                    // knee-drive envelope
  // Takeoff (left) leg loads then trails.
  out[J_HIL] += -0.55 * gather * (1 - drive) + 0.35 * drive * (1 - settle);
  out[J_KNL] += 0.85 * gather * (1 - drive) + 0.55 * drive * (1 - settle);
  // Driving (right) knee punches up.
  out[J_HIR] += -1.45 * kd - 0.25 * gather * (1 - drive);
  out[J_KNR] += 1.5 * kd + 0.3 * gather * (1 - drive);
  out[J_FOL] = -(out[J_HIL] + out[J_KNL]) * 0.6 + 0.3 * kd;
  out[J_FOR] = -(out[J_HIR] + out[J_KNR]) * 0.4;
  out[C_PY] += -0.10 * gather * (1 - drive)
             - 0.06 * seg(u, 0.86, 0.96) * (1 - seg(u, 0.96, 1));
  out[C_PZ] += 0.08 * kd;
  out[J_SPINE] += 0.30 * gather * (1 - drive) + 0.04 * kd;
  out[J_CHEST] += 0.10 * gather * (1 - drive);
  out[J_HEAD] += -0.30 * drive * (1 - settle);
  // Finishing arm extends up-and-out.
  let shr = lerp(BASE[J_SHR], -2.95, reach);
  shr = lerp(shr, -1.0, settle);
  out[J_SHR] = shr;
  out[J_SHR + 2] = lerp(BASE[J_SHR + 2], -0.22, reach);
  let elr = lerp(lerp(BASE[J_ELR], -1.5, drive), -0.12, reach);
  elr = lerp(elr, -0.5, settle);
  out[J_ELR] = elr;
  let har = lerp(0.35 * drive, -0.85, seg(u, 0.50, 0.64));
  har = lerp(har, -0.1, settle);
  out[J_HAR] = har;
  // Balance arm.
  out[J_SHL] = BASE[J_SHL] - 0.75 * drive * (1 - settle);
  out[J_SHL + 2] = BASE[J_SHL + 2] + 0.30 * drive * (1 - settle);
  out[J_ELL] = -0.9;
}

function posePass(m, u, out) {
  out.set(BASE);
  const gather = seg(u, 0, 0.28);
  const push = seg(u, 0.22, 0.55);
  const rec = seg(u, 0.72, 1);
  let sh = lerp(BASE[J_SHL], -0.85, gather);
  sh = lerp(sh, -1.5, push);
  sh = lerp(sh, -0.5, rec);
  out[J_SHL] = sh;  out[J_SHR] = sh;
  const shz = lerp(BASE[J_SHL + 2], 0.30 - 0.24 * push, gather);
  out[J_SHL + 2] = shz;  out[J_SHR + 2] = -shz;
  let el = lerp(BASE[J_ELL], -1.9, gather);
  el = lerp(el, -0.12, push);
  el = lerp(el, -0.5, rec);
  out[J_ELL] = el;  out[J_ELR] = el;
  const wr = lerp(0.35 * gather, -0.6, push);          // wrist snap
  out[J_HAL] = wr;  out[J_HAR] = wr;
  const step = push * (1 - rec);
  out[J_SPINE] += 0.12 * step;
  out[C_PY] += -0.03 * step;
  out[J_KNL] += 0.18 * step;  out[J_KNR] += 0.18 * step;
  out[J_HIL] += -0.12 * step; out[J_HIR] += -0.12 * step;
}

function poseBlock(m, u, out) {
  out.set(BASE);
  const crouch = seg(u, 0, 0.16) * (1 - seg(u, 0.14, 0.30));
  const explode = seg(u, 0.14, 0.34);
  const settle = seg(u, 0.84, 1);
  const land = seg(u, 0.86, 0.94) * (1 - seg(u, 0.94, 1));
  const airHold = explode * (1 - settle);
  out[J_HIL] += -0.8 * crouch - 0.3 * land;
  out[J_HIR] += -0.8 * crouch - 0.3 * land;
  out[J_KNL] += 1.3 * crouch + 0.18 * airHold + 0.55 * land;
  out[J_KNR] += 1.3 * crouch + 0.18 * airHold + 0.55 * land;
  out[J_FOL] = -(out[J_HIL] + out[J_KNL]) * 0.8 + 0.4 * airHold;
  out[J_FOR] = out[J_FOL];
  out[C_PY] += -0.17 * crouch - 0.07 * land;
  out[J_SPINE] += 0.25 * crouch - 0.05 * airHold;
  out[J_HEAD] += -0.32 * explode * (1 - settle);
  // Both arms rocket straight up.
  let sh = lerp(BASE[J_SHL], -3.0, explode);
  sh = lerp(sh, -1.0, settle);
  out[J_SHL] = sh;  out[J_SHR] = sh;
  const shz = lerp(BASE[J_SHL + 2], 0.12, explode);
  out[J_SHL + 2] = shz;  out[J_SHR + 2] = -shz;
  const el = lerp(BASE[J_ELL], -0.08, explode);
  out[J_ELL] = el;  out[J_ELR] = el;
  out[J_HAL] = 0.1 * explode;  out[J_HAR] = 0.1 * explode;
}

function poseSteal(m, u, out) {
  out.set(BASE);
  const wind = seg(u, 0, 0.22);
  const swipe = seg(u, 0.20, 0.55);
  const rec = seg(u, 0.68, 1);
  const lunge = swipe * (1 - rec);
  out[C_PZ] += 0.16 * lunge;                           // lunge at the ball
  out[C_PY] += -0.11 * lunge - 0.04 * wind * (1 - swipe);
  out[J_SPINE] += 0.38 * lunge + 0.1 * wind;
  out[J_CHEST + 1] += 0.25 * lunge;                    // torso twist into swipe
  out[J_HEAD] += 0.10 * lunge;
  out[J_HIL] += -0.75 * lunge;
  out[J_KNL] += 0.85 * lunge;
  out[J_HIR] += 0.30 * lunge;
  out[J_KNR] += 0.45 * lunge;
  out[J_FOL] = -(out[J_HIL] + out[J_KNL]) * 0.7;
  out[J_FOR] = -(out[J_HIR] + out[J_KNR]) * 0.5;
  // Swiping right arm: wind back-right, sweep low across the body.
  out[J_SHR] = lerp(BASE[J_SHR], -1.15, swipe) - 0.25 * wind * (1 - swipe);
  out[J_SHR + 1] = -0.55 * wind * (1 - swipe) + 0.9 * swipe * (1 - 0.5 * rec);
  out[J_ELR] = lerp(-0.6, -0.15, swipe);
  out[J_HAR] = -0.4 * swipe;
  // Off arm counters behind.
  out[J_SHL] += 0.45 * lunge;
  out[J_ELL] = -0.6;
}

function poseCelebrate(m, u, out) {
  out.set(BASE);
  const up = seg(u, 0, 0.18);
  const end = seg(u, 0.85, 1);
  const hold = up * (1 - end);
  const pump = Math.sin(u * Math.PI * 4);
  // Two hops (celebration hops do NOT count as airborne per contract).
  const s1 = (u - 0.10) / 0.32;
  if (s1 > 0 && s1 < 1) out[C_RIGY] += 0.26 * 4 * s1 * (1 - s1);
  const s2 = (u - 0.52) / 0.26;
  if (s2 > 0 && s2 < 1) out[C_RIGY] += 0.13 * 4 * s2 * (1 - s2);
  // Fist pumps overhead.
  let shr = lerp(BASE[J_SHR], -2.55, up);
  shr = lerp(shr, -0.9, end);
  out[J_SHR] = shr + 0.22 * pump * hold;
  out[J_ELR] = -0.75 - 0.45 * (pump > 0 ? pump : 0) * hold;
  out[J_HAR] = -0.5 * hold;
  out[J_SHL] = lerp(BASE[J_SHL], -1.3, 0.8 * hold);
  out[J_SHL + 2] = BASE[J_SHL + 2] + 0.5 * hold;
  out[J_ELL] = -0.8;
  out[J_CHEST] += -0.10 * hold;                        // chest out
  out[J_HEAD] += -0.30 * hold;                         // chin up
  const kt = (s1 > 0 && s1 < 1) ? Math.sin(clamp(s1, 0, 1) * Math.PI) : 0;
  out[J_KNL] += 0.35 * kt;  out[J_KNR] += 0.35 * kt;
  out[J_HIL] += -0.18 * kt; out[J_HIR] += -0.18 * kt;
}

function poseDejected(m, u, out) {
  out.set(BASE);
  const g = seg(u, 0, 0.32);
  out[J_HEAD] += 0.72 * g;                             // head drops
  out[J_NECK] += 0.15 * g;
  out[J_CHEST] += 0.26 * g;                            // shoulders slump
  out[J_SPINE] += 0.08 * g;
  out[J_PELVIS + 1] += 0.03 * g * Math.sin(u * 5.5);
  // Hands to hips (akimbo).
  const sh = lerp(BASE[J_SHL], 0.25, g);
  out[J_SHL] = sh;  out[J_SHR] = sh;
  const shz = lerp(BASE[J_SHL + 2], 0.62, g);
  out[J_SHL + 2] = shz;  out[J_SHR + 2] = -shz;
  const el = lerp(BASE[J_ELL], -1.3, g);
  out[J_ELL] = el;  out[J_ELR] = el;
  out[J_HIL] += -0.05 * g;  out[J_HIR] += -0.05 * g;
  out[J_KNL] += 0.08 * g;   out[J_KNR] += 0.08 * g;
}

// ---------------------------------------------------------------------------
// State tables
// ---------------------------------------------------------------------------
const LOOPS = {
  idle: poseIdle,
  run: poseRun,
  sprint: poseSprint,
  defense: poseDefense,
  dribbleIdle: poseDribbleIdle,
  dribbleRun: poseDribbleRun,
};

// air: [u0, u1, jumpHeight] — a parabola on the inner rig's Y.
const ONESHOTS = {
  shoot:     { dur: 0.90, releaseU: 0.58, air: [0.36, 0.86, 0.50], airborne: true,  fn: poseShoot },
  layup:     { dur: 0.80, releaseU: 0.56, air: [0.28, 0.90, 0.60], airborne: true,  fn: poseLayup },
  pass:      { dur: 0.35, releaseU: 0.50, air: null,               airborne: false, fn: posePass },
  block:     { dur: 0.70, releaseU: 0.50, air: [0.22, 0.86, 0.65], airborne: true,  fn: poseBlock },
  steal:     { dur: 0.40, releaseU: 0.45, air: null,               airborne: false, fn: poseSteal },
  celebrate: { dur: 1.20, releaseU: null, air: null,               airborne: false, fn: poseCelebrate },
  dejected:  { dur: 1.20, releaseU: null, air: null,               airborne: false, fn: poseDejected },
};

// ===========================================================================
// PlayerModel
// ===========================================================================
export class PlayerModel {
  constructor(opts = {}) {
    const jersey = opts.jersey || '#cc3333';
    const jerseyTrim = opts.jerseyTrim || '#ffffff';
    const shorts = opts.shorts || jersey;
    const skin = opts.skin || '#8d5524';
    const number = (opts.number === undefined || opts.number === null) ? 0 : opts.number;
    const name = typeof opts.name === 'string' ? opts.name : '';

    let h = Number(opts.height);
    if (!Number.isFinite(h)) h = 1.98;
    h = clamp(h, 1.7, 2.3);
    this._h = h;

    // Deterministic per-player variety seed.
    let sd = 0;
    const idStr = name + '#' + number;
    for (let i = 0; i < idStr.length; i++) sd = (sd * 31 + idStr.charCodeAt(i)) % 997;
    this._seed = (sd / 997) * TWO_PI;

    // --- proportions (NBA-ish: wingspan ≈ 1.06 × height, legs ≈ 48-50%) ---
    const d = this._dims = {
      pelvisY: 0.545 * h,
      hipDown: 0.045 * h,          // pelvis pivot → hip joints
      hipHalf: 0.052 * h,
      thigh: 0.24 * h,
      shin: 0.215 * h,
      ankle: 0.045 * h,
      spineUp: 0.07 * h,
      chestUp: 0.09 * h,
      shoulderUp: 0.10 * h,
      shoulderHalf: 0.115 * h,     // (wingspan - 2·shoulderHalf)/2 per arm
      neckUp: 0.115 * h,
      headUp: 0.045 * h,
      headCenter: 0.055 * h,
      headR: 0.070 * h,
      upperArm: 0.175 * h,
      forearm: 0.16 * h,
      hand: 0.08 * h,
    };
    // Bigger players carry more mass: radius scale grows with height.
    const bulk = 0.94 + 0.22 * clamp((h - 1.85) / 0.28, 0, 1);
    const rb = h * bulk;

    this.group = new THREE.Group();
    const rig = this._rig = new THREE.Group();
    this.group.add(rig);
    this.group.add(blobShadowMesh());

    // --- joint hierarchy -------------------------------------------------
    const J = (parent, x, y, z) => {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      parent.add(g);
      return g;
    };
    const pelvis = J(rig, 0, d.pelvisY, 0);
    const spine = J(pelvis, 0, d.spineUp, 0);
    const chest = J(spine, 0, d.chestUp, 0);
    const neck = J(chest, 0, d.neckUp, 0);
    const head = J(neck, 0, d.headUp, 0);
    const shoulderL = J(chest, d.shoulderHalf, d.shoulderUp, 0);
    const elbowL = J(shoulderL, 0, -d.upperArm, 0);
    const handL = J(elbowL, 0, -d.forearm, 0);
    const shoulderR = J(chest, -d.shoulderHalf, d.shoulderUp, 0);
    const elbowR = J(shoulderR, 0, -d.upperArm, 0);
    const handR = J(elbowR, 0, -d.forearm, 0);
    const hipL = J(pelvis, d.hipHalf, -d.hipDown, 0);
    const kneeL = J(hipL, 0, -d.thigh, 0);
    const footL = J(kneeL, 0, -d.shin, 0);
    const hipR = J(pelvis, -d.hipHalf, -d.hipDown, 0);
    const kneeR = J(hipR, 0, -d.thigh, 0);
    const footR = J(kneeR, 0, -d.shin, 0);
    // Order MUST match the channel constants.
    this._joints = [pelvis, spine, chest, neck, head,
                    shoulderL, elbowL, handL, shoulderR, elbowR, handR,
                    hipL, kneeL, footL, hipR, kneeR, footR];
    this._pelvis = pelvis;

    // --- materials --------------------------------------------------------
    const skinM = stdMat(skin, 0.75);
    const skinDarkM = stdMat(darken(skin, 0.55), 0.8);
    const hairM = stdMat(HAIR_COLORS[Math.abs(number | 0) % HAIR_COLORS.length], 0.92);
    const jerseyM = stdMat(jersey, 0.82);
    const trimM = stdMat(jerseyTrim, 0.7);
    const shortsM = stdMat(shorts, 0.82);
    const whiteM = stdMat('#f4f4f2', 0.55);
    const shoeM = stdMat(jerseyTrim, 0.45);

    // --- radii ------------------------------------------------------------
    const torsoR = 0.073 * rb;
    const shortsR = 0.082 * rb;
    const thighR = 0.058 * rb;
    const shinR = 0.035 * rb;
    const armR = 0.030 * rb;
    const foreR = 0.026 * rb;
    const neckR = 0.033 * rb;
    const shoeR = 0.031 * rb;
    const headR = d.headR;

    const M = (parent, geo, mat, x = 0, y = 0, z = 0) => {
      const mm = new THREE.Mesh(geo, mat);
      mm.position.set(x, y, z);
      mm.castShadow = true;
      parent.add(mm);
      return mm;
    };

    // --- torso / uniform ----------------------------------------------------
    M(spine, capsuleGeo(torsoR * 0.92, 0.10 * h), jerseyM, 0, 0.035 * h, 0);
    M(chest, capsuleGeo(torsoR, 0.13 * h), jerseyM, 0, 0.055 * h, 0);
    M(chest, cylGeo(neckR + 0.012, 0.014 * h), trimM, 0, 0.112 * h, 0);   // collar
    // Jersey side piping.
    M(chest, boxGeo(0.012 * h, 0.11 * h, 0.03 * h), trimM, torsoR * 0.95, 0.05 * h, 0);
    M(chest, boxGeo(0.012 * h, 0.11 * h, 0.03 * h), trimM, -torsoR * 0.95, 0.05 * h, 0);
    // Shorts + waistband.
    const shortsMesh = M(pelvis, capsuleGeo(shortsR, 0.10 * h), shortsM, 0, -0.055 * h, 0);
    shortsMesh.scale.z = 0.92;
    M(pelvis, cylGeo(shortsR + 0.004, 0.02 * h), trimM, 0, 0.012 * h, 0);

    // --- head ---------------------------------------------------------------
    M(neck, cylGeo(neckR, 0.05 * h), skinM, 0, 0.012 * h, 0);
    const headMesh = M(head, sphereGeo(headR), skinM, 0, d.headCenter, 0);
    headMesh.scale.set(0.88, 1.06, 0.94);
    const hairMesh = M(head, sphereGeo(headR * 1.03), hairM, 0, d.headCenter + 0.022 * h, -0.006 * h);
    hairMesh.scale.set(0.90, 0.82, 0.96);
    // Subtle darker eye band suggests a face without uncanny detail.
    M(head, boxGeo(headR * 1.15, headR * 0.32, headR * 0.35), skinDarkM,
      0, d.headCenter + headR * 0.10, headR * 0.62);
    if (Math.abs(number | 0) % 5 < 2) { // some players wear a headband
      M(head, cylGeo(headR * 0.93, headR * 0.38), trimM, 0, d.headCenter + headR * 0.42, 0);
    }

    // --- arms (jersey is sleeveless → skin) ----------------------------------
    const blobGeo = sphereGeo(0.045 * rb);
    const upperArmGeo = capsuleGeo(armR, d.upperArm * 0.8);
    const foreGeo = capsuleGeo(foreR, d.forearm * 0.78);
    const elbowGeo = sphereGeo(armR * 1.05);
    const handGeo = sphereGeo(0.034 * rb);
    const wristGeo = cylGeo(foreR + 0.005, 0.022 * h);
    const buildArm = (shoulder, elbow, hand, wristband) => {
      M(shoulder, blobGeo, jerseyM, 0, 0.01 * h, 0);   // shoulder sleeve cap
      M(shoulder, upperArmGeo, skinM, 0, -d.upperArm * 0.5, 0);
      M(elbow, elbowGeo, skinM, 0, 0, 0);
      M(elbow, foreGeo, skinM, 0, -d.forearm * 0.48, 0);
      if (wristband) M(elbow, wristGeo, trimM, 0, -d.forearm * 0.88, 0);
      const hm = M(hand, handGeo, skinM, 0, -0.032 * h, 0);
      hm.scale.set(0.8, 1.25, 0.55);
    };
    buildArm(shoulderL, elbowL, handL, Math.abs(number | 0) % 2 === 0);
    buildArm(shoulderR, elbowR, handR, Math.abs(number | 0) % 3 === 0);

    // --- legs ----------------------------------------------------------------
    const thighGeo = capsuleGeo(thighR, d.thigh * 0.8);
    const hemGeo = cylGeo(thighR + 0.004, 0.02 * h);
    const stripeGeo = boxGeo(0.012 * h, d.thigh * 0.5, 0.026 * h);
    const kneeGeo = sphereGeo(shinR * 1.15);
    const shinGeo = capsuleGeo(shinR, d.shin * 0.75);
    const sockGeo = cylGeo(shinR + 0.003, 0.04 * h);
    const soleGeo = boxGeo(0.055 * h, 0.014 * h, 0.14 * h);
    const upperFootGeo = capsuleGeo(shoeR, 0.055 * h);
    const toeGeo = sphereGeo(shoeR * 0.8);
    const buildLeg = (hip, knee, foot, side) => {
      // NBA shorts cover the thigh — thigh capsule wears the shorts color.
      M(hip, thighGeo, shortsM, 0, -d.thigh * 0.46, 0);
      M(hip, hemGeo, trimM, 0, -d.thigh * 0.8, 0);
      M(hip, stripeGeo, trimM, side * thighR * 0.92, -d.thigh * 0.42, 0);
      M(knee, kneeGeo, skinM, 0, 0, 0);
      M(knee, shinGeo, skinM, 0, -d.shin * 0.45, 0);
      M(knee, sockGeo, whiteM, 0, -d.shin * 0.86, 0);
      // Sneaker: white sole + team-accent upper + white toe cap.
      const soleTop = -d.ankle + 0.014 * h;
      M(foot, soleGeo, whiteM, 0, -d.ankle + 0.007 * h, 0.028 * h);
      const up = M(foot, upperFootGeo, shoeM, 0, soleTop + shoeR * 0.66, 0.026 * h);
      up.rotation.x = Math.PI / 2;
      up.scale.set(1, 1, 0.78);
      M(foot, toeGeo, whiteM, 0, soleTop + shoeR * 0.42, 0.028 * h + 0.0275 * h + shoeR * 0.45);
    };
    buildLeg(hipL, kneeL, footL, 1);
    buildLeg(hipR, kneeR, footR, -1);

    // --- jersey number / name planes ----------------------------------------
    this._owned = [];
    const frontTex = makeNumberTexture(number, name, jerseyTrim, false);
    const backTex = makeNumberTexture(number, name, jerseyTrim, true);
    if (frontTex && backTex) {
      const frontMat = new THREE.MeshStandardMaterial({
        map: frontTex, transparent: true, roughness: 0.85, metalness: 0, depthWrite: false,
      });
      const backMat = new THREE.MeshStandardMaterial({
        map: backTex, transparent: true, roughness: 0.85, metalness: 0, depthWrite: false,
      });
      this._owned.push(frontMat, backMat);
      const front = M(chest, planeGeo(), frontMat, 0, 0.055 * h, torsoR + 0.012);
      front.scale.set(0.095 * h, 0.095 * h, 1);
      front.castShadow = false;
      const back = M(chest, planeGeo(), backMat, 0, 0.058 * h, -(torsoR + 0.012));
      back.rotation.y = Math.PI;
      back.scale.set(0.165 * h, 0.175 * h, 1);
      back.castShadow = false;
    }

    // --- anchors --------------------------------------------------------------
    // Palm of the dribbling/carry (right) hand.
    this._ballAnchor = J(handR, 0, -0.05 * h, 0.012);
    // Shot release point above the head (neck barely rotates in poses, so this
    // anchor stays stable while still riding the jump and torso lean).
    this._releaseAnchor = J(neck, 0, 0.40 * h, 0.05 * h);

    // --- animation state --------------------------------------------------------
    this._pose = new Float32Array(NCH);
    this._poseFrom = new Float32Array(NCH);
    this._poseApplied = new Float32Array(NCH);
    this._poseApplied.set(BASE);
    this._fade = 1;
    this._loopName = 'idle';
    this._loopFn = poseIdle;
    this._shot = null;
    this._speed = 0;
    this._time = this._seed * 1.7;
    this._idleT = this._seed * 3.1;
    this._runPhase = this._seed;
    this._dribblePhase = this._seed * 2;
    this._defPhase = this._seed * 3;
    this.isAirborne = false;
    this._disposed = false;

    this.update(0); // settle into idle so the model never renders un-posed
  }

  // -------------------------------------------------------------------------
  setAnimation(name, opts = {}) {
    if (this._disposed) return;
    if (LOOPS[name]) {
      if (this._shot) {
        // Just retarget the loop we return to once the one-shot finishes.
        this._loopName = name;
        this._loopFn = LOOPS[name];
        return;
      }
      if (name === this._loopName) return; // cheap no-op
      this._startFade();
      this._loopName = name;
      this._loopFn = LOOPS[name];
      return;
    }
    const def = ONESHOTS[name];
    if (!def) return; // unknown state: ignore, never throw
    if (this._shot) {
      // Interrupting: the old one-shot must fire nothing further.
      this._shot.onRelease = null;
      this._shot.onComplete = null;
    }
    this._startFade();
    this._shot = {
      def, t: 0, released: false,
      onRelease: typeof opts.onRelease === 'function' ? opts.onRelease : null,
      onComplete: typeof opts.onComplete === 'function' ? opts.onComplete : null,
    };
  }

  setMoveSpeed(v) {
    this._speed = Number.isFinite(v) ? clamp(v, 0, 12) : 0;
  }

  // -------------------------------------------------------------------------
  update(dt) {
    if (this._disposed) return;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    else if (dt > 0.1) dt = 0.1;

    const sp = this._speed;
    this._time += dt;
    this._idleT += dt;
    // Cadence scales with commanded move speed (stride amplitude scales in
    // the pose functions themselves).
    this._runPhase += dt * TWO_PI * clamp(0.55 + 0.30 * sp, 0.7, 2.9);
    this._dribblePhase += dt * TWO_PI * (2.2 + 0.5 * clamp(sp / PLAYER.DRIBBLE_SPEED, 0, 1));
    this._defPhase += dt * TWO_PI * (1.7 + 0.8 * clamp(sp / PLAYER.DEFENSE_SPEED, 0, 1));

    const pose = this._pose;
    let airborne = false;

    const shot = this._shot;
    if (shot) {
      shot.t += dt;
      const def = shot.def;
      const u = def.dur > 0 ? shot.t / def.dur : 1;
      if (!shot.released && def.releaseU !== null && u >= def.releaseU) {
        shot.released = true;
        const cb = shot.onRelease;
        shot.onRelease = null;
        fire(cb);
      }
      if (this._shot !== shot) {
        // onRelease started a new one-shot: render its first frame.
        this._shot.def.fn(this, 0, pose);
      } else if (u >= 1) {
        this._shot = null;
        this._startFade();
        const done = shot.onComplete;
        shot.onComplete = null;
        this._loopFn(this, pose);
        fire(done);
        if (this._shot) this._shot.def.fn(this, 0, pose); // onComplete chained a new one-shot
      } else {
        def.fn(this, u, pose);
        if (def.air) {
          const s = (u - def.air[0]) / (def.air[1] - def.air[0]);
          if (s > 0 && s < 1) {
            pose[C_RIGY] += def.air[2] * 4 * s * (1 - s);
            airborne = def.airborne;
          }
        }
      }
    } else {
      this._loopFn(this, pose);
    }

    // Crossfade from the snapshot taken at the last transition.
    let out = pose;
    if (this._fade < 1) {
      this._fade = Math.min(1, this._fade + dt / FADE_TIME);
      const a = sm01(this._fade);
      const from = this._poseFrom, appl = this._poseApplied;
      for (let i = 0; i < NCH; i++) appl[i] = from[i] + (pose[i] - from[i]) * a;
      out = appl;
    } else {
      this._poseApplied.set(pose);
    }
    this._applyPose(out);
    this.isAirborne = airborne && out[C_RIGY] > 0.02;
  }

  _startFade() {
    this._poseFrom.set(this._poseApplied);
    this._fade = 0;
  }

  _applyPose(out) {
    const js = this._joints;
    for (let i = 0; i < NJ; i++) {
      const k = i * 3;
      js[i].rotation.set(out[k], out[k + 1], out[k + 2]);
    }
    this._pelvis.position.set(out[C_PX], this._dims.pelvisY + out[C_PY], out[C_PZ]);
    this._rig.position.y = out[C_RIGY];
  }

  // -------------------------------------------------------------------------
  getBallAnchor(outVector3) {
    const out = outVector3 || _fallbackV;
    return this._ballAnchor.getWorldPosition(out);
  }

  getReleasePoint(outVector3) {
    const out = outVector3 || _fallbackV;
    return this._releaseAnchor.getWorldPosition(out);
  }

  // -------------------------------------------------------------------------
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    // Per-player resources only; cached geometries/materials are shared statics.
    for (let i = 0; i < this._owned.length; i++) {
      const m = this._owned[i];
      if (m.map) m.map.dispose();
      m.dispose();
    }
    this._owned.length = 0;
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
