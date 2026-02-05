const { ipcRenderer, clipboard, nativeImage } = require('electron');

// Global Error Handler
window.onerror = function (message, source, lineno, colno, error) {
    console.error('Renderer Error:', message, source, lineno, colno, error);
    ipcRenderer.invoke('log', `Renderer Error: ${message} at ${lineno}:${colno}`);
};

const fabric = require('fabric');

// Log helper
function log(msg) {
    console.log(msg);
    ipcRenderer.invoke('log', msg);
}

log('Renderer script loaded');

// Initialize Canvas
const canvas = new fabric.Canvas('c', {
    isDrawingMode: false,
    width: window.innerWidth,
    height: window.innerHeight - 50,
    backgroundColor: 'white'
});

log('Canvas initialized');

// =========== UNDO/REDO SYSTEM ===========
let undoStack = [];  // Array of state IDs (not actual states)
let redoStack = [];  // Array of state IDs
let historyLock = false;
let lastActionWasUndoRedo = false;
const MAX_UNDO_STEPS = 100;
const DB_NAME = 'SimpleSkitchDB';
const STORE_NAME = 'history';
let db = null;
let stateCounter = 0;

// Initialize IndexedDB
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onerror = () => {
            log('Error opening IndexedDB');
            reject(request.error);
        };

        request.onsuccess = () => {
            db = request.result;
            log('IndexedDB opened successfully');
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

// Clear all history from IndexedDB
function clearDB() {
    return new Promise((resolve) => {
        if (!db) {
            resolve();
            return;
        }
        try {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();
            request.onsuccess = () => {
                log('IndexedDB cleared');
                resolve();
            };
            request.onerror = () => {
                log('Error clearing IndexedDB');
                resolve();
            };
        } catch (e) {
            log('Error clearing DB: ' + e);
            resolve();
        }
    });
}

// Save state to IndexedDB
function saveStateTooDB(id, state) {
    return new Promise((resolve) => {
        if (!db) {
            resolve();
            return;
        }
        try {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            store.put({ id: id, state: state });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => {
                log('Error saving state to DB');
                resolve();
            };
        } catch (e) {
            log('Error saving to DB: ' + e);
            resolve();
        }
    });
}

// Load state from IndexedDB
function loadStateFromDB(id) {
    return new Promise((resolve) => {
        if (!db) {
            resolve(null);
            return;
        }
        try {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(id);
            request.onsuccess = () => {
                resolve(request.result ? request.result.state : null);
            };
            request.onerror = () => {
                log('Error loading state from DB');
                resolve(null);
            };
        } catch (e) {
            log('Error loading from DB: ' + e);
            resolve(null);
        }
    });
}

// Delete states from IndexedDB that are no longer in stacks
async function cleanupDB() {
    if (!db) return;
    try {
        const validIds = new Set([...undoStack, ...redoStack]);
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAllKeys();
        request.onsuccess = () => {
            const allKeys = request.result;
            allKeys.forEach(key => {
                if (!validIds.has(key)) {
                    store.delete(key);
                }
            });
        };
    } catch (e) {
        log('Error cleaning up DB: ' + e);
    }
}

// Clear history (called by doNew, doOpen, doPaste)
async function clearHistoryStorage() {
    undoStack = [];
    redoStack = [];
    stateCounter = 0;
    await clearDB();
}

// Store actual state data separately (only keep recent in memory)
let stateCache = new Map(); // id -> state string

function captureState() {
    // Get canvas JSON but exclude backgroundImage (we handle it separately)
    const canvasJson = canvas.toJSON([
        'data', 'selectable', 'evented',
        'text', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
        'textAlign', 'lineHeight', 'charSpacing'
    ]);

    // Remove backgroundImage from the JSON to avoid loadFromJSON hanging
    // when trying to reload the large data URL
    delete canvasJson.backgroundImage;

    const state = {
        objects: canvasJson,
        background: null,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height
    };

    // Capture background image with position/scale
    if (canvas.backgroundImage) {
        try {
            const bg = canvas.backgroundImage;
            state.background = {
                dataUrl: bg.toDataURL(),
                left: bg.left || 0,
                top: bg.top || 0,
                scaleX: bg.scaleX || 1,
                scaleY: bg.scaleY || 1
            };
        } catch (e) {
            log('Error capturing background: ' + e);
        }
    }

    return JSON.stringify(state);
}

async function saveHistory() {
    if (historyLock) {
        return;
    }

    const state = captureState();

    // Check for duplicate by comparing with last state
    if (undoStack.length > 0) {
        const lastId = undoStack[undoStack.length - 1];
        const lastState = stateCache.get(lastId) || await loadStateFromDB(lastId);
        if (lastState === state) {
            return;
        }
    }

    // Only clear redo stack if this is a NEW user action
    if (!lastActionWasUndoRedo) {
        redoStack = [];
    }
    lastActionWasUndoRedo = false;

    // Generate new state ID and save
    stateCounter++;
    const stateId = stateCounter;

    undoStack.push(stateId);
    stateCache.set(stateId, state);

    // Save to IndexedDB asynchronously
    saveStateTooDB(stateId, state);

    // Trim stack if too large
    if (undoStack.length > MAX_UNDO_STEPS) {
        const removedId = undoStack.shift();
        stateCache.delete(removedId);
    }

    // Mark as modified if we have more than the check point
    if (undoStack.length > 1) {
        isModified = true;
    }

    // Limit cache size
    if (stateCache.size > 20) {
        const keysToDelete = [...stateCache.keys()].slice(0, stateCache.size - 20);
        keysToDelete.forEach(k => stateCache.delete(k));
    }

    log('History saved. Undo: ' + undoStack.length + ', Redo: ' + redoStack.length);
}

async function getStateById(id) {
    // Check cache first
    if (stateCache.has(id)) {
        return stateCache.get(id);
    }
    // Load from DB
    const state = await loadStateFromDB(id);
    if (state) {
        stateCache.set(id, state);
    }
    return state;
}

async function restoreFromState(stateJson) {
    const state = JSON.parse(stateJson);

    log('Restoring state: hasBackground=' + !!state.background + ', dims=' + state.canvasWidth + 'x' + state.canvasHeight);

    // Restore canvas dimensions if saved
    if (state.canvasWidth && state.canvasHeight) {
        canvas.setDimensions({
            width: state.canvasWidth,
            height: state.canvasHeight
        });
    }

    // Clear canvas
    canvas.clear();
    canvas.backgroundColor = 'white';



    // Load objects (Fabric.js v7 uses Promise-based API, not callbacks)
    try {
        await canvas.loadFromJSON(state.objects);
        log('Objects loaded from JSON');
    } catch (e) {
        log('Error loading objects: ' + e);
    }

    // Then restore background image separately (properly awaited)
    if (state.background && state.background.dataUrl) {
        try {
            const img = await fabric.FabricImage.fromURL(state.background.dataUrl);
            img.set({
                left: state.background.left,
                top: state.background.top,
                scaleX: state.background.scaleX,
                scaleY: state.background.scaleY,
                originX: 'left',
                originY: 'top'
            });
            canvas.backgroundImage = img;
        } catch (e) {
            log('Error restoring background: ' + e);
        }
    }

    canvas.renderAll();
    log('Restore complete. backgroundImage=' + !!canvas.backgroundImage);
}

async function performUndo() {
    // Guard against concurrent undo/redo
    if (historyLock) {
        log('Undo blocked: history lock active');
        return;
    }

    if (undoStack.length <= 1) {
        log('Nothing to undo');
        return;
    }

    // Exit any text editing
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'i-text' && activeObj.isEditing) {
        activeObj.exitEditing();
    }
    canvas.discardActiveObject();

    // Lock and set flag
    historyLock = true;
    lastActionWasUndoRedo = true;

    // Clear any pending debounced save
    if (historyTimeout) {
        clearTimeout(historyTimeout);
        historyTimeout = null;
    }

    // Move current state ID to redo stack
    const currentStateId = undoStack.pop();
    redoStack.push(currentStateId);

    // Get previous state from DB/cache
    const previousStateId = undoStack[undoStack.length - 1];
    const previousState = await getStateById(previousStateId);

    if (previousState) {
        await restoreFromState(previousState);
        log('Undo done. Undo: ' + undoStack.length + ', Redo: ' + redoStack.length);
    } else {
        log('Error: Could not load previous state');
    }

    // Unlock after delay
    setTimeout(() => {
        historyLock = false;
        if (historyTimeout) {
            clearTimeout(historyTimeout);
            historyTimeout = null;
        }
    }, 500);
}

