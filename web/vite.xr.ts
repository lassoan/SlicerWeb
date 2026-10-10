import type { Plugin, UserConfig } from "vite";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * WebXR: Slicer's 3D view in a headset (docs/webxr.md).
 *
 *  - xr/slicer-xr.js (the Enter VR / Enter AR buttons) and xr/slicer_xr.py (the Python half, which
 *    it loads from beside itself) are served from web/xr/ and copied into the build as they are,
 *    not bundled. The page loads the script only for an application whose application.json has the
 *    feature webxr (main.ts); otherwise the build carries them unused.
 *  - The servers print what the page sends to xr/log: a headset has no console one can read.
 *  - SLICERWEB_HTTPS=1 (slicerweb.py: SW_HTTPS of the env file): the servers use https, with a
 *    certificate made for this computer's names and addresses - WebXR needs a secure page, and a
 *    headset reaches this computer by its address, not by localhost. It is made once and kept in
 *    SLICERWEB_CERT_DIR (default node_modules/.slicerweb-cert), so that a browser that was told to
 *    trust it keeps trusting it.
 */
export function slicerWebXR(): Plugin {
  const https = process.env.SLICERWEB_HTTPS === "1";
  const xrDir = path.resolve("xr");
  const files = ["slicer-xr.js", "slicer_xr.py"];

  /** What the page logs, printed with the address it came from. */
  const logEndpoint = (req: any, res: any, next: any) => {
    if (req.method !== "POST" || !(req.url ?? "").split("?")[0].endsWith("/xr/log")) return next();
    let body = "";
    req.on("data", (chunk: Buffer) => {
      if (body.length < 1e6) body += chunk;
    });
    req.on("end", () => {
      const from = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
      try {
        for (const { level, text } of JSON.parse(body)) console.log(`[page ${from}] ${level}: ${String(text).replace(/\n/g, "\n    ")}`);
      } catch {
        // not a log: nothing to print
      }
      res.statusCode = 204;
      res.end();
    });
  };

  /** With https, the addresses to open on a headset, once the server listens. */
  const announce = (server: any) => {
    if (!https) return;
    server.httpServer?.once("listening", () => {
      const address = server.httpServer.address();
      const port = typeof address === "object" && address ? address.port : "";
      setTimeout(() => {
        for (const a of lanAddresses()) console.log(`  On a headset: https://${a}:${port}/ (accept the certificate warning once)`);
      }, 100);
    });
  };

  return {
    name: "slicerweb-xr",
    config(): UserConfig | undefined {
      if (!https) return undefined;
      const tls = certificate();
      return { server: { https: tls }, preview: { https: tls } };
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({ type: "asset", fileName: `xr/${name}`, source: fs.readFileSync(path.join(xrDir, name)) });
      }
    },
    configureServer(server) {
      server.middlewares.use(logEndpoint);
      announce(server);
    },
    configurePreviewServer(server) {
      server.middlewares.use(logEndpoint);
      announce(server);
    },
  };
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

/** A self-signed certificate for this computer's names and addresses: made again when one is new. */
function certificate(): { key: string; cert: string } {
  const folder = path.resolve(process.env.SLICERWEB_CERT_DIR ?? "node_modules/.slicerweb-cert");
  const keyFile = path.join(folder, "key.pem"), certFile = path.join(folder, "cert.pem"), namesFile = path.join(folder, "names.json");
  const names = ["localhost", os.hostname(), "127.0.0.1", ...lanAddresses()];
  try {
    const kept: string[] = JSON.parse(fs.readFileSync(namesFile, "utf8"));
    if (names.every((n) => kept.includes(n))) return { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") };
  } catch {
    // none yet
  }
  const selfsigned = createRequire(import.meta.url)("selfsigned"); // (its generate() is synchronous in 2.x)
  const altNames = names.map((n) => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? { type: 7, ip: n } : { type: 2, value: n }));
  const pems = selfsigned.generate([{ name: "commonName", value: os.hostname() }], {
    keySize: 2048, days: 825, algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames }, { name: "basicConstraints", cA: false }],
  });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(namesFile, JSON.stringify(names));
  return { key: pems.private, cert: pems.cert };
}
