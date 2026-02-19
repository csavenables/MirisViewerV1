import { MIRIS_ASSETS, MIRIS_VIEWER_KEY } from "./splat-config.js";

const viewerStage = document.getElementById("viewer-stage");
const controlsRoot = document.getElementById("controls");

if (!viewerStage || !controlsRoot) {
  throw new Error("Missing required DOM elements.");
}

if (!MIRIS_VIEWER_KEY || !Array.isArray(MIRIS_ASSETS) || MIRIS_ASSETS.length !== 3) {
  throw new Error("Invalid Miris config. Check splat-config.js.");
}

await customElements.whenDefined("miris-scene");
await customElements.whenDefined("miris-stream");

const sceneEl = document.createElement("miris-scene");
sceneEl.setAttribute("key", MIRIS_VIEWER_KEY);
sceneEl.style.width = "100%";
sceneEl.style.height = "100%";

const streamEl = document.createElement("miris-stream");
sceneEl.appendChild(streamEl);
viewerStage.appendChild(sceneEl);

let activeAssetId = "";
let zoomExtentsEnabled = true;
let autoSpinEnabled = false;

const manualStateByAssetId = new Map();
const fitProfileByAssetId = new Map();

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 3.5;
const MIN_Z = -22;
const MAX_Z = -0.75;

const ROTATE_SPEED_X = 0.0065;
const ROTATE_SPEED_Y = 0.008;
const ROTATE_PITCH_MIN = -1.2;
const ROTATE_PITCH_MAX = 1.2;
const AUTO_SPIN_SPEED = 0.012;

const TARGET_FILL_MIN = 0.78;
const TARGET_FILL_MAX = 0.88;
const TARGET_CENTER_Y = 0.14;
const MAX_FIT_STEPS = 22;
const MAX_BOOT_FRAMES = 55;

let activeFitToken = 0;

