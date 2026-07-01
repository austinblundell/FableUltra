// ============================================================================
// arena.js — the entire NBA arena environment, fully procedural.
//
//   export function createArena(scene, renderer) -> {
//     group, hoops:[{ index, rimCenter, netImpulse(vel) } x2],
//     update(dt, excitement), setJumbotron({home, away, quarter, clock})
//   }
//
// Everything is built from Three.js primitives + canvas textures. No assets.
// ============================================================================

import * as THREE from 'three';
import { COURT, TEAMS } from './constants.js';

// ---------------------------------------------------------------------------
// deterministic PRNG so the arena looks identical every load
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// tiny manual geometry merge (position + normal + index only) — no addons dep
// ---------------------------------------------------------------------------
function mergeGeometries(geoms) {
  let vCount = 0, iCount = 0;
  for (const g of geoms) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const idx = new Uint16Array(iCount);
  let vOff = 0, iOff = 0;
  for (const g of geoms) {
    const p = g.attributes.position, n = g.attributes.normal;
    pos.set(p.array.subarray(0, p.count * 3), vOff * 3);
    nor.set(n.array.subarray(0, n.count * 3), vOff * 3);
    if (g.index) {
      const src = g.index.array;
      for (let k = 0; k < src.length; k++) idx[iOff + k] = src[k] + vOff;
      iOff += src.length;
    } else {
      for (let k = 0; k < p.count; k++) idx[iOff + k] = k + vOff;
      iOff += p.count;
    }
    vOff += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// ---------------------------------------------------------------------------
// COURT FLOOR canvas
// ---------------------------------------------------------------------------
function buildFloorTexture(renderer) {
  const W = 2048, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const sx = W / COURT.LENGTH, sy = H / COURT.WIDTH;
  const px = (x) => (x + COURT.HALF_LENGTH) * sx;
  const pz = (z) => (z + COURT.HALF_WIDTH) * sy;
  const rand = mulberry32(1337);

  const home = TEAMS[0], away = TEAMS[1];

  // --- parquet (Boston-style alternating-grain squares) ---
  const cell = 1.194; // ~ classic parquet square
  const nx = Math.ceil(COURT.LENGTH / cell), nz = Math.ceil(COURT.WIDTH / cell);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x0 = px(-COURT.HALF_LENGTH + i * cell);
      const y0 = pz(-COURT.HALF_WIDTH + j * cell);
      const cw = cell * sx + 1, ch = cell * sy + 1;
      const horiz = (i + j) % 2 === 0; // grain direction
      // warm maple with per-square value/hue noise
      const l = 62 + (rand() - 0.5) * 9;
      const hDeg = 33 + (rand() - 0.5) * 7;
      const s = 42 + (rand() - 0.5) * 8;
      ctx.fillStyle = `hsl(${hDeg}, ${s}%, ${l}%)`;
      ctx.fillRect(x0, y0, cw, ch);
      // planks inside the square
      const planks = 4;
      for (let k = 0; k < planks; k++) {
        const pl = l + (rand() - 0.5) * 6;
        ctx.fillStyle = `hsla(${hDeg + (rand() - 0.5) * 5}, ${s}%, ${pl}%, 0.55)`;
        if (horiz) ctx.fillRect(x0, y0 + (k / planks) * ch, cw, ch / planks - 1);
        else ctx.fillRect(x0 + (k / planks) * cw, y0, cw / planks - 1, ch);
        // faint grain streaks
        ctx.strokeStyle = `hsla(${hDeg - 8}, 30%, ${pl - 14}%, 0.12)`;
        ctx.lineWidth = 1;
        for (let g = 0; g < 2; g++) {
          ctx.beginPath();
          if (horiz) {
            const yy = y0 + (k / planks) * ch + rand() * (ch / planks);
            ctx.moveTo(x0, yy); ctx.lineTo(x0 + cw, yy + (rand() - 0.5) * 3);
          } else {
            const xx = x0 + (k / planks) * cw + rand() * (cw / planks);
            ctx.moveTo(xx, y0); ctx.lineTo(xx + (rand() - 0.5) * 3, y0 + ch);
          }
          ctx.stroke();
        }
      }
      // seam
      ctx.strokeStyle = 'rgba(60, 38, 16, 0.28)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.75, y0 + 0.75, cw - 1.5, ch - 1.5);
    }
  }

  // soft sheen blooms so the floor doesn't read flat
  for (let k = 0; k < 5; k++) {
    const gx = rand() * W, gy = rand() * H, gr = 200 + rand() * 380;
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    grad.addColorStop(0, 'rgba(255,245,220,0.05)');
    grad.addColorStop(1, 'rgba(255,245,220,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
  }

  // --- helpers for court markings (drawn in court meters) ---
  const LW = 0.05 * (sx + sy) * 0.5; // regulation 2" line
  function moveLine(x1, z1, x2, z2) {
    ctx.beginPath();
    ctx.moveTo(px(x1), pz(z1));
    ctx.lineTo(px(x2), pz(z2));
    ctx.stroke();
  }
  function pathArc(cx, cz, r, a0, a1, n = 64) {
    for (let k = 0; k <= n; k++) {
      const a = a0 + (a1 - a0) * (k / n);
      const X = px(cx + Math.cos(a) * r), Y = pz(cz + Math.sin(a) * r);
      if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
  }
  function strokeArc(cx, cz, r, a0, a1) {
    ctx.beginPath(); pathArc(cx, cz, r, a0, a1); ctx.stroke();
  }

  // --- painted key interiors (translucent home color) + center circle fill ---
  const keyHW = COURT.KEY_WIDTH / 2;
  for (const s of [-1, 1]) {
    const bx = s * COURT.HALF_LENGTH;
    const fx = s * (COURT.HALF_LENGTH - COURT.FT_LINE_FROM_BASELINE);
    ctx.fillStyle = 'rgba(76, 32, 118, 0.52)';
    ctx.fillRect(Math.min(px(bx), px(fx)), pz(-keyHW),
      Math.abs(px(fx) - px(bx)), pz(keyHW) - pz(-keyHW));
  }
  ctx.fillStyle = 'rgba(76, 32, 118, 0.52)';
  ctx.beginPath(); pathArc(0, 0, COURT.CENTER_CIRCLE_R, 0, Math.PI * 2); ctx.fill();

  // --- center-court logo ---
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // basketball emblem
  const brx = 1.15 * sx, bry = 1.15 * sy;
  ctx.beginPath(); ctx.ellipse(px(0), pz(0), brx, bry, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(224, 110, 32, 0.9)'; ctx.fill();
  ctx.strokeStyle = 'rgba(52, 24, 8, 0.85)'; ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px(0), pz(0) - bry); ctx.lineTo(px(0), pz(0) + bry); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px(0) - brx, pz(0)); ctx.lineTo(px(0) + brx, pz(0)); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(px(0) - brx * 0.95, pz(0), brx * 0.72, bry * 1.05, 0, -Math.PI * 0.42, Math.PI * 0.42); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(px(0) + brx * 0.95, pz(0), brx * 0.72, bry * 1.05, 0, Math.PI * 0.58, Math.PI * 1.42); ctx.stroke();
  // wordmark
  ctx.font = 'italic 900 74px "Arial Black", Arial, sans-serif';
  ctx.lineWidth = 8; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(40, 16, 62, 0.95)';
  ctx.strokeText('FABLEULTRA', px(0), pz(-2.55));
  ctx.fillStyle = home.secondary;
  ctx.fillText('FABLEULTRA', px(0), pz(-2.55));
  ctx.font = 'italic 700 34px Arial, sans-serif';
  ctx.lineWidth = 5;
  ctx.strokeText('BASKETBALL', px(0), pz(2.5));
  ctx.fillStyle = '#f3ecdf';
  ctx.fillText('BASKETBALL', px(0), pz(2.5));
  ctx.restore();

  // --- regulation lines ---
  ctx.strokeStyle = '#f5f0e4';
  ctx.lineWidth = LW;
  ctx.lineCap = 'butt';

  // boundary (inset by half line width so nothing clips off the plane)
  const inset = LW * 0.5;
  ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
  // half-court line + center circles
  moveLine(0, -COURT.HALF_WIDTH, 0, COURT.HALF_WIDTH);
  strokeArc(0, 0, COURT.CENTER_CIRCLE_R, 0, Math.PI * 2);
  strokeArc(0, 0, 0.61, 0, Math.PI * 2);

  for (const s of [-1, 1]) {
    const bx = s * COURT.HALF_LENGTH;
    const fx = s * (COURT.HALF_LENGTH - COURT.FT_LINE_FROM_BASELINE);
    const hx = s * COURT.HOOP_X;

    // key borders
    moveLine(bx, -keyHW, fx, -keyHW);
    moveLine(bx, keyHW, fx, keyHW);
    moveLine(fx, -keyHW, fx, keyHW);
    // key hash marks (block positions)
    for (const hz of [-1, 1]) {
      for (let m = 1; m <= 4; m++) {
        const mx = s * (COURT.HALF_LENGTH - 2.1 - m * 0.85);
        moveLine(mx, hz * keyHW, mx, hz * (keyHW + 0.15));
      }
    }
    // free-throw circle: solid half away from basket, dashed half toward it
    const awayA0 = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    strokeArc(fx, 0, COURT.FT_CIRCLE_R, awayA0, awayA0 + Math.PI);
    ctx.setLineDash([12, 12]);
    strokeArc(fx, 0, COURT.FT_CIRCLE_R, awayA0 + Math.PI, awayA0 + Math.PI * 2);
    ctx.setLineDash([]);
    // restricted-area arc (opens toward mid-court)
    const rA0 = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    strokeArc(hx, 0, COURT.RESTRICTED_R, rA0, rA0 + Math.PI);

    // three-point line — EXACTLY the isThreePointer geometry:
    // straight corner segments at |z| = THREE_PT_CORNER_Z from the baseline
    // to breakX, then the THREE_PT_RADIUS arc around the rim center.
    ctx.strokeStyle = home.secondary; // team-color 3pt line
    const breakX = s * (COURT.HOOP_X - COURT.THREE_PT_BREAK_DX);
    moveLine(bx, -COURT.THREE_PT_CORNER_Z, breakX, -COURT.THREE_PT_CORNER_Z);
    moveLine(bx, COURT.THREE_PT_CORNER_Z, breakX, COURT.THREE_PT_CORNER_Z);
    // arc endpoints: dx (relative to hoop) = -s*THREE_PT_BREAK_DX, z = ±CORNER_Z
    const aTop = Math.atan2(-COURT.THREE_PT_CORNER_Z, -s * COURT.THREE_PT_BREAK_DX);
    const aBot = Math.atan2(COURT.THREE_PT_CORNER_Z, -s * COURT.THREE_PT_BREAK_DX);
    if (s > 0) {
      // east arc bulges toward mid-court (-x): sweep through angle PI
      ctx.beginPath(); pathArc(hx, 0, COURT.THREE_PT_RADIUS, aBot, aTop + Math.PI * 2, 96); ctx.stroke();
    } else {
      // west arc bulges toward mid-court (+x): sweep through angle 0
      ctx.beginPath(); pathArc(hx, 0, COURT.THREE_PT_RADIUS, aTop, aBot, 96); ctx.stroke();
    }
    ctx.strokeStyle = '#f5f0e4';
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const maxAniso = (renderer && renderer.capabilities)
    ? renderer.capabilities.getMaxAnisotropy() : 4;
  tex.anisotropy = Math.min(8, maxAniso || 4);
  return tex;
}

// ---------------------------------------------------------------------------
// backboard decal (border + shooter square) — transparent canvas
// ---------------------------------------------------------------------------
function buildBackboardTexture() {
  const W = 256, H = 152;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const sx = W / COURT.BACKBOARD_WIDTH, sy = H / COURT.BACKBOARD_HEIGHT;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  // outer border
  ctx.lineWidth = 0.05 * sx;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
  // shooter square: 0.61 x 0.457 m, bottom edge level with the rim
  const sqW = 0.61 * sx, sqH = 0.457 * sy;
  const rimAboveBottom = COURT.RIM_HEIGHT - COURT.BACKBOARD_BOTTOM; // 0.153
  const sqBottomY = H - rimAboveBottom * sy; // canvas y grows downward
  ctx.lineWidth = 0.05 * sx;
  ctx.strokeRect(W / 2 - sqW / 2, sqBottomY - sqH, sqW, sqH);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// LED ad strip canvas (tiles horizontally, we scroll texture.offset.x)
// ---------------------------------------------------------------------------
function buildAdTexture() {
  const W = 1024, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const panels = [
    { bg: '#0c1e4e', fg: '#ffd86b', text: 'FABLE AIR' },
    { bg: '#5a1020', fg: '#ffffff', text: 'ULTRA SPORT' },
    { bg: TEAMS[0].primary, fg: TEAMS[0].secondary, text: TEAMS[0].abbr + ' ★' },
    { bg: '#08331c', fg: '#eafff2', text: TEAMS[1].abbr + ' ★' },
  ];
  const pw = W / panels.length;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  panels.forEach((p, i) => {
    const x0 = i * pw;
    const grad = ctx.createLinearGradient(x0, 0, x0, H);
    grad.addColorStop(0, p.bg);
    grad.addColorStop(0.5, '#000000');
    grad.addColorStop(1, p.bg);
    ctx.fillStyle = p.bg; ctx.fillRect(x0, 0, pw, H);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x0, H * 0.62, pw, H * 0.38);
    ctx.fillStyle = p.fg;
    ctx.font = 'italic 900 52px "Arial Black", Arial, sans-serif';
    ctx.fillText(p.text, x0 + pw / 2, H / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(x0, 0, 3, H); // panel seam
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// NET — tapered diamond lattice as LineSegments with CPU sway (tiny vert count)
// ---------------------------------------------------------------------------
const NET_ROWS = 7, NET_COLS = 12, NET_LEN = 0.42;

function buildNet(cx, cy) {
  // vertices around local rim center (cx, cy, 0) — built for the east hoop
  const count = NET_ROWS * NET_COLS;
  const base = new Float32Array(count * 3);
  const radX = new Float32Array(count);
  const radZ = new Float32Array(count);
  const depth = new Float32Array(count);
  const phase = new Float32Array(count);
  const rTop = COURT.RIM_RADIUS - 0.006, rBot = 0.115;
  let v = 0;
  for (let i = 0; i < NET_ROWS; i++) {
    const d = i / (NET_ROWS - 1);
    const r = rTop + (rBot - rTop) * Math.pow(d, 0.85);
    const aOff = (i % 2) * (Math.PI / NET_COLS);
    for (let j = 0; j < NET_COLS; j++) {
      const a = (j / NET_COLS) * Math.PI * 2 + aOff;
      const rx = Math.cos(a), rz = Math.sin(a);
      base[v * 3] = cx + rx * r;
      base[v * 3 + 1] = cy - 0.02 - d * NET_LEN;
      base[v * 3 + 2] = rz * r;
      radX[v] = rx; radZ[v] = rz;
      depth[v] = d;
      phase[v] = j * 0.9 + i * 1.7;
      v++;
    }
  }
  const idx = [];
  for (let i = 0; i < NET_ROWS - 1; i++) {
    for (let j = 0; j < NET_COLS; j++) {
      const a = i * NET_COLS + j;
      idx.push(a, (i + 1) * NET_COLS + j);
      idx.push(a, (i + 1) * NET_COLS + ((j + 1) % NET_COLS));
    }
  }
  for (let j = 0; j < NET_COLS; j++) { // bottom ring
    const a = (NET_ROWS - 1) * NET_COLS + j;
    idx.push(a, (NET_ROWS - 1) * NET_COLS + ((j + 1) % NET_COLS));
  }
  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(base.slice(), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posAttr);
  geom.setIndex(idx);
  return {
    geom, base, radX, radZ, depth, phase,
    impT: 99, impAmp: 0, dirX: 0, dirZ: 0,
  };
}

function updateNet(net, time, excitement) {
  const arr = net.geom.attributes.position.array;
  const n = NET_ROWS * NET_COLS;
  net.impT += net._dt;
  const env = net.impAmp > 0.0005 ? net.impAmp * Math.exp(-net.impT * 3.1) : 0;
  const idleA = 0.005 + excitement * 0.004;
  for (let v = 0; v < n; v++) {
    const d = net.depth[v];
    const idle = idleA * d * Math.sin(time * 1.7 + net.phase[v]);
    let rad = 0, kx = 0, kz = 0;
    if (env > 0.0004) {
      rad = env * d * Math.sin(net.impT * 15 - d * 3.2);
      const push = env * 0.7 * d * Math.sin(net.impT * 12 + 0.6);
      kx = net.dirX * push;
      kz = net.dirZ * push;
    }
    const off = idle + rad;
    arr[v * 3] = net.base[v * 3] + net.radX[v] * off + kx;
    arr[v * 3 + 1] = net.base[v * 3 + 1] - Math.abs(rad) * 0.35;
    arr[v * 3 + 2] = net.base[v * 3 + 2] + net.radZ[v] * off + kz;
  }
  net.geom.attributes.position.needsUpdate = true;
}

// ===========================================================================
// createArena
// ===========================================================================
export function createArena(scene, renderer) {
  const group = new THREE.Group();
  group.name = 'arena';
  scene.add(group);

  const home = TEAMS[0], away = TEAMS[1];
  const rand = mulberry32(4242);

  // -------------------------------------------------------------------------
  // 1. FLOOR
  // -------------------------------------------------------------------------
  const floorTex = buildFloorTexture(renderer);
  const floorMat = new THREE.MeshPhysicalMaterial({
    map: floorTex,
    roughness: 0.35,
    metalness: 0.0,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.LENGTH, COURT.WIDTH), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // painted apron ring around the court, then a big dark base slab
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.LENGTH + 5.2, COURT.WIDTH + 4.6),
    new THREE.MeshStandardMaterial({ color: 0x1a1030, roughness: 0.85 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  apron.receiveShadow = true;
  group.add(apron);

  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(72, 60),
    new THREE.MeshStandardMaterial({ color: 0x0b0d13, roughness: 0.95 }));
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = -0.05;
  slab.receiveShadow = true;
  group.add(slab);

  // -------------------------------------------------------------------------
  // 2. HOOPS (built at east coordinates; west copy rotated PI about Y)
  // -------------------------------------------------------------------------
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.45, metalness: 0.8 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xf25c19, roughness: 0.38, metalness: 0.65 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 0.28,
    roughness: 0.06, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false,
  });
  const netMat = new THREE.LineBasicMaterial({ color: 0xf7f7f7, transparent: true, opacity: 0.85 });
  const boardTex = buildBackboardTexture();
  const decalMat = new THREE.MeshBasicMaterial({
    map: boardTex, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });

  const rimGeom = new THREE.TorusGeometry(COURT.RIM_RADIUS + COURT.RIM_TUBE, COURT.RIM_TUBE, 10, 40);
  rimGeom.rotateX(Math.PI / 2);
  const boardGeom = new THREE.BoxGeometry(0.05, COURT.BACKBOARD_HEIGHT, COURT.BACKBOARD_WIDTH);
  const decalGeom = new THREE.PlaneGeometry(COURT.BACKBOARD_WIDTH, COURT.BACKBOARD_HEIGHT);
  decalGeom.rotateY(-Math.PI / 2); // face -x (toward mid-court on the east side)

  const boardCY = COURT.BACKBOARD_BOTTOM + COURT.BACKBOARD_HEIGHT / 2;

  const nets = [];
  const hoops = [];

  function buildHoop(index) {
    const hg = new THREE.Group();
    const rim = new THREE.Mesh(rimGeom, rimMat);
    rim.position.set(COURT.HOOP_X, COURT.RIM_HEIGHT, 0);
    rim.castShadow = true;
    hg.add(rim);

    // bracket rim -> board
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.11), steelMat);
    bracket.position.set((COURT.HOOP_X + COURT.RIM_RADIUS * 0.4 + COURT.BACKBOARD_X) / 2, COURT.RIM_HEIGHT - 0.055, 0);
    bracket.castShadow = true;
    hg.add(bracket);

    // backboard glass + decal
    const board = new THREE.Mesh(boardGeom, glassMat);
    board.position.set(COURT.BACKBOARD_X + 0.025, boardCY, 0);
    hg.add(board);
    const decal = new THREE.Mesh(decalGeom, decalMat);
    decal.position.set(COURT.BACKBOARD_X - 0.003, boardCY, 0);
    hg.add(decal);

    // bottom safety pad on the board
    const boardPad = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.1, COURT.BACKBOARD_WIDTH * 0.96), padMat);
    boardPad.position.set(COURT.BACKBOARD_X + 0.02, COURT.BACKBOARD_BOTTOM - 0.04, 0);
    hg.add(boardPad);

    // stanchion: padded base behind the baseline, post, angled arm
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.95, 1.7), padMat);
    base.position.set(COURT.HALF_LENGTH + 1.75, 0.475, 0);
    base.castShadow = true;
    hg.add(base);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.8, 0.26), padMat);
    post.position.set(COURT.HALF_LENGTH + 1.75, 1.7, 0);
    post.castShadow = true;
    hg.add(post);
    // angled arm from post top to behind the backboard
    const p0x = COURT.HALF_LENGTH + 1.75, p0y = 2.6;
    const p1x = COURT.BACKBOARD_X + 0.28, p1y = boardCY - 0.05;
    const armLen = Math.hypot(p1x - p0x, p1y - p0y);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.15, 0.15), steelMat);
    arm.position.set((p0x + p1x) / 2, (p0y + p1y) / 2, 0);
    arm.rotation.z = Math.atan2(p1y - p0y, p1x - p0x);
    arm.castShadow = true;
    hg.add(arm);
    // rear board mount
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 0.5), steelMat);
    mount.position.set(COURT.BACKBOARD_X + 0.18, boardCY, 0);
    hg.add(mount);

    // net
    const net = buildNet(COURT.HOOP_X, COURT.RIM_HEIGHT);
    net._dt = 0;
    const netLines = new THREE.LineSegments(net.geom, netMat);
    netLines.frustumCulled = false;
    hg.add(netLines);
    nets.push(net);

    const sign = index === 0 ? -1 : 1;
    if (index === 0) hg.rotation.y = Math.PI; // mirror to the west end
    group.add(hg);

    const rimCenter = new THREE.Vector3(sign * COURT.HOOP_X, COURT.RIM_HEIGHT, 0);
    return {
      index,
      rimCenter,
      netImpulse(velocity) {
        if (!velocity) { net.impAmp = 0.05; net.impT = 0; return; }
        const vx = Number.isFinite(velocity.x) ? velocity.x : 0;
        const vy = Number.isFinite(velocity.y) ? velocity.y : 0;
        const vz = Number.isFinite(velocity.z) ? velocity.z : 0;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        net.impAmp = Math.min(0.12, 0.02 + speed * 0.011);
        net.impT = 0;
        // transform world horizontal direction into hoop-local space
        const s = sign > 0 ? 1 : -1;
        const hl = Math.hypot(vx, vz);
        if (hl > 1e-4) { net.dirX = (vx / hl) * s; net.dirZ = (vz / hl) * s; }
        else { net.dirX = 0; net.dirZ = 0; }
      },
    };
  }
  hoops.push(buildHoop(0), buildHoop(1));

  // -------------------------------------------------------------------------
  // 3. SCORER'S TABLE, AD BOARDS, BENCHES
  // -------------------------------------------------------------------------
  const adTex = buildAdTexture();
  const adMat = new THREE.MeshBasicMaterial({ map: adTex });
  adMat.color.setScalar(0.85); // slightly dimmed LED so it doesn't blow out
  const adBackMat = new THREE.MeshStandardMaterial({ color: 0x0c0e14, roughness: 0.9 });

  function addAdBoard(w, h, x, y, z, rotY) {
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.18), adBackMat);
    back.position.set(x, y, z);
    back.rotation.y = rotY;
    back.castShadow = true;
    group.add(back);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h * 0.86), adMat);
    face.position.set(
      x + Math.sin(rotY) * 0.095, y, z + Math.cos(rotY) * 0.095);
    face.rotation.y = rotY;
    group.add(face);
  }

  // scorer's table on the -z sideline (opposite the broadcast camera)
  addAdBoard(9.2, 0.82, 0, 0.41, -(COURT.HALF_WIDTH + 1.05), 0);
  // flanking sideline boards
  addAdBoard(6.4, 0.82, -11.4, 0.41, -(COURT.HALF_WIDTH + 1.05), 0);
  addAdBoard(6.4, 0.82, 11.4, 0.41, -(COURT.HALF_WIDTH + 1.05), 0);
  // baseline boards behind each hoop
  addAdBoard(11.5, 0.82, -(COURT.HALF_LENGTH + 2.9), 0.41, 0, Math.PI / 2);
  addAdBoard(11.5, 0.82, COURT.HALF_LENGTH + 2.9, 0.41, 0, -Math.PI / 2);

  // benches (simple slabs; seated figures are added to the crowd instancing)
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x20242e, roughness: 0.8 });
  const benchGeom = new THREE.BoxGeometry(3.6, 0.45, 0.55);
  for (const bx of [-7.6, 7.6]) {
    const bench = new THREE.Mesh(benchGeom, benchMat);
    bench.position.set(bx, 0.225, -(COURT.HALF_WIDTH + 1.9));
    bench.castShadow = true;
    bench.receiveShadow = true;
    group.add(bench);
  }

  // -------------------------------------------------------------------------
  // 4. STANDS + CROWD
  // -------------------------------------------------------------------------
  const ROWS = 15, TREAD = 0.98, RISER = 0.52;
  const SIDE_D0 = 10.9;   // first row distance from center (sidelines, |z|)
  const BASE_D0 = 16.6;   // first row distance (baselines, |x|)

  // stepped bowls: one InstancedMesh of unit boxes
  const stepMat = new THREE.MeshStandardMaterial({ color: 0x121520, roughness: 0.95 });
  const stepGeom = new THREE.BoxGeometry(1, 1, 1);
  const steps = new THREE.InstancedMesh(stepGeom, stepMat, ROWS * 4);
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _qSide = new THREE.Quaternion();
  const _qBase = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  let si = 0;
  for (let r = 0; r < ROWS; r++) {
    const topY = 0.85 + r * RISER;
    const d = SIDE_D0 + r * TREAD;
    for (const zs of [-1, 1]) { // sidelines
      _p.set(0, topY / 2, zs * (d + TREAD / 2));
      _s.set(34, topY, TREAD);
      _m.compose(_p, _qSide.identity(), _s);
      steps.setMatrixAt(si++, _m);
    }
    const db = BASE_D0 + r * TREAD;
    for (const xs of [-1, 1]) { // baselines
      _p.set(xs * (db + TREAD / 2), topY / 2, 0);
      _s.set(21.5, topY, TREAD);
      _m.compose(_p, _qBase, _s);
      steps.setMatrixAt(si++, _m);
    }
  }
  steps.instanceMatrix.needsUpdate = true;
  steps.frustumCulled = false;
  group.add(steps);

  // --- crowd figure: merged low-poly torso + head ---
  const torso = new THREE.BoxGeometry(0.37, 0.52, 0.25);
  torso.translate(0, 0.3, 0);
  const head = new THREE.SphereGeometry(0.105, 6, 5);
  head.translate(0, 0.68, 0);
  const figureGeom = mergeGeometries([torso, head]);
  torso.dispose(); head.dispose();

  // seat placement list
  const seats = []; // { x, y, z, rotY, scale, color }
  const _c = new THREE.Color();
  const neutralPalette = [0x2b2f3a, 0x454a58, 0x6b6f7a, 0x8d8f96, 0x3a3f52,
    0x5a4632, 0x22303f, 0x74655a, 0x9aa0ac, 0x323844];
  function pickColor() {
    const t = rand();
    if (t < 0.16) _c.set(home.primary);
    else if (t < 0.28) _c.set(home.secondary);
    else if (t < 0.38) _c.set(away.primary);
    else if (t < 0.44) _c.set(away.secondary);
    else _c.setHex(neutralPalette[(rand() * neutralPalette.length) | 0]);
    // shading noise
    const v = 0.75 + rand() * 0.45;
    _c.r = Math.min(1, _c.r * v); _c.g = Math.min(1, _c.g * v); _c.b = Math.min(1, _c.b * v);
    return _c;
  }
  function addSeat(x, y, z) {
    if (rand() < 0.085) return; // some empty seats
    seats.push({
      x: x + (rand() - 0.5) * 0.12,
      y, z: z + (rand() - 0.5) * 0.1,
      rotY: Math.atan2(-x, -z) + (rand() - 0.5) * 0.35,
      scale: 0.86 + rand() * 0.26,
      color: pickColor().getHex(),
    });
  }
  const PITCH = 0.56;
  for (let r = 0; r < ROWS; r++) {
    const topY = 0.85 + r * RISER;
    const dz = SIDE_D0 + r * TREAD + TREAD * 0.55;
    const nSide = Math.floor(33 / PITCH);
    for (let k = 0; k < nSide; k++) {
      const x = -16.5 + (k + 0.5) * PITCH;
      addSeat(x, topY, dz);
      addSeat(x, topY, -dz);
    }
    const dx = BASE_D0 + r * TREAD + TREAD * 0.55;
    const nBase = Math.floor(20.5 / PITCH);
    for (let k = 0; k < nBase; k++) {
      const z = -10.25 + (k + 0.5) * PITCH;
      addSeat(dx, topY, z);
      addSeat(-dx, topY, z);
    }
  }
  // bench players join the crowd instancing (team colors, floor level)
  for (const side of [0, 1]) {
    const team = TEAMS[side];
    for (let k = 0; k < 5; k++) {
      const x = (side === 0 ? -1 : 1) * (6.2 + k * 0.72);
      seats.push({
        x, y: 0.42, z: -(COURT.HALF_WIDTH + 1.9),
        rotY: 0, scale: 1.05,
        color: new THREE.Color(team.jersey).getHex(),
      });
    }
  }

  const crowdCount = seats.length;
  const crowdUniforms = {
    uTime: { value: 0 },
    uExcite: { value: 0 },
  };
  const crowdMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  crowdMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = crowdUniforms.uTime;
    shader.uniforms.uExcite = crowdUniforms.uExcite;
    shader.vertexShader =
      'uniform float uTime;\nuniform float uExcite;\n' +
      'attribute float aPhase;\nattribute float aWave;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float bob = sin(uTime * (2.0 + uExcite * 3.5) + aPhase) * (0.015 + uExcite * 0.05);
          float standT = smoothstep(0.7, 0.95, uExcite);
          float wave = sin(uTime * 2.4 - aWave * 2.0 + aPhase * 0.15);
          wave = max(wave, 0.0); wave = wave * wave * wave;
          transformed.y += bob + standT * wave * 0.3;
        }`);
  };
  const crowd = new THREE.InstancedMesh(figureGeom, crowdMat, crowdCount);
  const phaseArr = new Float32Array(crowdCount);
  const waveArr = new Float32Array(crowdCount);
  for (let i = 0; i < crowdCount; i++) {
    const st = seats[i];
    _p.set(st.x, st.y, st.z);
    _q.setFromAxisAngle(_s.set(0, 1, 0), st.rotY);
    _m.compose(_p, _q, _s.set(st.scale, st.scale, st.scale));
    crowd.setMatrixAt(i, _m);
    crowd.setColorAt(i, _c.setHex(st.color));
    phaseArr[i] = rand() * Math.PI * 2;
    waveArr[i] = Math.atan2(st.z, st.x);
  }
  figureGeom.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phaseArr, 1));
  figureGeom.setAttribute('aWave', new THREE.InstancedBufferAttribute(waveArr, 1));
  crowd.instanceMatrix.needsUpdate = true;
  if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
  crowd.frustumCulled = false;
  group.add(crowd);

  // -------------------------------------------------------------------------
  // 5. ARENA SHELL + TRUSS + FIXTURES
  // -------------------------------------------------------------------------
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(92, 26, 80),
    new THREE.MeshStandardMaterial({ color: 0x090c13, roughness: 1, side: THREE.BackSide }));
  shell.position.y = 12.4;
  group.add(shell);

  // truss grid
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x232833, roughness: 0.6, metalness: 0.5 });
  const trussGeom = new THREE.BoxGeometry(1, 1, 1);
  const trussSpans = [];
  for (const z of [-9, 0, 9]) trussSpans.push({ p: [0, 16.2, z], s: [46, 0.42, 0.42] });
  for (const x of [-18, -9, 0, 9, 18]) trussSpans.push({ p: [x, 16.2, 0], s: [0.42, 0.42, 26] });
  const truss = new THREE.InstancedMesh(trussGeom, trussMat, trussSpans.length);
  trussSpans.forEach((t, i) => {
    _p.set(t.p[0], t.p[1], t.p[2]);
    _m.compose(_p, _qSide.identity(), _s.set(t.s[0], t.s[1], t.s[2]));
    truss.setMatrixAt(i, _m);
  });
  truss.instanceMatrix.needsUpdate = true;
  truss.frustumCulled = false;
  group.add(truss);

  // spotlight fixtures: dark housings + emissive lenses (visual only)
  const fixturePos = [];
  for (const x of [-13.5, -4.5, 4.5, 13.5]) for (const z of [-9, 9]) fixturePos.push([x, z]);
  for (const x of [-9, 9]) fixturePos.push([x, 0]);
  const housingGeom = new THREE.ConeGeometry(0.34, 0.55, 10);
  housingGeom.rotateX(Math.PI); // point down
  const housings = new THREE.InstancedMesh(housingGeom, padMat, fixturePos.length);
  const lensGeom = new THREE.CircleGeometry(0.24, 10);
  lensGeom.rotateX(-Math.PI / 2);
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xfff0d0 });
  const lenses = new THREE.InstancedMesh(lensGeom, lensMat, fixturePos.length);
  fixturePos.forEach((f, i) => {
    _p.set(f[0], 15.75, f[1]);
    _m.compose(_p, _qSide.identity(), _s.set(1, 1, 1));
    housings.setMatrixAt(i, _m);
    _p.y = 15.46;
    _m.setPosition(_p);
    lenses.setMatrixAt(i, _m);
  });
  housings.instanceMatrix.needsUpdate = true;
  lenses.instanceMatrix.needsUpdate = true;
  housings.frustumCulled = false;
  lenses.frustumCulled = false;
  group.add(housings, lenses);

  // -------------------------------------------------------------------------
  // 6. JUMBOTRON (center-hung, 4 identical canvas screens)
  // -------------------------------------------------------------------------
  const jumbo = new THREE.Group();
  jumbo.position.set(0, 11, 0);
  const jumboCanvas = document.createElement('canvas');
  jumboCanvas.width = 512; jumboCanvas.height = 288;
  const jumboCtx = jumboCanvas.getContext('2d');
  const jumboTex = new THREE.CanvasTexture(jumboCanvas);
  jumboTex.colorSpace = THREE.SRGBColorSpace;
  const jumboState = { home: null, away: null, quarter: null, clock: null };

  function renderJumbotron() {
    const c = jumboCtx, W = 512, H = 288;
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0a1226'); grad.addColorStop(1, '#040610');
    c.fillStyle = grad; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#2b3c6e'; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    // branding
    c.font = 'italic 900 26px "Arial Black", Arial, sans-serif';
    c.fillStyle = '#ffd86b';
    c.fillText('FABLEULTRA', W / 2, 32);
    // team abbrs
    c.font = '900 44px "Arial Black", Arial, sans-serif';
    c.fillStyle = home.secondary;
    c.fillText(home.abbr, 92, 108);
    c.fillStyle = '#ffffff';
    c.fillText(away.abbr, W - 92, 108);
    // scores
    const hs = jumboState.home == null ? 0 : jumboState.home;
    const as = jumboState.away == null ? 0 : jumboState.away;
    c.font = '900 72px "Arial Black", Arial, sans-serif';
    c.fillStyle = '#f6ff8a';
    c.fillText(String(hs), 92, 182);
    c.fillText(String(as), W - 92, 182);
    // clock + quarter
    c.fillStyle = '#101a35';
    c.fillRect(W / 2 - 88, 76, 176, 120);
    c.strokeStyle = '#31457c'; c.lineWidth = 3;
    c.strokeRect(W / 2 - 88, 76, 176, 120);
    c.font = '900 52px "Arial Black", Arial, sans-serif';
    c.fillStyle = '#ff5a3c';
    c.fillText(jumboState.clock == null ? '0:00' : String(jumboState.clock), W / 2, 122);
    c.font = '900 34px "Arial Black", Arial, sans-serif';
    c.fillStyle = '#9fb4ff';
    const q = jumboState.quarter;
    c.fillText(q == null ? 'Q1' : (typeof q === 'number' ? (q <= 4 ? 'Q' + q : 'OT') : String(q)), W / 2, 170);
    // city names
    c.font = '700 18px Arial, sans-serif';
    c.fillStyle = '#8892aa';
    c.fillText(home.city.toUpperCase(), 92, 238);
    c.fillText(away.city.toUpperCase(), W - 92, 238);
    jumboTex.needsUpdate = true;
  }
  renderJumbotron();

  const jumboBody = new THREE.Mesh(
    new THREE.BoxGeometry(3.7, 2.5, 3.7),
    new THREE.MeshStandardMaterial({ color: 0x11141c, roughness: 0.7, metalness: 0.4 }));
  jumbo.add(jumboBody);
  const screenMat = new THREE.MeshBasicMaterial({ map: jumboTex });
  const screenGeom = new THREE.PlaneGeometry(3.45, 2.0);
  for (let k = 0; k < 4; k++) {
    const scr = new THREE.Mesh(screenGeom, screenMat);
    const a = k * Math.PI / 2;
    scr.position.set(Math.sin(a) * 1.87, 0.02, Math.cos(a) * 1.87);
    scr.rotation.y = a;
    jumbo.add(scr);
  }
  // LED ring trim + cap
  const ring = new THREE.Mesh(
    new THREE.BoxGeometry(3.85, 0.16, 3.85),
    new THREE.MeshBasicMaterial({ color: 0x4468ff }));
  ring.position.y = -1.28;
  jumbo.add(ring);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 2.6), padMat);
  cap.position.y = 1.5;
  jumbo.add(cap);
  // hanging cables to the truss
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x1a1d26, roughness: 0.8 });
  const cableGeom = new THREE.CylinderGeometry(0.025, 0.025, 1, 5);
  for (const cx of [-1, 1]) for (const cz of [-1, 1]) {
    const cable = new THREE.Mesh(cableGeom, cableMat);
    const topY = 16.2 - 11, botY = 1.7; // local to jumbo group
    cable.scale.y = topY - botY;
    cable.position.set(cx * 1.1, (topY + botY) / 2, cz * 1.1);
    jumbo.add(cable);
  }
  group.add(jumbo);

  // -------------------------------------------------------------------------
  // 7. LIGHTING — bright court, moody crowd
  // -------------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0x7d8fc8, 0x8a5c34, 0.35);
  group.add(hemi);

  function makeKeySpot(x) {
    const spot = new THREE.SpotLight(0xfff3e0, 60, 45, 0.56, 0.48, 1);
    spot.position.set(x, 15.4, 1.6);
    spot.target.position.set(x, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(2048, 2048);
    spot.shadow.camera.near = 5;
    spot.shadow.camera.far = 26;
    spot.shadow.bias = -0.0004;
    group.add(spot, spot.target);
    return spot;
  }
  makeKeySpot(-7.2);
  makeKeySpot(7.2);

  // non-shadow fills
  function makeFill(x, z, intensity, angle) {
    const fill = new THREE.SpotLight(0xf4ecff, intensity, 50, angle, 0.8, 1);
    fill.position.set(x, 14.5, z);
    fill.target.position.set(x * 0.4, 0, z * 0.25);
    group.add(fill, fill.target);
  }
  makeFill(0, 7, 22, 0.85);
  makeFill(0, -7, 18, 0.85);
  makeFill(0, 0, 14, 0.9);

  // blue-ish crowd glow
  const crowdLightPos = [[0, 8.5, 16.5], [0, 8.5, -16.5], [21, 8.5, 0], [-21, 8.5, 0]];
  for (const p of crowdLightPos) {
    const pl = new THREE.PointLight(0x3d5aa8, 14, 30, 1);
    pl.position.set(p[0], p[1], p[2]);
    group.add(pl);
  }

  // -------------------------------------------------------------------------
  // runtime
  // -------------------------------------------------------------------------
  let tAcc = 0;
  let exciteSmooth = 0.25;

  function update(dt, excitement) {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    let ex = Number.isFinite(excitement) ? excitement : 0;
    if (ex < 0) ex = 0; else if (ex > 1) ex = 1;

    tAcc += dt;
    exciteSmooth += (ex - exciteSmooth) * Math.min(1, dt * 3);

    crowdUniforms.uTime.value = tAcc;
    crowdUniforms.uExcite.value = exciteSmooth;

    for (let i = 0; i < nets.length; i++) {
      nets[i]._dt = dt;
      updateNet(nets[i], tAcc, exciteSmooth);
    }

    // LED ticker crawl
    adTex.offset.x = (adTex.offset.x + dt * 0.022) % 1;
  }

  function setJumbotron(state) {
    if (!state) return;
    const h = state.home, a = state.away, q = state.quarter, c = state.clock;
    if (h === jumboState.home && a === jumboState.away &&
        q === jumboState.quarter && c === jumboState.clock) return;
    jumboState.home = h;
    jumboState.away = a;
    jumboState.quarter = q;
    jumboState.clock = c;
    renderJumbotron();
  }

  return { group, hoops, update, setJumbotron };
}
