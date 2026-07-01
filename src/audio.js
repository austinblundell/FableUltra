// ============================================================================
// audio.js — fully synthesized WebAudio engine. No audio files: everything is
// oscillators, filtered noise buffers, and envelope automation.
//
// Public API (see main.js header):
//   new AudioEngine()      — builds nothing AudioContext-dependent
//   .unlock()              — call from a user gesture; safe to call twice
//   .update(dt)            — eases crowd level toward excitement target
//   .setExcitement(0..1)   — crowd loudness/brightness target
//   .bounce(i) .rim() .backboard() .swish() .netSwish()
//   .buzzer() .whistle() .cheer(big) .groan() .squeak()
//
// All methods are safe no-ops before unlock() and never throw.
// ============================================================================

/* eslint-disable no-empty */

const NOISE_SECONDS = 3;         // shared noise buffer length
const SQUEAK_MIN_INTERVAL = 0.15; // seconds — rate limit sneaker squeaks

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.noiseBuffer = null;

    // Crowd bed nodes.
    this.crowdGain = null;
    this.crowdFilter = null;
    this.crowdSources = [];

    // Excitement smoothing.
    this.excitementTarget = 0.25;
    this.excitement = 0.25;

    // Slow "breathing" LFO state (updated in update(), not an OscillatorNode,
    // so we can shape it with random drift without extra graph nodes).
    this._lfoPhase = Math.random() * Math.PI * 2;
    this._lfoRate = 0.35;         // Hz-ish
    this._lfoDrift = 0;

    this._lastSqueakTime = -Infinity;
    this._unlocked = false;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  unlock() {
    if (this._unlocked && this.ctx) {
      // Already unlocked — just make sure the context is running (a second
      // user gesture is a legitimate place to resume a suspended context).
      try {
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {}
      return;
    }
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') this.ctx.resume();

      // Master chain: gain -> compressor -> destination.
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 5;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.22;
      this.master.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      this.noiseBuffer = this._buildNoiseBuffer();
      this._startCrowdBed();
      this._unlocked = true;
    } catch (e) {
      // Audio is a luxury; the game must run silently rather than crash.
      this.ctx = null;
      this._unlocked = false;
    }
  }

  // Pink-ish noise via octave-stacked random (Voss-McCartney style), stereo:
  // right channel is the same signal shifted a few ms for cheap width.
  _buildNoiseBuffer() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const ROWS = 7;
    const rows = new Float32Array(ROWS);
    for (let r = 0; r < ROWS; r++) rows[r] = Math.random() * 2 - 1;
    let counter = 0;
    for (let i = 0; i < len; i++) {
      counter++;
      // Update the row whose bit flipped (classic Voss trick).
      for (let r = 0; r < ROWS; r++) {
        if ((counter & ((1 << r) - 1)) === 0) rows[r] = Math.random() * 2 - 1;
      }
      let sum = 0;
      for (let r = 0; r < ROWS; r++) sum += rows[r];
      left[i] = (sum / ROWS) * 0.9 + (Math.random() * 2 - 1) * 0.08;
    }
    // Fade the seam so the loop doesn't click.
    const fade = Math.min(2048, len >> 2);
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      left[i] *= g;
      left[len - 1 - i] *= g;
    }
    const shift = Math.floor(ctx.sampleRate * 0.011); // ~11ms interaural delay
    for (let i = 0; i < len; i++) right[i] = left[(i + shift) % len];
    return buffer;
  }

  _startCrowdBed() {
    const ctx = this.ctx;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'lowpass';
    this.crowdFilter.frequency.value = 700;
    this.crowdFilter.Q.value = 0.4;

    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.0;

    // Two loop instances started half a buffer apart, panned slightly, so the
    // texture never reads as a short loop.
    const pans = [-0.35, 0.35];
    for (let i = 0; i < 2; i++) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.playbackRate.value = i === 0 ? 1.0 : 0.93;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      if (pan) {
        pan.pan.value = pans[i];
        src.connect(g); g.connect(pan); pan.connect(this.crowdFilter);
      } else {
        src.connect(g); g.connect(this.crowdFilter);
      }
      src.start(ctx.currentTime, i * NOISE_SECONDS * 0.5);
      this.crowdSources.push(src);
    }
    this.crowdFilter.connect(this.crowdGain);
    this.crowdGain.connect(this.master);

    // Ease the bed in so unlock doesn't pop.
    const t = ctx.currentTime;
    this.crowdGain.gain.setValueAtTime(0.0001, t);
    this.crowdGain.gain.setTargetAtTime(this._crowdLevel(this.excitement), t, 0.8);
  }

  _crowdLevel(e) { return 0.05 + 0.30 * e; }
  _crowdCutoff(e) { return 400 + 1800 * e; }

  // --------------------------------------------------------------------------
  // Per-frame update
  // --------------------------------------------------------------------------

  setExcitement(e) {
    if (typeof e !== 'number' || !isFinite(e)) return;
    this.excitementTarget = e < 0 ? 0 : e > 1 ? 1 : e;
  }

  update(dt) {
    if (!this._unlocked || !this.ctx) return;
    if (typeof dt !== 'number' || !isFinite(dt) || dt <= 0) return;

    // Ease excitement toward target.
    const k = 1 - Math.exp(-2.2 * dt);
    this.excitement += (this.excitementTarget - this.excitement) * k;

    // Slow breathing LFO with drifting rate so it never feels metronomic.
    this._lfoDrift += (Math.random() - 0.5) * 0.4 * dt;
    if (this._lfoDrift > 0.15) this._lfoDrift = 0.15;
    if (this._lfoDrift < -0.15) this._lfoDrift = -0.15;
    this._lfoPhase += (this._lfoRate + this._lfoDrift) * dt * Math.PI * 2;
    if (this._lfoPhase > Math.PI * 2) this._lfoPhase -= Math.PI * 2;
    const breathe = 1 + Math.sin(this._lfoPhase) * (0.10 + 0.08 * this.excitement);

    try {
      const t = this.ctx.currentTime;
      const level = this._crowdLevel(this.excitement) * breathe;
      this.crowdGain.gain.setTargetAtTime(level, t, 0.25);
      this.crowdFilter.frequency.setTargetAtTime(this._crowdCutoff(this.excitement), t, 0.35);
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // Internal SFX plumbing
  // --------------------------------------------------------------------------

  _ready() { return this._unlocked && this.ctx && this.ctx.state !== 'closed'; }

  // A gain node routed to master whose source auto-disconnects on end.
  _voiceGain() {
    const g = this.ctx.createGain();
    g.connect(this.master);
    return g;
  }

  _cleanup(source, ...nodes) {
    source.onended = () => {
      try {
        source.disconnect();
        for (const n of nodes) n.disconnect();
      } catch (e) {}
    };
  }

  // Filtered noise burst. Returns nothing; fully self-cleaning.
  _noiseBurst({ type = 'bandpass', freqStart = 1000, freqEnd = null, q = 1,
                gain = 0.3, attack = 0.005, duration = 0.2, curve = 0.06,
                rate = 1 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = rate;
    src.loop = true;
    // Random start offset so repeated SFX don't sound identical.
    const offset = Math.random() * (NOISE_SECONDS - duration - 0.05);

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freqStart, t);
    if (freqEnd !== null && freqEnd !== freqStart) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + duration);
    }

    const g = this._voiceGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, curve);

    src.connect(filter);
    filter.connect(g);
    this._cleanup(src, filter, g);
    src.start(t, offset);
    src.stop(t + duration + 0.1);
  }

  // Enveloped oscillator. freqEnd lets us pitch-bend.
  _tone({ type = 'sine', freq = 440, freqEnd = null, gain = 0.3,
          attack = 0.004, duration = 0.3, curve = 0.05, delay = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd !== null && freqEnd !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + duration);
    }
    const g = this._voiceGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, curve);
    osc.connect(g);
    this._cleanup(osc, g);
    osc.start(t);
    osc.stop(t + duration + 0.1);
    return osc;
  }

  // --------------------------------------------------------------------------
  // SFX
  // --------------------------------------------------------------------------

  bounce(intensity) {
    if (!this._ready()) return;
    try {
      let i = typeof intensity === 'number' && isFinite(intensity) ? intensity : 0.5;
      if (i < 0) i = 0; if (i > 1) i = 1;
      if (i < 0.03) return;
      // Body thump: pitch-bent sine, harder bounces ring slightly higher.
      this._tone({
        type: 'sine',
        freq: 95 + 45 * i,
        freqEnd: 62,
        gain: 0.10 + 0.34 * i,
        attack: 0.003,
        duration: 0.16 + 0.08 * i,
        curve: 0.035 + 0.02 * i,
      });
      // Leather click transient.
      this._noiseBurst({
        type: 'bandpass', freqStart: 2600, freqEnd: 1200, q: 1.2,
        gain: 0.05 + 0.10 * i, attack: 0.001, duration: 0.04, curve: 0.01,
      });
    } catch (e) {}
  }

  rim() {
    if (!this._ready()) return;
    try {
      // Metallic clank: detuned inharmonic partials, very fast decay.
      const partials = [
        { f: 1780, g: 0.16 },
        { f: 2410, g: 0.12 },
        { f: 3140, g: 0.06 },
      ];
      for (const p of partials) {
        const detune = 1 + (Math.random() - 0.5) * 0.03;
        this._tone({
          type: 'triangle', freq: p.f * detune, freqEnd: p.f * detune * 0.985,
          gain: p.g, attack: 0.001, duration: 0.28, curve: 0.045,
        });
      }
      // Low ring of the rim/stanchion.
      this._tone({ type: 'sine', freq: 320, freqEnd: 300, gain: 0.08,
                   attack: 0.002, duration: 0.3, curve: 0.07 });
      // Impact tick.
      this._noiseBurst({ type: 'highpass', freqStart: 3500, q: 0.7,
                         gain: 0.09, attack: 0.001, duration: 0.03, curve: 0.008 });
    } catch (e) {}
  }

  backboard() {
    if (!this._ready()) return;
    try {
      // Dull board thud, a touch of body resonance.
      this._tone({ type: 'sine', freq: 210, freqEnd: 130, gain: 0.26,
                   attack: 0.002, duration: 0.18, curve: 0.035 });
      this._tone({ type: 'triangle', freq: 460, freqEnd: 380, gain: 0.07,
                   attack: 0.002, duration: 0.12, curve: 0.02 });
      this._noiseBurst({ type: 'lowpass', freqStart: 900, q: 0.5,
                         gain: 0.12, attack: 0.001, duration: 0.06, curve: 0.015 });
    } catch (e) {}
  }

  swish() {
    if (!this._ready()) return;
    try {
      // Clean net whoosh: bandpassed noise sweeping down.
      this._noiseBurst({
        type: 'bandpass', freqStart: 5200, freqEnd: 1400, q: 1.6,
        gain: 0.22, attack: 0.012, duration: 0.26, curve: 0.07,
      });
      this._noiseBurst({
        type: 'bandpass', freqStart: 3000, freqEnd: 900, q: 1.0,
        gain: 0.10, attack: 0.02, duration: 0.3, curve: 0.08,
      });
    } catch (e) {}
  }

  netSwish() {
    if (!this._ready()) return;
    try {
      // Duller variant — shot that touched iron first.
      this._noiseBurst({
        type: 'bandpass', freqStart: 2800, freqEnd: 800, q: 1.2,
        gain: 0.16, attack: 0.015, duration: 0.24, curve: 0.06,
      });
      this._noiseBurst({
        type: 'lowpass', freqStart: 1400, q: 0.6,
        gain: 0.07, attack: 0.02, duration: 0.22, curve: 0.06,
      });
    } catch (e) {}
  }

  buzzer() {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const DUR = 1.1;
      const g = this._voiceGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.30, t + 0.006);       // hard attack
      g.gain.setValueAtTime(0.30, t + DUR - 0.06);
      g.gain.linearRampToValueAtTime(0.0001, t + DUR);

      // Rough it up a hair through a lowpass so the saws don't sizzle.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2600;
      filter.Q.value = 0.8;
      filter.connect(g);

      const oscs = [];
      const defs = [
        { type: 'sawtooth', freq: 380 },
        { type: 'sawtooth', freq: 380 * 1.008 },   // slight detune = angry beat
        { type: 'square', freq: 190 },
      ];
      for (const d of defs) {
        const osc = ctx.createOscillator();
        osc.type = d.type;
        osc.frequency.value = d.freq;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + DUR + 0.05);
        oscs.push(osc);
      }
      oscs[0].onended = () => {
        try {
          for (const o of oscs) o.disconnect();
          filter.disconnect();
          g.disconnect();
        } catch (e) {}
      };
    } catch (e) {}
  }

  whistle() {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx;
      // Two quick trills; each is a sine with fast vibrato (pea rattle).
      for (let n = 0; n < 2; n++) {
        const delay = n * 0.26;
        const t = ctx.currentTime + delay;
        const dur = 0.2;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 2800;

        // Vibrato LFO — the "prrrt" of the pea.
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 38;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 240;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);

        const g = this._voiceGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.16, t + 0.01);
        g.gain.setValueAtTime(0.16, t + dur - 0.04);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);

        osc.connect(g);
        osc.start(t);
        osc.stop(t + dur + 0.02);
        lfo.start(t);
        lfo.stop(t + dur + 0.02);
        osc.onended = () => {
          try { osc.disconnect(); lfo.disconnect(); lfoGain.disconnect(); g.disconnect(); } catch (e) {}
        };
        // Breath noise under the tone.
        this._noiseBurst({ type: 'bandpass', freqStart: 3200, q: 3,
                           gain: 0.04, attack: 0.01, duration: dur, curve: 0.05 });
      }
    } catch (e) {}
  }

  cheer(big) {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const dur = big ? 2.4 : 1.5;
      const peak = big ? 0.42 : 0.24;

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.playbackRate.value = 1.05;

      // Rising bandpass = crowd standing up and opening its throat.
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.7;
      filter.frequency.setValueAtTime(500, t);
      filter.frequency.exponentialRampToValueAtTime(big ? 2400 : 1800, t + dur * 0.35);
      filter.frequency.exponentialRampToValueAtTime(700, t + dur);

      const g = this._voiceGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + dur * 0.22);
      g.gain.setTargetAtTime(0.0001, t + dur * 0.4, dur * 0.22);

      src.connect(filter);
      filter.connect(g);
      this._cleanup(src, filter, g);
      src.start(t, Math.random() * (NOISE_SECONDS - 0.1));
      src.stop(t + dur + 0.2);

      // A couple of high "whoo" chirps on big cheers.
      if (big) {
        this._tone({ type: 'sine', freq: 900, freqEnd: 1400, gain: 0.05,
                     attack: 0.05, duration: 0.5, curve: 0.12, delay: 0.15 });
        this._tone({ type: 'sine', freq: 1050, freqEnd: 1500, gain: 0.04,
                     attack: 0.06, duration: 0.5, curve: 0.12, delay: 0.4 });
      }
    } catch (e) {}
  }

  groan() {
    if (!this._ready()) return;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const dur = 1.2;

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.playbackRate.value = 0.8;

      // Descending, dark bandpass — a disappointed exhale.
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.8;
      filter.frequency.setValueAtTime(900, t);
      filter.frequency.exponentialRampToValueAtTime(300, t + dur);

      const g = this._voiceGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.13, t + 0.18);
      g.gain.setTargetAtTime(0.0001, t + 0.35, 0.28);

      src.connect(filter);
      filter.connect(g);
      this._cleanup(src, filter, g);
      src.start(t, Math.random() * (NOISE_SECONDS - 0.1));
      src.stop(t + dur + 0.2);

      // Falling "aww" tone underneath.
      this._tone({ type: 'sine', freq: 420, freqEnd: 240, gain: 0.045,
                   attack: 0.08, duration: 0.8, curve: 0.2 });
    } catch (e) {}
  }

  squeak() {
    if (!this._ready()) return;
    try {
      const now = this.ctx.currentTime;
      if (now - this._lastSqueakTime < SQUEAK_MIN_INTERVAL) return;
      this._lastSqueakTime = now;

      const f = 2000 + Math.random() * 2000;                // 2–4 kHz
      const dur = 0.06 + Math.random() * 0.03;              // 60–90 ms
      const up = Math.random() < 0.6;                       // chirp direction
      this._noiseBurst({
        type: 'bandpass',
        freqStart: f,
        freqEnd: up ? f * 1.5 : f * 0.65,
        q: 9,
        gain: 0.07 + Math.random() * 0.05,
        attack: 0.004,
        duration: dur,
        curve: dur * 0.35,
      });
    } catch (e) {}
  }
}