async function performRedo() {
    // Guard against concurrent undo/redo
    if (historyLock) {
        log('Redo blocked: history lock active');
        return;
    }

    if (redoStack.length === 0) {
        log('Nothing to redo');
        return;
    }

    // Exit any text editing
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'i-text' && activeObj.isEditing) {
        activeObj.exitEditing();
    }
    canvas.discardActiveObject();

    // Lock and set flag
    historyLock = true;
    lastActionWasUndoRedo = true;

    // Clear any pending debounced save
    if (historyTimeout) {
        clearTimeout(historyTimeout);
        historyTimeout = null;
    }

    // Get state ID from redo and push to undo
    const redoStateId = redoStack.pop();
    undoStack.push(redoStateId);

    // Get state from DB/cache
    const redoState = await getStateById(redoStateId);

    if (redoState) {
        await restoreFromState(redoState);
        log('Redo done. Undo: ' + undoStack.length + ', Redo: ' + redoStack.length);
    } else {
        log('Error: Could not load redo state');
    }

    // Unlock after delay
    setTimeout(() => {
        historyLock = false;
        if (historyTimeout) {
            clearTimeout(historyTimeout);
            historyTimeout = null;
        }
    }, 500);
}

// Debounced save for canvas events
let historyTimeout = null;
function debouncedHistorySave() {
    if (historyTimeout) clearTimeout(historyTimeout);
    historyTimeout = setTimeout(() => {
        saveHistory();
    }, 150);
}

