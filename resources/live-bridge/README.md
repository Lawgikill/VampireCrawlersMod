# Live Bridge Payload

This folder is copied into the Vampire Crawlers game directory by
`File > Install/Update Live Bridge`.

Release builds package this folder as `resources/live-bridge`.

The bridge plugin is staged at:

```text
BepInEx/plugins/VampireCrawlers.LiveBridge/VampireCrawlers.LiveBridge.dll
```

For a fully self-contained release, stage the clean BepInEx IL2CPP loader files
here as well before building:

```text
.doorstop_version
doorstop_config.ini
winhttp.dll
dotnet/**
BepInEx/core/**
```

Do not stage generated runtime folders such as `BepInEx/cache`,
`BepInEx/interop`, logs, or user config.
