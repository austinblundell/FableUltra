// ============================================================================
// cameraRig.js — game camera with switchable views.
//
//   const rig = new CameraRig(camera);
//   rig.update(dt, focus, immediate, ctx);   // each frame
//     focus:     THREE.Vector3 the action point (ball biased toward the hoop)
//     immediate: true snaps instead of smoothing (game start)
//     ctx:       optional { playerPos, actionPoint } from game.cameraContext()
//                (required for the PLAYER/RIM views to track; without it those
//                views fall back to framing the focus point)
//   rig.cycleMode() -> next view's display name ('BROADCAST' | 'PLAYER' | ...)
//   rig.reset()     -> back to BROADCAST
//
// Views:
//   BROADCAST — classic sideline TV camera (default)
//   PLAYER    — low camera close behind the controlled player, looking through
//               them toward the basket the play is attacking
//   RIM       — elevated camera behind the attacked basket
//   SKY       — high overhead trailing the ball
// ============================================================================

import * as THREE from 'three';
import { CAMERA, COURT } from './constants.js';

// smoothstep(edge0, edge1, x): 0 below edge0, 1 above edge1, smooth in between
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const _desiredPos = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3();
const _back = new THREE.Vector3();

const MODES = ['BROADCAST', 'PLAYER', 'RIM', 'SKY'];

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.modeIndex = 0;
    // Persistent smoothed state.
    this._pos = new THREE.Vector3(0, CAMERA.HEIGHT, CAMERA.SIDELINE_Z);
    this._target = new THREE.Vector3(0, 1.35, 0);
    this._fov = CAMERA.FOV;
    if (camera) {
      this._pos.copy(camera.position);
      if (Number.isFinite(camera.fov)) this._fov = camera.fov;
    }
  }

  get mode() { return MODES[this.modeIndex]; }

  cycleMode() {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    return this.mode;
  }

  reset() { this.modeIndex = 0; }

  update(dt, focus, immediate = false, ctx = null) {
    const camera = this.camera;
    if (!camera || !focus) return;

    // Guard NaN focus (never let the camera fly to NaN-land).
    const fx = Number.isFinite(focus.x) ? focus.x : 0;
    const fz = Number.isFinite(focus.z) ? focus.z : 0;

    const mode = MODES[this.modeIndex];
    let desiredFov = CAMERA.FOV;
    let smoothing = CAMERA.SMOOTHING;

    if (mode === 'PLAYER' && ctx && ctx.playerPos) {
      // Close third-person: sit behind the player on the line from the
      // attacked basket through them, looking past them at the action.
      const p = ctx.playerPos;
      const a = ctx.actionPoint || focus;
      _back.set(p.x - a.x, 0, p.z - a.z);
      if (_back.lengthSq() < 0.04) _back.set(-Math.sign(a.x || 1), 0, 0.3);
      _back.normalize();
      _desiredPos.set(
        p.x + _back.x * 4.2,
        2.8,
        p.z + _back.z * 4.2 + 0.25,   // tiny sideline bias so passes read better
      );
      _desiredTarget.set(
        p.x + (a.x - p.x) * 0.3,
        1.4,
        p.z + (a.z - p.z) * 0.3,
      );
      desiredFov = 55;
      smoothing = CAMERA.SMOOTHING * 1.8;   // tighter tracking up close
    } else if (mode === 'RIM' && ctx && ctx.actionPoint) {
      // Behind the attacked backboard, elevated, watching the play develop.
      const a = ctx.actionPoint;
      const sign = a.x >= 0 ? 1 : -1;
      _desiredPos.set(sign * (COURT.HALF_LENGTH + 4.5), 4.6, 2.2);
      _desiredTarget.set(fx * 0.55 + a.x * 0.45, 1.6, fz * 0.55);
      desiredFov = 50;
    } else if (mode === 'SKY') {
      // High overhead trailing the ball — great for reading spacing.
      _desiredPos.set(fx * 0.6, 15.5, fz * 0.4 + 7.5);
      _desiredTarget.set(fx, 0.4, fz);
      desiredFov = 50;
      smoothing = CAMERA.SMOOTHING * 0.8;
    } else {
      // BROADCAST (and fallback when ctx is missing).
      const clampX = CAMERA.FOLLOW_CLAMP_X;
      _desiredPos.set(
        Math.min(clampX, Math.max(-clampX, fx * 0.82)),
        CAMERA.HEIGHT,
        CAMERA.SIDELINE_Z,
      );
      _desiredTarget.set(fx * 0.9, 1.35, fz * 0.3);
      // FOV drama: tighten slightly as play approaches either hoop.
      desiredFov = CAMERA.FOV - 5 * smoothstep(6, 11.5, Math.abs(fx));
    }

    // Exponential smoothing factor; dt = 0 -> k = 0 (no movement, no NaN).
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const k = immediate ? 1 : 1 - Math.exp(-smoothing * safeDt);

    this._pos.lerp(_desiredPos, k);
    this._target.lerp(_desiredTarget, k);
    this._fov += (desiredFov - this._fov) * k;

    camera.position.copy(this._pos);
    camera.lookAt(this._target);

    if (Math.abs(camera.fov - this._fov) > 0.01) {
      camera.fov = this._fov;
      camera.updateProjectionMatrix();
    }
  }
}