// Canvas events that trigger history save
canvas.on('object:added', debouncedHistorySave);
canvas.on('object:modified', debouncedHistorySave);
canvas.on('object:removed', debouncedHistorySave);
canvas.on('path:created', debouncedHistorySave);
canvas.on('text:changed', debouncedHistorySave);
canvas.on('text:editing:exited', () => {
    if (historyTimeout) clearTimeout(historyTimeout);
    saveHistory();
});

// Initialize DB and clear history on app start (fresh session)
(async function initHistory() {
    try {
        await initDB();
        await clearDB(); // Clear on app start for fresh session
        log('History DB initialized and cleared for fresh session');
        historyLock = false;
        saveHistory(); // Save initial empty state
    } catch (e) {
        log('Error initializing history: ' + e);
        historyLock = false;
        saveHistory();
    }
})();
// =========== END UNDO/REDO ===========

// Handle window resize
window.addEventListener('resize', () => {
    if (!canvas.backgroundImage) {
        // Only resize base dimensions if we are in "sketchpad" mode (no image)
        originalWidth = window.innerWidth;
        originalHeight = window.innerHeight - 50;
        canvas.setDimensions({
            width: originalWidth * currentZoom,
            height: originalHeight * currentZoom
        });
    }
});

function setZoom(zoom) {
    if (zoom < 0.1) zoom = 0.1;
    if (zoom > 5) zoom = 5;

    currentZoom = zoom;
    canvas.setZoom(zoom);
    canvas.setDimensions({
        width: originalWidth * currentZoom,
        height: originalHeight * currentZoom
    });
    canvas.renderAll();
}

// State
let currentTool = 'select';
let currentColor = '#ff0000';
let currentWidth = 3;
let isDrawing = false;
let startX = 0;
let startY = 0;
let activeShape = null;
let isModified = false;
let currentZoom = 1;
let originalWidth = window.innerWidth;
let originalHeight = window.innerHeight - 50;

// UI Elements
const toolBtns = document.querySelectorAll('.tool-btn');
const colorPicker = document.getElementById('color-picker');
const widthSlider = document.getElementById('width-slider');

// Tool Selection
toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        toolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTool = btn.dataset.tool;
        setTool(currentTool);
        log('Tool selected: ' + currentTool);
    });
});

colorPicker.addEventListener('input', (e) => {
    currentColor = e.target.value;
    if (canvas.freeDrawingBrush) {
        canvas.freeDrawingBrush.color = currentColor;
    }
    const activeObj = canvas.getActiveObject();
    if (activeObj) {
        if (activeObj.type === 'i-text' || activeObj.type === 'path') {
            activeObj.set({ fill: currentColor, stroke: currentColor });
        } else {
            activeObj.set({ stroke: currentColor });
        }
        canvas.requestRenderAll();
    }
});

