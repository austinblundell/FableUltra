// ============================================================================
// cameraRig.js — broadcast-style sideline camera.
//
// Sits on the +z sideline (CAMERA.SIDELINE_Z) at CAMERA.HEIGHT, tracking the
// action along x with exponential smoothing, plus a subtle FOV zoom-in near
// the hoops for broadcast drama.
//
//   const rig = new CameraRig(camera);
//   rig.update(dt, focus);            // each frame
//   rig.update(0, focus, true);       // snap (game start)
// ============================================================================

import * as THREE from 'three';
import { CAMERA } from './constants.js';

// smoothstep(edge0, edge1, x): 0 below edge0, 1 above edge1, smooth in between
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const _desiredPos = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    // Persistent smoothed state.
    this._pos = new THREE.Vector3(0, CAMERA.HEIGHT, CAMERA.SIDELINE_Z);
    this._target = new THREE.Vector3(0, 1.35, 0);
    this._fov = CAMERA.FOV;
    if (camera) {
      this._pos.copy(camera.position);
      if (Number.isFinite(camera.fov)) this._fov = camera.fov;
    }
  }

  update(dt, focus, immediate = false) {
    const camera = this.camera;
    if (!camera || !focus) return;

    // Guard NaN focus (never let the camera fly to NaN-land).
    const fx = Number.isFinite(focus.x) ? focus.x : 0;
    const fz = Number.isFinite(focus.z) ? focus.z : 0;

    // Desired rig pose.
    const clampX = CAMERA.FOLLOW_CLAMP_X;
    _desiredPos.set(
      Math.min(clampX, Math.max(-clampX, fx * 0.82)),
      CAMERA.HEIGHT,
      CAMERA.SIDELINE_Z,
    );
    _desiredTarget.set(fx * 0.9, 1.35, fz * 0.3);

    // FOV drama: tighten slightly as play approaches either hoop.
    const desiredFov = CAMERA.FOV - 5 * smoothstep(6, 11.5, Math.abs(fx));

    // Exponential smoothing factor; dt = 0 -> k = 0 (no movement, no NaN).
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const k = immediate ? 1 : 1 - Math.exp(-CAMERA.SMOOTHING * safeDt);

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
