const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { startServer } = require("../server");
const {
  createDefaultConfig,
  loadConfig,
  saveConfig,
} = require("./config");
const { getLiveBridgeStatus, installLiveBridge } = require("./liveBridgeInstaller");

let mainWindow;
let serverHandle;
let config;
let updateCheckInFlight = false;
let autoUpdater;

function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require("electron-updater"));
  }
  return autoUpdater;
}

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
    const result = await getAutoUpdater().checkForUpdates();
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
              silentlyInstallOrUpdateLiveBridge("game folder selection");
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
        {
          label: "Install/Update Live Bridge",
          click: async () => {
            try {
              await installOrUpdateLiveBridge();
            } catch (error) {
              dialog.showErrorBox("Live Bridge Install Failed", error.message);
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

if (app.isPackaged) {
  getAutoUpdater().autoDownload = true;

  getAutoUpdater().on("checking-for-update", () => {
    sendUpdateStatus({ state: "checking", message: "Checking for updates..." });
  });

  getAutoUpdater().on("update-available", (info) => {
    sendUpdateStatus({
      state: "available",
      message: `Update ${info.version} found. Downloading...`,
      version: info.version,
    });
  });

  getAutoUpdater().on("update-not-available", () => {
    sendUpdateStatus({ state: "idle", message: "You are running the latest version." });
  });

  getAutoUpdater().on("download-progress", (progress) => {
    sendUpdateStatus({
      state: "downloading",
      message: `Downloading update: ${Math.round(progress.percent || 0)}%`,
      percent: progress.percent || 0,
    });
  });

  getAutoUpdater().on("update-downloaded", async (info) => {
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
      getAutoUpdater().quitAndInstall();
    }
  });

  getAutoUpdater().on("error", (error) => {
    sendUpdateStatus({ state: "error", message: `Update error: ${error.message}` });
  });
}

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

function localDataPaths() {
  const generatedAssetsDir = path.join(config.generatedDir, "assets");
  return {
    generatedAssetsDir,
    artDir: path.join(generatedAssetsDir, "art"),
    manifestPath: path.join(generatedAssetsDir, "art-manifest.json"),
    cardMapPath: path.join(generatedAssetsDir, "card-map.json"),
    cardCostsPath: path.join(generatedAssetsDir, "card-costs.json"),
    cardNamesPath: path.join(generatedAssetsDir, "card-names.json"),
    cardTextPath: path.join(generatedAssetsDir, "card-text.json"),
    textMetaPath: path.join(generatedAssetsDir, "text-meta.json"),
    gemMapPath: path.join(generatedAssetsDir, "gem-map.json"),
    gemTextPath: path.join(generatedAssetsDir, "gem-text.json"),
  };
}

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function countMissingMappedArt(mapPath) {
  const map = readJsonIfExists(mapPath, null);
  if (!map || typeof map !== "object") return 1;
  return Object.values(map).reduce((count, relativePath) => {
    if (!relativePath) return count + 1;
    return fs.existsSync(path.join(config.generatedDir, relativePath)) ? count : count + 1;
  }, 0);
}

function getLocalDataStatus() {
  const paths = localDataPaths();
  const requiredFiles = [
    paths.manifestPath,
    paths.cardMapPath,
    paths.cardCostsPath,
    paths.cardNamesPath,
    paths.cardTextPath,
    paths.textMetaPath,
    paths.gemMapPath,
    paths.gemTextPath,
  ];
  const missingFiles = requiredFiles.filter((filePath) => !fs.existsSync(filePath));
  const missingCardArt = fs.existsSync(paths.cardMapPath) ? countMissingMappedArt(paths.cardMapPath) : 1;
  const missingGemArt = fs.existsSync(paths.gemMapPath) ? countMissingMappedArt(paths.gemMapPath) : 1;

  return {
    ready: missingFiles.length === 0 && missingCardArt === 0 && missingGemArt === 0,
    missingFiles,
    missingCardArt,
    missingGemArt,
  };
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
    "--text-meta",
    paths.textMetaPath,
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
  const paths = localDataPaths();
  const log = [];
  const append = (line) => {
    log.push(line.trimEnd());
    mainWindow?.webContents.send("setup-log", line);
  };

  append("Rebuilding local art and cost data...\n");

  if (!config.gameDir || !fs.existsSync(path.join(config.gameDir, "Vampire Crawlers_Data"))) {
    throw new Error("Vampire Crawlers install folder is not configured.");
  }

  fs.mkdirSync(paths.generatedAssetsDir, { recursive: true });
  await runLocalDataBuilder(projectRoot, {
    artDir: paths.artDir,
    manifestPath: paths.manifestPath,
    cardMapPath: paths.cardMapPath,
    cardCostsPath: paths.cardCostsPath,
    cardNamesPath: paths.cardNamesPath,
    cardTextPath: paths.cardTextPath,
    textMetaPath: paths.textMetaPath,
    gemMapPath: paths.gemMapPath,
    gemTextPath: paths.gemTextPath,
  }, append);

  config.firstRunComplete = true;
  saveConfig(config, app.getPath("userData"));
  return { ok: true, log };
}

async function installOrUpdateLiveBridge() {
  const projectRoot = path.resolve(__dirname, "..");
  const status = installLiveBridge(config.gameDir, projectRoot);
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Live Bridge Installed",
    message: "The Vampire Crawlers live bridge was installed or updated.",
    detail: [
      "Start or restart Vampire Crawlers for BepInEx to load the bridge.",
      status.hasBepInExLoader
        ? "BepInEx loader files were found in the game folder."
        : "The bridge plugin was installed, but BepInEx loader files were not found. Stage a complete live-bridge payload before release.",
      status.installedPluginPath,
    ].join("\n\n"),
  });
}