widthSlider.addEventListener('input', (e) => {
    currentWidth = parseInt(e.target.value, 10);
    if (canvas.freeDrawingBrush) {
        canvas.freeDrawingBrush.width = currentWidth;
    }
});

function setTool(tool) {
    // Disable all special modes first
    canvas.isDrawingMode = false;
    canvas.selection = true;
    canvas.defaultCursor = 'default';
    canvas.hoverCursor = 'move';

    // Make all objects selectable
    canvas.forEachObject(function (obj) {
        obj.selectable = true;
        obj.evented = true;
    });

    if (tool === 'select') {
        // Already set above
    } else if (tool === 'marker' || tool === 'highlighter') {
        canvas.isDrawingMode = true;
        canvas.selection = false;
        canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
        canvas.freeDrawingBrush.color = currentColor;
        canvas.freeDrawingBrush.width = currentWidth;
        if (tool === 'highlighter') {
            const r = parseInt(currentColor.slice(1, 3), 16);
            const g = parseInt(currentColor.slice(3, 5), 16);
            const b = parseInt(currentColor.slice(5, 7), 16);
            canvas.freeDrawingBrush.color = `rgba(${r},${g},${b},0.3)`;
            canvas.freeDrawingBrush.width = currentWidth * 3;
        }
    } else if (tool === 'arrow' || tool === 'rectangle' || tool === 'text' || tool === 'crop' || tool === 'mosaic') {
        canvas.selection = false;
        canvas.defaultCursor = 'crosshair';
        canvas.hoverCursor = 'crosshair';
        // Make objects not selectable when drawing
        canvas.forEachObject(function (obj) {
            obj.selectable = false;
            obj.evented = false;
        });
    }
}

function switchToSelect() {
    currentTool = 'select';
    toolBtns.forEach(b => b.classList.remove('active'));
    document.querySelector('[data-tool="select"]').classList.add('active');
    setTool('select');
    log('Auto-switched to select mode');
}

// Get the upper canvas element for direct event handling
const upperCanvas = document.querySelector('.upper-canvas');

// Direct DOM event handlers for shape drawing
if (upperCanvas) {
    upperCanvas.addEventListener('mousedown', handleMouseDown);
    upperCanvas.addEventListener('mousemove', handleMouseMove);
    upperCanvas.addEventListener('mouseup', handleMouseUp);
    log('Direct DOM events attached to upper-canvas');
}

function handleMouseDown(e) {
    if (currentTool === 'select' || currentTool === 'marker' || currentTool === 'highlighter') return;

    canvas.calcOffset();
    const pointer = canvas.getScenePoint(e);
    startX = pointer.x;
    startY = pointer.y;
    isDrawing = true;

    log('Mouse down at ' + startX.toFixed(0) + ', ' + startY.toFixed(0) + ' with tool: ' + currentTool);

    if (currentTool === 'arrow') {
        activeShape = new fabric.Line([startX, startY, startX, startY], {
            strokeWidth: currentWidth,
            stroke: currentColor,
            selectable: false,
            evented: false
        });
        canvas.add(activeShape);
    } else if (currentTool === 'rectangle') {
        activeShape = new fabric.Rect({
            left: startX,
            top: startY,
            originX: 'left',
            originY: 'top',
            width: 0,
            height: 0,
            stroke: currentColor,
            strokeWidth: currentWidth,
            fill: 'transparent',
            selectable: false,
            evented: false
        });
        canvas.add(activeShape);
    } else if (currentTool === 'crop' || currentTool === 'mosaic') {
        // Create dashed selection rectangle for crop/mosaic
        activeShape = new fabric.Rect({
            left: startX,
            top: startY,
            originX: 'left',
            originY: 'top',
            width: 0,
            height: 0,
            stroke: currentTool === 'crop' ? '#007AFF' : '#FF6B00',
            strokeWidth: 2,
            strokeDashArray: [5, 5],
            fill: 'rgba(0, 122, 255, 0.1)',
            selectable: false,
            evented: false,
            transparentCorners: false
        });
        canvas.add(activeShape);
    } else if (currentTool === 'text') {
        const text = new fabric.IText('Type here', {
            left: startX,
            top: startY,
            fontFamily: 'Arial',
            fill: currentColor,
            fontSize: 20,
            selectable: true,
            evented: true
        });
        canvas.add(text);
        canvas.setActiveObject(text);
        text.enterEditing();
        text.selectAll();
        isDrawing = false;
        // Switch back to select mode after placing text
        switchToSelect();
    }
    canvas.renderAll();
}

