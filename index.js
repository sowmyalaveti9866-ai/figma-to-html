/**
 * ============================================================
 * FIGMA → HTML/CSS GENERATOR (with caching)
 * Option C = Fully commented + important lines marked
 * ------------------------------------------------------------
 * RUN COMMANDS (PowerShell):
 *
 * 1) Set token (make sure it is valid):
 *    $env:FIGMA_TOKEN="YOUR_VALID_TOKEN"
 *
 * 2) Run generator:
 *    node index.js YOUR_FILE_KEY
 *
 * 3) Re-run without API hit (uses cache):
 *    node index.js YOUR_FILE_KEY
 *
 * Output:
 *   dist/index.html
 *   dist/styles.css
 *   dist/YOUR_FILE_KEY.json  (cached figma file)
 * ============================================================
 */

import fs from "node:fs";
import path from "node:path";

const FIGMA_API_BASE = "https://api.figma.com/v1";

/**
 * ============================================================
 * CACHE HELPERS
 * ============================================================
 * IMPORTANT: This prevents hitting the Figma API again.
 * We store the JSON in dist/<fileKey>.json
 */
function readCache(fileKey) {
  const cachePath = path.join("dist", `${fileKey}.json`);
  if (fs.existsSync(cachePath)) {
    console.log("✅ Using cached Figma JSON:", cachePath);
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }
  return null;
}

function writeCache(fileKey, data) {
  fs.mkdirSync("dist", { recursive: true });
  const cachePath = path.join("dist", `${fileKey}.json`);
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
  console.log("✅ Saved cache to:", cachePath);
}

/**
 * ============================================================
 * FIX FOR FIGMA API 429 RATE LIMIT
 * ------------------------------------------------------------
 * Retries automatically with exponential backoff.
 * Respects Retry-After header if present.
 * ============================================================
 */
