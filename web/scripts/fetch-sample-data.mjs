// Download the sample data sets into the sample data directory served by the application.
// Usage: node scripts/fetch-sample-data.mjs [name...]   (default: all sample data sets)
import path from "node:path";
import fs from "node:fs";

const samples = JSON.parse(fs.readFileSync(new URL("../src/app/sampleData.json", import.meta.url), "utf8"));
const dir = path.resolve(process.env.SLICERWEB_SAMPLE_DATA ?? "D:/SlicerWeb-build/dist/sample-data");
const names = process.argv.slice(2).map((n) => n.toLowerCase());
for (const s of samples) {
  if (names.length && !names.includes(s.name.toLowerCase())) continue;
  const file = path.join(dir, s.fileName);
  if (fs.existsSync(file)) continue;
  console.log(`Downloading ${s.name} -> ${file}`);
  const response = await fetch(s.sourceUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${s.sourceUrl}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file + ".part", Buffer.from(await response.arrayBuffer()));
  fs.renameSync(file + ".part", file);
}