function handleMouseMove(e) {
    if (!isDrawing || !activeShape) return;

    const pointer = canvas.getScenePoint(e);
    const currentX = pointer.x;
    const currentY = pointer.y;

    if (currentTool === 'arrow') {
        activeShape.set({ x2: currentX, y2: currentY });
    } else if (currentTool === 'rectangle' || currentTool === 'crop' || currentTool === 'mosaic') {
        let left = startX;
        let top = startY;
        let width = currentX - startX;
        let height = currentY - startY;

        if (width < 0) {
            left = currentX;
            width = Math.abs(width);
        }
        if (height < 0) {
            top = currentY;
            height = Math.abs(height);
        }

        activeShape.set({
            left: left,
            top: top,
            width: width,
            height: height
        });
        activeShape.setCoords(); // Update bounding box for proper display
    }
    canvas.renderAll();
}

function handleMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;

    if (activeShape) {
        log('Shape completed');

        if (currentTool === 'arrow') {
            // Add arrow head
            const headLength = 15;
            const x1 = activeShape.x1;
            const y1 = activeShape.y1;
            const x2 = activeShape.x2;
            const y2 = activeShape.y2;
            const angle = Math.atan2(y2 - y1, x2 - x1);

            const triangle = new fabric.Triangle({
                left: x2,
                top: y2,
                originX: 'center',
                originY: 'center',
                angle: (angle * 180 / Math.PI) + 90,
                width: headLength,
                height: headLength,
                fill: currentColor,
                selectable: false,
                evented: false
            });

            canvas.remove(activeShape);
            const group = new fabric.Group([activeShape, triangle], {
                selectable: true,
                evented: true
            });
            canvas.add(group);
        } else if (currentTool === 'crop') {
            // Execute crop
            executeCrop(activeShape);
            canvas.remove(activeShape);
        } else if (currentTool === 'mosaic') {
            // Execute mosaic
            executeMosaic(activeShape);
            canvas.remove(activeShape);
        } else {
            activeShape.set({ selectable: true, evented: true });
            activeShape.setCoords();
        }
        activeShape = null;

        // Switch to select mode after drawing
        switchToSelect();
    }
    canvas.renderAll();
}

// =========== CROP AND MOSAIC FUNCTIONS ===========
async function executeCrop(selectionRect) {
    const cropLeft = Math.max(0, selectionRect.left);
    const cropTop = Math.max(0, selectionRect.top);
    const cropWidth = Math.min(selectionRect.width, canvas.width - cropLeft);
    const cropHeight = Math.min(selectionRect.height, canvas.height - cropTop);

    if (cropWidth < 10 || cropHeight < 10) {
        log('Crop area too small');
        return;
    }

    log('Executing crop: ' + cropWidth + 'x' + cropHeight + ' at ' + cropLeft + ',' + cropTop);

    historyLock = true;

    try {
        // Remove the selection rectangle temporarily for capture
        canvas.remove(selectionRect);
        canvas.renderAll();

        // Create a temporary canvas to capture the crop area
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = cropWidth;
        tempCanvas.height = cropHeight;
        const tempCtx = tempCanvas.getContext('2d');

        // Get the current canvas as data URL
        const fullDataUrl = canvas.toDataURL({ format: 'png' });

        // Load and crop the image
        const img = new Image();
        img.onload = async () => {
            // Draw the cropped portion
            // We need to scale the source coordinates because fullDataUrl is zoomed
            const scale = currentZoom;
            tempCtx.drawImage(img, cropLeft * scale, cropTop * scale, cropWidth * scale, cropHeight * scale, 0, 0, cropWidth, cropHeight);

            // Get the cropped image data URL
            const croppedDataUrl = tempCanvas.toDataURL('image/png');

            // Clear current canvas and resize logic dimensions
            canvas.clear();
            canvas.backgroundColor = 'white';
            originalWidth = cropWidth;
            originalHeight = cropHeight;

            // Set element dimensions based on current zoom
            canvas.setDimensions({ width: originalWidth * currentZoom, height: originalHeight * currentZoom });

            // Set the cropped image as background
            const fabricImg = await fabric.FabricImage.fromURL(croppedDataUrl);
            fabricImg.set({
                originX: 'left',
                originY: 'top',
                left: 0,
                top: 0,
                scaleX: 1,
                scaleY: 1
            });
            canvas.backgroundImage = fabricImg;
            canvas.renderAll();

            log('Crop completed');

            // Clear history and save new state
            await clearHistoryStorage();
            historyLock = false;
            saveHistory();
        };
        img.src = fullDataUrl;
    } catch (e) {
        log('Error during crop: ' + e);
        historyLock = false;
    }
}

