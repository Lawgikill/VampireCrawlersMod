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

let mainWindow;
let serverHandle;
let config;

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

ipcMain.handle("rebuild-art-cache", async () => {
  const projectRoot = path.resolve(__dirname, "..");
  const generatedAssetsDir = path.join(config.generatedDir, "assets");
  const artDir = path.join(generatedAssetsDir, "art");
  const manifestPath = path.join(generatedAssetsDir, "art-manifest.json");
  const cardMapPath = path.join(generatedAssetsDir, "card-map.json");
  const cardCostsPath = path.join(generatedAssetsDir, "card-costs.json");
  const log = [];
  const append = (line) => {
    log.push(line.trimEnd());
    mainWindow?.webContents.send("setup-log", line);
  };

  if (!config.gameDir || !fs.existsSync(path.join(config.gameDir, "Vampire Crawlers_Data"))) {
    throw new Error("Vampire Crawlers install folder is not configured.");
  }

  fs.mkdirSync(generatedAssetsDir, { recursive: true });
  await runLocalDataBuilder(projectRoot, {
    artDir,
    manifestPath,
    cardMapPath,
    cardCostsPath,
  }, append);

  config.firstRunComplete = true;
  saveConfig(config, app.getPath("userData"));
  return { ok: true, log };
});

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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  serverHandle?.server?.close();
});
