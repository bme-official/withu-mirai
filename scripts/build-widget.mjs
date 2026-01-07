import { build } from "esbuild";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const entry = path.join(rootDir, "widget-src", "index.ts");
const outDir = path.join(rootDir, "widget-dist");
const outFile = path.join(outDir, "widget.js");

await mkdir(outDir, { recursive: true });

// Workaround: in some sandboxed environments, esbuild cannot truncate an existing output file.
// Deleting first avoids "operation not permitted" on open().
try {
  await unlink(outFile);
} catch {
  // ignore if missing
}

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2018"],
  minify: true,
  sourcemap: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  banner: {
    js: "/*! withu-voice-widget | 1-file embed | MIT */",
  },
});

// Write a tiny marker file to help debugging deployments
await writeFile(path.join(outDir, "BUILD_INFO.txt"), `builtAt=${new Date().toISOString()}\n`);

console.log(`[withu] built widget -> ${outFile}`);


