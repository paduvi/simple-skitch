# Simple Skitch

A lightweight, Electron-based screen capture and annotation tool inspired by Skitch. Built with [Fabric.js](http://fabricjs.com/).

## Features

-   **Image Loading**:
    -   Open images from your local file system (`Cmd+O`).
    -   Paste images directly from your clipboard (`Cmd+V`).
    -   Canvas automatically resizes to fit the image dimensions without scaling.
-   **Annotation Tools**:
    -   **Arrow**: Draw arrows to point out details.
    -   **Rectangle**: Highlight areas with boxes.
    -   **Text**: Add text labels.
    -   **Marker**: Freehand drawing.
    -   **Highlighter**: Translucent freehand highlighting.
    -   **Crop**: Select and crop image to specific area.
    -   **Mosaic**: Pixelate sensitive information.
-   **View Controls**:
    -   **Zoom**: Zoom in/out (`+`/`-` buttons) for detailed work.
    -   **Scroll**: Automatically enabled when canvas exceeds window size.
-   **Safety**:
    -   **Discard Warning**: Confirmation dialog prevents accidental loss of unsaved changes.
-   **Customization**:
    -   Choose any color.
    -   Adjust stroke width.
-   **History**: Robust Undo/Redo system (`Cmd+Z` / `Cmd+Shift+Z`) backed by IndexedDB.
-   **Export**:
    -   Save annotated images to disk (`Cmd+S`).
    -   Copy annotated images to clipboard (`Cmd+C`).

## Getting Started

### Prerequisites
-   Node.js (v14 or higher recommended)
-   npm

### Installation

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```

### Running the App

Start the application in development mode:
```bash
npm start
```

### Building for Production

To create a distributable application:
```bash
npm run pack
```

## Keyboard Shortcuts

| Action | Shortcut (Mac) |
| :--- | :--- |
| **New Canvas** | `Cmd + N` |
| **Open Image** | `Cmd + O` |
| **Save Image** | `Cmd + S` |
| **Copy to Clipboard** | `Cmd + C` |
| **Paste from Clipboard** | `Cmd + V` |
| **Undo** | `Cmd + Z` |
| **Redo** | `Cmd + Shift + Z` or `Cmd + Y` |
| **Delete Object** | `Delete` or `Backspace` |
| **Cancel / Deselect** | `Escape` |

## Technologies

-   [Electron](https://www.electronjs.org/)
-   [Fabric.js](http://fabricjs.com/) (v7)
