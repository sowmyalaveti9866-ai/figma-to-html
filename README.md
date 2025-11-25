# Figma to HTML/CSS Generator (Softlight Take-Home)

This repository contains a small system that converts a Figma design into HTML/CSS
with pixel-level visual fidelity. The generator is general-purpose and can be
run on other Figma mocks as well.

## What this does
1. Fetches a Figma file via the Figma REST API.
2. Normalizes the Figma node tree into a layout-friendly structure.
3. Generates:
   - `dist/index.html`
   - `dist/styles.css`
4. Uses absolute positioning from Figma bounding boxes to ensure the HTML
   matches the mock visually.

## How to run

### 1) Set your Figma token
PowerShell:

$env:FIGMA_TOKEN="YOUR_FIGMA_PERSONAL_ACCESS_TOKEN"

### 2. Run the generator
node index.js YOUR_FIGMA_FILE_KEY

Output will appear in the dist/ folder.

### ⚠️ Known Limitations

1. Rate-limited (429) responses if the Figma API is hit repeatedly — use the built-in cache before retrying.

2. Some Figma features (Auto-layout, constraints, responsive rules, components, variants, rotations, blend modes) are not fully supported.

3. Uses absolute positioning only — resulting HTML is not responsive.

4. Gradient directions simplified (e.g., default 90° for linear gradients).

5. Text vertical alignment may vary slightly between browsers and Figma.

6. Designed for mock-fidelity, not production-ready UI.

### Output

<img width="1913" height="976" alt="image" src="https://github.com/user-attachments/assets/c9efed1b-8893-4011-be1e-633902bcb6e4" />
