"use client";

import { AGENT_LIST, DEFAULT_AGENT_ID, getAgent, type AgentIcon, type AgentId } from "@voice-studio/shared";
import {
  AudioLines,
  HeartHandshake,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Settings2,
  Sparkles,
  TriangleAlert,
  Utensils,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { voiceServerUrl } from "@/lib/config";
import { formatTranscript } from "@/lib/transcript";
import { VoiceSessionController, type VoiceSessionSnapshot } from "@/lib/voice-session";
import { SettingsDrawer, type AgentSettings } from "./settings-drawer";
import { TranscriptPanel } from "./transcript-panel";
import { Visualizer, type VisualMode } from "./visualizer";

const ICONS: Record<AgentIcon, typeof Sparkles> = { sparkles: Sparkles, utensils: Utensils, "heart-handshake": HeartHandshake };

type ServerHealth = "checking" | "online" | "offline";

function initialSettings(): Record<AgentId, AgentSettings> {
  return Object.fromEntries(
    AGENT_LIST.map((agent) => [agent.id, { instructions: agent.instructions, language: "auto" }]),
  ) as Record<AgentId, AgentSettings>;
}

function visualMode(snapshot: VoiceSessionSnapshot): VisualMode {
  if (snapshot.status === "connecting" || snapshot.status === "reconnecting") return "connecting";
  if (snapshot.status === "error") return "error";
  if (snapshot.status !== "live") return "idle";
  return snapshot.activity;
}

const STATUS_LABEL: Record<VisualMode | "reconnecting" | "ended", string> = {
  idle: "Ready",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  error: "Error",
  ended: "Conversation ended",
};

function statusLabel(snapshot: VoiceSessionSnapshot): string {
  if (snapshot.status === "reconnecting") return STATUS_LABEL.reconnecting;
  if (snapshot.status === "ended") return STATUS_LABEL.ended;
  if (snapshot.status === "live" && snapshot.muted) return "Muted";
  return STATUS_LABEL[visualMode(snapshot)];
}

function useServerHealth(): ServerHealth {
  const [health, setHealth] = useState<ServerHealth>("checking");
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch(`${voiceServerUrl()}/health`, { cache: "no-store" });
        if (!cancelled) setHealth(response.ok ? "online" : "offline");
      } catch {
        if (!cancelled) setHealth("offline");
      }
    };
    void check();
    const timer = setInterval(check, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return health;
}

