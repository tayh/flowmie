import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWorkspace } from "./useWorkspace";
import type { ResourceRef } from "../types/workspace";

interface ResourceCreatedPayload {
  resource: ResourceRef;
}

/**
 * Listens for `resource://created` and folds the new resource into the
 * workspace store (F002 Phase 3). This is the *only* way the frontend learns
 * about resources an agent published on its own — `share_resource` and
 * `capture_webview` register through the bridge with no frontend round-trip.
 * Adds are deduped by id, so a resource the frontend also created directly
 * (and already has) collapses to one. Mounted once in Canvas.
 */
export function useResources() {
  useEffect(() => {
    const unlisten = listen<ResourceCreatedPayload>("resource://created", (event) => {
      useWorkspace.getState().addResource(event.payload.resource);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
}