async function fetchWithRetry(url, token, retries = 6) {
  let attempt = 0;

  while (true) {
    const res = await fetch(url, {
      headers: { "X-Figma-Token": token }
    });

    // If success or non-429 errors
    if (res.status !== 429) {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Figma API error ${res.status}: ${text}`);
      }
      return res.json();
    }

    // Handle 429
    attempt++;
    const retryAfter = Number(res.headers.get("Retry-After")) || 0;

    if (attempt > retries) {
      throw new Error(
        "❌ Figma API rate limit exceeded too many times. Try again later."
      );
    }

    // Backoff logic
    const backoffMs = retryAfter
      ? retryAfter * 1000
      : Math.min(1000 * Math.pow(2, attempt), 30000); // 1s → 2s → 4s → 8s… max 30s

    console.log(
      `⚠️  429 Rate limit hit. Retrying in ${backoffMs}ms (attempt ${attempt}/${retries})...`
    );

    await new Promise(r => setTimeout(r, backoffMs));
  }
}

/**
 * ============================================================
 * 1) FETCH FIGMA FILE (API only if no cache)
 * ============================================================
 * IMPORTANT LINES:
 *  - headers: { "X-Figma-Token": token }
 *  - GET /v1/files/:key
 */
async function getFigmaFile(fileKey, token) {
  // ✅ FIRST try cache
  const cached = readCache(fileKey);
  if (cached) return cached;

  // 🌐 If no cache, fetch from API WITH RETRY
  console.log("🌐 Fetching Figma file from API...");
  const url = `${FIGMA_API_BASE}/files/${fileKey}`;
  const json = await fetchWithRetry(url, token);

  writeCache(fileKey, json);
  return json;
}

/**
 * ============================================================
 * 2) NORMALIZE FIGMA NODE → SIMPLE IR NODE
 * ============================================================
 * IMPORTANT:
 *  - Uses absoluteBoundingBox for left/top/width/height
 *  - Parent subtraction gives relative position
 */
function normalizeNode(node, parentX = 0, parentY = 0) {
  const bbox = node.absoluteBoundingBox || {
    x: 0, y: 0, width: 0, height: 0
  };

  // IMPORTANT relative position calc
  const x = bbox.x - parentX;
  const y = bbox.y - parentY;

  const fills = node.fills || [];
  const strokes = node.strokes || [];
  const strokeWeight = node.strokeWeight;
  const effects = node.effects || [];
  const opacity = node.opacity !== undefined ? node.opacity : 1;

  const cornerRadius =
    node.cornerRadius !== undefined ? node.cornerRadius : null;
  const cornerRadii =
    node.rectangleCornerRadii !== undefined ? node.rectangleCornerRadii : null;

  // Layout props (not fully used yet, but good for generalization)
  const padding = {
    top: node.paddingTop || 0,
    bottom: node.paddingBottom || 0,
    left: node.paddingLeft || 0,
    right: node.paddingRight || 0
  };
  const layoutMode = node.layoutMode || null;
  const itemSpacing = node.itemSpacing || 0;

  // TEXT node special handling
  let text = null;
  if (node.type === "TEXT") {
    text = {
      characters: node.characters || "",
      style: node.style || {}
    };
  }

  // Recurse children
  const children = (node.children || []).map((child) =>
    normalizeNode(child, bbox.x, bbox.y)
  );

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    children,
    x, y,
    width: bbox.width,
    height: bbox.height,
    fills,
    strokes,
    strokeWeight,
    effects,
    opacity,
    cornerRadius,
    cornerRadii,
    text,
    padding,
    layoutMode,
    itemSpacing
  };
}

/**
 * ============================================================
 * Extract ONLY the main phone frame from first page
 * ============================================================
 * IMPORTANT:
 *  - We find the first FRAME named "Frame"
 *  - Normalize only that (so output doesn’t include side panels etc.)
 */
function fileToIR(file) {
  const pages = file.document.children || [];
  const firstPage = pages[0];

  const mainFrame = (firstPage.children || []).find(n =>
    n.type === "FRAME" &&
    n.name.toLowerCase().includes("frame")
  );

  if (!mainFrame) throw new Error("❌ No main FRAME found.");

  // IMPORTANT: normalize with its own origin so x/y starts at 0,0
  return [
    normalizeNode(
      mainFrame,
      mainFrame.absoluteBoundingBox.x,
      mainFrame.absoluteBoundingBox.y
    )
  ];
}

/**
 * ============================================================
 * 3) STYLE REGISTRY
 * ============================================================
 * Why: to reuse same CSS class for same style.
 */
function collectStyles(nodes, registry) {
  for (const node of nodes) {
    // TEXT styles
    if (node.type === "TEXT" && node.text?.style) {
      const key = JSON.stringify(node.text.style);
      if (!registry.textStyles.has(key)) {
        registry.textStyles.set(key, {
          id: "ts-" + registry.textStyles.size,
          style: node.text.style
        });
      }
    }

    // Fill styles
    const visibleFill = (node.fills || []).find(p => p.visible !== false);
    if (visibleFill) {
      const key = JSON.stringify(visibleFill);
      if (!registry.fills.has(key)) {
        registry.fills.set(key, {
          id: "fs-" + registry.fills.size,
          paint: visibleFill
        });
      }
    }

    // Border styles
    const strokePaint = (node.strokes || []).find(p => p.visible !== false);
    if (strokePaint && node.strokeWeight) {
      const key = JSON.stringify({ strokePaint, w: node.strokeWeight });
      if (!registry.strokes.has(key)) {
        registry.strokes.set(key, {
          id: "bs-" + registry.strokes.size,
          paint: strokePaint,
          weight: node.strokeWeight
        });
      }
    }

    collectStyles(node.children, registry);
  }
}

/**
 * ============================================================
 * Helper: Convert Figma SOLID paint to rgba()
 * ============================================================
 */
function rgbaFromPaint(paint) {
  if (!paint || paint.type !== "SOLID") return "transparent";
  const { r, g, b } = paint.color;
  const a = paint.opacity ?? paint.color.a ?? 1;
  return `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},${a.toFixed(3)})`;
}

/**
 * ============================================================
 * Helper: Convert Figma gradient to CSS gradient
 * ============================================================
 */
function gradientFromPaint(paint) {
  if (!paint?.gradientStops) return null;

  const stops = paint.gradientStops.map(s => {
    const col = rgbaFromPaint({ type:"SOLID", color:s.color, opacity:s.color.a });
    return `${col} ${Math.round((s.position||0)*100)}%`;
  }).join(", ");

  if (paint.type === "GRADIENT_LINEAR")
    return `linear-gradient(90deg, ${stops})`;

  if (paint.type === "GRADIENT_RADIAL")
    return `radial-gradient(circle, ${stops})`;

  return null;
}

/**
 * ============================================================
 * 4) GENERATE CSS
 * ============================================================
 */
function generateCss(rootNodes, registry) {
  collectStyles(rootNodes, registry);

 
  const globalCss = `
* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  background:#111111;
  display:flex; justify-content:center; align-items:center;
  min-height:100vh;
}
.page { position:relative; }
.node { position:absolute; overflow:visible; } /* IMPORTANT: visible fixes text spacing/cropping */

