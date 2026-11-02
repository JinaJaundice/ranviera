// Connects a SessionModel to React. The view re-renders on the version of the model, through a store subscription, and never on a
// stable function. A fresh mount of a session creates one model, opens it, and detaches on unmount: the turn goes on at the server.
import { useEffect, useSyncExternalStore } from "react";
import { SessionModel, type ViewState } from "./model";

const models = new Map<string, SessionModel>();
const openings = new Map<string, string>();
const delivering = new Set<string>();

/** The first message of a session that was just created. It is kept in memory and never put in an address. */
export function stashOpening(id: string, text: string): void {
  openings.set(id, text);
}

/** One model for each session id, kept for the life of the window so that a drafted answer survives a change of session. */
export function modelFor(id: string): SessionModel {
  let m = models.get(id);
  if (!m) {
    m = new SessionModel(id);
    models.set(id, m);
  }
  return m;
}

export function useSessionState(model: SessionModel): ViewState {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
}

/** Opens the session when it is shown and detaches its stream when it is not. It broadcasts running and not running to the window. */
export function useOpenSession(model: SessionModel, onRunning: (id: string, running: boolean) => void): void {
  useEffect(() => {
    let live = true;
    void (async () => {
      await model.open();
      // a new session hands its first message over here, and it stays on the shelf until the server has accepted it
      const text = openings.get(model.id);
      if (text && live && !delivering.has(model.id)) {
        delivering.add(model.id);
        await model.send({ type: "text", text }, { opening: true, onAccepted: () => openings.delete(model.id) });
        delivering.delete(model.id);
      }
    })();
    return () => {
      live = false;
      model.stop();
    };
  }, [model]);
  const running = useSyncExternalStore(model.subscribe, () => model.getSnapshot().status === "submitted" || model.getSnapshot().status === "streaming");
  useEffect(() => {
    onRunning(model.id, running);
  }, [model, running, onRunning]);
}
