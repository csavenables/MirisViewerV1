# MirisViewerV1

MirisViewerV1 is a lightweight web viewer for Miris Gaussian splat assets with fast asset switching, responsive orbit/pan controls, and adaptive zoom extents for clean framing across multiple scans.

## Features

- Load and switch between three Miris splat assets from a simple top toolbar.
- Store and restore per-splat view state when `Zoom Extents` is disabled.
- Adaptive `Zoom Extents` mode with per-splat, per-viewport fit caching.
- Smooth custom interactions:
  - Left-drag orbit
  - Right-drag pan
  - Mouse wheel dolly
  - `Shift + wheel` zoom scaling
- Optional `Auto Spin` presentation mode.

## Getting Started

1. Open a terminal in the project folder.
2. Run:
   ```powershell
   python .\dev-server.py
   ```
3. Open `http://127.0.0.1:8080` in your browser.
4. Update `splat-config.js` with your Miris viewer key and asset UUIDs as needed.

## Controls

- `Splat 1 / Splat 2 / Splat 3`: switch active asset.
- `Auto Spin`: toggle continuous rotation for the active asset.
- `Zoom Extents`: when ON, apply adaptive framing; when OFF, restore saved manual view state.
- Left mouse drag: orbit.
- Right mouse drag: pan.
- Mouse wheel: move nearer/farther.
- `Shift + Mouse wheel`: zoom scale.
