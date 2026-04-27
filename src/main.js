const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");

const { startServer } = require("../server");
const {
  createDefaultConfig,
  loadConfig,
  saveConfig,
} = require("./config");

let mainWindow;
let serverHandle;
let config;
let updateCheckInFlight = false;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#111413",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL(url);
}

function sendUpdateStatus(status) {
  mainWindow?.webContents.send("update-status", {
    at: new Date().toISOString(),
    ...status,
  });
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    const message = "Update checks are only available in the installed app.";
    sendUpdateStatus({ state: "idle", message });
    return { ok: false, message };
  }

  if (updateCheckInFlight) {
    const message = "Already checking for updates.";
    sendUpdateStatus({ state: "checking", message });
    return { ok: true, message };
  }

  updateCheckInFlight = true;
  sendUpdateStatus({ state: "checking", message: "Checking for updates..." });
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo || null };
  } catch (error) {
    const message = `Update check failed: ${error.message}`;
    sendUpdateStatus({ state: "error", message });
    if (manual) dialog.showErrorBox("Update Check Failed", error.message);
    return { ok: false, message };
  } finally {
    updateCheckInFlight = false;
  }
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Choose Vampire Crawlers Install...",
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ["openDirectory"],
              title: "Choose Vampire Crawlers install folder",
            });
            if (!result.canceled && result.filePaths[0]) {
              config.gameDir = result.filePaths[0];
              saveConfig(config, app.getPath("userData"));
            }
          },
        },
        {
          label: "Choose Save File...",
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ["openFile"],
              title: "Choose Vampire Crawlers save file",
              filters: [{ name: "Vampire Crawlers Save", extensions: ["save", "*"] }],
            });
            if (!result.canceled && result.filePaths[0]) {
              config.savePath = result.filePaths[0];
              saveConfig(config, app.getPath("userData"));
            }
          },
        },
        { type: "separator" },
        {
          label: "Rebuild Local Data",
          click: async () => {
            try {
              await rebuildLocalData();
              dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "Local Data Rebuilt",
                message: "Local art and cost data were rebuilt successfully.",
              });
            } catch (error) {
              dialog.showErrorBox("Rebuild Local Data Failed", error.message);
            }
          },
        },
        { type: "separator" },
        {
          label: "Check for Updates",
          click: () => checkForUpdates(true),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

autoUpdater.autoDownload = true;

autoUpdater.on("checking-for-update", () => {
  sendUpdateStatus({ state: "checking", message: "Checking for updates..." });
});

autoUpdater.on("update-available", (info) => {
  sendUpdateStatus({
    state: "available",
    message: `Update ${info.version} found. Downloading...`,
    version: info.version,
  });
});

autoUpdater.on("update-not-available", () => {
  sendUpdateStatus({ state: "idle", message: "You are running the latest version." });
});

autoUpdater.on("download-progress", (progress) => {
  sendUpdateStatus({
    state: "downloading",
    message: `Downloading update: ${Math.round(progress.percent || 0)}%`,
    percent: progress.percent || 0,
  });
});

autoUpdater.on("update-downloaded", async (info) => {
  sendUpdateStatus({
    state: "downloaded",
    message: `Update ${info.version} is ready to install.`,
    version: info.version,
  });

  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    buttons: ["Restart and Install", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Update Ready",
    message: `Vampire Crawlers Deck Tracker ${info.version} is ready to install.`,
    detail: "Restart the app now to finish updating.",
  });

  if (result.response === 0) {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on("error", (error) => {
  sendUpdateStatus({ state: "error", message: `Update error: ${error.message}` });
});

function runProcess(command, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    child.stdout.on("data", (chunk) => onLine(chunk.toString()));
    child.stderr.on("data", (chunk) => onLine(chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function runPython(args, cwd, onLine) {
  try {
    return await runProcess("python", args, cwd, onLine);
  } catch (error) {
    onLine(`python failed: ${error.message}\nTrying py launcher...\n`);
    return runProcess("py", args, cwd, onLine);
  }
}

function candidateAssetBuilderPaths(projectRoot) {
  const names = [
    "vampire-crawlers-asset-builder.exe",
    "vampire-crawlers-asset-builder",
  ];
  const roots = [
    path.join(projectRoot, "bin"),
    path.join(process.resourcesPath || "", "asset-builder"),
    path.join(process.resourcesPath || "", "app", "bin"),
  ];

  return roots.flatMap((root) => names.map((name) => path.join(root, name)));
}

function getAssetBuilderPath(projectRoot) {
  return candidateAssetBuilderPaths(projectRoot).find((candidate) => fs.existsSync(candidate));
}

async function runLocalDataBuilder(projectRoot, paths, append) {
  const builderPath = getAssetBuilderPath(projectRoot);
  const args = [
    "--game-dir",
    config.gameDir,
    "--art-dir",
    paths.artDir,
    "--manifest",
    paths.manifestPath,
    "--card-map",
    paths.cardMapPath,
    "--card-costs",
    paths.cardCostsPath,
    "--card-names",
    paths.cardNamesPath,
    "--card-text",
    paths.cardTextPath,
    "--gem-map",
    paths.gemMapPath,
    "--gem-text",
    paths.gemTextPath,
    "--min-size",
    "16",
  ];

  if (builderPath) {
    append(`Using bundled asset builder: ${builderPath}\n`);
    await runProcess(builderPath, args, projectRoot, append);
    return;
  }

  append("Bundled asset builder was not found; trying local Python fallback.\n");
  await runPython(
    ["-m", "pip", "install", "-r", path.join(projectRoot, "requirements.txt")],
    projectRoot,
    append,
  );
  await runPython([path.join(projectRoot, "tools", "build_local_data.py"), ...args], projectRoot, append);
}

async function rebuildLocalData() {
  const projectRoot = path.resolve(__dirname, "..");
  const generatedAssetsDir = path.join(config.generatedDir, "assets");
  const artDir = path.join(generatedAssetsDir, "art");
  const manifestPath = path.join(generatedAssetsDir, "art-manifest.json");
  const cardMapPath = path.join(generatedAssetsDir, "card-map.json");
  const cardCostsPath = path.join(generatedAssetsDir, "card-costs.json");
  const cardNamesPath = path.join(generatedAssetsDir, "card-names.json");
  const cardTextPath = path.join(generatedAssetsDir, "card-text.json");
  const gemMapPath = path.join(generatedAssetsDir, "gem-map.json");
  const gemTextPath = path.join(generatedAssetsDir, "gem-text.json");
  const log = [];
  const append = (line) => {
    log.push(line.trimEnd());
    mainWindow?.webContents.send("setup-log", line);
  };

  append("Rebuilding local art and cost data...\n");

  if (!config.gameDir || !fs.existsSync(path.join(config.gameDir, "Vampire Crawlers_Data"))) {
    throw new Error("Vampire Crawlers install folder is not configured.");
  }

  fs.mkdirSync(generatedAssetsDir, { recursive: true });
  await runLocalDataBuilder(projectRoot, {
    artDir,
    manifestPath,
    cardMapPath,
    cardCostsPath,
    cardNamesPath,
    cardTextPath,
    gemMapPath,
    gemTextPath,
  }, append);

  config.firstRunComplete = true;
  saveConfig(config, app.getPath("userData"));
  return { ok: true, log };
}

ipcMain.handle("rebuild-art-cache", rebuildLocalData);

ipcMain.handle("hide-setup-panel-forever", async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Hide Forever", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Hide Local Setup",
    message: "Hide the Local setup section by default from now on?",
    detail: "You can still rebuild local art and cost data later from File > Rebuild Local Data in the app menu.",
  });

  if (result.response !== 0) return { hidden: false };

  config.hideSetupPanel = true;
  saveConfig(config, app.getPath("userData"));
  return { hidden: true };
});

ipcMain.handle("check-for-updates", () => checkForUpdates(true));

if (singleInstanceLock) app.whenReady().then(async () => {
  config = {
    ...createDefaultConfig(app.getPath("userData")),
    ...loadConfig(app.getPath("userData")),
  };
  saveConfig(config, app.getPath("userData"));

  buildMenu();
  serverHandle = await startServer({
    port: 0,
    config,
    userDataDir: app.getPath("userData"),
  });
  createWindow(serverHandle.url);
  setTimeout(() => checkForUpdates(false), 3000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  serverHandle?.server?.close();
});