function sendSetupProgress(status) {
  mainWindow?.webContents.send("setup-progress", {
    at: new Date().toISOString(),
    ...status,
  });
}

function silentlyInstallOrUpdateLiveBridge(reason = "startup") {
  try {
    const projectRoot = path.resolve(__dirname, "..");
    const status = installLiveBridge(config.gameDir, projectRoot);
    console.log(`[live-bridge] Installed/updated during ${reason}: ${status.installedPluginPath}`);
    if (!status.hasBepInExLoader) {
      console.warn("[live-bridge] Bridge plugin installed, but BepInEx loader files were not found.");
    }
    return status;
  } catch (error) {
    console.warn(`[live-bridge] Silent install skipped during ${reason}: ${error.message}`);
    return null;
  }
}

async function promptForGameDirIfNeeded() {
  if (config.gameDir && fs.existsSync(path.join(config.gameDir, "Vampire Crawlers_Data", "globalgamemanagers.assets"))) {
    return true;
  }

  sendSetupProgress({
    state: "needs-input",
    title: "Game folder needed",
    message: "Select the Vampire Crawlers install folder to finish setup.",
  });

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choose Vampire Crawlers install folder",
  });
  if (result.canceled || !result.filePaths[0]) return false;

  config.gameDir = result.filePaths[0];
  saveConfig(config, app.getPath("userData"));
  return true;
}

async function promptForSavePathIfNeeded() {
  if (config.savePath && fs.existsSync(config.savePath)) return true;

  sendSetupProgress({
    state: "needs-input",
    title: "Save file needed",
    message: "Select your Vampire Crawlers save file to finish setup.",
  });

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    title: "Choose Vampire Crawlers save file",
    filters: [{ name: "Vampire Crawlers Save", extensions: ["save", "*"] }],
  });
  if (result.canceled || !result.filePaths[0]) return false;

  config.savePath = result.filePaths[0];
  saveConfig(config, app.getPath("userData"));
  return true;
}

async function runStartupSetup() {
  if (!mainWindow) return { ok: false, message: "Main window is not ready." };

  sendSetupProgress({
    state: "checking",
    title: "Checking setup",
    message: "Looking for Vampire Crawlers files...",
  });

  if (!(await promptForGameDirIfNeeded())) {
    return {
      ok: false,
      needsInput: true,
      message: "Vampire Crawlers install folder was not selected.",
    };
  }

  if (!(await promptForSavePathIfNeeded())) {
    return {
      ok: false,
      needsInput: true,
      message: "Vampire Crawlers save file was not selected.",
    };
  }

  const localDataStatus = getLocalDataStatus();
  if (!localDataStatus.ready) {
    sendSetupProgress({
      state: "working",
      title: "Preparing card art",
      message: "Building local card art and game data. This can take a minute.",
    });
    await rebuildLocalData();
  }

  const projectRoot = path.resolve(__dirname, "..");
  const bridgeStatus = getLiveBridgeStatus(config.gameDir, projectRoot);
  if (!bridgeStatus.hasPayload) {
    throw new Error("Live bridge payload is missing from this app build.");
  }

  if (!bridgeStatus.isCurrent) {
    sendSetupProgress({
      state: "working",
      title: bridgeStatus.isInstalled ? "Updating live bridge" : "Installing live bridge",
      message: "Copying the live bridge into the Vampire Crawlers install folder.",
    });
    installLiveBridge(config.gameDir, projectRoot);
  }

  sendSetupProgress({
    state: "complete",
    title: "Setup complete",
    message: "Local art, save data, and live bridge are ready.",
  });

  return {
    ok: true,
    localData: getLocalDataStatus(),
    liveBridge: getLiveBridgeStatus(config.gameDir, projectRoot),
  };
}

ipcMain.handle("rebuild-art-cache", rebuildLocalData);
ipcMain.handle("run-startup-setup", runStartupSetup);

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
