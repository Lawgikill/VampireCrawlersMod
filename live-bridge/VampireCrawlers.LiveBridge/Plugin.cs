using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using Il2CppInterop.Runtime.Injection;
using UnityEngine;

namespace VampireCrawlers.LiveBridge;

[BepInPlugin(PluginGuid, PluginName, PluginVersion)]
public sealed class Plugin : BasePlugin
{
    public const string PluginGuid = "com.vampirecrawlers.decktracker.livebridge";
    public const string PluginName = "Vampire Crawlers Live Bridge";
    public const string PluginVersion = "0.2.3";
    internal static ManualLogSource BridgeLog { get; private set; }

    public override void Load()
    {
        BridgeLog = Log;
        ClassInjector.RegisterTypeInIl2Cpp<LiveBridgeBehaviour>();

        var runner = new GameObject("VampireCrawlers.LiveBridge");
        runner.hideFlags = HideFlags.HideAndDontSave;
        UnityEngine.Object.DontDestroyOnLoad(runner);
        runner.AddComponent<LiveBridgeBehaviour>();

        Log.LogInfo("Live bridge loaded.");
    }
}