async function executeMosaic(selectionRect) {
    const mosaicLeft = Math.max(0, Math.round(selectionRect.left));
    const mosaicTop = Math.max(0, Math.round(selectionRect.top));
    const mosaicWidth = Math.min(Math.round(selectionRect.width), canvas.width - mosaicLeft);
    const mosaicHeight = Math.min(Math.round(selectionRect.height), canvas.height - mosaicTop);

    if (mosaicWidth < 10 || mosaicHeight < 10) {
        log('Mosaic area too small');
        return;
    }

    log('Executing mosaic: ' + mosaicWidth + 'x' + mosaicHeight + ' at ' + mosaicLeft + ',' + mosaicTop);

    try {
        // Remove the selection rectangle temporarily for capture
        canvas.remove(selectionRect);
        canvas.renderAll();

        // Get the canvas data URL
        const dataUrl = canvas.toDataURL({ format: 'png' });

        // Create temporary canvas to process
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = mosaicWidth;
        tempCanvas.height = mosaicHeight;
        const tempCtx = tempCanvas.getContext('2d');

        const img = new Image();
        img.onload = async () => {
            // Draw the selected portion (scaled)
            const scale = currentZoom;
            tempCtx.drawImage(img, mosaicLeft * scale, mosaicTop * scale, mosaicWidth * scale, mosaicHeight * scale, 0, 0, mosaicWidth, mosaicHeight);

            // Apply pixelation effect
            const blockSize = 10; // Size of mosaic blocks
            const imageData = tempCtx.getImageData(0, 0, mosaicWidth, mosaicHeight);
            const data = imageData.data;

            for (let y = 0; y < mosaicHeight; y += blockSize) {
                for (let x = 0; x < mosaicWidth; x += blockSize) {
                    // Calculate average color in block
                    let r = 0, g = 0, b = 0, count = 0;

                    for (let by = 0; by < blockSize && y + by < mosaicHeight; by++) {
                        for (let bx = 0; bx < blockSize && x + bx < mosaicWidth; bx++) {
                            const idx = ((y + by) * mosaicWidth + (x + bx)) * 4;
                            r += data[idx];
                            g += data[idx + 1];
                            b += data[idx + 2];
                            count++;
                        }
                    }

                    r = Math.round(r / count);
                    g = Math.round(g / count);
                    b = Math.round(b / count);

                    // Fill block with average color
                    for (let by = 0; by < blockSize && y + by < mosaicHeight; by++) {
                        for (let bx = 0; bx < blockSize && x + bx < mosaicWidth; bx++) {
                            const idx = ((y + by) * mosaicWidth + (x + bx)) * 4;
                            data[idx] = r;
                            data[idx + 1] = g;
                            data[idx + 2] = b;
                        }
                    }
                }
            }

            tempCtx.putImageData(imageData, 0, 0);

            // Create fabric image from pixelated data
            const mosaicDataUrl = tempCanvas.toDataURL('image/png');
            const mosaicImg = await fabric.FabricImage.fromURL(mosaicDataUrl);
            mosaicImg.set({
                left: mosaicLeft,
                top: mosaicTop,
                originX: 'left',
                originY: 'top',
                selectable: true,
                evented: true
            });

            canvas.add(mosaicImg);
            canvas.renderAll();

            log('Mosaic completed');
        };
        img.src = dataUrl;
    } catch (e) {
        log('Error during mosaic: ' + e);
    }
}
// =========== END CROP AND MOSAIC ===========