let renderCanvasCache = null;
const sampleCanvas = document.createElement("canvas");
sampleCanvas.width = 192;
sampleCanvas.height = 108;
const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cloneState(state) {
  return {
    x: Number(state.x) || 0,
    y: Number(state.y) || 0,
    z: Number(state.z) || -5,
    zoom: clamp(Number(state.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    rotationX: clamp(Number(state.rotationX) || 0, ROTATE_PITCH_MIN, ROTATE_PITCH_MAX),
    rotationY: Number(state.rotationY) || 0,
    rotationZ: Number(state.rotationZ) || 0
  };
}

function getAssetById(assetId) {
  return MIRIS_ASSETS.find((asset) => asset.id === assetId);
}

function setActiveButton(assetId) {
  controlsRoot.querySelectorAll("button[data-asset-id]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.assetId === assetId);
  });
}

function getDistanceFromAssetDefaults(asset) {
  const cam = Array.isArray(asset?.defaultCameraPosition) ? asset.defaultCameraPosition : [0, 1, 5];
  const target = Array.isArray(asset?.defaultTarget) ? asset.defaultTarget : [0, 0, 0];
  const dx = Number(cam[0]) - Number(target[0]);
  const dy = Number(cam[1]) - Number(target[1]);
  const dz = Number(cam[2]) - Number(target[2]);
  const distance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
  return Number.isFinite(distance) && distance > 0 ? distance : 5;
}

function getDefaultViewState(asset) {
  const configuredPosition = Array.isArray(asset?.defaultStreamPosition) && asset.defaultStreamPosition.length === 3
    ? asset.defaultStreamPosition
    : null;
  const configuredZoom = Number.isFinite(Number(asset?.defaultStreamZoom))
    ? Number(asset.defaultStreamZoom)
    : null;

  if (configuredPosition) {
    return {
      x: Number(configuredPosition[0]) || 0,
      y: Number(configuredPosition[1]) || 0,
      z: Number(configuredPosition[2]) || -6,
      zoom: clamp(configuredZoom ?? 0.62, MIN_ZOOM, MAX_ZOOM),
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0
    };
  }

  const defaultTargetY = Array.isArray(asset?.defaultTarget) && Number.isFinite(Number(asset.defaultTarget[1]))
    ? Number(asset.defaultTarget[1])
    : 0;
  const defaultDistance = getDistanceFromAssetDefaults(asset);
  const defaultZ = -clamp(defaultDistance * 1.1, 4.2, 9.8);

  return {
    x: 0,
    y: -defaultTargetY * 0.65,
    z: defaultZ,
    zoom: 0.62,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0
  };
}

function readCurrentViewState() {
  return {
    x: Number(streamEl.position?.x) || 0,
    y: Number(streamEl.position?.y) || 0,
    z: Number(streamEl.position?.z) || -5,
    zoom: clamp(Number(streamEl.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    rotationX: Number(streamEl.rotation?.x) || 0,
    rotationY: Number(streamEl.rotation?.y) || 0,
    rotationZ: Number(streamEl.rotation?.z) || 0
  };
}

function applyViewState(state) {
  const safe = cloneState(state);
  streamEl.position.set(safe.x, safe.y, clamp(safe.z, MIN_Z, MAX_Z));
  streamEl.zoom = safe.zoom;
  streamEl.rotation.set(safe.rotationX, safe.rotationY, safe.rotationZ);
}

function saveActiveManualState() {
  if (!activeAssetId) return;
  manualStateByAssetId.set(activeAssetId, cloneState(readCurrentViewState()));
}

function saveManualStateForActive(state) {
  if (!activeAssetId) return;
  manualStateByAssetId.set(activeAssetId, cloneState(state));
}

function getViewportKey() {
  const widthBucket = Math.max(1, Math.round(viewerStage.clientWidth / 160));
  const heightBucket = Math.max(1, Math.round(viewerStage.clientHeight / 120));
  return `${widthBucket}x${heightBucket}`;
}

function getCachedFit(assetId) {
  const profile = fitProfileByAssetId.get(assetId);
  if (!profile) return null;
  if (profile.viewportKey !== getViewportKey()) return null;
  return cloneState(profile.state);
}

function setCachedFit(assetId, state) {
  fitProfileByAssetId.set(assetId, {
    viewportKey: getViewportKey(),
    state: cloneState(state)
  });
}

function invalidateFitsForViewportChange() {
  fitProfileByAssetId.clear();
}

function getRenderCanvas() {
  if (renderCanvasCache && renderCanvasCache.isConnected) {
    return renderCanvasCache;
  }

  const direct = viewerStage.querySelector("canvas");
  if (direct) {
    renderCanvasCache = direct;
    return renderCanvasCache;
  }

  if (sceneEl.shadowRoot) {
    const shadowCanvas = sceneEl.shadowRoot.querySelector("canvas");
    if (shadowCanvas) {
      renderCanvasCache = shadowCanvas;
      return renderCanvasCache;
    }
  }

  return null;
}

function measureFill() {
  if (!sampleCtx) return null;
  const canvas = getRenderCanvas();
  if (!canvas || canvas.width < 4 || canvas.height < 4) return null;

  const targetWidth = sampleCanvas.width;
  const targetHeight = sampleCanvas.height;

  sampleCtx.clearRect(0, 0, targetWidth, targetHeight);
  sampleCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
  const data = sampleCtx.getImageData(0, 0, targetWidth, targetHeight).data;

  let minX = targetWidth;
  let minY = targetHeight;
  let maxX = -1;
  let maxY = -1;
  let hitCount = 0;

  // The scene background is near black, so count meaningful color/alpha samples as splat coverage.
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const i = ((y * targetWidth) + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const luminance = (r + g + b) / 3;
      if (a < 6 || luminance < 6) continue;

      hitCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (hitCount < 120 || maxX < minX || maxY < minY) {
    return null;
  }

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const widthRatio = boxWidth / targetWidth;
  const heightRatio = boxHeight / targetHeight;
  const centerY = ((minY + maxY + 1) / 2 / targetHeight) - 0.5;
  const areaRatio = (boxWidth * boxHeight) / (targetWidth * targetHeight);

  return {
    widthRatio,
    heightRatio,
    centerY,
    areaRatio
  };
}

function raf() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function runFitSolver(assetId, seedState) {
  const token = ++activeFitToken;
  let state = cloneState(seedState);
  applyViewState(state);

  // Allow stream startup to produce a measurable frame.
  let measurement = null;
  for (let i = 0; i < MAX_BOOT_FRAMES; i += 1) {
    await raf();
    if (token !== activeFitToken || activeAssetId !== assetId || !zoomExtentsEnabled) return;
    measurement = measureFill();
    if (measurement) break;

    // Fallback ramp: if we still cannot measure, push in progressively.
    state.z = clamp(state.z + 0.55, MIN_Z, MAX_Z);
    state.zoom = clamp(state.zoom * 1.08, MIN_ZOOM, MAX_ZOOM);
    applyViewState(state);
  }

  if (!measurement) {
    setCachedFit(assetId, state);
    applyViewState(state);
    return;
  }

  for (let step = 0; step < MAX_FIT_STEPS; step += 1) {
    if (token !== activeFitToken || activeAssetId !== assetId || !zoomExtentsEnabled) return;

    const fill = measurement.heightRatio;
    const centerErr = measurement.centerY - TARGET_CENTER_Y;

    const centered = Math.abs(centerErr) < 0.02;
    const filled = fill >= TARGET_FILL_MIN && fill <= TARGET_FILL_MAX;
    if (centered && filled) {
      break;
    }

    // Bias subject lower in frame so origin reads nearer bottom-center.
    state.y = clamp(state.y + (centerErr * Math.abs(state.z) * -0.16), -8, 8);

    if (fill < TARGET_FILL_MIN) {
      // Move closer and scale up.
      state.z = clamp(state.z + clamp((TARGET_FILL_MIN - fill) * 3.2, 0.18, 0.95), MIN_Z, MAX_Z);
      state.zoom = clamp(state.zoom * 1.045, MIN_ZOOM, MAX_ZOOM);
    } else if (fill > TARGET_FILL_MAX) {
      // Move farther and slightly scale down.
      state.z = clamp(state.z - clamp((fill - TARGET_FILL_MAX) * 3.8, 0.24, 1.2), MIN_Z, MAX_Z);
      state.zoom = clamp(state.zoom * 0.955, MIN_ZOOM, MAX_ZOOM);
    }

    applyViewState(state);
    await raf();
    measurement = measureFill();
    if (!measurement) break;
  }

  if (token !== activeFitToken || activeAssetId !== assetId || !zoomExtentsEnabled) return;
  setCachedFit(assetId, state);
  applyViewState(state);
}

async function fitActiveAsset() {
  const asset = getAssetById(activeAssetId);
  if (!asset) return;
  const cached = getCachedFit(activeAssetId);
  const seed = cached ?? getDefaultViewState(asset);
  await runFitSolver(activeAssetId, seed);
}

function setActiveAsset(assetId) {
  const selected = getAssetById(assetId);
  if (!selected) return;

  if (activeAssetId === assetId) {
    if (zoomExtentsEnabled) {
      fitActiveAsset();
    }
    return;
  }

  saveActiveManualState();
  setActiveButton(assetId);
  streamEl.uuid = selected.uuid;
  activeAssetId = assetId;

  const cachedFit = getCachedFit(assetId);
  const defaultView = getDefaultViewState(selected);
  const manualView = manualStateByAssetId.get(assetId);

  if (zoomExtentsEnabled) {
    applyViewState(cachedFit ?? defaultView);
    fitActiveAsset();
  } else {
    applyViewState(manualView ?? cachedFit ?? defaultView);
  }
}

MIRIS_ASSETS.forEach((asset) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = asset.label;
  button.dataset.assetId = asset.id;
  button.addEventListener("click", () => {
    setActiveAsset(asset.id);
  });
  controlsRoot.appendChild(button);
});

function createViewControlButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "view-tool";
  button.textContent = label;
  button.addEventListener("click", onClick);
  controlsRoot.appendChild(button);
}

createViewControlButton("Auto Spin", () => {
  autoSpinEnabled = !autoSpinEnabled;
});

function createZoomExtentsToggle() {
  const label = document.createElement("label");
  label.className = "view-tool-toggle";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = zoomExtentsEnabled;
  input.addEventListener("change", () => {
    zoomExtentsEnabled = input.checked;
    if (zoomExtentsEnabled && activeAssetId) {
      fitActiveAsset();
    }
  });

  const text = document.createElement("span");
  text.textContent = "Zoom Extents";

  label.appendChild(input);
  label.appendChild(text);
  controlsRoot.appendChild(label);
}

createZoomExtentsToggle();

viewerStage.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

let isPanning = false;
let isRotating = false;
let panPointerId = null;
let rotatePointerId = null;
let lastPanX = 0;
let lastPanY = 0;
let lastRotateX = 0;
let lastRotateY = 0;

viewerStage.addEventListener("pointerdown", (event) => {
  // Cancel any in-flight auto-fit as soon as user takes control.
  activeFitToken += 1;

  if (event.button === 0) {
    isRotating = true;
    rotatePointerId = event.pointerId;
    lastRotateX = event.clientX;
    lastRotateY = event.clientY;
    viewerStage.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }

  if (event.button !== 2) return;
  isPanning = true;
  panPointerId = event.pointerId;
  lastPanX = event.clientX;
  lastPanY = event.clientY;
  viewerStage.setPointerCapture(event.pointerId);
  event.preventDefault();
});

viewerStage.addEventListener("pointermove", (event) => {
  if (isRotating && event.pointerId === rotatePointerId && activeAssetId) {
    const dx = event.clientX - lastRotateX;
    const dy = event.clientY - lastRotateY;
    lastRotateX = event.clientX;
    lastRotateY = event.clientY;

    const current = readCurrentViewState();
    current.rotationY += dx * ROTATE_SPEED_Y;
    current.rotationX = clamp(current.rotationX + (dy * ROTATE_SPEED_X), ROTATE_PITCH_MIN, ROTATE_PITCH_MAX);

    applyViewState(current);
    saveManualStateForActive(current);
    event.preventDefault();
    return;
  }

  if (!isPanning || event.pointerId !== panPointerId || !activeAssetId) return;

  const dx = event.clientX - lastPanX;
  const dy = event.clientY - lastPanY;
  lastPanX = event.clientX;
  lastPanY = event.clientY;

  const current = readCurrentViewState();
  const panScale = clamp(Math.abs(current.z) * 0.0018, 0.002, 0.014);
  current.x += dx * panScale;
  current.y -= dy * panScale;

  applyViewState(current);
  saveManualStateForActive(current);
  event.preventDefault();
});

function endPointer(event) {
  if (isPanning && event.pointerId === panPointerId) {
    isPanning = false;
    panPointerId = null;
  }

  if (isRotating && event.pointerId === rotatePointerId) {
    isRotating = false;
    rotatePointerId = null;
  }

  event.preventDefault();
}

viewerStage.addEventListener("pointerup", endPointer);
viewerStage.addEventListener("pointercancel", endPointer);

viewerStage.addEventListener("dblclick", () => {
  if (!activeAssetId) return;
  fitActiveAsset();
});

viewerStage.addEventListener("wheel", (event) => {
  if (!activeAssetId) return;

  activeFitToken += 1;

  const current = readCurrentViewState();
  const wheelUnit = clamp(Math.abs(event.deltaY) / 120, 0.4, 3);

  if (event.shiftKey) {
    const zoomMultiplier = event.deltaY < 0 ? 1 + (0.08 * wheelUnit) : 1 / (1 + (0.08 * wheelUnit));
    current.zoom = clamp(current.zoom * zoomMultiplier, MIN_ZOOM, MAX_ZOOM);
  } else {
    current.z = clamp(current.z - (event.deltaY * 0.018), MIN_Z, MAX_Z);
  }

  applyViewState(current);
  saveManualStateForActive(current);
  event.preventDefault();
}, { passive: false });

let lastViewportKey = getViewportKey();
window.addEventListener("resize", () => {
  const currentKey = getViewportKey();
  if (currentKey === lastViewportKey) return;
  lastViewportKey = currentKey;
  invalidateFitsForViewportChange();
  if (zoomExtentsEnabled && activeAssetId) {
    fitActiveAsset();
  }
}, { passive: true });

function animate() {
  if (autoSpinEnabled && activeAssetId && !isRotating) {
    const current = readCurrentViewState();
    current.rotationY += AUTO_SPIN_SPEED;
    applyViewState(current);
    saveManualStateForActive(current);
  }

  requestAnimationFrame(animate);
}
animate();

setActiveAsset(MIRIS_ASSETS[0].id);