/* Center the "Forgot password" text */
.forgot-center {
  left: 50% !important;
  transform: translateX(-50%) !important;
  text-align: center;
  width: max-content;
}
`.trim();

  const textCss = [...registry.textStyles.values()].map(({id, style}) => `
.${id}{
  ${style.fontFamily ? `font-family:"${style.fontFamily}", system-ui,sans-serif;` : ""}
  ${style.fontSize ? `font-size:${style.fontSize}px;` : ""}
  ${style.fontWeight ? `font-weight:${style.fontWeight};` : ""}
  ${style.lineHeightPx ? `line-height:${style.lineHeightPx}px;` : ""}
  ${style.letterSpacing ? `letter-spacing:${style.letterSpacing}px;` : ""}
}
`.trim()).join("\n\n");

  const fillsCss = [...registry.fills.values()].map(({id, paint}) => {
    const grad = gradientFromPaint(paint);
    return `
.${id}{
  ${grad ? `background:${grad};` : `background-color:${rgbaFromPaint(paint)};`}
}
`.trim();
  }).join("\n\n");

  const strokesCss = [...registry.strokes.values()].map(({id, paint, weight}) => `
.${id}{
  border:${weight}px solid ${rgbaFromPaint(paint)};
}
`.trim()).join("\n\n");

  return [globalCss, textCss, fillsCss, strokesCss].filter(Boolean).join("\n\n");
}

/**
 * ============================================================
 * Style class lookups
 * ============================================================
 */
function findTextClassId(style, registry) {
  if (!style) return null;
  return registry.textStyles.get(JSON.stringify(style))?.id || null;
}
function findFillClassId(node, registry) {
  const f = (node.fills||[]).find(p=>p.visible!==false);
  if (!f) return null;
  return registry.fills.get(JSON.stringify(f))?.id || null;
}
function findStrokeClassId(node, registry) {
  const s = (node.strokes||[]).find(p=>p.visible!==false);
  if (!s || !node.strokeWeight) return null;
  return registry.strokes.get(JSON.stringify({strokePaint:s, w:node.strokeWeight}))?.id || null;
}

function escapeHtml(str){
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/**
 * ============================================================
 * 5) NODE → HTML (ABSOLUTE LAYOUT)
 * ============================================================
 * IMPORTANT:
 *  - inline style keeps pixel-perfect placement
 *  - TEXT nodes use flex to vertically center within bbox
 */
function nodeToHtml(node, registry, depth=0){
  const indent = "  ".repeat(depth);

  const styleParts = [
    `left:${node.x}px`,
    `top:${node.y}px`,
    `width:${node.width}px`,
    `height:${node.height}px`
  ];

  if (node.opacity !== 1) styleParts.push(`opacity:${node.opacity}`);
  if (node.cornerRadius != null) styleParts.push(`border-radius:${node.cornerRadius}px`);
  if (node.cornerRadii) {
    const [tl,tr,br,bl] = node.cornerRadii;
    styleParts.push(`border-radius:${tl}px ${tr}px ${br}px ${bl}px`);
  }

  const classes = ["node"];

  
// If this is the "Forgot password" text, center it
if (node.name && node.name.toLowerCase().includes("forgot password")) {
  classes.push("forgot-center");
  }

  console.log("test")
  
  // ✅ fill only for non-text
  if (node.type !== "TEXT") {
    const fillClass = findFillClassId(node, registry);
    if (fillClass) classes.push(fillClass);
  }

  const strokeClass = findStrokeClassId(node, registry);
  if (strokeClass) classes.push(strokeClass);

  // TEXT nodes
    // TEXT node
  if (node.type === "TEXT" && node.text) {
    const textStyle = node.text.style || {};
    const textAlignHraw = textStyle.textAlignHorizontal || "LEFT";
    const textAlignH = textAlignHraw.toLowerCase();

    // ✅ Important: if the text is center-aligned in Figma,
    // stretch the wrapper to full width of its parent so it
    // can visually be centered (e.g. "Forgot password").
    if (textAlignH === "center") {
      styleParts[0] = "left:0px";      // override left
      styleParts[2] = "width:100%";    // full width of parent
    }

    const textClass = findTextClassId(textStyle, registry);
    if (textClass) classes.push(textClass);

    // Text color from fills
    const visibleFill = (node.fills || []).find((p) => p.visible !== false);
    let colorStyle = "";
    if (visibleFill && visibleFill.type === "SOLID") {
      colorStyle = `color:${rgbaFromPaint(visibleFill)};`;
    } else {
      colorStyle = `color:#333333;`;
    }

    // Extra font styles pulled straight from Figma
    const fontSize = textStyle.fontSize
      ? `font-size:${textStyle.fontSize}px;`
      : "";
    const fontWeight = textStyle.fontWeight
      ? `font-weight:${textStyle.fontWeight};`
      : "";
    const lineHeight = textStyle.lineHeightPx
      ? `line-height:${textStyle.lineHeightPx}px;`
      : "";
    const letterSpacing = textStyle.letterSpacing
      ? `letter-spacing:${textStyle.letterSpacing}px;`
      : "";

    // Make the wrapper flex so text sits vertically centered in its box
    styleParts.push(
      "display:flex",
      "align-items:center",
      "justify-content:flex-start"
    );

    const textHtml = escapeHtml(node.text.characters);

    return `${indent}<div id="node-${node.id}" class="${classes.join(
      " "
    )}" style="${styleParts.join(";")};">
${indent}  <p style="margin:0;width:100%;white-space:pre-wrap;text-align:${textAlignH};${colorStyle}${fontSize}${fontWeight}${lineHeight}${letterSpacing}">
${textHtml}
${indent}  </p>
${indent}</div>`;
  }


  // Other nodes
  const childrenHtml = node.children.map(c => nodeToHtml(c, registry, depth+1)).join("\n");
  if (childrenHtml){
    return `${indent}<div class="${classes.join(" ")}" style="${styleParts.join(";")}">
${childrenHtml}
${indent}</div>`;
  }

  return `${indent}<div class="${classes.join(" ")}" style="${styleParts.join(";")}"></div>`;
}

