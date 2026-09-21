/**
 * Jobs: work run away from the page, in a worker with a Python of its own.
 *
 * This is the browser's answer to the CLI modules of desktop Slicer, which are separate programs:
 * the inputs are written to files, the work runs elsewhere, and the outputs come back as files. The
 * scene and the views stay in the page and keep working while a job runs.
 */
import { DEFAULT_STARTUP_PACKAGES, PYODIDE_VERSION } from "./runtime";

export interface JobSpec {
  /** Python run in the worker; what it leaves in "result" comes back. */
  code: string;
  /** Values the code can read as globals. */
  globals?: Record<string, unknown>;
  /** Files to write before it runs, as {path: bytes}. */
  files?: Record<string, Uint8Array>;
  /** Files to read back afterwards. */
  outputs?: string[];
  /** Pyodide packages to load in the worker before the code runs (e.g. ["scipy"]). */
  packages?: string[];
}

export interface JobEvents {
  onProgress?: (message: string, fraction: number) => void;
  onLog?: (level: string, message: string) => void;
}

export interface JobResult {
  result: unknown;
  files: Record<string, Uint8Array>;
}

interface WheelIndex {
  packages: { name: string; version: string; file: string }[];
}

export class JobRunner {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private jobs = new Map<string, { resolve: (r: JobResult) => void; reject: (e: Error) => void; events: JobEvents }>();
  private nextId = 1;
  private current: string | null = null;

  constructor(
    private wheelsURL = new URL("wheels/", document.baseURI).href,
    private extensionWheels: string[] = [],
  ) {}

  /** Whether a job is running now. */
  get busy() {
    return this.current !== null;
  }

  /** Start the worker and install the wheels in it (kept warm for later jobs). */
  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const response = await fetch(this.wheelsURL + "index.json");
      const index = (await response.json()) as WheelIndex;
      const wheels = DEFAULT_STARTUP_PACKAGES.map((name) => index.packages.find((p) => p.name === name))
        .filter((p): p is WheelIndex["packages"][0] => Boolean(p))
        .map((p) => new URL(this.wheelsURL + p.file, document.baseURI).href)
        .concat(this.extensionWheels);
      const slicerVersion = /slicer_core-(\d+\.\d+)/.exec(wheels.join(" "))?.[1] ?? "5.13";

      this.worker = new Worker(new URL("./jobWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event) => this.onMessage(event.data);
      await new Promise<void>((resolve, reject) => {
        const onReady = (event: MessageEvent) => {
          if (event.data?.type === "ready") {
            this.worker?.removeEventListener("message", onReady);
            resolve();
          } else if (event.data?.type === "failed" && !event.data.id) {
            reject(new Error(event.data.error));
          }
        };
        this.worker!.addEventListener("message", onReady);
        this.worker!.postMessage({
          type: "start",
          pyodideURL: new URL("pyodide/", document.baseURI).href,
          pyodidePackagesURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
          wheels,
          slicerVersion,
          pyodidePackages: ["numpy", "micropip", "packaging"],
        });
      });
    })();
    return this.ready;
  }

  /** Run a job. Only one runs at a time; the next waits for it. */
  async run(spec: JobSpec, events: JobEvents = {}): Promise<JobResult> {
    await this.start();
    const id = String(this.nextId++);
    this.current = id;
    return new Promise<JobResult>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, events });
      const transfer = Object.values(spec.files ?? {}).map((f) => f.buffer);
      this.worker!.postMessage({ type: "run", id, ...spec }, transfer);
    }).finally(() => {
      this.current = null;
    });
  }

  /** Stop the work: the worker is ended, and the next job starts a new one. */
  cancel() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.ready = null;
    for (const [, job] of this.jobs) job.reject(new Error("The job was cancelled"));
    this.jobs.clear();
    this.current = null;
  }

  private onMessage(message: any) {
    const job = message.id ? this.jobs.get(message.id) : undefined;
    if (message.type === "progress") {
      (job ?? [...this.jobs.values()][0])?.events.onProgress?.(message.message, message.fraction);
    } else if (message.type === "log") {
      (job ?? [...this.jobs.values()][0])?.events.onLog?.(message.level, message.message);
    } else if (message.type === "done" && job) {
      this.jobs.delete(message.id);
      job.resolve({ result: message.result, files: message.files ?? {} });
    } else if (message.type === "failed" && job) {
      this.jobs.delete(message.id);
      job.reject(new Error(message.error));
    }
  }
}

/** The job runner of this page, made when it is first needed (starting one costs a few seconds). */
let runner: JobRunner | null = null;
export function jobRunner(extensionWheels: string[] = []): JobRunner {
  if (!runner) runner = new JobRunner(undefined, extensionWheels);
  return runner;
}
