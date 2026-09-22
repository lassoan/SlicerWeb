"""Work run away from the page, in a worker with a Python of its own.

Desktop Slicer runs its heavy work in other programs: a CLI module is an executable, given its inputs
as files and asked for its outputs. A web page cannot start programs, but it can start a worker, and
that is what a job is here: the same SlicerWeb Python, in a thread of its own, so that the scene, the
views and the user interface keep working while it computes.

A job takes Python to run, values to give it, files to write before it and files to read after it.
It is started and answered later, as a CLI module is::

    def done(result, files):
        slicer.util.loadModel("/work/output.vtp")

    jobs.run("import vtk; result = 2 + 2", onDone=done)

Nothing waits for a job: the page would stop drawing if it did.
"""

import base64
import json
import logging

logger = logging.getLogger("slicerweb.jobs")

_jobs = {}   # id -> callbacks, so that they are not collected while the worker runs


def available():
    """Whether jobs can be run (they cannot outside the browser, e.g. in tests on the desktop)."""
    try:
        import slicerweb_jobs  # noqa: F401
    except ImportError:
        return False
    return True


def busy():
    import slicerweb_jobs

    return bool(slicerweb_jobs.busy())


def start():
    """Start the worker before there is work for it.

    Loading Python and the wheels into a worker takes a few seconds. A panel that is about to give
    it work can ask for it early, so that the wait happens while the user is still choosing.
    """
    if not available():
        return False
    import slicerweb_jobs

    slicerweb_jobs.start()
    return True


def run(code, globals=None, files=None, outputs=None, onDone=None, onFailed=None, onProgress=None,
        onLog=None, packages=None):
    """Run Python in the worker and answer later.

    :param code: Python to run there; what it leaves in ``result`` is given to onDone.
    :param globals: values the code can read by name (must be JSON: numbers, strings, lists, dicts).
    :param files: files to write before it runs, as ``{path: bytes}``.
    :param outputs: paths to read back afterwards; they arrive as ``{path: bytes}``.
    :param onDone: ``onDone(result, files)`` when it finishes.
    :param onFailed: ``onFailed(message)`` if it raises or is cancelled.
    :param onProgress: ``onProgress(message, fraction)`` while it runs.
    :param onLog: ``onLog(level, message)`` for each line the job prints.
    :param packages: Pyodide packages to load in the worker first (e.g. ``["scipy"]``); the ones
        the application itself starts with are already there.
    :return: the job id.
    """
    import slicerweb_jobs

    from .qtcompat import dom  # create_proxy lives with the other JS glue

    jobID = str(len(_jobs) + 1)
    spec = {
        "code": code,
        "globals": globals or {},
        "outputs": list(outputs or []),
        "packages": list(packages or []),
        "files": {path: base64.b64encode(data).decode("ascii") for path, data in (files or {}).items()},
    }

    def done(resultJson):
        _jobs.pop(jobID, None)
        payload = json.loads(resultJson)
        returned = {path: base64.b64decode(data) for path, data in (payload.get("files") or {}).items()}
        if onDone is not None:
            try:
                onDone(payload.get("result"), returned)
            except Exception:
                logger.exception("The answer of job %s could not be handled", jobID)

    def failed(message):
        _jobs.pop(jobID, None)
        logger.error("Job %s failed: %s", jobID, message)
        if onFailed is not None:
            onFailed(str(message))

    def progress(message, fraction):
        if onProgress is not None:
            onProgress(str(message), float(fraction))

    def log(level, message):
        if onLog is not None:
            onLog(str(level), str(message))

    proxies = [dom.proxy(done), dom.proxy(failed), dom.proxy(progress), dom.proxy(log)]
    _jobs[jobID] = proxies
    slicerweb_jobs.run(json.dumps(spec), *proxies)
    return jobID


def cancel():
    """Stop the work: the worker is ended, and the next job starts a new one."""
    import slicerweb_jobs

    slicerweb_jobs.cancel()
    _jobs.clear()
    return True
