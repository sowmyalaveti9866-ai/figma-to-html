// index.js
import fs from "node:fs";
import path from "node:path";

const FIGMA_API_BASE = "https://api.figma.com/v1";

const CACHE_DIR = ".cache";

function readCache(fileKey) {
  try {
    const p = path.join(CACHE_DIR, `${fileKey}.json`);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch {}
  return null;
}

function writeCache(fileKey, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = path.join(CACHE_DIR, `${fileKey}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 1. Fetch file JSON from Figma
 */
async function getFigmaFile(fileKey, token) {
 const cachePath = path.join("dist", `${fileKey}.json`);

  // If cache exists, reuse it
  if (fs.existsSync(cachePath)) {
    console.log("✅ Using cached Figma JSON:", cachePath);
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }

  console.log("🌐 Fetching Figma file from API...");
  const res = await fetch(`${FIGMA_API_BASE}/files/${fileKey}`, {
    headers: { "X-Figma-Token": token }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma API error ${res.status}: ${text}`);
  }

  const json = await res.json();

  fs.mkdirSync("dist", { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(json, null, 2));

  console.log("✅ Saved cache to:", cachePath);
  return json;
}

/**
 * 2. Normalize Figma nodes into a simpler structure (IR)
 */

function normalizeNode(node, parentX = 0, parentY = 0) {
  const bbox = node.absoluteBoundingBox || {
    x: 0,
    y: 0,
    width: 0,
    height: 0
  };
  const padding = {
  top: node.paddingTop || 0,
  bottom: node.paddingBottom || 0,
  left: node.paddingLeft || 0,
  right: node.paddingRight || 0
};

const layoutMode = node.layoutMode || null; // HORIZONTAL / VERTICAL
const itemSpacing = node.itemSpacing || 0;

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

  let text = null;
  if (node.type === "TEXT") {
    const characters = node.characters || "";
    const style = node.style || {};
    text = { characters, style };
  }

  const children = (node.children || []).map((child) =>
    normalizeNode(child, bbox.x, bbox.y)
  );

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    children,
    x,
    y,
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
  itemSpacing,
  };
}

function fileToIR(file) {
  const pages = file.document.children || [];
  const firstPage = pages[0];

  // Find the *main frame* (the phone screen)
  const mainFrame = (firstPage.children || []).find(n =>
    n.type === "FRAME" && n.name.toLowerCase().includes("frame")
  );

  if (!mainFrame) {
    throw new Error("No main FRAME found.");
  }

  // Normalize ONLY this frame
  return [normalizeNode(mainFrame, mainFrame.absoluteBoundingBox.x, mainFrame.absoluteBoundingBox.y)];
}


/**
 * 3. Style registry helpers
 */

