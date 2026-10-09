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

/** A start of the worker that a later end() abandoned: who waited for it starts again. */
class StartSuperseded extends Error {
  /** @param cancelled whether the work was cancelled (else the worker is only being replaced) */
  constructor(readonly cancelled = false) {
    super(cancelled ? "The job was cancelled" : "The worker was replaced while it was starting");
  }
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
  /** The extension wheels the worker was started with, to tell when it has fallen behind the page. */
  private startedWith: string[] = [];
  /**
   * Counts the starts. A start keeps the worker it makes only if no end() came in the meantime: a
   * worker that is ended while it is starting - the page's extensions changed, a job was cancelled -
   * must neither be left running beside the next one, nor keep the jobs waiting for it waiting.
   */
  private generation = 0;
  /** Settles a start that is still waiting for its worker to say it is ready. */
  private abandonStart: ((cancelled: boolean) => void) | null = null;
  /** Whether the last start was abandoned by cancel() rather than replaced. */
  private startCancelled = false;

  constructor(
    private wheelsURL = new URL("wheels/", document.baseURI).href,
    private extensionWheels: string[] = [],
  ) {}

  /** Whether a job is running now. */
  get busy() {
    return this.current !== null;
  }

  /**
   * The extension wheels a job can import from, as the page has them. An extension installed while
   * the page runs - from the Extensions Manager - is installed into the page's Python at once; the
   * worker has a Python of its own, so a worker started before that has no such wheel and a job of
   * that extension fails to find its own files. One that is not working is ended here, and the next
   * start installs the whole set; one in the middle of a job is left to finish it first (see start()).
   */
  setExtensionWheels(wheels: string[]) {
    this.extensionWheels = [...wheels];
    if (this.behind && !this.busy) this.end();
  }

  /** Whether the worker was started with other wheels than the page has now. */
  private get behind() {
    return this.ready !== null && JSON.stringify(this.startedWith) !== JSON.stringify(this.extensionWheels);
  }

  /** Start the worker and install the wheels in it (kept warm for later jobs). */
  async start(): Promise<void> {
    // A worker that fell behind the page's extensions while it was idle is replaced by one that has them.
    if (this.behind && !this.busy) this.end();
    if (this.ready) return this.ready;
    const generation = ++this.generation;
    const extensionWheels = [...this.extensionWheels];
    this.startedWith = extensionWheels;
    const ready = (async () => {
      const response = await fetch(this.wheelsURL + "index.json");
      const index = (await response.json()) as WheelIndex;
      // Ended while the index was being fetched: no worker is made for a start nobody wants
      if (generation !== this.generation) throw new StartSuperseded(this.startCancelled);
      const wheels = DEFAULT_STARTUP_PACKAGES.map((name) => index.packages.find((p) => p.name === name))
        .filter((p): p is WheelIndex["packages"][0] => Boolean(p))
        .map((p) => new URL(this.wheelsURL + p.file, document.baseURI).href)
        .concat(extensionWheels);
      const slicerVersion = /slicer_core-(\d+\.\d+)/.exec(wheels.join(" "))?.[1] ?? "5.13";

      const worker = new Worker(new URL("./jobWorker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = (event) => this.onMessage(event.data);
      await new Promise<void>((resolve, reject) => {
        // Ended while it was starting (see end()): the worker is gone and will never say it is ready
        this.abandonStart = (cancelled) => reject(new StartSuperseded(cancelled));
        const onReady = (event: MessageEvent) => {
          if (event.data?.type === "ready") {
            worker.removeEventListener("message", onReady);
            resolve();
          } else if (event.data?.type === "failed" && !event.data.id) {
            reject(new Error(event.data.error));
          }
        };
        worker.addEventListener("message", onReady);
        worker.postMessage({
          type: "start",
          pyodideURL: new URL("pyodide/", document.baseURI).href,
          pyodidePackagesURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
          wheels,
          slicerVersion,
          pyodidePackages: ["numpy", "micropip", "packaging"],
        });
      }).finally(() => {
        if (generation === this.generation) this.abandonStart = null;
      });
    })();
    // A start that nobody waits for (one made ahead of the work) may be abandoned without a word
    ready.catch(() => {});
    this.ready = ready;
    return ready;
  }

  /** Start the worker, again if the start waited for was abandoned; the worker that is then running. */
  private async startedWorker(): Promise<Worker> {
    for (;;) {
      try {
        await this.start();
      } catch (error) {
        // Replaced: wait for the worker that replaces it; cancelled: so is the job
        if (error instanceof StartSuperseded && !error.cancelled) continue;
        throw error;
      }
      if (this.worker) return this.worker;
    }
  }

  /** Run a job. Only one runs at a time; the next waits for it. */
  async run(spec: JobSpec, events: JobEvents = {}): Promise<JobResult> {
    const worker = await this.startedWorker();
    const id = String(this.nextId++);
    this.current = id;
    return new Promise<JobResult>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, events });
      const transfer = Object.values(spec.files ?? {}).map((f) => f.buffer);
      worker.postMessage({ type: "run", id, ...spec }, transfer);
    }).finally(() => {
      this.current = null;
    });
  }

  /** Stop the work: the worker is ended, and the next job starts a new one. */
  cancel() {
    if (!this.worker && !this.ready) return;
    this.end(true);
    for (const [, job] of this.jobs) job.reject(new Error("The job was cancelled"));
    this.jobs.clear();
    this.current = null;
  }

  /** End the worker, started or starting; the next start makes a new one. */
  private end(cancelled = false) {
    this.generation++;
    this.startCancelled = cancelled;
    this.abandonStart?.(cancelled);
    this.abandonStart = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
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

/**
 * The job runner of this page, made when it is first needed (starting one costs a few seconds).
 * Given the page's extension wheels, it follows them: a worker that lacks one is replaced before its
 * next job.
 */
let runner: JobRunner | null = null;
export function jobRunner(extensionWheels?: string[]): JobRunner {
  if (!runner) runner = new JobRunner(undefined, extensionWheels ?? []);
  else if (extensionWheels) runner.setExtensionWheels(extensionWheels);
  return runner;
}
