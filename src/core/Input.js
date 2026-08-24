// Keyboard + mouse + pointer-lock input with raw-delta mouse look.
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressed = new Set();     // edge-triggered this frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, wheel: 0 };
    this.locked = false;
    this.enabled = true;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Tab', 'Space', 'KeyR'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onMove = (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
    };
    this._onUp = (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    };
    this._onWheel = (e) => { this.mouse.wheel += Math.sign(e.deltaY); };
    this._onLock = () => { this.locked = document.pointerLockElement === this.dom; };
    this._onCtx = (e) => e.preventDefault();

    addEventListener('keydown', this._onKeyDown);
    addEventListener('keyup', this._onKeyUp);
    addEventListener('mousemove', this._onMove);
    addEventListener('mousedown', this._onDown);
    addEventListener('mouseup', this._onUp);
    addEventListener('wheel', this._onWheel, { passive: true });
    document.addEventListener('pointerlockchange', this._onLock);
    this.dom.addEventListener('contextmenu', this._onCtx);
    this.dom.addEventListener('click', () => { if (!this.locked) this.dom.requestPointerLock?.(); });
  }
  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  // Consume per-frame accumulators. Called by Engine at END of frame.
  endFrame() { this.pressed.clear(); this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0; }
  dispose() {
    removeEventListener('keydown', this._onKeyDown);
    removeEventListener('keyup', this._onKeyUp);
    removeEventListener('mousemove', this._onMove);
    removeEventListener('mousedown', this._onDown);
    removeEventListener('mouseup', this._onUp);
    document.removeEventListener('pointerlockchange', this._onLock);
  }
}
