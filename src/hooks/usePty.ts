import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PtyDataEvent, PtyErrorEvent, PtyExitEvent } from "../types/pty";

type PtyStatus = "idle" | "running" | "exited" | "error";

interface UsePtyResult {
  status: PtyStatus;
  exitCode: number | null;
  errorMessage: string | null;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

/**
 * Attaches to an already-spawned PTY (spawn/kill are owned by the canvas
 * store, since a node's PTY must outlive re-renders and be spawned exactly
 * once when the node is created).
 */
export function usePty(ptyId: string | null, onData: (data: string) => void): UsePtyResult {
  const [status, setStatus] = useState<PtyStatus>(ptyId ? "running" : "idle");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    setStatus(ptyId ? "running" : "idle");
    setExitCode(null);
    setErrorMessage(null);

    if (!ptyId) return;

    let cancelled = false;
    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;

    (async () => {
      const [dataFn, exitFn, errorFn] = await Promise.all([
        listen<PtyDataEvent>("pty://data", (event) => {
          if (event.payload.ptyId === ptyId) onDataRef.current(event.payload.data);
        }),
        listen<PtyExitEvent>("pty://exit", (event) => {
          if (event.payload.ptyId === ptyId) {
            setExitCode(event.payload.exitCode);
            setStatus("exited");
          }
        }),
        listen<PtyErrorEvent>("pty://error", (event) => {
          if (event.payload.ptyId === ptyId) {
            setErrorMessage(event.payload.message);
            setStatus("error");
          }
        }),
      ]);
      if (cancelled) {
        dataFn();
        exitFn();
        errorFn();
        return;
      }
      unlistenData = dataFn;
      unlistenExit = exitFn;
      unlistenError = errorFn;
    })();

    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenExit?.();
      unlistenError?.();
    };
  }, [ptyId]);

  const write = useCallback(
    (data: string) => {
      if (ptyId) void invoke("pty_write", { ptyId, data });
    },
    [ptyId],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (ptyId) void invoke("pty_resize", { ptyId, cols, rows });
    },
    [ptyId],
  );

  return { status, exitCode, errorMessage, write, resize };
}