// =========== KEYBOARD SHORTCUTS ===========
window.addEventListener('keydown', (e) => {
    // Don't handle shortcuts if editing text
    const activeObj = canvas.getActiveObject();
    if (activeObj && activeObj.type === 'i-text' && activeObj.isEditing) {
        // Only allow Escape to exit text editing
        if (e.key === 'Escape') {
            activeObj.exitEditing();
            canvas.discardActiveObject();
            canvas.renderAll();
        }
        return;
    }

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

    // Delete/Backspace - Delete selected objects
    if (e.key === 'Delete' || e.key === 'Backspace') {
        const activeObjects = canvas.getActiveObjects();
        if (activeObjects.length) {
            canvas.discardActiveObject();
            activeObjects.forEach((obj) => {
                canvas.remove(obj);
            });
            canvas.requestRenderAll();
            e.preventDefault();
        }
    }

    // Cmd/Ctrl + Z - Undo
    if (ctrlOrCmd && e.key === 'z' && !e.shiftKey) {
        performUndo();
        e.preventDefault();
    }

    // Cmd/Ctrl + Shift + Z or Cmd/Ctrl + Y - Redo
    if ((ctrlOrCmd && e.shiftKey && e.key === 'z') || (ctrlOrCmd && e.key === 'y')) {
        performRedo();
        e.preventDefault();
    }

    // Cmd/Ctrl + C - Copy
    if (ctrlOrCmd && e.key === 'c') {
        doCopy();
        e.preventDefault();
    }

    // Cmd/Ctrl + V - Paste
    if (ctrlOrCmd && e.key === 'v') {
        doPaste();
        e.preventDefault();
    }

    // Cmd/Ctrl + S - Save
    if (ctrlOrCmd && e.key === 's') {
        doSave();
        e.preventDefault();
    }

    // Cmd/Ctrl + O - Open
    if (ctrlOrCmd && e.key === 'o') {
        doOpen();
        e.preventDefault();
    }

    // Cmd/Ctrl + N - New
    if (ctrlOrCmd && e.key === 'n') {
        doNew();
        e.preventDefault();
    }

    // Escape - Deselect / Cancel current drawing
    if (e.key === 'Escape') {
        if (isDrawing && activeShape) {
            canvas.remove(activeShape);
            activeShape = null;
            isDrawing = false;
        }
        canvas.discardActiveObject();
        canvas.renderAll();
        switchToSelect();
    }
});
// =========== END KEYBOARD SHORTCUTS ===========

// =========== IO FUNCTIONS ===========
async function doNew() {
    log('New clicked');

    if (isModified) {
        const confirmed = await ipcRenderer.invoke('show-confirm-dialog', {
            message: 'You have unsaved changes. Are you sure you want to create a new canvas?',
            detail: 'Your current work will be lost.'
        });
        if (!confirmed) return;
    }

    historyLock = true;

    // Reset zoom and dimensions
    currentZoom = 1;
    originalWidth = window.innerWidth;
    originalHeight = window.innerHeight - 50;
    canvas.setZoom(1);
    canvas.setDimensions({
        width: originalWidth,
        height: originalHeight
    });

    canvas.clear();
    canvas.backgroundColor = 'white';
    canvas.backgroundImage = null;
    canvas.requestRenderAll();
    undoStack = [];
    redoStack = [];
    clearHistoryStorage();
    setTimeout(() => {
        historyLock = false;
        saveHistory();
        isModified = false;
    }, 100);
}

async function doOpen() {
    log('Open clicked');

    if (isModified) {
        const confirmed = await ipcRenderer.invoke('show-confirm-dialog', {
            message: 'You have unsaved changes. Are you sure you want to open a new image?',
            detail: 'Your current work will be lost.'
        });
        if (!confirmed) return;
    }

    try {
        const result = await ipcRenderer.invoke('open-image');
        if (!result.canceled) {
            const dataUrl = `data:image/png;base64,${result.data}`;
            log('Loading image...');

            historyLock = true;

            // Clear canvas first
            canvas.clear();
            canvas.backgroundColor = 'white';
            undoStack = [];
            redoStack = [];
            clearHistoryStorage();

            // Use FabricImage.fromURL which returns a Promise in v7
            const img = await fabric.FabricImage.fromURL(dataUrl);

            // Resize canvas to match image
            originalWidth = img.width;
            originalHeight = img.height;
            currentZoom = 1;
            canvas.setZoom(1);
            canvas.setDimensions({
                width: originalWidth,
                height: originalHeight
            });

            img.set({
                originX: 'left',
                originY: 'top',
                scaleX: 1,
                scaleY: 1,
                left: 0,
                top: 0
            });
            canvas.backgroundImage = img;
            canvas.requestRenderAll();

            log('Image loaded successfully');

            setTimeout(() => {
                historyLock = false;
                saveHistory();
                isModified = false;
            }, 200);
        }
    } catch (err) {
        historyLock = false;
        log('Error opening image: ' + err);
    }
}

