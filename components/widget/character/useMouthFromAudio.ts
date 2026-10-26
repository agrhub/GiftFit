"use client";

import { useEffect, useState } from "react";
import { frameRms, rmsToLevel, smoothMouth } from "./mouth";

/**
 * Web Audio lip-sync source for the mascot (owner: A4; fed by P8.3 TTS). Returns a smoothed 0..1
 * mouth amplitude from an <audio>/<video> element or a MediaStream; 0 when `audio` is null or Web
 * Audio is unavailable. The rAF loop stops on unmount (and browsers pause it in hidden tabs).
 *
 * MediaStream: the hook owns its AudioContext (analyser only, not routed to the speakers, so no
 * echo) and closes it on cleanup.
 * Media element: Web Audio can route an element only once and never un-route it, so each element
 * gets one shared context (element → speakers, plus our analyser) kept for the element's lifetime;
 * cleanup disconnects the analyser. Closing it would silence the element for good (and React
 * StrictMode's double effect would do exactly that). The context is resumed on "play", because a
 * context created before a user gesture starts suspended and would mute the element.
 */
type Ctor = typeof AudioContext;
const elementGraphs = new WeakMap<HTMLMediaElement, { ctx: AudioContext; source: AudioNode }>();

function audioContextCtor(): Ctor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext;
}

function isStream(a: HTMLMediaElement | MediaStream): a is MediaStream {
  return typeof (a as MediaStream).getAudioTracks === "function";
}

function connect(audio: HTMLMediaElement | MediaStream, Ctx: Ctor): { ctx: AudioContext; source: AudioNode; owns: boolean } | null {
  let fresh: AudioContext | undefined;
  try {
    if (isStream(audio)) {
      if (!audio.getAudioTracks().length) return null;
      fresh = new Ctx();
      return { ctx: fresh, source: fresh.createMediaStreamSource(audio), owns: true };
    }
    let g = elementGraphs.get(audio);
    if (!g) {
      fresh = new Ctx();
      const source = fresh.createMediaElementSource(audio);
      source.connect(fresh.destination);
      g = { ctx: fresh, source };
      elementGraphs.set(audio, g);
    }
    return { ...g, owns: false };
  } catch {
    void fresh?.close().catch(() => {});
    return null;
  }
}

export function useMouthFromAudio(audio: HTMLMediaElement | MediaStream | null): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const Ctx = audioContextCtor();
    if (!audio || !Ctx) return;
    const graph = connect(audio, Ctx);
    if (!graph) return;
    const { ctx, source, owns } = graph;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const resume = () => void ctx.resume().catch(() => {});
    if (!owns) {
      (audio as HTMLMediaElement).addEventListener("play", resume);
      if (!(audio as HTMLMediaElement).paused) resume();
    }

    let raf = 0;
    let cur = 0;
    let shown = 0;
    let last = -1;
    const tick = (now: number) => {
      const dt = last < 0 ? 16 : Math.min(64, now - last);
      last = now;
      analyser.getFloatTimeDomainData(buf);
      cur = smoothMouth(cur, rmsToLevel(frameRms(buf)), dt);
      // Re-render only on visible change.
      if (Math.abs(cur - shown) > 0.01 || (cur !== shown && (cur === 0 || cur === 1))) {
        shown = cur;
        setLevel(cur);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      try {
        source.disconnect(analyser);
      } catch {
        /* already disconnected */
      }
      if (owns) void ctx.close().catch(() => {});
      else (audio as HTMLMediaElement).removeEventListener("play", resume);
      setLevel(0);
    };
  }, [audio]);

  return audio ? level : 0;
}