/**
 * ============================================================
 * PAGE HTML WRAPPER
 * ============================================================
 */
function generateHtml(rootNodes, registry){
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Figma Export</title>
  <link rel="stylesheet" href="styles.css"/>
</head>
<body>
${rootNodes.map(root=>{
  // Apply root fill/radius to page
  const rootFill = findFillClassId(root, registry);
  const rootStroke = findStrokeClassId(root, registry);
  const pageClasses = ["page", rootFill, rootStroke].filter(Boolean).join(" ");

  const pageStyle = [
    `width:${root.width}px`,
    `height:${root.height}px`,
    `position:relative`,
    ...(root.cornerRadius!=null ? [`border-radius:${root.cornerRadius}px`, "overflow:hidden"] : [])
  ].join(";");

  const childrenHtml = root.children.map(c=>nodeToHtml(c, registry, 1)).join("\n");
  return `<section class="${pageClasses}" style="${pageStyle}">\n${childrenHtml}\n</section>`;
}).join("\n")}
</body>
</html>`;
}

/**
 * ============================================================
 * 6) MAIN CLI
 * ============================================================
 * IMPORTANT:
 *  - fileKey comes from command line
 *  - token comes from env FIGMA_TOKEN
 */
async function main(){
  const fileKey = process.argv[2];
  const outDir = process.argv[3] || "dist";
  const token = process.env.FIGMA_TOKEN;

  if (!fileKey){
    console.error("Usage: node index.js <FILE_KEY> [outDir]");
    process.exit(1);
  }
  if (!token){
    console.error("Error: FIGMA_TOKEN env is not set.");
    process.exit(1);
  }

  console.log("Loading Figma file...");
  const file = await getFigmaFile(fileKey, token);

  console.log("Normalizing...");
  const roots = fileToIR(file);

  const registry = { textStyles:new Map(), fills:new Map(), strokes:new Map() };

  console.log("Generating CSS...");
  const css = generateCss(roots, registry);

  console.log("Generating HTML...");
  const html = generateHtml(roots, registry);

  fs.mkdirSync(outDir, { recursive:true });
  fs.writeFileSync(path.join(outDir,"styles.css"), css, "utf8");
  fs.writeFileSync(path.join(outDir,"index.html"), html, "utf8");

  console.log(`✅ Done! Open ${outDir}/index.html`);
}

main().catch(err=>{
  console.error(err);
  process.exit(1);
});
