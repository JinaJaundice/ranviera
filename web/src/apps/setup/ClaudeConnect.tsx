import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn, RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { toast } from "../../shell/toastStore";
import { INSTALL_URL } from "./copy";
import { POLL_LIMIT_MS, POLL_MS, claudeSummary } from "./model";
import { refreshClaude, useSetupStore } from "./state";

/**
 * The state of Claude Code with the sign-in button. The product never asks for a password, a code or a key:
 * the sign-in happens in a terminal window that belongs to Claude Code, and this panel only checks the result.
 */
export function ClaudeConnect() {
  const claude = useSetupStore((s) => s.claude);
  const [watching, setWatching] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(0);

  useEffect(() => {
    void refreshClaude();
  }, []);

  // The sign-in happens in another window, so the state is checked again when this window comes back.
  useEffect(() => {
    const onFocus = () => void refreshClaude();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshClaude();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // After the person starts the sign-in, check every 3 seconds for up to 5 minutes.
  const watch = watching && claude?.signed_in !== true;
  useEffect(() => {
    if (!watch) return;
    const t = setInterval(() => {
      if (Date.now() - started.current >= POLL_LIMIT_MS) {
        setWatching(false);
        setTimedOut(true);
        return;
      }
      void refreshClaude().then((c) => {
        if (c?.signed_in) setWatching(false);
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [watch]);

  const login = useCallback(async () => {
    setBusy(true);
    setTimedOut(false);
    try {
      const r = await api.claudeLogin();
      setNote(r.message);
      if (r.started) {
        started.current = Date.now();
        setWatching(true);
      }
    } catch (e) {
      toast(`The sign-in could not be started. ${e instanceof Error ? e.message : ""}`.trim(), "error");
    } finally {
      setBusy(false);
    }
  }, []);

  const sum = claudeSummary(claude);
  return (
    <div className="min-w-0">
      <p className="flex min-w-0 items-center gap-2 text-body text-ink" role="status">
        <StatusDot tone={sum.tone} />
        <span className="min-w-0 font-medium">{sum.label}</span>
      </p>
      <p className="mt-1 text-small text-ink-soft">{sum.detail}</p>

      {claude && !claude.installed ? (
        <div className="mt-3 min-w-0">
          <p className="mb-2 text-body text-ink">
            Install Claude Code from Anthropic, then return to this window. The window checks again when you return.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={INSTALL_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rule-strong bg-raised px-3 text-body font-medium text-ink hover:bg-sunken"
            >
              <ExternalLink size={14} aria-hidden="true" />
              Anthropic installation page
            </a>
            <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void refreshClaude()}>
              Check again
            </Button>
          </div>
        </div>
      ) : null}

      {claude?.installed && !claude.signed_in ? (
        <div className="mt-3 min-w-0">
          <p className="mb-2 text-body text-ink">
            The button opens a terminal window that belongs to Claude Code. You sign in there, and this window never sees a password, a code or a key.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<LogIn size={14} aria-hidden="true" />} disabled={busy || watch} onClick={() => void login()}>
              Sign in with Claude Code
            </Button>
            <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void refreshClaude()}>
              Check again
            </Button>
          </div>
          {watch ? (
            <p className="mt-2 text-small text-ink-soft" role="status">
              Waiting for the sign-in. This window checks every 3 seconds for up to 5 minutes.
            </p>
          ) : null}
          {timedOut ? (
            <p className="mt-2 text-small text-hold" role="status">
              The sign-in was not completed within 5 minutes. Select the button to try again.
            </p>
          ) : null}
          {note ? <p className="mt-2 text-small text-ink-soft">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