async function doSave() {
    log('Save clicked');
    canvas.discardActiveObject();
    canvas.renderAll();

    const dataUrl = canvas.toDataURL({ format: 'png' });
    const buffer = Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), 'base64');

    const result = await ipcRenderer.invoke('save-image', buffer);
    if (result.success) {
        log('Saved to ' + result.filePath);
    }
}

async function doCopy() {
    log('Copy clicked');
    canvas.discardActiveObject();
    canvas.renderAll();

    const dataUrl = canvas.toDataURL({ format: 'png' });
    await ipcRenderer.invoke('copy-to-clipboard', dataUrl);
    log('Copied to clipboard!');
}

async function doPaste() {
    log('Paste clicked');
    const image = clipboard.readImage();

    if (!image.isEmpty()) {
        if (isModified) {
            const confirmed = await ipcRenderer.invoke('show-confirm-dialog', {
                message: 'You have unsaved changes. Are you sure you want to paste from clipboard?',
                detail: 'This will replace your current work.'
            });
            if (!confirmed) return;
        }

        try {
            const dataUrl = image.toDataURL();
            log('Pasting image from clipboard...');

            historyLock = true;

            // Clear canvas first
            canvas.clear();
            canvas.backgroundColor = 'white';
            undoStack = [];
            redoStack = [];
            clearHistoryStorage();

            const img = await fabric.FabricImage.fromURL(dataUrl);

            // Resize canvas to match image
            originalWidth = img.width;
            originalHeight = img.height;
            currentZoom = 1;
            canvas.setZoom(1);
            canvas.setDimensions({
                width: originalWidth,
                height: originalHeight
            });

            img.set({
                originX: 'left',
                originY: 'top',
                scaleX: 1,
                scaleY: 1,
                left: 0,
                top: 0
            });
            canvas.backgroundImage = img;
            canvas.requestRenderAll();

            log('Pasted image from clipboard');

            setTimeout(() => {
                historyLock = false;
                saveHistory();
                isModified = false;
            }, 200);
        } catch (err) {
            historyLock = false;
            log('Error pasting image: ' + err);
        }
    } else {
        log('No image in clipboard');
    }
}
// =========== END IO FUNCTIONS ===========

// Button click handlers
document.getElementById('btn-new').addEventListener('click', doNew);
document.getElementById('btn-open').addEventListener('click', doOpen);
document.getElementById('btn-save').addEventListener('click', doSave);
document.getElementById('btn-copy').addEventListener('click', doCopy);
document.getElementById('btn-paste').addEventListener('click', doPaste);
document.getElementById('btn-undo').addEventListener('click', performUndo);
document.getElementById('btn-redo').addEventListener('click', performRedo);
document.getElementById('btn-zoom-in').addEventListener('click', () => {
    setZoom(currentZoom * 1.1);
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
    setZoom(currentZoom / 1.1);
});

// Wait for DOM to be ready, then try to attach events again
setTimeout(() => {
    const upperCanvas = document.querySelector('.upper-canvas');
    if (upperCanvas && !upperCanvas._eventsAttached) {
        upperCanvas.addEventListener('mousedown', handleMouseDown);
        upperCanvas.addEventListener('mousemove', handleMouseMove);
        upperCanvas.addEventListener('mouseup', handleMouseUp);
        upperCanvas._eventsAttached = true;
        log('Direct DOM events attached to upper-canvas (delayed)');
    }
}, 500);

log('All event handlers registered');
log('Keyboard shortcuts: Cmd+Z=Undo, Cmd+Shift+Z=Redo, Cmd+C=Copy, Cmd+V=Paste, Cmd+S=Save, Cmd+O=Open, Cmd+N=New, Escape=Cancel');