function useElapsed(startedAt: number | null, running: boolean): string {
  // Clock is read only in the interval (never during render) so prerendering stays deterministic.
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  const seconds = startedAt && now >= startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceStudio() {
  const [controller] = useState(() => new VoiceSessionController());
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [agentId, setAgentId] = useState<AgentId>(DEFAULT_AGENT_ID);
  const [settings, setSettings] = useState(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const health = useServerHealth();
  const agent = getAgent(agentId);
  const active = snapshot.status === "connecting" || snapshot.status === "live" || snapshot.status === "reconnecting";
  const live = snapshot.status === "live" || snapshot.status === "reconnecting";
  const elapsed = useElapsed(snapshot.startedAt, live);
  const readLevel = useCallback(() => controller.getLevel(), [controller]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    const onHide = () => controller.end();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      controller.end();
    };
  }, [controller]);

  const start = () => {
    const current = settings[agentId];
    const custom = current.instructions.trim() !== agent.instructions.trim();
    void controller.start({ agentId, language: current.language, ...(custom ? { instructions: current.instructions } : {}) });
  };

  const download = () => {
    const text = formatTranscript(snapshot.transcript, { agentName: agent.name, startedAt: snapshot.startedAt });
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `voice-studio-${agent.id}.txt` });
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1500px] flex-col gap-3 p-3 lg:grid lg:h-dvh lg:grid-cols-[250px_minmax(0,1fr)_360px] lg:gap-4 lg:p-4">
      {/* Sidebar */}
      <aside className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <AudioLines className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">Voice Studio</p>
            <p className="text-[11px] text-ink-faint">Gemini Live playground</p>
          </div>
        </div>
        <nav aria-label="Agents" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
          <p className="hidden px-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint lg:block">Agents</p>
          {AGENT_LIST.map((item) => {
            const Icon = ICONS[item.icon];
            const selected = item.id === agentId;
            return (
              <button
                key={item.id}
                type="button"
                disabled={active}
                aria-pressed={selected}
                onClick={() => setAgentId(item.id)}
                className={`flex min-w-52 items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition lg:min-w-0 ${
                  selected ? "border-accent/40 bg-accent/[0.07]" : "border-transparent hover:bg-raised"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <Icon className={`mt-0.5 size-4 shrink-0 ${selected ? "text-accent" : "text-ink-muted"}`} />
                <span>
                  <span className="block text-sm font-medium">{item.name}</span>
                  <span className="block text-xs text-ink-faint">{item.tagline}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto hidden space-y-3 lg:block">
          <ServerIndicator health={health} />
          <PrivacyNotice />
        </div>
      </aside>

      {/* Conversation */}
      <main className="flex min-h-[560px] flex-col rounded-2xl border border-line bg-surface">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">{agent.name}</h1>
              <StatusPill snapshot={snapshot} />
            </div>
            <p className="mt-1 max-w-xl text-sm text-ink-muted">{agent.description}</p>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition hover:bg-raised hover:text-ink"
          >
            <Settings2 className="size-4" /> Settings
          </button>
        </header>

        {snapshot.error && (
          <div role="alert" className="mx-5 mt-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
            <p className="flex-1 text-ink">{snapshot.error.message}</p>
            <button type="button" onClick={() => controller.dismissError()} aria-label="Dismiss error" className="text-ink-muted hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
        )}

        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-5 py-8">
          <Visualizer mode={visualMode(snapshot)} readLevel={readLevel} />
          <div className="text-center" aria-live="polite">
            <p className="text-lg font-medium tracking-tight">{statusLabel(snapshot)}</p>
            <p className="mt-1 text-sm text-ink-faint">
              {snapshot.status === "live"
                ? "Speak naturally. You can interrupt the agent at any time."
                : snapshot.status === "connecting"
                  ? "Allow microphone access if your browser asks."
                  : snapshot.status === "ended"
                    ? "Review the transcript, or start another conversation."
                    : "Start a conversation, then ask anything."}
            </p>
          </div>
          {!active && snapshot.transcript.length === 0 && (
            <ul className="flex max-w-xl flex-wrap justify-center gap-2" aria-label="Things to try">
              {agent.suggestedPrompts.map((prompt) => (
                <li key={prompt} className="rounded-full border border-line px-3 py-1 text-xs text-ink-muted">“{prompt}”</li>
              ))}
            </ul>
          )}
        </div>

        <footer className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-2xl border-t border-line bg-surface/95 px-5 py-4 backdrop-blur">
          <button
            type="button"
            disabled={!live}
            aria-pressed={snapshot.muted}
            aria-label={snapshot.muted ? "Unmute microphone" : "Mute microphone"}
            onClick={() => controller.setMuted(!snapshot.muted)}
            className={`inline-flex size-11 items-center justify-center rounded-full border transition disabled:opacity-40 ${
              snapshot.muted ? "border-danger/40 bg-danger/15 text-danger" : "border-line bg-raised text-ink hover:border-line-strong"
            }`}
          >
            {snapshot.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </button>

          {active ? (
            <button
              type="button"
              onClick={() => controller.end()}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-danger px-6 text-sm font-semibold text-black transition hover:bg-danger/90"
            >
              <PhoneOff className="size-4" /> End conversation
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={health === "offline"}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:opacity-50"
            >
              <Phone className="size-4" />
              {snapshot.status === "ended" || snapshot.status === "error" ? "Start new conversation" : "Start conversation"}
            </button>
          )}

          <div className="min-w-16 text-right font-mono text-xs text-ink-muted">
            <p aria-label="Elapsed time">{elapsed}</p>
            {snapshot.setupMs !== null && <p className="text-ink-faint" title="Measured on the server: request to Gemini setup complete">setup {snapshot.setupMs} ms</p>}
          </div>
        </footer>
      </main>

      <TranscriptPanel
        entries={snapshot.transcript}
        agentName={agent.name}
        live={active}
        onDownload={download}
        onClear={() => controller.clearTranscript()}
      />

      <div className="space-y-3 rounded-2xl border border-line bg-surface p-4 lg:hidden">
        <ServerIndicator health={health} />
        <PrivacyNotice />
      </div>

      <SettingsDrawer
        open={settingsOpen}
        agent={agent}
        settings={settings[agentId]}
        sessionActive={active}
        onChange={(next) => setSettings((prev) => ({ ...prev, [agentId]: next }))}
        onClose={closeSettings}
      />
    </div>
  );
}

function StatusPill({ snapshot }: { readonly snapshot: VoiceSessionSnapshot }) {
  const live = snapshot.status === "live";
  const color =
    snapshot.status === "error" ? "bg-danger" : live ? "bg-accent" : snapshot.status === "idle" || snapshot.status === "ended" ? "bg-ink-faint" : "bg-ink-muted";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-muted">
      <span className={`size-1.5 rounded-full ${color} ${live ? "motion-safe:animate-pulse" : ""}`} />
      {statusLabel(snapshot)}
    </span>
  );
}

function ServerIndicator({ health }: { readonly health: ServerHealth }) {
  const label = health === "online" ? "Voice server online" : health === "offline" ? "Voice server offline" : "Checking voice server…";
  const color = health === "online" ? "bg-accent" : health === "offline" ? "bg-danger" : "bg-ink-faint";
  return (
    <p className="flex items-center gap-2 text-xs text-ink-muted">
      <span className={`size-2 rounded-full ${color}`} aria-hidden="true" />
      {label}
    </p>
  );
}

function PrivacyNotice() {
  return (
    <p className="text-[11px] leading-relaxed text-ink-faint">
      Your microphone audio is sent to Google&apos;s Gemini API to power the conversation. Headphones give the best
      barge-in experience.
    </p>
  );
}
