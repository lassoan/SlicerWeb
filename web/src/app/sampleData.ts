/**
 * Sample data sets (same sources and checksums as Slicer's SampleData module).
 * Files are served from the application origin (sample-data/), because GitHub release downloads
 * do not allow cross-origin requests. The dev server fetches and caches them on first use; for static
 * hosting, run `npm run fetch-sample-data` before `npm run build`.
 */
import samples from "./sampleData.json";

export interface SampleData {
  name: string;
  description: string;
  fileName: string;
  sourceUrl: string;
  url: string;
  properties?: Record<string, unknown>;
}

export const SAMPLE_DATA: SampleData[] = samples.map((s) => ({ ...s, url: `sample-data/${s.fileName}` }));
