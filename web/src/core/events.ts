/** Minimal typed event bus used by the runtime and the UI. */
export type Listener<T = unknown> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener<any>>>();

  on<T = unknown>(event: string, listener: Listener<T>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  once<T = unknown>(event: string, listener: Listener<T>): () => void {
    const off = this.on<T>(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<T = unknown>(event: string, payload?: T): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (e) {
        console.error(`Error in listener of "${event}"`, e);
      }
    }
    for (const listener of this.listeners.get("*") ?? []) {
      listener({ event, payload });
    }
  }
}
