"use client";

import { useEffect, useRef } from "react";
import type { AudioLevel } from "@/lib/voice-session";

export type VisualMode = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

interface VisualizerProps {
  readonly mode: VisualMode;
  readonly readLevel: () => AudioLevel;
}

/**
 * Orb driven by real microphone/playback RMS. With no audio it only shows a
 * neutral breathing animation (disabled under prefers-reduced-motion).
 */
export function Visualizer({ mode, readLevel }: VisualizerProps) {
  const orbRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let smoothed = 0;
    const tick = () => {
      const { level } = readLevel();
      smoothed += (level - smoothed) * 0.25;
      if (orbRef.current) orbRef.current.style.transform = `scale(${1 + smoothed * 0.28})`;
      if (ringRef.current) {
        ringRef.current.style.transform = `scale(${1 + smoothed * 0.6})`;
        ringRef.current.style.opacity = String(Math.min(0.9, smoothed * 1.6));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [readLevel]);

  const tone =
    mode === "speaking"
      ? "bg-accent/90 shadow-[0_0_80px_-10px] shadow-accent/50"
      : mode === "listening"
        ? "bg-ink/85 shadow-[0_0_60px_-15px] shadow-ink/30"
        : mode === "thinking"
          ? "bg-accent/40"
          : mode === "error"
            ? "bg-danger/40"
            : "bg-raised border border-line-strong";
  const ringTone = mode === "speaking" ? "border-accent/60" : "border-ink/40";
  const idleMotion = mode === "idle" || mode === "connecting" || mode === "thinking";

  return (
    <div className="relative flex size-56 items-center justify-center sm:size-64" aria-hidden="true">
      <div ref={ringRef} className={`absolute inset-6 rounded-full border-2 opacity-0 ${ringTone}`} />
      <div className={`absolute inset-0 rounded-full border border-line ${idleMotion ? "motion-safe:animate-breathe" : ""}`} />
      <div className="absolute inset-10 rounded-full border border-line/60" />
      <div
        ref={orbRef}
        className={`size-28 rounded-full transition-colors duration-500 sm:size-32 ${tone} ${
          mode === "connecting" || mode === "thinking" ? "motion-safe:animate-pulse" : ""
        }`}
      />
    </div>
  );
}
