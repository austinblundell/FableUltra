// ============================================================================
// controls.js — keyboard input with per-frame edge detection.
//
// Usage: const controls = new Controls(window);
//        each frame: controls.update(); then read controls.state.
//
// Edge flags (shootPressed, shootReleased, passPressed, stealPressed,
// switchPressed, pausePressed, anyPressed) are true for exactly ONE update()
// cycle. Down/up events are buffered in Sets between updates so a quick tap
// that begins and ends between two frames is never lost.
// ============================================================================

// codes whose default browser behavior must be suppressed (scroll, tab focus)
const PREVENT_CODES = new Set([
  'Space', 'Tab', 'Enter',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);

export class Controls {
  constructor(target) {
    this.state = {
      moveX: 0, moveZ: 0,
      sprint: false,
      shootHeld: false, shootPressed: false, shootReleased: false,
      passPressed: false, stealPressed: false,
      switchPressed: false, pausePressed: false,
      anyPressed: false,
    };

    // Keys currently held (by e.code).
    this._down = new Set();
    // Down/up edges buffered since the last update().
    this._pressedBuffer = new Set();
    this._releasedBuffer = new Set();

    this._onKeyDown = (e) => {
      if (PREVENT_CODES.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._down.add(e.code);
      this._pressedBuffer.add(e.code);
    };
    this._onKeyUp = (e) => {
      if (PREVENT_CODES.has(e.code)) e.preventDefault();
      this._down.delete(e.code);
      this._releasedBuffer.add(e.code);
    };
    this._onBlur = () => {
      // Clear everything so no key sticks when focus is lost mid-hold.
      this._down.clear();
      this._pressedBuffer.clear();
      this._releasedBuffer.clear();
      const s = this.state;
      s.moveX = 0; s.moveZ = 0;
      s.sprint = false;
      s.shootHeld = false; s.shootPressed = false; s.shootReleased = false;
      s.passPressed = false; s.stealPressed = false;
      s.switchPressed = false; s.pausePressed = false;
      s.anyPressed = false;
    };

    if (target && target.addEventListener) {
      target.addEventListener('keydown', this._onKeyDown);
      target.addEventListener('keyup', this._onKeyUp);
      target.addEventListener('blur', this._onBlur);
    }
    this._target = target;
  }

  update() {
    const s = this.state;
    const down = this._down;
    const pressed = this._pressedBuffer;
    const released = this._releasedBuffer;

    // --- movement axes: raw -1/0/+1 per axis --------------------------------
    let moveX = 0, moveZ = 0;
    if (down.has('KeyA') || down.has('ArrowLeft')) moveX -= 1;
    if (down.has('KeyD') || down.has('ArrowRight')) moveX += 1;
    if (down.has('KeyW') || down.has('ArrowUp')) moveZ -= 1;
    if (down.has('KeyS') || down.has('ArrowDown')) moveZ += 1;
    s.moveX = moveX;
    s.moveZ = moveZ;

    s.sprint = down.has('ShiftLeft') || down.has('ShiftRight');

    // --- shoot: held + edges -------------------------------------------------
    // shootHeld is true if Space is down now, OR was tapped entirely between
    // frames (present in the pressed buffer) so a fast tap still registers.
    s.shootPressed = pressed.has('Space');
    s.shootReleased = released.has('Space');
    s.shootHeld = down.has('Space') || s.shootPressed;

    // --- action edges ---------------------------------------------------------
    s.passPressed = pressed.has('KeyE') || pressed.has('Enter');
    s.stealPressed = pressed.has('KeyQ');
    s.switchPressed = pressed.has('Tab') || pressed.has('KeyC');
    s.pausePressed = pressed.has('Escape') || pressed.has('KeyP');

    s.anyPressed = pressed.size > 0;

    // Edge buffers consumed — flags stay true until the start of next update.
    pressed.clear();
    released.clear();
  }

  dispose() {
    const t = this._target;
    if (t && t.removeEventListener) {
      t.removeEventListener('keydown', this._onKeyDown);
      t.removeEventListener('keyup', this._onKeyUp);
      t.removeEventListener('blur', this._onBlur);
    }
  }
}