function collectStyles(nodes, registry) {
  for (const node of nodes) {
    // Text styles
    if (node.type === "TEXT" && node.text && node.text.style) {
      const key = JSON.stringify(node.text.style);
      if (!registry.textStyles.has(key)) {
        const style = node.text.style;
        registry.textStyles.set(key, {
          id: "ts-" + registry.textStyles.size,
          style
        });
      }
    }

    // Fill
    const visibleFill = (node.fills || []).find((p) => p.visible !== false);
    if (visibleFill) {
      const key = JSON.stringify(visibleFill);
      if (!registry.fills.has(key)) {
        registry.fills.set(key, {
          id: "fs-" + registry.fills.size,
          paint: visibleFill
        });
      }
    }

    // Stroke
    const strokePaint = (node.strokes || []).find((p) => p.visible !== false);
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

function rgbaFromPaint(paint) {
  if (!paint || paint.type !== "SOLID") return "transparent";
  const { r, g, b } = paint.color;
  const a = paint.opacity !== undefined ? paint.opacity : paint.color.a ?? 1;
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);
  return `rgba(${R}, ${G}, ${B}, ${a.toFixed(3)})`;
}

function gradientFromPaint(paint) {
  if (!paint || !paint.gradientStops) return null;

  const stops = paint.gradientStops
    .map((s) => {
      const col = rgbaFromPaint({
        type: "SOLID",
        color: s.color,
        opacity: s.color.a
      });
      const pos = Math.round((s.position || 0) * 100);
      return `${col} ${pos}%`;
    })
    .join(", ");

  if (paint.type === "GRADIENT_LINEAR") {
    // For simplicity, always 90deg. Good enough for this test.
    return `linear-gradient(90deg, ${stops})`;
  }

  if (paint.type === "GRADIENT_RADIAL") {
    return `radial-gradient(circle, ${stops})`;
  }

  return null;
}

/**
 * 4. Generate CSS
 */

function generateCss(rootNodes, registry) {
  collectStyles(rootNodes, registry);

  const globalCss = `
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
}
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  background: #111111;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.page {
  position: relative;
}
.node {
  position: absolute;
  overflow: hidden;
}
`.trim();

  const textCss = Array.from(registry.textStyles.values())
    .map(({ id, style }) => {
      const lines = [];
      if (style.fontFamily) {
        lines.push(
          `font-family: "${style.fontFamily}", system-ui, -apple-system, sans-serif;`
        );
      }
      if (style.fontSize) lines.push(`font-size: ${style.fontSize}px;`);
      if (style.fontWeight) lines.push(`font-weight: ${style.fontWeight};`);
      if (style.lineHeightPx)
        lines.push(`line-height: ${style.lineHeightPx}px;`);
      if (style.letterSpacing)
        lines.push(`letter-spacing: ${style.letterSpacing}px;`);
      if (style.textAlignHorizontal) {
        const map = {
          LEFT: "left",
          RIGHT: "right",
          CENTER: "center",
          JUSTIFIED: "justify"
        };
        lines.push(
          `text-align: ${map[style.textAlignHorizontal] || "left"};`
        );
      }
      if (style.textCase === "UPPER") {
        lines.push("text-transform: uppercase;");
      }

      return `
.${id} {
  ${lines.join("\n  ")}
}
`.trim();
    })
    .join("\n\n");

  const fillsCss = Array.from(registry.fills.values())
    .map(({ id, paint }) => {
      const gradient = gradientFromPaint(paint);
      const line = gradient
        ? `background: ${gradient};`
        : `background-color: ${rgbaFromPaint(paint)};`;
      return `
.${id} {
  ${line}
}
`.trim();
    })
    .join("\n\n");

  const strokesCss = Array.from(registry.strokes.values())
    .map(({ id, paint, weight }) => {
      const color = rgbaFromPaint(paint);
      return `
.${id} {
  border: ${weight}px solid ${color};
}
`.trim();
    })
    .join("\n\n");

  return [globalCss, textCss, fillsCss, strokesCss].filter(Boolean).join("\n\n");
}

/**
 * Helpers to look up style classes
 */

function findTextClassId(style, registry) {
  if (!style) return null;
  const key = JSON.stringify(style);
  const entry = registry.textStyles.get(key);
  return entry ? entry.id : null;
}

function findFillClassId(node, registry) {
  const visibleFill = (node.fills || []).find((p) => p.visible !== false);
  if (!visibleFill) return null;
  const key = JSON.stringify(visibleFill);
  const entry = registry.fills.get(key);
  return entry ? entry.id : null;
}

function findStrokeClassId(node, registry) {
  const strokePaint = (node.strokes || []).find((p) => p.visible !== false);
  if (!strokePaint || !node.strokeWeight) return null;
  const key = JSON.stringify({ strokePaint, w: node.strokeWeight });
  const entry = registry.strokes.get(key);
  return entry ? entry.id : null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 5. Generate HTML
 */

function nodeToHtml(node, registry, depth = 0) {
  const indent = "  ".repeat(depth);

  const styleParts = [
    `left:${node.x}px`,
    `top:${node.y}px`,
    `width:${node.width}px`,
    `height:${node.height}px`
  ];
  

  if (node.opacity !== undefined && node.opacity !== 1) {
    styleParts.push(`opacity:${node.opacity}`);
  }
  if (node.cornerRadius !== null && node.cornerRadius !== undefined) {
    styleParts.push(`border-radius:${node.cornerRadius}px`);
  }
  if (node.cornerRadii && Array.isArray(node.cornerRadii)) {
    const [tl, tr, br, bl] = node.cornerRadii;
    styleParts.push(`border-radius:${tl}px ${tr}px ${br}px ${bl}px`);
  }
  
  const classes = ["node"];

  // ✅ Only apply background fill for NON-TEXT nodes
if (node.type !== "TEXT") {
    const fillClass = findFillClassId(node, registry);
    console.log("test")
  if (fillClass) classes.push(fillClass);
}

  const strokeClass = findStrokeClassId(node, registry);
  if (strokeClass) classes.push(strokeClass);

  // TEXT node
  if (node.type === "TEXT" && node.text) {
    const textClass = findTextClassId(node.text.style, registry);
    if (textClass) classes.push(textClass);

    // Text color from fills
    const visibleFill = (node.fills || []).find((p) => p.visible !== false);
    let colorStyle = "";
    if (visibleFill && visibleFill.type === "SOLID") {
      colorStyle = `color:${rgbaFromPaint(visibleFill)};`;
    } else {
      colorStyle = `color:#333333;`;
    }

    // Pull some text styles directly (more accurate than relying on class)
    const fontSize = node.text.style?.fontSize
      ? `font-size:${node.text.style.fontSize}px;`
      : "";
    const fontWeight = node.text.style?.fontWeight
      ? `font-weight:${node.text.style.fontWeight};`
      : "";
    const lineHeight = node.text.style?.lineHeightPx
      ? `line-height:${node.text.style.lineHeightPx}px;`
      : "";
    const letterSpacing = node.text.style?.letterSpacing
      ? `letter-spacing:${node.text.style.letterSpacing}px;`
      : "";

    const textAlignH = node.text.style?.textAlignHorizontal
      ? node.text.style.textAlignHorizontal.toLowerCase()
      : "left";

    // ✅ key fix: vertically align text inside its bounding box
    styleParts.push(
      "display:flex",
      "align-items:center", // vertical centering
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

  // Non-text nodes
  const childrenHtml = node.children
    .map((child) => nodeToHtml(child, registry, depth + 1))
    .join("\n");

  if (childrenHtml) {
    return `${indent}<div id="node-${node.id}" class="${classes.join(
      " "
    )}" style="${styleParts.join(";")};">
${childrenHtml}
${indent}</div>`;
  }

  return `${indent}<div id="node-${node.id}" class="${classes.join(
    " "
  )}" style="${styleParts.join(";")};"></div>`;
}

function generateHtml(rootNodes, registry) {
  const pagesHtml = rootNodes
    .map((root) => {
      // page uses root’s size
      const pageStyle = `
        width:${root.width}px;
        height:${root.height}px;
        position:relative;
      `.trim();

      // IMPORTANT: render children only, not root again
      const childrenHtml = root.children
        .map((child) => nodeToHtml(child, registry, 1))
        .join("\n");

      // apply root fill / radius to page
      const rootFillClass =
        root.type !== "TEXT" ? findFillClassId(root, registry) : null;
      const rootStrokeClass = findStrokeClassId(root, registry);

      const rootClasses = ["page"];
      if (rootFillClass) rootClasses.push(rootFillClass);
      if (rootStrokeClass) rootClasses.push(rootStrokeClass);

      let extraPageStyle = "";
      if (root.cornerRadius !== null && root.cornerRadius !== undefined) {
        extraPageStyle += `border-radius:${root.cornerRadius}px; overflow:hidden;`;
      }
      if (root.cornerRadii && Array.isArray(root.cornerRadii)) {
        const [tl, tr, br, bl] = root.cornerRadii;
        extraPageStyle += `border-radius:${tl}px ${tr}px ${br}px ${bl}px; overflow:hidden;`;
      }

      return `
<section class="${rootClasses.join(" ")}" id="page-${root.id}" style="${pageStyle};${extraPageStyle}">
${childrenHtml}
</section>
      `.trim();
    })
    .join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Figma Export</title>
  <link rel="stylesheet" href="styles.css" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
${pagesHtml}
</body>
</html>`;
}

/**
 * 6. Main CLI
 */

async function main() {
  const fileKey = process.argv[2];
  const outDir = process.argv[3] || "dist";
  const token = process.env.FIGMA_TOKEN;

  if (!fileKey) {
    console.error("Usage: node index.js <FILE_KEY> [outDir]");
    process.exit(1);
  }

  if (!token) {
    console.error(
      "Error: FIGMA_TOKEN environment variable is not set. Get a personal access token from Figma."
    );
    process.exit(1);
  }

  console.log("Fetching Figma file...");
  let file = readCache(fileKey);

  if (file) {
    console.log("Loaded Figma file from cache.");
  } else {
    console.log("Fetching Figma file from API...");
    file = await getFigmaFile(fileKey, token);
    writeCache(fileKey, file);
    console.log("Saved to cache.");
  }

  console.log("Normalizing document...");
  const roots = fileToIR(file);

  const registry = {
    textStyles: new Map(),
    fills: new Map(),
    strokes: new Map()
  };

  console.log("Generating CSS...");
  const css = generateCss(roots, registry);

  console.log("Generating HTML...");
  const html = generateHtml(roots, registry);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "styles.css"), css, "utf8");
  fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");

  console.log(`Done! Open ${path.join(outDir, "index.html")} in a browser.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
