/**
 * Mouth-amplitude helpers for the widget mascot (owner: A4). Pure functions, shared by the Mascot's
 * animation loop and useMouthFromAudio, so they are unit-tested without a DOM.
 */

/** Any input to 0..1; NaN, undefined and ±Infinity outside the range are clamped (NaN → 0). */
export function clampMouth(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * One step of an attack/release follower: opens fast (attackMs), closes a little slower (releaseMs),
 * frame-rate independent (dtMs is the time since the previous step).
 */
export function smoothMouth(current: number, target: number, dtMs: number, attackMs = 50, releaseMs = 120): number {
  const t = clampMouth(target);
  const tau = t > current ? attackMs : releaseMs;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  const next = current + (t - current) * k;
  return Math.abs(next - t) < 0.002 ? t : next;
}

/** RMS of a time-domain frame (−1..1 samples) mapped to 0..1 with a small noise gate. */
export function rmsToLevel(rms: number, gate = 0.012, gain = 5): number {
  return clampMouth((rms - gate) * gain);
}

/** RMS of a frame of float samples. */
export function frameRms(buf: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return buf.length ? Math.sqrt(sum / buf.length) : 0;
}

/** A soft, syllable-like 0.15..0.7 rhythm for "talking" without audio (tMs = a clock in ms). */
export function typingRhythm(tMs: number): number {
  const a = 0.5 + 0.5 * Math.sin(tMs * 0.019);
  const b = 0.7 + 0.3 * Math.sin(tMs * 0.0067 + 1.3);
  return 0.15 + 0.55 * a * b;
}

/** What the mouth should aim for this frame: closed unless talking; `mouth` wins over the rhythm. */
export function mouthTarget(nowMs: number, o: { talking: boolean; mouth?: number; rhythm: boolean }): number {
  if (!o.talking) return 0;
  if (o.mouth !== undefined) return clampMouth(o.mouth);
  return o.rhythm ? typingRhythm(nowMs) : 0;
}

/** A stateful attack/release follower: call it once per frame with the frame time and the target. */
export function createMouthFollower(): (nowMs: number, target: number) => number {
  let cur = 0;
  let last = -1;
  return (nowMs, target) => {
    cur = smoothMouth(cur, target, last < 0 ? 16 : Math.min(64, nowMs - last));
    last = nowMs;
    return cur;
  };
}

/** Mouth amplitude → Live2D ParamMouthOpenY (0..1). A gentle curve so quiet speech still opens it. */
export function mouthToParam(m: number): number {
  return Math.round(Math.pow(clampMouth(m), 0.75) * 1000) / 1000;
}
