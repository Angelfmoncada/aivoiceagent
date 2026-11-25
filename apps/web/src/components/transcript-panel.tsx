"use client";

import { Download, MessageSquareText, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { displayText, type TranscriptEntry } from "@/lib/transcript";

interface TranscriptPanelProps {
  readonly entries: readonly TranscriptEntry[];
  readonly agentName: string;
  readonly live: boolean;
  readonly onDownload: () => void;
  readonly onClear: () => void;
}

export function TranscriptPanel({ entries, agentName, live, onDownload, onClear }: TranscriptPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const empty = entries.length === 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [entries]);

  return (
    <section aria-label="Transcript" className="flex min-h-80 flex-col rounded-2xl border border-line bg-surface lg:min-h-0">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">Transcript</h2>
        <div className="flex gap-1">
          <IconButton label="Download transcript as text" disabled={empty} onClick={onDownload}>
            <Download className="size-4" />
          </IconButton>
          <IconButton label="Clear transcript" disabled={empty || live} onClick={onClear}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </header>
      <div role="log" aria-live="polite" className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-ink-faint">
            <MessageSquareText className="size-6" />
            <p className="text-sm">{live ? "Start speaking — live transcription appears here." : "No transcript yet."}</p>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={entry.role === "user" ? "flex flex-col items-end" : "flex flex-col items-start"}>
              <span className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                {entry.role === "user" ? "You" : agentName}
              </span>
              <p
                className={`max-w-[90%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  entry.role === "user" ? "bg-raised text-ink" : "border border-line text-ink"
                } ${entry.final ? "" : "opacity-70"}`}
              >
                {displayText(entry.text)}
                {!entry.final && <span className="ml-1 text-ink-faint" aria-label="still transcribing">…</span>}
                {entry.interrupted && <span className="ml-2 text-xs text-ink-faint">(interrupted)</span>}
              </p>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}

interface IconButtonProps {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

export function IconButton({ label, disabled, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-lg text-ink-muted transition hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
