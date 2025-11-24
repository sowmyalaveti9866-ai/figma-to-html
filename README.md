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

```powershell
$env:FIGMA_TOKEN="YOUR_FIGMA_PERSONAL_ACCESS_TOKEN"
