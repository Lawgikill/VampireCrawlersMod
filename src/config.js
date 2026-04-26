const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR_NAME = "VampireCrawlersDeckTracker";
const DEFAULT_GAME_DIR = path.join(
  "C:",
  "Program Files (x86)",
  "Steam",
  "steamapps",
  "common",
  "Vampire Crawlers",
);
const DEFAULT_SAVE_PATH = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "Nosebleed Interactive",
  "Vampire Crawlers",
  "Save",
  "SaveProfile0.save",
);

function defaultUserDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_DIR_NAME);
}

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function getConfigPath(userDataDir = defaultUserDataDir()) {
  return path.join(userDataDir, "config.json");
}

function findSteamLibraries() {
  const steamRoot = path.join("C:", "Program Files (x86)", "Steam");
  const libraries = [steamRoot];
  const libraryFile = path.join(steamRoot, "steamapps", "libraryfolders.vdf");

  try {
    const raw = fs.readFileSync(libraryFile, "utf8");
    for (const match of raw.matchAll(/"path"\s+"([^"]+)"/g)) {
      libraries.push(match[1].replace(/\\\\/g, "\\"));
    }
  } catch {
    // Steam may not be installed in the default location.
  }

  return [...new Set(libraries)];
}

function detectGameDir() {
  const candidates = [
    DEFAULT_GAME_DIR,
    ...findSteamLibraries().map((library) =>
      path.join(library, "steamapps", "common", "Vampire Crawlers"),
    ),
  ];

  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "Vampire Crawlers_Data", "globalgamemanagers.assets")),
  ) || "";
}

function detectSavePath() {
  return fs.existsSync(DEFAULT_SAVE_PATH) ? DEFAULT_SAVE_PATH : "";
}

function createDefaultConfig(userDataDir = defaultUserDataDir()) {
  return {
    gameDir: detectGameDir(),
    savePath: detectSavePath(),
    generatedDir: path.join(userDataDir, "generated"),
    firstRunComplete: false,
  };
}

function loadConfig(userDataDir = defaultUserDataDir()) {
  const configPath = getConfigPath(userDataDir);
  const loaded = readJsonIfExists(configPath, {});
  return {
    ...createDefaultConfig(userDataDir),
    ...loaded,
  };
}

function saveConfig(config, userDataDir = defaultUserDataDir()) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(getConfigPath(userDataDir), JSON.stringify(config, null, 2) + "\n", "utf8");
}

module.exports = {
  APP_DIR_NAME,
  DEFAULT_GAME_DIR,
  DEFAULT_SAVE_PATH,
  createDefaultConfig,
  defaultUserDataDir,
  detectGameDir,
  detectSavePath,
  getConfigPath,
  loadConfig,
  saveConfig,
};
