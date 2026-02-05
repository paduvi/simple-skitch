const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, dialog, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let tray = null;

if (process.platform === 'darwin') {
    app.setName('Simple Skitch');
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'assets', 'logo.png'),
        // frame: false, // Optional: for custom look
        // transparent: true, // Optional: for transparency
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false // For simplicity in this prototype. Better to use preload in prod.
        },
        show: false // Don't show until ready
    });

    if (process.platform === 'darwin') {
        const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo.png'));
        app.dock.setIcon(icon);
    }

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });
}

function createTray() {
    // Create a simple icon
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));

    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('Simple Skitch');

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show App', click: () => mainWindow.show() },
        { type: 'separator' },
        {
            label: 'Quit', click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
        }
    });
}

// IPC Handlers
ipcMain.handle('log', (event, msg) => {
    console.log(msg);
});

ipcMain.handle('save-image', async (event, buffer) => {
    const { filePath } = await dialog.showSaveDialog({
        buttonLabel: 'Save Image',
        defaultPath: `skitch-${Date.now()}.png`,
        filters: [{ name: 'Images', extensions: ['png', 'jpg'] }]
    });

    if (filePath) {
        fs.writeFileSync(filePath, buffer);
        return { success: true, filePath };
    }
    return { canceled: true };
});

ipcMain.handle('open-image', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['jpg', 'png', 'gif'] }]
    });
    if (canceled) {
        return { canceled: true };
    } else {
        const data = fs.readFileSync(filePaths[0]);
        return { canceled: false, data: data.toString('base64'), filePath: filePaths[0] };
    }
});

ipcMain.handle('show-confirm-dialog', async (event, options) => {
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        title: 'Confirm',
        message: options.message,
        detail: options.detail
    });
    return result.response === 0;
});

ipcMain.handle('copy-to-clipboard', async (event, dataUrl) => {
    const image = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(image);
    return { success: true };
});

app.whenReady().then(() => {
    createWindow();
    createTray();

    // Show window on activate
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else mainWindow.show();
    });
});

app.on('before-quit', () => {
    app.isQuitting = true;
});
