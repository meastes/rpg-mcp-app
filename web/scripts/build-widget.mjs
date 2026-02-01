import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..", "..");

const srcHtmlPath = path.join(root, "web", "src", "widget.html");
const cssPath = path.join(root, "web", "dist", "tailwind.css");
const jsPath = path.join(root, "web", "dist", "widget.js");
const outDir = path.join(root, "web", "dist");
const outHtmlPath = path.join(outDir, "widget.html");

const html = readFileSync(srcHtmlPath, "utf8");
const css = readFileSync(cssPath, "utf8");
const js = readFileSync(jsPath, "utf8");

const marker = "/*__TAILWIND__*/";
if (!html.includes(marker)) {
  throw new Error("Missing Tailwind marker in widget.html");
}

const scriptMarker = "/*__WIDGET_JS__*/";
if (!html.includes(scriptMarker)) {
  throw new Error("Missing widget JS marker in widget.html");
}

const output = html.replace(marker, css).replace(scriptMarker, js);
mkdirSync(outDir, { recursive: true });
writeFileSync(outHtmlPath, output, "utf8");

console.log(`Built widget: ${outHtmlPath}`);
