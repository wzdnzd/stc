/**
 * 将 src/shared/account-convert.js（ESM 源）同步为
 * public/shared/account-convert.js（浏览器 IIFE → window.AccountConvert）。
 * 请只改 src 侧，再运行 npm run sync:account-convert。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const srcPath = path.join(root, "src", "shared", "account-convert.js");
const outPath = path.join(root, "public", "shared", "account-convert.js");

const src = fs.readFileSync(srcPath, "utf8");

const exportNames = [];
const nameRe =
  /^export\s+(?:async\s+)?(?:function\s+|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/gm;
let m;
while ((m = nameRe.exec(src))) {
  exportNames.push(m[1]);
}

if (!exportNames.length) {
  console.error("未在 src/shared/account-convert.js 中解析到 export 符号");
  process.exit(1);
}

let body = src
  .replace(/^export\s+async\s+function\s+/gm, "async function ")
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+class\s+/gm, "class ")
  .replace(/^export\s+const\s+/gm, "const ")
  .replace(/^export\s+let\s+/gm, "let ")
  .replace(/^export\s+var\s+/gm, "var ")
  .replace(/^export\s+\{[^}]+\}\s*;?\s*$/gm, "");

const unique = [...new Set(exportNames)];
const assign = unique.map((name) => `    ${name},`).join("\n");

const out = `/* SUB2API ↔ CPA 转换共享模块（浏览器）。由 src/shared/account-convert.js 同步生成，请勿手改逻辑。 */
(function (global) {
  "use strict";
${body
  .split("\n")
  .map((line) => (line.length ? `  ${line}` : ""))
  .join("\n")}

  global.AccountConvert = {
${assign}
  };
})(typeof window !== "undefined" ? window : globalThis);
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.replace(/\r\n/g, "\n"), "utf8");
console.log(
  `synced ${path.relative(root, outPath)} (${unique.length} exports) from ${path.relative(root, srcPath)}`
);
