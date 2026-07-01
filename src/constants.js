// ============================================================================
// constants.js — single source of truth for court geometry, physics, rules,
// and team data. All dimensions in meters, matching real NBA specifications.
//
// Coordinate system (shared by every module):
//   x — along the court length  (-14.325 … +14.325), east/west
//   z — along the court width   (-7.62  … +7.62), the broadcast camera sits
//       on the +z sideline looking toward -z
//   y — up, floor at y = 0
//
// Hoop 0 is at x = -HOOP_X (west), hoop 1 at x = +HOOP_X (east).
// The HOME (user) team attacks hoop 1; AWAY attacks hoop 0.
// ============================================================================

export const COURT = {
  LENGTH: 28.65,
  WIDTH: 15.24,
  HALF_LENGTH: 14.325,
  HALF_WIDTH: 7.62,

  RIM_HEIGHT: 3.048,
  RIM_RADIUS: 0.2286,   // inner radius of the rim
  RIM_TUBE: 0.019,      // rim tube radius

  BACKBOARD_WIDTH: 1.829,
  BACKBOARD_HEIGHT: 1.067,
  BACKBOARD_BOTTOM: 2.895,  // height of the bottom edge of the backboard
  BACKBOARD_X: 13.105,      // |x| of the backboard front face (faces mid-court)

  HOOP_X: 12.726,           // |x| of rim center

  // Three point line: 7.24 m arc, straight lines 0.914 m in from each
  // sideline (|z| = 6.706) in the corners. The arc meets the straight
  // segment at |x| = HOOP_X - 2.729 (~4.33 m from the baseline).
  THREE_PT_RADIUS: 7.24,
  THREE_PT_CORNER_Z: 6.706,
  THREE_PT_BREAK_DX: 2.729,

  KEY_WIDTH: 4.88,
  FT_LINE_FROM_BASELINE: 5.79,
  FT_CIRCLE_R: 1.8,
  CENTER_CIRCLE_R: 1.8,
  RESTRICTED_R: 1.22,
};

// True if a shot released from (x, z) at the hoop with rim-center x = hoopX
// (signed, ±COURT.HOOP_X) is worth three points.
export function isThreePointer(x, z, hoopX) {
  const sign = Math.sign(hoopX);
  const breakX = Math.abs(hoopX) - COURT.THREE_PT_BREAK_DX;
  if (x * sign >= breakX) {
    return Math.abs(z) >= COURT.THREE_PT_CORNER_Z;
  }
  const dx = x - hoopX;
  return Math.hypot(dx, z) >= COURT.THREE_PT_RADIUS;
}

export const PHYSICS = {
  GRAVITY: 9.81,
  BALL_RADIUS: 0.12,
  BALL_MASS: 0.62,
  FLOOR_RESTITUTION: 0.78,
  RIM_RESTITUTION: 0.55,
  BACKBOARD_RESTITUTION: 0.62,
  AIR_DRAG: 0.012,          // simple linear drag coefficient
};

export const PLAYER = {
  RADIUS: 0.38,             // horizontal collision radius
  RUN_SPEED: 4.7,
  SPRINT_SPEED: 6.9,
  DRIBBLE_SPEED: 4.3,
  DRIBBLE_SPRINT_SPEED: 6.2,
  DEFENSE_SPEED: 4.4,
  AI_SPEED_SCALE: 0.94,     // AI players are slightly slower than user input
  ACCEL: 22,
  FRICTION: 14,
  PASS_SPEED: 14,
  STEAL_RANGE: 1.35,
  BLOCK_RANGE: 1.7,
  CATCH_RADIUS: 0.95,
};

export const RULES = {
  SHOT_CLOCK: 24,
  QUARTERS: 4,
  DEFAULT_QUARTER_MINUTES: 3,
  OVERTIME_MINUTES: 1,
  INBOUND_PAUSE: 1.6,       // seconds of dead time after a made basket
};

export const DIFFICULTY = {
  rookie:  { aiShotSkill: 0.72, aiReaction: 0.55, aiAggression: 0.5,  userShotBonus: 0.12 },
  pro:     { aiShotSkill: 0.88, aiReaction: 0.75, aiAggression: 0.7,  userShotBonus: 0.05 },
  allstar: { aiShotSkill: 1.0,  aiReaction: 0.95, aiAggression: 0.88, userShotBonus: 0.0  },
};

// Attributes are 0..1 scales.
export const TEAMS = [
  {
    name: 'Los Angeles', abbr: 'LAC', city: 'Los Angeles',
    primary: '#552583', secondary: '#FDB927',
    jersey: '#FDB927', jerseyTrim: '#552583', shorts: '#FDB927', shortsTrim: '#552583',
    players: [
      { name: 'D. Carter',   number: 3,  role: 'PG', height: 1.88, skin: '#8d5524', speed: 0.95, three: 0.85, mid: 0.80, finishing: 0.78, defense: 0.70, rebound: 0.40 },
      { name: 'T. Brooks',   number: 8,  role: 'SG', height: 1.96, skin: '#c68642', speed: 0.86, three: 0.90, mid: 0.85, finishing: 0.74, defense: 0.72, rebound: 0.48 },
      { name: 'M. Sterling', number: 23, role: 'SF', height: 2.03, skin: '#6b4423', speed: 0.84, three: 0.78, mid: 0.82, finishing: 0.90, defense: 0.82, rebound: 0.65 },
      { name: 'A. Okafor',   number: 35, role: 'PF', height: 2.08, skin: '#4a2c17', speed: 0.72, three: 0.55, mid: 0.72, finishing: 0.85, defense: 0.85, rebound: 0.85 },
      { name: 'V. Petrov',   number: 17, role: 'C',  height: 2.13, skin: '#e8beac', speed: 0.62, three: 0.35, mid: 0.62, finishing: 0.88, defense: 0.88, rebound: 0.95 },
    ],
  },
  {
    name: 'Boston', abbr: 'BOS', city: 'Boston',
    primary: '#007A33', secondary: '#FFFFFF',
    jersey: '#007A33', jerseyTrim: '#FFFFFF', shorts: '#007A33', shortsTrim: '#FFFFFF',
    players: [
      { name: 'J. Hayes',    number: 0,  role: 'PG', height: 1.85, skin: '#8d5524', speed: 0.96, three: 0.82, mid: 0.78, finishing: 0.75, defense: 0.75, rebound: 0.38 },
      { name: 'C. Walsh',    number: 11, role: 'SG', height: 1.93, skin: '#ffdbac', speed: 0.85, three: 0.92, mid: 0.86, finishing: 0.70, defense: 0.68, rebound: 0.45 },
      { name: 'L. Bennett',  number: 7,  role: 'SF', height: 2.01, skin: '#c68642', speed: 0.86, three: 0.84, mid: 0.85, finishing: 0.86, defense: 0.80, rebound: 0.62 },
      { name: 'R. Thompson', number: 42, role: 'PF', height: 2.06, skin: '#6b4423', speed: 0.70, three: 0.60, mid: 0.75, finishing: 0.82, defense: 0.86, rebound: 0.88 },
      { name: 'K. Mbeki',    number: 50, role: 'C',  height: 2.11, skin: '#4a2c17', speed: 0.60, three: 0.30, mid: 0.58, finishing: 0.90, defense: 0.90, rebound: 0.96 },
    ],
  },
];

export const CAMERA = {
  FOV: 42,
  SIDELINE_Z: 17.5,
  HEIGHT: 9.0,
  FOLLOW_CLAMP_X: 10.5,
  SMOOTHING: 3.2,
};
