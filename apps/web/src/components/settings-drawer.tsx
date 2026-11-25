"use client";

import { LANGUAGES, LIMITS, type AgentConfig, type LanguageCode } from "@voice-studio/shared";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef } from "react";

export interface AgentSettings {
  readonly instructions: string;
  readonly language: LanguageCode;
}

interface SettingsDrawerProps {
  readonly open: boolean;
  readonly agent: AgentConfig;
  readonly settings: AgentSettings;
  readonly sessionActive: boolean;
  readonly onChange: (settings: AgentSettings) => void;
  readonly onClose: () => void;
}

export function SettingsDrawer({ open, agent, settings, sessionActive, onChange, onClose }: SettingsDrawerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    textareaRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close settings" className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-surface"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 id="settings-title" className="text-sm font-medium">{agent.name} settings</h2>
            <p className="text-xs text-ink-faint">Changes apply to the next conversation.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-lg p-1.5 text-ink-muted hover:bg-raised hover:text-ink">
            <X className="size-4" />
          </button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {sessionActive && (
            <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
              A conversation is live. New settings take effect when you start the next one.
            </p>
          )}
          <label className="block space-y-2">
            <span className="text-xs font-medium text-ink-muted">Response language</span>
            <select
              value={settings.language}
              onChange={(event) => onChange({ ...settings, language: event.target.value as LanguageCode })}
              className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm"
            >
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>{language.label}</option>
              ))}
            </select>
          </label>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="agent-instructions" className="text-xs font-medium text-ink-muted">Agent instructions</label>
              <button
                type="button"
                onClick={() => onChange({ ...settings, instructions: agent.instructions })}
                className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
              >
                <RotateCcw className="size-3" /> Reset
              </button>
            </div>
            <textarea
              id="agent-instructions"
              ref={textareaRef}
              rows={16}
              maxLength={LIMITS.maxInstructionsChars}
              value={settings.instructions}
              onChange={(event) => onChange({ ...settings, instructions: event.target.value })}
              className="w-full resize-y rounded-lg border border-line bg-raised px-3 py-2 font-mono text-xs leading-relaxed"
            />
            <p className="text-xs text-ink-faint">
              {settings.instructions.length}/{LIMITS.maxInstructionsChars}. Built-in honesty rules (no real bookings or actions) always apply. Voice: Zephyr.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
