/**
 * SlicerBridge: the API that web widgets and module panels use to talk to 3D Slicer.
 *
 * Two implementations:
 *  - PyodideBridge: Slicer runs in the same page (WebAssembly, Pyodide).
 *  - QWebChannelBridge: the page is displayed inside desktop 3D Slicer (QtWebEngine); requests go
 *    through QWebChannel to the "slicerBridge" object provided by the SlicerWebWidgets extension.
 *
 * Both call the same Python API (slicerweb.bridge) with JSON arguments, so widgets work unchanged
 * in the browser and in the desktop application.
 */
import { EventBus } from "./events";

export interface VtkRef {
  __vtk__: string;
  id: string | null;
  name?: string;
}

export interface NodeSummary {
  id: string;
  name: string;
  className: string;
  hidden: boolean;
  visible?: boolean;
  displayNodeID?: string | null;
  color?: number[];
}

export interface SubjectHierarchyItem {
  id: number;
  name: string;
  nodeID: string | null;
  className: string;
  level: string;
  visible: boolean;
  children: SubjectHierarchyItem[];
}

export interface SlicerBridge {
  readonly events: EventBus;
  /** Call a slicerweb.bridge method. Arguments are positional or a single keyword object. */
  call<T = unknown>(method: string, args?: unknown[] | Record<string, unknown>): Promise<T>;
  /** Call a method of an object: target is "app", "layout", "scene", "node:<id>", "logic:<Module>". */
  invoke<T = unknown>(target: string, name: string, args?: unknown[]): Promise<T>;
  /** Run Python code in the application namespace. */
  evalPython(code: string, mode?: "exec" | "eval"): Promise<string | null>;
}

export class BridgeError extends Error {
  constructor(message: string, public readonly type: string) {
    super(message);
  }
}

abstract class BridgeBase implements SlicerBridge {
  readonly events = new EventBus();

  protected abstract rawCall(method: string, argsJson: string): Promise<string>;

  async call<T = unknown>(method: string, args: unknown[] | Record<string, unknown> = []): Promise<T> {
    const response = JSON.parse(await this.rawCall(method, JSON.stringify(args)));
    if ("error" in response) throw new BridgeError(response.error, response.type);
    return response.result as T;
  }

  invoke<T = unknown>(target: string, name: string, args: unknown[] = []): Promise<T> {
    return this.call<T>("invoke", [target, name, args]);
  }

  evalPython(code: string, mode: "exec" | "eval" = "exec"): Promise<string | null> {
    return this.call<string | null>("evalPython", [code, mode]);
  }

  /** Dispatch an event received from Python ("host.emit"). */
  dispatch(event: string, payloadJson: string) {
    let payload: unknown = undefined;
    try {
      payload = payloadJson ? JSON.parse(payloadJson) : undefined;
    } catch {
      payload = payloadJson;
    }
    this.events.emit(event, payload);
  }
}

/** Bridge to Slicer running in this page through Pyodide. */
export class PyodideBridge extends BridgeBase {
  private pyCall: ((method: string, args: string) => string) | null = null;

  attach(pyCall: (method: string, args: string) => string) {
    this.pyCall = pyCall;
  }

  protected async rawCall(method: string, argsJson: string): Promise<string> {
    if (!this.pyCall) throw new BridgeError("Slicer is not loaded yet", "NotReady");
    return this.pyCall(method, argsJson);
  }
}

/** Bridge to desktop 3D Slicer through QWebChannel (page shown in a Slicer module panel). */
export class QWebChannelBridge extends BridgeBase {
  private remote: any = null;
  readonly ready: Promise<void>;

  constructor() {
    super();
    this.ready = new Promise((resolve, reject) => {
      const w = window as any;
      if (!w.qt?.webChannelTransport || !w.QWebChannel) {
        reject(new Error("QWebChannel is not available"));
        return;
      }
      new w.QWebChannel(w.qt.webChannelTransport, (channel: any) => {
        this.remote = channel.objects.slicerBridge;
        this.remote.eventEmitted.connect((event: string, payloadJson: string) => this.dispatch(event, payloadJson));
        resolve();
      });
    });
  }

  protected async rawCall(method: string, argsJson: string): Promise<string> {
    await this.ready;
    return new Promise((resolve) => this.remote.call(method, argsJson, resolve));
  }
}

let current: SlicerBridge | null = null;

/** The bridge used by widgets. Set by the application (browser) or by the desktop host page. */
export function setBridge(bridge: SlicerBridge) {
  current = bridge;
}

export function bridge(): SlicerBridge {
  if (!current) {
    const w = window as any;
    if (w.qt?.webChannelTransport) {
      current = new QWebChannelBridge();
    } else {
      throw new Error("No Slicer bridge: call setBridge() first");
    }
  }
  return current;
}
