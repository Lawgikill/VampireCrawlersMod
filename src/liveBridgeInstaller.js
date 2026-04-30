const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const BRIDGE_PLUGIN_RELATIVE_PATH = path.join(
  "BepInEx",
  "plugins",
  "VampireCrawlers.LiveBridge",
  "VampireCrawlers.LiveBridge.dll",
);

function candidatePayloadRoots(projectRoot) {
  return [
    path.join(projectRoot, "resources", "live-bridge"),
    path.join(process.resourcesPath || "", "live-bridge"),
    path.join(process.resourcesPath || "", "app", "resources", "live-bridge"),
  ];
}

function getLiveBridgePayloadRoot(projectRoot) {
  return candidatePayloadRoots(projectRoot).find((candidate) =>
    fs.existsSync(path.join(candidate, BRIDGE_PLUGIN_RELATIVE_PATH)),
  );
}

function copyDirectoryContents(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "README.md") continue;

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listPayloadFiles(root, current = root) {
  if (!root || !fs.existsSync(current)) return [];
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "README.md") return [];
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) return listPayloadFiles(root, fullPath);
    if (!entry.isFile()) return [];
    return [path.relative(root, fullPath)];
  });
}

function isLiveBridgeCurrent(payloadRoot, gameDir) {
  if (!payloadRoot || !gameDir) return false;
  const payloadFiles = listPayloadFiles(payloadRoot);
  if (!payloadFiles.length) return false;

  return payloadFiles.every((relativePath) => {
    const sourcePath = path.join(payloadRoot, relativePath);
    const targetPath = path.join(gameDir, relativePath);
    if (!fs.existsSync(targetPath)) return false;
    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);
    if (sourceStat.size !== targetStat.size) return false;
    return hashFile(sourcePath) === hashFile(targetPath);
  });
}

function getLiveBridgeStatus(gameDir, projectRoot) {
  const payloadRoot = getLiveBridgePayloadRoot(projectRoot);
  const installedPluginPath = gameDir ? path.join(gameDir, BRIDGE_PLUGIN_RELATIVE_PATH) : "";

  return {
    payloadRoot: payloadRoot || "",
    hasPayload: Boolean(payloadRoot),
    installedPluginPath,
    isInstalled: Boolean(installedPluginPath && fs.existsSync(installedPluginPath)),
    isCurrent: isLiveBridgeCurrent(payloadRoot, gameDir),
    hasBepInExLoader: Boolean(
      gameDir
        && fs.existsSync(path.join(gameDir, "winhttp.dll"))
        && fs.existsSync(path.join(gameDir, "doorstop_config.ini"))
        && fs.existsSync(path.join(gameDir, "BepInEx", "core")),
    ),
  };
}

function installLiveBridge(gameDir, projectRoot) {
  if (!gameDir || !fs.existsSync(path.join(gameDir, "Vampire Crawlers_Data"))) {
    throw new Error("Vampire Crawlers install folder is not configured.");
  }

  const payloadRoot = getLiveBridgePayloadRoot(projectRoot);
  if (!payloadRoot) {
    throw new Error(
      "Live bridge payload is missing. Build or stage resources/live-bridge before packaging the app.",
    );
  }

  copyDirectoryContents(payloadRoot, gameDir);
  const status = getLiveBridgeStatus(gameDir, projectRoot);
  if (!status.isInstalled) {
    throw new Error("Live bridge payload copied, but the plugin DLL was not found in the game folder.");
  }
  return status;
}

module.exports = {
  BRIDGE_PLUGIN_RELATIVE_PATH,
  getLiveBridgeStatus,
  installLiveBridge,
};
