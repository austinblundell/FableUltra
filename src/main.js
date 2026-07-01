// ============================================================================
// main.js — bootstrap and frame loop. Wires together the arena, ball, game
// logic, camera, HUD, audio and input modules. This file defines the exact
// API each module must expose:
//
//   arena.js      export function createArena(scene, renderer)
//                   -> { group, hoops: [{ index, rimCenter:Vector3,
//                        netImpulse(velocity:Vector3) }, ...2],
//                        update(dt, excitement:0..1),
//                        setJumbotron({home, away, quarter, clock}) }
//   ball.js       export class Ball(scene, audio)
//                   .mesh .radius .state ('HELD'|'SHOT'|'PASS'|'FREE')
//                   .setHeld(pos) .launchShot(start, target, apexHeight, opts)
//                   .launchPass(start, velocity) .drop(pos, vel)
//                   .update(dt) .onScore(hoopIndex) .onTouchFloor()
//   game.js       export class Game({scene, arena, ball, audio, hud, options})
//                   .update(dt, input) .snapshot() .cameraFocus():Vector3
//                   .over:boolean .dispose()
//   cameraRig.js  export class CameraRig(camera)
//                   .update(dt, focus:Vector3, immediate?:boolean,
//                           ctx?: {playerPos, actionPoint})
//                   .cycleMode():string .reset()
//                   .mapMoveToCourt(moveX, moveZ, out:{x,z})
//   hud.js        export class HUD()
//                   .onStart = ({quarterMinutes, difficulty}) => {}
//                   .update(snapshot) .showMessage(text, seconds, accent?)
//                   .setPaused(bool) .showGameOver({homeScore, awayScore, winnerName})
//   audio.js      export class AudioEngine()
//                   .unlock() .update(dt) .setExcitement(0..1)
//                   .bounce(i) .rim() .backboard() .swish() .buzzer()
//                   .whistle() .cheer(big) .groan() .squeak() .netSwish()
//   controls.js   export class Controls(target)
//                   .update() .state {moveX, moveZ, sprint, shootHeld,
//                     shootPressed, shootReleased, passPressed, stealPressed,
//                     switchPressed, cameraPressed, pausePressed, anyPressed}
// ============================================================================

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CAMERA, TEAMS, RULES } from './constants.js';
import { createArena } from './arena.js';
import { Ball } from './ball.js';
import { Game } from './game.js';
import { CameraRig } from './cameraRig.js';
import { HUD } from './hud.js';
import { AudioEngine } from './audio.js';
import { Controls } from './controls.js';

const container = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
scene.fog = new THREE.Fog(0x05070d, 55, 110);

// Soft studio environment for PBR reflections (court gloss, ball leather).
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(
  CAMERA.FOV, window.innerWidth / window.innerHeight, 0.1, 220);
camera.position.set(0, CAMERA.HEIGHT, CAMERA.SIDELINE_Z);
camera.lookAt(0, 1, 0);

const arena = createArena(scene, renderer);
const audio = new AudioEngine();
const ball = new Ball(scene, audio);
const hud = new HUD();
const controls = new Controls(window);
const cameraRig = new CameraRig(camera);

let game = null;
let paused = false;

hud.onStart = (options) => {
  audio.unlock();
  if (game) game.dispose();
  paused = false;
  game = new Game({ scene, arena, ball, audio, hud, options });
  cameraRig.reset();
  cameraRig.update(0, game.cameraFocus(), true);
  window.__game = game;   // debug/testing handle
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let jumboAccum = 0;

// Debug/testing hooks: ?dt=0.0166 fixes the timestep, ?steps=N runs N sim
// steps per rendered frame (lets slow software renderers simulate full games).
const params = new URLSearchParams(location.search);
const FIXED_DT = Math.min(parseFloat(params.get('dt')) || 0, 1 / 30);
const SIM_STEPS = Math.max(1, Math.min(parseInt(params.get('steps'), 10) || 1, 60));

// Dynamic resolution scaling: ease pixel ratio down when the frame rate
// sags, back up when there's headroom.
const MAX_PR = Math.min(window.devicePixelRatio, 2);
let pixelRatio = MAX_PR;
let ftAccum = 0, ftFrames = 0, ftCheck = 0;

function adaptResolution(dt) {
  ftAccum += dt; ftFrames++; ftCheck += dt;
  if (ftCheck < 2 || ftFrames < 10) return;
  const avg = ftAccum / ftFrames;
  ftAccum = 0; ftFrames = 0; ftCheck = 0;
  if (avg > 1 / 45 && pixelRatio > 0.55 * MAX_PR) {
    pixelRatio = Math.max(0.55 * MAX_PR, pixelRatio * 0.85);
    renderer.setPixelRatio(pixelRatio);
  } else if (avg < 1 / 58 && pixelRatio < MAX_PR) {
    pixelRatio = Math.min(MAX_PR, pixelRatio * 1.1);
    renderer.setPixelRatio(pixelRatio);
  }
}

// Input handed to the sim: controls.state with the move axes remapped from
// screen space to court space for the active camera view (W = up-screen).
const gameInput = {};
const _mv = { x: 0, z: 0 };

// Edge-triggered flags must only reach the sim once per rendered frame.
const heldOnlyState = {};
function stripEdges(state) {
  Object.assign(heldOnlyState, state);
  heldOnlyState.shootPressed = heldOnlyState.shootReleased = heldOnlyState.passPressed = false;
  heldOnlyState.stealPressed = heldOnlyState.switchPressed = heldOnlyState.pausePressed = false;
  heldOnlyState.anyPressed = false;
  return heldOnlyState;
}

function frame() {
  requestAnimationFrame(frame);
  const rawDt = Math.min(clock.getDelta(), 1 / 30);
  const dt = FIXED_DT || rawDt;
  controls.update();

  if (controls.state.pausePressed && game && !game.over) {
    paused = !paused;
    hud.setPaused(paused);
  }

  if (controls.state.cameraPressed && game && !paused) {
    hud.showMessage('CAMERA: ' + cameraRig.cycleMode(), 1.1);
  }

  let excitement = 0.25;
  if (game && !paused) {
    Object.assign(gameInput, controls.state);
    cameraRig.mapMoveToCourt(gameInput.moveX, gameInput.moveZ, _mv);
    gameInput.moveX = _mv.x;
    gameInput.moveZ = _mv.z;
    for (let i = 0; i < SIM_STEPS; i++) {
      game.update(dt, i === 0 ? gameInput : stripEdges(gameInput));
      ball.update(dt);
    }
    const snap = game.snapshot();
    hud.update(snap);
    excitement = snap.excitement;

    jumboAccum += dt;
    if (jumboAccum > 0.25) {
      jumboAccum = 0;
      arena.setJumbotron({
        home: snap.homeScore, away: snap.awayScore,
        quarter: snap.quarter, clock: snap.clockText,
      });
    }
    cameraRig.update(dt, game.cameraFocus(), false, game.cameraContext());
  } else if (!game) {
    // Idle attract mode behind the start menu: slow orbit around the court.
    const t = clock.elapsedTime * 0.08;
    camera.position.set(Math.sin(t) * 20, 7.5, Math.cos(t) * 20);
    camera.lookAt(0, 1.2, 0);
    ball.update(dt);
  }

  arena.update(dt, excitement);
  audio.setExcitement(excitement);
  audio.update(dt);
  adaptResolution(rawDt);
  renderer.render(scene, camera);
}

document.getElementById('loading').style.opacity = '0';
setTimeout(() => document.getElementById('loading').remove(), 600);
frame();
