using System.Collections;
using System.Reflection;
using System.Text.Json;
using Nosebleed.Pancake.Models;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace VampireCrawlers.LiveBridge;

public sealed class LiveBridgeBehaviour : MonoBehaviour
{
    private static readonly string OutputPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "VampireCrawlersDeckTracker",
        "live-state.json");
    private static readonly string CommandPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "VampireCrawlersDeckTracker",
        "command.json");
    private static readonly string CommandResultPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "VampireCrawlersDeckTracker",
        "command-result.json");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };
    private static readonly bool EnableVerboseDiagnostics = false;

    private float _nextWriteAt;
    private float _nextErrorLogAt;
    private GUIStyle _overlayStyle;
    private GUIStyle _overlayPanelStyle;
    private Texture2D _overlayBackground;
    private GameObject _overlayRoot;
    private RectTransform _overlayRect;
    private Text _overlayText;
    private string _handManaTotal = "HAND MANA\nTOTAL: --";
    private string _lastCommandId = "";
    private LiveState _lastState;
    private bool _overlayDisabled;
    private static float _nextManaTextProbeAt;
    private static int? CachedDisplayedMana;
    private static TMP_Text CachedManaText;
    private static Text CachedUiManaText;
    private static readonly Dictionary<string, string> CachedManaTextDiagnostics = new();

    public LiveBridgeBehaviour(IntPtr pointer) : base(pointer)
    {
    }

    private void Update()
    {
        if (Time.realtimeSinceStartup < _nextWriteAt) return;
        _nextWriteAt = Time.realtimeSinceStartup + 0.5f;

        try
        {
            var state = CaptureState();
            if (state.Piles.Count == 0) return;
            _lastState = state;
            _handManaTotal = $"HAND MANA\nTOTAL: {FormatHandManaTotal(state)}";
            UpdateOverlayCanvas(state.IsInCombat == true);
            ProcessPendingCommand();

            Directory.CreateDirectory(Path.GetDirectoryName(OutputPath));
            File.WriteAllText(OutputPath, JsonSerializer.Serialize(state, JsonOptions));
        }
        catch (Exception error)
        {
            if (Time.realtimeSinceStartup < _nextErrorLogAt) return;
            _nextErrorLogAt = Time.realtimeSinceStartup + 5f;
            Plugin.BridgeLog?.LogWarning($"Live bridge capture/write failed: {error}");
        }
    }

    private void ProcessPendingCommand()
    {
        if (!File.Exists(CommandPath)) return;

        BridgeCommand command;
        try
        {
            command = JsonSerializer.Deserialize<BridgeCommand>(File.ReadAllText(CommandPath), JsonOptions);
        }
        catch (Exception error)
        {
            WriteCommandResult(new BridgeCommandResult
            {
                Ok = false,
                Message = $"Unable to read command: {error.Message}",
            });
            return;
        }

        if (command == null || string.IsNullOrWhiteSpace(command.Id)) return;
        if (command.Id == _lastCommandId) return;
        _lastCommandId = command.Id;

        if (!string.Equals(command.Type, "play-card", StringComparison.OrdinalIgnoreCase))
        {
            WriteCommandResult(new BridgeCommandResult
            {
                Id = command.Id,
                Type = command.Type,
                Ok = false,
                Message = $"Unsupported command type: {command.Type}",
            });
            return;
        }

        WriteCommandResult(InspectPlayCardCommand(command, _lastState));
    }

    private static BridgeCommandResult InspectPlayCardCommand(BridgeCommand command, LiveState state)
    {
        var hand = state.Piles.FirstOrDefault((pile) => pile.PileId == "HandPile");
        var matched = FindCommandCard(hand, command);
        var runtimeCard = FindRuntimeCommandCard(command);
        var candidates = FindPlayCardCandidates();
        var referenceOwners = runtimeCard == null
            ? new List<string>()
            : FindCardReferenceOwners(runtimeCard).Take(80).ToList();
        var ownerCandidates = FindOwnerCandidateMethods(referenceOwners).Take(120).ToList();
        var invocation = command.DryRun || runtimeCard == null
            ? null
            : TryInvokePlayCard(runtimeCard);
        var message = BuildPlayCardResultMessage(command, matched, runtimeCard, invocation);

        Plugin.BridgeLog?.LogInfo($"Received play-card command for {command.CardConfigId} index={command.Index} guid={command.CardGuid}. {message}");
        if (runtimeCard != null)
        {
            Plugin.BridgeLog?.LogInfo($"Matched runtime card model: {runtimeCard.GetType().FullName} guid={FormatGuidValue(runtimeCard.Guid)} config={runtimeCard.CardConfig?.AssetId}");
        }
        if (invocation != null)
        {
            Plugin.BridgeLog?.LogInfo($"Play-card invocation: {invocation.Method} ok={invocation.Ok} return={invocation.ReturnValue} error={invocation.Error}");
        }
        foreach (var candidate in candidates.Take(20))
        {
            Plugin.BridgeLog?.LogInfo($"Play-card candidate: {candidate}");
        }
        foreach (var owner in referenceOwners.Take(20))
        {
            Plugin.BridgeLog?.LogInfo($"Play-card card owner: {owner}");
        }
        foreach (var candidate in ownerCandidates.Take(30))
        {
            Plugin.BridgeLog?.LogInfo($"Play-card owner candidate: {candidate}");
        }

        return new BridgeCommandResult
        {
            Id = command.Id,
            Type = command.Type,
            Ok = invocation?.Ok ?? matched != null,
            DryRun = command.DryRun,
            Message = message,
            MatchedCard = matched,
            CandidateMethods = candidates,
            RuntimeCardType = runtimeCard?.GetType().FullName ?? "",
            RuntimeCardGuid = runtimeCard == null ? "" : FormatGuidValue(runtimeCard.Guid),
            ReferenceOwners = referenceOwners,
            OwnerCandidateMethods = ownerCandidates,
            InvocationMethod = invocation?.Method ?? "",
            InvocationReturnValue = invocation?.ReturnValue ?? "",
            InvocationError = invocation?.Error ?? "",
        };
    }

    private static string BuildPlayCardResultMessage(BridgeCommand command, LiveCard matched, CardModel runtimeCard, PlayCardInvocation invocation)
    {
        if (matched == null)
        {
            return $"No matching hand card found for {command.CardConfigId} at index {command.Index}.";
        }

        if (runtimeCard == null)
        {
            return $"Matched {matched.CardConfigId} in JSON state, but no runtime CardModel was found.";
        }

        if (command.DryRun)
        {
            return $"Matched {matched.CardConfigId} in hand. Dry run only; no gameplay method invoked.";
        }

        if (invocation == null)
        {
            return $"Matched {matched.CardConfigId} in hand, but no invocation result was produced.";
        }

        return invocation.Ok
            ? $"Invoked {invocation.Method} for {matched.CardConfigId}. Return: {invocation.ReturnValue}."
            : $"Failed to invoke {invocation.Method} for {matched.CardConfigId}: {invocation.Error}";
    }

    private static PlayCardInvocation TryInvokePlayCard(CardModel runtimeCard)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var method = runtimeCard.GetType().GetMethod("TryPlayCard", flags, null, Type.EmptyTypes, null);
        if (method == null)
        {
            return new PlayCardInvocation
            {
                Method = "CardModel.TryPlayCard()",
                Ok = false,
                Error = "Method not found on runtime card model.",
            };
        }

        try
        {
            var result = method.Invoke(runtimeCard, Array.Empty<object>());
            return new PlayCardInvocation
            {
                Method = $"{runtimeCard.GetType().FullName}.TryPlayCard()",
                Ok = true,
                ReturnValue = result?.ToString() ?? "void/null",
            };
        }
        catch (TargetInvocationException error)
        {
            return new PlayCardInvocation
            {
                Method = $"{runtimeCard.GetType().FullName}.TryPlayCard()",
                Ok = false,
                Error = error.InnerException?.Message ?? error.Message,
            };
        }
        catch (Exception error)
        {
            return new PlayCardInvocation
            {
                Method = $"{runtimeCard.GetType().FullName}.TryPlayCard()",
                Ok = false,
                Error = error.Message,
            };
        }
    }

    private static LiveCard FindCommandCard(LivePile hand, BridgeCommand command)
    {
        if (hand == null || hand.Cards == null) return null;

        if (!string.IsNullOrWhiteSpace(command.CardGuid))
        {
            var byGuid = hand.Cards.FirstOrDefault((card) =>
                !string.IsNullOrWhiteSpace(card.CardGuid)
                && string.Equals(card.CardGuid, command.CardGuid, StringComparison.OrdinalIgnoreCase));
            if (byGuid != null) return byGuid;
        }

        if (command.Index >= 0 && command.Index < hand.Cards.Count)
        {
            var byIndex = hand.Cards[command.Index];
            if (string.IsNullOrWhiteSpace(command.CardConfigId)
                || string.Equals(byIndex.CardConfigId, command.CardConfigId, StringComparison.Ordinal))
            {
                return byIndex;
            }
        }

        return hand.Cards.FirstOrDefault((card) =>
            string.Equals(card.CardConfigId, command.CardConfigId, StringComparison.Ordinal));
    }

    private static CardModel FindRuntimeCommandCard(BridgeCommand command)
    {
        var handPile = First<HandPileModel>()?.CardPile;
        if (handPile?._cards == null) return null;

        if (!string.IsNullOrWhiteSpace(command.CardGuid))
        {
            for (var index = 0; index < handPile._cards.Count; index++)
            {
                var card = handPile._cards[index];
                if (card == null) continue;
                if (string.Equals(FormatGuidValue(card.Guid), command.CardGuid, StringComparison.OrdinalIgnoreCase))
                {
                    return card;
                }
            }
        }

        if (command.Index >= 0 && command.Index < handPile._cards.Count)
        {
            var card = handPile._cards[command.Index];
            if (card != null
                && (string.IsNullOrWhiteSpace(command.CardConfigId)
                    || string.Equals(card.CardConfig?.AssetId, command.CardConfigId, StringComparison.Ordinal)))
            {
                return card;
            }
        }

        for (var index = 0; index < handPile._cards.Count; index++)
        {
            var card = handPile._cards[index];
            if (card != null && string.Equals(card.CardConfig?.AssetId, command.CardConfigId, StringComparison.Ordinal))
            {
                return card;
            }
        }

        return null;
    }

    private static List<string> FindPlayCardCandidates()
    {
        var candidates = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var component in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
        {
            if (component == null) continue;
            var type = component.GetType();
            var typeName = type.FullName ?? type.Name;

            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            foreach (var method in type.GetMethods(flags))
            {
                var methodName = method.Name;
                if (!LooksLikePlayCardMethod(typeName, methodName)) continue;
                var parameters = string.Join(", ", method.GetParameters().Select((parameter) =>
                    $"{parameter.ParameterType.Name} {parameter.Name}"));
                candidates.Add($"{typeName}.{methodName}({parameters})");
                if (candidates.Count >= 80) return candidates.ToList();
            }
        }

        return candidates.ToList();
    }

    private static bool LooksLikePlayCardMethod(string typeName, string methodName)
    {
        var combined = $"{typeName}.{methodName}";
        var hasCardContext = combined.Contains("Card", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("Hand", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("Pile", StringComparison.OrdinalIgnoreCase);
        var hasActionContext = methodName.Contains("Play", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Try", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Select", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Interact", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Afford", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Move", StringComparison.OrdinalIgnoreCase);
        return hasCardContext && hasActionContext;
    }

    private static List<string> FindCardReferenceOwners(CardModel targetCard)
    {
        var owners = new SortedSet<string>(StringComparer.Ordinal);
        var targetGuid = FormatGuidValue(targetCard.Guid);
        var targetConfigId = targetCard.CardConfig?.AssetId ?? "";

        foreach (var component in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
        {
            if (component == null) continue;
            var type = component.GetType();
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

            foreach (var field in type.GetFields(flags))
            {
                var value = SafeReadField(field, component);
                if (ContainsCardReference(value, targetCard, targetGuid, targetConfigId))
                {
                    owners.Add($"{type.FullName ?? type.Name}.{field.Name}");
                }
            }

            foreach (var property in type.GetProperties(flags))
            {
                if (property.GetIndexParameters().Length > 0) continue;
                var value = SafeReadProperty(property, component);
                if (ContainsCardReference(value, targetCard, targetGuid, targetConfigId))
                {
                    owners.Add($"{type.FullName ?? type.Name}.{property.Name}");
                }
            }
        }

        return owners.ToList();
    }

    private static List<string> FindOwnerCandidateMethods(List<string> referenceOwners)
    {
        var ownerTypeNames = referenceOwners
            .Select((owner) =>
            {
                var lastDot = owner.LastIndexOf('.');
                return lastDot <= 0 ? owner : owner[..lastDot];
            })
            .Where((name) => !string.IsNullOrWhiteSpace(name))
            .ToHashSet(StringComparer.Ordinal);
        var candidates = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var component in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
        {
            if (component == null) continue;
            var type = component.GetType();
            var typeName = type.FullName ?? type.Name;
            if (!ownerTypeNames.Contains(typeName)) continue;

            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            foreach (var method in type.GetMethods(flags))
            {
                if (!LooksLikeOwnerPlayMethod(method.Name)) continue;
                var parameters = string.Join(", ", method.GetParameters().Select((parameter) =>
                    $"{parameter.ParameterType.Name} {parameter.Name}"));
                candidates.Add($"{typeName}.{method.Name}({parameters})");
            }
        }

        return candidates.ToList();
    }

    private static bool LooksLikeOwnerPlayMethod(string methodName)
    {
        if (methodName.StartsWith("get_", StringComparison.Ordinal)
            || methodName.StartsWith("set_", StringComparison.Ordinal)
            || methodName.StartsWith("add_", StringComparison.Ordinal)
            || methodName.StartsWith("remove_", StringComparison.Ordinal))
        {
            return false;
        }

        return methodName.Contains("Play", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Click", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Pointer", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Select", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Submit", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Use", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Cast", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Drag", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Drop", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Press", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Release", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Interact", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Card", StringComparison.OrdinalIgnoreCase)
            || methodName.Contains("Hand", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ContainsCardReference(object value, CardModel targetCard, string targetGuid, string targetConfigId)
    {
        if (value == null) return false;
        if (ReferenceEquals(value, targetCard)) return true;
        if (IsMatchingCardModel(value, targetGuid, targetConfigId)) return true;
        if (value is string) return false;
        if (value is not IEnumerable enumerable) return false;

        var checkedItems = 0;
        foreach (var item in enumerable)
        {
            if (item == null) continue;
            if (ReferenceEquals(item, targetCard) || IsMatchingCardModel(item, targetGuid, targetConfigId))
            {
                return true;
            }

            checkedItems++;
            if (checkedItems >= 200) return false;
        }

        return false;
    }

    private static bool IsMatchingCardModel(object value, string targetGuid, string targetConfigId)
    {
        if (value is not CardModel cardModel) return false;
        var guid = FormatGuidValue(cardModel.Guid);
        if (!string.IsNullOrWhiteSpace(targetGuid)
            && string.Equals(guid, targetGuid, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return string.IsNullOrWhiteSpace(targetGuid)
            && !string.IsNullOrWhiteSpace(targetConfigId)
            && string.Equals(cardModel.CardConfig?.AssetId, targetConfigId, StringComparison.Ordinal);
    }

    private static object SafeReadField(FieldInfo field, object owner)
    {
        try
        {
            return field.GetValue(owner);
        }
        catch
        {
            return null;
        }
    }

    private static object SafeReadProperty(PropertyInfo property, object owner)
    {
        try
        {
            return property.GetValue(owner);
        }
        catch
        {
            return null;
        }
    }

    private static void WriteCommandResult(BridgeCommandResult result)
    {
        result.UpdatedAt = DateTimeOffset.UtcNow.ToString("O");
        Directory.CreateDirectory(Path.GetDirectoryName(CommandResultPath));
        File.WriteAllText(CommandResultPath, JsonSerializer.Serialize(result, JsonOptions));
    }

    private void OnGUI()
    {
        return;
    }

    private void UpdateOverlayCanvas(bool isInCombat)
    {
        if (_overlayDisabled) return;

        try
        {
            if (!isInCombat)
            {
                if (_overlayRoot != null) _overlayRoot.SetActive(false);
                return;
            }

            EnsureOverlayCanvas();
            if (_overlayRoot != null && !_overlayRoot.activeSelf) _overlayRoot.SetActive(true);
            if (_overlayText != null) _overlayText.text = _handManaTotal;
            PositionOverlayCanvas();
        }
        catch (Exception error)
        {
            _overlayDisabled = true;
            Plugin.BridgeLog?.LogWarning($"Live bridge overlay disabled after UI draw failure: {error}");
        }
    }

    private void EnsureOverlayCanvas()
    {
        if (_overlayRoot != null && _overlayText != null && _overlayRect != null) return;

        _overlayRoot = new GameObject("VampireCrawlers.LiveBridge.HandManaOverlay");
        _overlayRoot.hideFlags = HideFlags.HideAndDontSave;
        UnityEngine.Object.DontDestroyOnLoad(_overlayRoot);

        var canvas = _overlayRoot.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = short.MaxValue;

        var panel = new GameObject("Panel");
        panel.hideFlags = HideFlags.HideAndDontSave;
        panel.transform.SetParent(_overlayRoot.transform, false);
        _overlayRect = panel.AddComponent<RectTransform>();
        _overlayRect.anchorMin = new Vector2(1f, 1f);
        _overlayRect.anchorMax = new Vector2(1f, 1f);
        _overlayRect.pivot = new Vector2(1f, 1f);
        _overlayRect.sizeDelta = new Vector2(138f, 52f);

        var image = panel.AddComponent<Image>();
        image.color = new Color(0.78f, 0.66f, 0.42f, 1f);
        image.raycastTarget = false;

        var textObject = new GameObject("Text");
        textObject.hideFlags = HideFlags.HideAndDontSave;
        textObject.transform.SetParent(panel.transform, false);
        var textRect = textObject.AddComponent<RectTransform>();
        textRect.anchorMin = Vector2.zero;
        textRect.anchorMax = Vector2.one;
        textRect.offsetMin = Vector2.zero;
        textRect.offsetMax = Vector2.zero;

        _overlayText = textObject.AddComponent<Text>();
        _overlayText.raycastTarget = false;
        _overlayText.alignment = TextAnchor.MiddleCenter;
        _overlayText.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        _overlayText.fontSize = 15;
        _overlayText.fontStyle = FontStyle.Bold;
        _overlayText.color = new Color(0.36f, 0.30f, 0.22f, 1f);
        _overlayText.text = _handManaTotal;
    }

    private void PositionOverlayCanvas()
    {
        if (_overlayRect == null) return;
        _overlayRect.anchoredPosition = new Vector2(-242f, -(Screen.height * 0.765f));
    }

    private void DrawImGuiOverlay()
    {
        if (_overlayDisabled) return;

        try
        {
            if (_overlayStyle == null)
            {
                _overlayStyle = new GUIStyle(GUI.skin.label)
                {
                    alignment = TextAnchor.MiddleCenter,
                    fontSize = 16,
                    fontStyle = FontStyle.Bold,
                    normal =
                    {
                        textColor = new Color(1f, 0.84f, 0.25f, 1f),
                    },
                };
            }

            if (_overlayBackground == null)
            {
                _overlayBackground = new Texture2D(1, 1);
                _overlayBackground.SetPixel(0, 0, new Color(0.06f, 0.06f, 0.06f, 1f));
                _overlayBackground.Apply();
            }

            if (_overlayPanelStyle == null)
            {
                _overlayPanelStyle = new GUIStyle(GUI.skin.box)
                {
                    border = new RectOffset(0, 0, 0, 0),
                    margin = new RectOffset(0, 0, 0, 0),
                    padding = new RectOffset(0, 0, 0, 0),
                    normal =
                    {
                        background = _overlayBackground,
                    },
                };
            }

            var width = 162f;
            var height = 52f;
            var rect = new Rect(Screen.width - width - 238f, Screen.height * 0.78f, width, height);

            var previousDepth = GUI.depth;
            try
            {
                GUI.depth = -10000;
                GUI.Box(rect, GUIContent.none, _overlayPanelStyle);
                GUI.Label(rect, _handManaTotal, _overlayStyle);
            }
            finally
            {
                GUI.depth = previousDepth;
            }
        }
        catch (Exception error)
        {
            _overlayDisabled = true;
            Plugin.BridgeLog?.LogWarning($"Live bridge overlay disabled after draw failure: {error}");
        }
    }

    private static LiveState CaptureState()
    {
        var best = new LiveState();
        var visualStates = BuildCardVisualStatesByGuid();

        AddPile(best, "HandPile", First<HandPileModel>()?.CardPile, visualStates);
        AddPile(best, "DrawPile", First<DrawPileModel>()?.CardPileModel, visualStates);
        AddPile(best, "DiscardPile", First<DiscardPileModel>()?.CardPile, visualStates);
        AddPile(best, "ComboPile", First<ComboPileModel>()?.CardPile, visualStates);
        AddPile(best, "FccPile", First<FccPileModel>()?.CardPile, visualStates);
        AddPile(best, "ThrowingPile", First<ThrowingPileModel>()?.CardPile, visualStates);

        if (best.Piles.Count > 0)
        {
            AttachCombatState(best);
            AttachManaState(best);
            best.UpdatedAt = DateTimeOffset.UtcNow.ToString("O");
            return best;
        }

        var components = UnityEngine.Object.FindObjectsOfType<MonoBehaviour>();
        foreach (var component in components)
        {
            if (component == null) continue;
            var typeName = component.GetType().Name;
            if (!LooksLikePileOwner(typeName)) continue;

            AddPile(best, component, "HandPile", visualStates, "_handPile", "_handPileView", "HandPileView");
            AddPile(best, component, "DrawPile", visualStates, "_drawPile", "_drawPileView", "DrawPileView");
            AddPile(best, component, "DiscardPile", visualStates, "_discardPile", "_discardPileView", "DiscardPileView");
            AddPile(best, component, "ComboPile", visualStates, "_comboPile", "_comboPileView", "ComboPileView");
            AddPile(best, component, "FccPile", visualStates, "_fccPile", "_fccPileView", "FccPileView");
            AddPile(best, component, "ThrowingPile", visualStates, "_throwingPileModel", "_throwingPileView", "ThrowingPileModel");
        }

        AttachCombatState(best);
        AttachManaState(best);
        best.UpdatedAt = DateTimeOffset.UtcNow.ToString("O");
        return best;
    }

    private static void AttachManaState(LiveState state)
    {
        AttachActiveManaTextDiagnostics(state);
    }

    private static bool LooksLikeManaProbeCandidate(string name, string typeName)
    {
        var combined = $"{name} {typeName}";
        if (combined.Contains("Projectile", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("Footstep", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("SFX_", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("Collision", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("CollectItem", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return combined.Contains("PlayerModel", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("PlayerView", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("ManaStat", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("ManaView", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("ManaModel", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("CurrentMana", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("CachedMana", StringComparison.OrdinalIgnoreCase);
    }

    private static void TryReadManaState(object value, LiveState state, string source)
    {
        if (value == null) return;

        var currentMana = ReadIntValue(value, "CurrentMana", "_currentMana", "currentMana");
        var cachedMana = ReadIntValue(value, "CachedMana", "_cachedMana", "cachedMana");
        var startingMana = ReadIntValue(value, "StartingMana", "_startingMana", "startingMana");
        var fccMana = ReadIntValue(value, "FccMana", "_fccMana", "fccMana");

        if (currentMana == null && cachedMana == null && startingMana == null && fccMana == null) return;

        state.CurrentMana ??= currentMana;
        state.CachedMana ??= cachedMana;
        state.StartingMana ??= startingMana;
        state.FccMana ??= fccMana;

        if (state.ManaDiagnostics.Count >= 12) return;
        var parts = new List<string>();
        if (currentMana != null) parts.Add($"CurrentMana={currentMana}");
        if (cachedMana != null) parts.Add($"CachedMana={cachedMana}");
        if (startingMana != null) parts.Add($"StartingMana={startingMana}");
        if (fccMana != null) parts.Add($"FccMana={fccMana}");
        state.ManaDiagnostics["Resolved"] = $"{source} {string.Join(" ", parts)}";
        if (state.ManaDiagnostics.Count < 12) state.ManaDiagnostics[source] = string.Join(" ", parts);
    }

    private static void AttachActiveManaTextDiagnostics(LiveState state)
    {
        if (TryReadCachedManaText(out var cachedMana))
        {
            state.DisplayedMana = cachedMana;
            state.CurrentMana = cachedMana;
            if (EnableVerboseDiagnostics)
            {
                foreach (var entry in CachedManaTextDiagnostics)
                {
                    state.ManaDiagnostics[entry.Key] = entry.Value;
                }
            }

            return;
        }

        if (Time.realtimeSinceStartup < _nextManaTextProbeAt)
        {
            state.DisplayedMana = CachedDisplayedMana;
            if (CachedDisplayedMana != null) state.CurrentMana = CachedDisplayedMana;
            if (EnableVerboseDiagnostics)
            {
                foreach (var entry in CachedManaTextDiagnostics)
                {
                    state.ManaDiagnostics[entry.Key] = entry.Value;
                }
            }

            return;
        }

        _nextManaTextProbeAt = Time.realtimeSinceStartup + 0.5f;
        CachedDisplayedMana = null;
        CachedManaText = null;
        CachedUiManaText = null;
        CachedManaTextDiagnostics.Clear();

        if (TryFindDisplayedManaText<TMP_Text>(UnityEngine.Object.FindObjectsOfType<TMP_Text>(), "TMP")
            || TryFindDisplayedManaText<Text>(UnityEngine.Object.FindObjectsOfType<Text>(), "UI"))
        {
            state.DisplayedMana = CachedDisplayedMana;
            if (CachedDisplayedMana != null) state.CurrentMana = CachedDisplayedMana;
            if (EnableVerboseDiagnostics)
            {
                foreach (var entry in CachedManaTextDiagnostics)
                {
                    state.ManaDiagnostics[entry.Key] = entry.Value;
                }
            }

            return;
        }

        var candidates = 0;
        ScanTextComponents<TMP_Text>(UnityEngine.Object.FindObjectsOfType<TMP_Text>(), "TMP", ref candidates);
        ScanTextComponents<Text>(UnityEngine.Object.FindObjectsOfType<Text>(), "UI", ref candidates);

        bool TryFindDisplayedManaText<T>(IEnumerable<T> components, string source) where T : UnityEngine.Component
        {
            if (components == null) return false;

            foreach (var component in components)
            {
                if (!TryCaptureDisplayedManaFromTextComponent(component, source, "DisplayedMana.Direct")) continue;
                return true;
            }

            return false;
        }

        void ScanTextComponents<T>(IEnumerable<T> components, string source, ref int candidateCount) where T : UnityEngine.Component
        {
            if (components == null) return;

            foreach (var component in components)
            {
                if (component == null || component.gameObject == null || !component.gameObject.activeInHierarchy) continue;
                if (component is Behaviour behaviour && !behaviour.enabled) continue;
                if (IsLiveBridgeObject(component.transform)) continue;

                var text = ReadTextLikeValue(component);
                if (!LooksLikeManaTextValue(text)) continue;

                candidateCount++;
                if (candidateCount > 200) return;

                var objectPath = BuildTransformPath(component.transform, 8);
                var key = $"ActiveText[{candidateCount}]";
                var line = $"{source}:{component.GetType().FullName ?? component.GetType().Name}:{objectPath} text={text}{FormatRectTransform(component.transform)}";
                if (EnableVerboseDiagnostics) CachedManaTextDiagnostics[key] = line;

                if (TryCaptureDisplayedManaFromTextComponent(component, source, "DisplayedMana.Resolved"))
                {
                    break;
                }
            }
        }

        state.DisplayedMana = CachedDisplayedMana;
        if (CachedDisplayedMana != null) state.CurrentMana = CachedDisplayedMana;
        if (EnableVerboseDiagnostics)
        {
            foreach (var entry in CachedManaTextDiagnostics)
            {
                state.ManaDiagnostics[entry.Key] = entry.Value;
            }
        }
    }

    private static bool TryCaptureDisplayedManaFromTextComponent(UnityEngine.Component component, string source, string diagnosticKey)
    {
        if (component == null || component.gameObject == null || !component.gameObject.activeInHierarchy) return false;
        if (component is Behaviour behaviour && !behaviour.enabled) return false;
        if (IsLiveBridgeObject(component.transform)) return false;

        var text = ReadTextLikeValue(component).Trim();
        if (!int.TryParse(text, out var parsedMana)) return false;

        var objectPath = BuildTransformPath(component.transform, 12);
        if (!LooksLikeDisplayedManaTextPath(objectPath, component.transform)) return false;

        CachedDisplayedMana = parsedMana;
        if (component is TMP_Text tmpText) CachedManaText = tmpText;
        if (component is Text uiText) CachedUiManaText = uiText;
        if (EnableVerboseDiagnostics)
        {
            CachedManaTextDiagnostics[diagnosticKey] =
                $"{source}:{component.GetType().FullName ?? component.GetType().Name}:{objectPath} text={text}{FormatRectTransform(component.transform)}";
        }

        return true;
    }

    private static bool TryReadCachedManaText(out int mana)
    {
        mana = 0;
        if (CachedManaText != null
            && CachedManaText.gameObject != null
            && CachedManaText.gameObject.activeInHierarchy
            && CachedManaText.enabled
            && int.TryParse(CachedManaText.text, out mana))
        {
            return true;
        }

        if (CachedUiManaText != null
            && CachedUiManaText.gameObject != null
            && CachedUiManaText.gameObject.activeInHierarchy
            && CachedUiManaText.enabled
            && int.TryParse(CachedUiManaText.text, out mana))
        {
            return true;
        }

        return false;
    }

    private static string ReadTextLikeValue(object value)
    {
        if (value is TMP_Text tmpText) return tmpText.text ?? "";
        if (value is Text uiText) return uiText.text ?? "";
        return ReadMember(value, "m_text")?.ToString()
            ?? ReadMember(value, "text")?.ToString()
            ?? ReadMember(value, "Text")?.ToString()
            ?? "";
    }

    private static bool LooksLikeManaTextValue(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        text = text.Trim();
        if (text.Length > 4) return false;
        if (int.TryParse(text, out _)) return true;
        return text.Equals("W", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeDisplayedManaTextPath(string path, Transform transform)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;

        var hasManaCountText = path.Contains("_manaCountText", StringComparison.OrdinalIgnoreCase)
            || path.Contains("manaCountText", StringComparison.OrdinalIgnoreCase)
            || TransformAncestryContains(transform, "manaCountText");
        if (!hasManaCountText) return false;

        return path.Contains("ManaOrb", StringComparison.OrdinalIgnoreCase)
            || path.Contains("_manaDisplay", StringComparison.OrdinalIgnoreCase)
            || TransformAncestryContains(transform, "ManaOrb")
            || TransformAncestryContains(transform, "_manaDisplay");
    }

    private static bool TransformAncestryContains(Transform transform, string value)
    {
        while (transform != null)
        {
            if ((transform.name ?? "").Contains(value, StringComparison.OrdinalIgnoreCase)) return true;
            transform = transform.parent;
        }

        return false;
    }

    private static bool IsLiveBridgeObject(Transform transform)
    {
        while (transform != null)
        {
            if ((transform.name ?? "").Contains("VampireCrawlers.LiveBridge", StringComparison.OrdinalIgnoreCase)) return true;
            transform = transform.parent;
        }

        return false;
    }

    private static string FormatRectTransform(Transform transform)
    {
        if (transform is not RectTransform rectTransform) return "";
        var position = rectTransform.position;
        var size = rectTransform.rect.size;
        return $" pos=({position.x:0},{position.y:0}) size=({size.x:0},{size.y:0})";
    }

    private static string BuildTransformPath(Transform transform, int maxDepth)
    {
        if (transform == null) return "";

        var parts = new List<string>();
        var current = transform;
        while (current != null && parts.Count < maxDepth)
        {
            parts.Add(current.name ?? "");
            current = current.parent;
        }

        parts.Reverse();
        return string.Join("/", parts.Where((part) => !string.IsNullOrWhiteSpace(part)));
    }

    private static void AttachCombatState(LiveState state)
    {
        if (EnableVerboseDiagnostics)
        {
            foreach (var component in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
            {
                if (component == null) continue;
                var typeName = component.GetType().FullName ?? component.GetType().Name;
                if (!typeName.Contains("GameStateManager", StringComparison.OrdinalIgnoreCase)
                    && !typeName.Contains("GameStateMachine", StringComparison.OrdinalIgnoreCase)
                    && !typeName.Contains("Encounter", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var localDiagnostics = new Dictionary<string, string>();
                InspectObjectMembers(
                    typeName,
                    component,
                    localDiagnostics,
                    120,
                    LooksLikeCombatDiagnostic,
                    inspectNestedMatches: true);
                InspectObjectMethods(
                    typeName,
                    component,
                    localDiagnostics,
                    160,
                    LooksLikeCombatDiagnostic);

                foreach (var entry in localDiagnostics)
                {
                    if (state.CombatDiagnostics.Count >= 200) break;
                    if (!state.CombatDiagnostics.ContainsKey(entry.Key)) state.CombatDiagnostics[entry.Key] = entry.Value;
                }

                state.IsInCombat ??= ReadBool(component, "_isInCombat")
                    ?? ReadBool(component, "IsInCombat")
                    ?? ReadBool(component, "isInCombat");
                state.IsPlayerTurn ??= ReadBool(component, "IsPlayerTurn")
                    ?? ReadBool(component, "_isPlayerTurn");
                state.EnemiesRemaining ??= ReadInt(component, "EnemiesRemaining");

                var currentState = ReadMember(component, "CurrentState")
                    ?? ReadMember(ReadMember(component, "GameStateMachine"), "CurrentState")
                    ?? ReadMember(ReadMember(component, "_gameStateMachine"), "CurrentState");
                if (currentState != null && string.IsNullOrWhiteSpace(state.GameStateName))
                {
                    state.GameStateName = FormatStateName(currentState);
                }
            }

            if (state.IsInCombat == null)
            {
                state.IsInCombat = state.GameStateName.Contains("Encounter", StringComparison.OrdinalIgnoreCase)
                    || state.GameStateName.Contains("Turn", StringComparison.OrdinalIgnoreCase);
            }

            AttachCombatDiscovery(state);
            return;
        }

        ApplyCombatPileHeuristic(state);
    }

    private static void AttachCombatDiscovery(LiveState state)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var hasActiveCombatObject = false;
        var hasActivePlayerTurnObject = false;
        foreach (var component in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
        {
            if (component == null) continue;
            var type = component.GetType();
            var typeName = type.FullName ?? type.Name;
            var objectName = ReadUnityName(component) ?? "";
            var activeInHierarchy = component.gameObject != null && component.gameObject.activeInHierarchy;
            var enabledAndActive = component.enabled && activeInHierarchy;
            var combined = $"{typeName} {objectName}";
            if (!LooksLikeCombatDiagnostic(combined, "")
                && (EnableVerboseDiagnostics ? !TypeHasCombatMembers(type) : true))
            {
                continue;
            }

            var active = component.gameObject == null
                ? ""
                : $" activeSelf={component.gameObject.activeSelf} activeInHierarchy={component.gameObject.activeInHierarchy}";
            var line = $"{typeName} name={objectName} enabled={component.enabled}{active}";
            if (EnableVerboseDiagnostics && seen.Add(line)) state.CombatComponents.Add(line);
            if (state.CombatComponents.Count >= 240) break;

            if (enabledAndActive && LooksLikeActiveCombatObject(objectName))
            {
                hasActiveCombatObject = true;
            }

            if (enabledAndActive && LooksLikePlayerTurnObject(objectName))
            {
                hasActivePlayerTurnObject = true;
            }
        }

        if (hasActiveCombatObject) state.IsInCombat = true;
        if (hasActivePlayerTurnObject) state.IsPlayerTurn = true;
        ApplyCombatPileHeuristic(state);
    }

    private static void ApplyCombatPileHeuristic(LiveState state)
    {
        var hasHandCards = state.Piles.FirstOrDefault((pile) => pile.PileId == "HandPile")?.Cards.Count > 0;
        var hasDiscardCards = state.Piles.FirstOrDefault((pile) => pile.PileId == "DiscardPile")?.Cards.Count > 0;
        if (hasHandCards || hasDiscardCards)
        {
            state.IsInCombat = true;
            return;
        }

        state.IsInCombat = false;
    }

    private static bool TypeHasCombatMembers(Type type)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        foreach (var field in type.GetFields(flags))
        {
            if (LooksLikeCombatDiagnostic(field.Name, field.FieldType.Name)) return true;
        }

        foreach (var property in type.GetProperties(flags))
        {
            if (property.GetIndexParameters().Length > 0) continue;
            if (LooksLikeCombatDiagnostic(property.Name, property.PropertyType.Name)) return true;
        }

        foreach (var method in type.GetMethods(flags))
        {
            if (method.GetParameters().Length > 0) continue;
            if (LooksLikeCombatDiagnostic(method.Name, method.ReturnType.Name)) return true;
        }

        return false;
    }

    private static T First<T>() where T : UnityEngine.Object
    {
        var items = UnityEngine.Object.FindObjectsOfType<T>();
        return items == null || items.Length == 0 ? null : items[0];
    }

    private static void AddPile(LiveState state, string pileId, CardPileModel pile, Dictionary<string, LiveCardVisualState> visualStates)
    {
        if (pile == null) return;
        if (state.Piles.Any((entry) => entry.PileId == pileId)) return;

        state.Piles.Add(new LivePile(pileId, ReadCards(pile, visualStates)));
    }

    private static bool LooksLikePileOwner(string typeName)
    {
        return typeName.Contains("Combat", StringComparison.OrdinalIgnoreCase)
            || typeName.Contains("Card", StringComparison.OrdinalIgnoreCase)
            || typeName.Contains("Pile", StringComparison.OrdinalIgnoreCase)
            || typeName.Contains("Run", StringComparison.OrdinalIgnoreCase);
    }

    private static void AddPile(
        LiveState state,
        object owner,
        string pileId,
        Dictionary<string, LiveCardVisualState> visualStates,
        params string[] candidateNames)
    {
        if (state.Piles.Any((pile) => pile.PileId == pileId)) return;

        foreach (var name in candidateNames)
        {
            var candidate = ReadMember(owner, name);
            var model = UnwrapPileModel(candidate);
            var cards = ReadCards(model, visualStates);
            if (cards.Count == 0 && !pileId.Equals("HandPile", StringComparison.Ordinal)) continue;

            state.Piles.Add(new LivePile(pileId, cards));
            return;
        }
    }

    private static object UnwrapPileModel(object value)
    {
        if (value == null) return null;

        return ReadMember(value, "_cardPileModel")
            ?? ReadMember(value, "CardPileModel")
            ?? ReadMember(value, "CardPile")
            ?? ReadMember(value, "_cardPile")
            ?? value;
    }

    private static Dictionary<string, LiveCardVisualState> BuildCardVisualStatesByGuid()
    {
        var visualStates = new Dictionary<string, LiveCardVisualState>(StringComparer.OrdinalIgnoreCase);

        foreach (var component in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
        {
            if (component == null) continue;
            var typeName = component.GetType().FullName ?? component.GetType().Name;
            var objectName = ReadUnityName(component) ?? "";
            if (!typeName.Contains("Card", StringComparison.OrdinalIgnoreCase)
                && !objectName.StartsWith("Card_", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var owner in FindOwnedCardModels(component))
            {
                var guid = FormatGuidValue(owner.Card.Guid);
                if (string.IsNullOrWhiteSpace(guid)) continue;

                var visualState = InspectCardView(component);
                if (EnableVerboseDiagnostics) AddDiagnostic(visualState.Diagnostics, "CardModelOwnerMember", owner.MemberName);
                visualStates[guid] = visualState;
            }
        }

        return visualStates;
    }

    private static List<CardModelOwner> FindOwnedCardModels(MonoBehaviour component)
    {
        var owners = new List<CardModelOwner>();
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var type = component.GetType();

        foreach (var field in type.GetFields(flags))
        {
            AddOwnedCardModel(owners, $"{field.Name}", SafeReadField(field, component));
        }

        foreach (var property in type.GetProperties(flags))
        {
            if (property.GetIndexParameters().Length > 0) continue;
            AddOwnedCardModel(owners, $"{property.Name}", SafeReadProperty(property, component));
        }

        return owners;
    }

    private static void AddOwnedCardModel(List<CardModelOwner> owners, string memberName, object value)
    {
        if (value is CardModel cardModel)
        {
            if (owners.All((owner) => !ReferenceEquals(owner.Card, cardModel)))
            {
                owners.Add(new CardModelOwner(memberName, cardModel));
            }

            return;
        }

        if (value is not IEnumerable enumerable || value is string) return;

        var inspected = 0;
        foreach (var item in enumerable)
        {
            if (item is CardModel itemCardModel
                && owners.All((owner) => !ReferenceEquals(owner.Card, itemCardModel)))
            {
                owners.Add(new CardModelOwner(memberName, itemCardModel));
            }

            inspected++;
            if (inspected >= 200) return;
        }
    }

    private static LiveCardVisualState InspectCardView(MonoBehaviour cardView)
    {
        var visualState = new LiveCardVisualState
        {
            CardViewType = cardView.GetType().FullName ?? cardView.GetType().Name,
            CardViewName = ReadUnityName(cardView) ?? "",
        };

        if (EnableVerboseDiagnostics)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            foreach (var field in cardView.GetType().GetFields(flags))
            {
                if (!LooksLikeVisualDiagnostic(field.Name, field.FieldType.Name)) continue;
                var value = SafeReadField(field, cardView);
                AddDiagnostic(visualState.Diagnostics, field.Name, value);
            }

            foreach (var property in cardView.GetType().GetProperties(flags))
            {
                if (property.GetIndexParameters().Length > 0) continue;
                if (!LooksLikeVisualDiagnostic(property.Name, property.PropertyType.Name)) continue;
                var value = SafeReadProperty(property, cardView);
                AddDiagnostic(visualState.Diagnostics, property.Name, value);
            }

            foreach (var child in cardView.GetComponentsInChildren<UnityEngine.Component>(true))
            {
                if (child == null) continue;
                var typeName = child.GetType().FullName ?? child.GetType().Name;
                var objectName = ReadUnityName(child) ?? "";
                if (!LooksLikeVisualDiagnostic(objectName, typeName)) continue;

                var active = child.gameObject == null
                    ? ""
                    : $" activeSelf={child.gameObject.activeSelf} activeInHierarchy={child.gameObject.activeInHierarchy}";
                var enabled = child is Behaviour behaviour ? $" enabled={behaviour.enabled}" : "";
                visualState.Components.Add($"{typeName} name={objectName}{enabled}{active}");
                if (visualState.Components.Count >= 40) break;
            }
        }

        InspectBreakableCard(cardView, visualState);
        InspectComboCostText(cardView, visualState);
        if (EnableVerboseDiagnostics) InspectComboPlayableState(cardView, visualState);

        return visualState;
    }

    private static void InspectBreakableCard(MonoBehaviour cardView, LiveCardVisualState visualState)
    {
        var breakable = cardView.GetComponentsInChildren<UnityEngine.Component>(true)
            .FirstOrDefault((component) =>
                component != null
                && (component.GetType().FullName ?? component.GetType().Name)
                    .Contains("BreakableCard", StringComparison.OrdinalIgnoreCase));
        if (breakable == null) return;

        visualState.BreakableCrackState = (ReadMember(breakable, "CrackState") ?? ReadMember(breakable, "_cardCrackState"))?.ToString() ?? "";
        visualState.BreakableCrackStage = ReadIntValue(ReadMember(breakable, "CardCrackStage") ?? ReadMember(breakable, "_cardCrackStage")) ?? 0;
        visualState.BreakableTimesPlayedThisTurn = ReadIntValue(ReadMember(breakable, "TimesPlayedThisTurn") ?? ReadMember(breakable, "_timesPlayedThisTurn")) ?? 0;
        if (EnableVerboseDiagnostics)
        {
            AddDiagnostic(visualState.Diagnostics, "BreakableCard.Type", breakable.GetType().FullName ?? breakable.GetType().Name);
            AddDiagnostic(visualState.Diagnostics, "BreakableCard.CrackState", visualState.BreakableCrackState);
            AddDiagnostic(visualState.Diagnostics, "BreakableCard.CardCrackStage", visualState.BreakableCrackStage);
            AddDiagnostic(visualState.Diagnostics, "BreakableCard.TimesPlayedThisTurn", visualState.BreakableTimesPlayedThisTurn);
            AddDiagnostic(visualState.Diagnostics, "BreakableCard.Object", breakable);
            InspectObjectMembers("BreakableCard", breakable, visualState.Diagnostics, 80);
        }

        var crackTransform = FindChildTransform(cardView.transform, "_cardCrack");
        if (crackTransform == null) return;

        if (EnableVerboseDiagnostics)
        {
            AddDiagnostic(visualState.Diagnostics, "CardCrack.Transform", crackTransform);
            AddDiagnostic(visualState.Diagnostics, "CardCrack.ChildCount", crackTransform.childCount);
        }

        var crackIndex = 0;
        foreach (var component in crackTransform.GetComponentsInChildren<UnityEngine.Component>(true))
        {
            if (component == null) continue;
            var typeName = component.GetType().FullName ?? component.GetType().Name;
            var objectName = ReadUnityName(component) ?? "";
            if (component is Image image)
            {
                visualState.CardCrackSprite = ExtractUnityObjectName(FormatDiagnosticValue(image.overrideSprite ?? image.sprite));
                if (EnableVerboseDiagnostics)
                {
                    AddDiagnostic(visualState.Diagnostics, "CardCrack[2].m_Sprite", image.sprite);
                    AddDiagnostic(visualState.Diagnostics, "CardCrack[2].m_OverrideSprite", image.overrideSprite);
                }
            }

            if (EnableVerboseDiagnostics)
            {
                var enabled = component is Behaviour behaviour ? $" enabled={behaviour.enabled}" : "";
                var active = component.gameObject == null
                    ? ""
                    : $" activeSelf={component.gameObject.activeSelf} activeInHierarchy={component.gameObject.activeInHierarchy}";
                visualState.Components.Add($"CardCrack[{crackIndex}] {typeName} name={objectName}{enabled}{active}");

                if (LooksLikeVisualDiagnostic(objectName, typeName))
                {
                    InspectObjectMembers($"CardCrack[{crackIndex}]", component, visualState.Diagnostics, 120);
                }
            }

            crackIndex++;
            if (crackIndex >= 80 || visualState.Components.Count >= 140) break;
        }
    }

    private static void InspectComboCostText(MonoBehaviour cardView, LiveCardVisualState visualState)
    {
        var costText = ReadMember(cardView, "_costText") ?? ReadMember(cardView, "CostText");
        visualState.ComboCostText = ReadMember(costText, "m_text")?.ToString()
            ?? ReadMember(costText, "text")?.ToString()
            ?? "";
    }

    private static void InspectComboPlayableState(MonoBehaviour cardView, LiveCardVisualState visualState)
    {
        InspectObjectMembers(
            "ComboProbe.CardView",
            cardView,
            visualState.ComboDiagnostics,
            120,
            LooksLikeComboDiagnostic,
            inspectNestedMatches: true);

        var comboIndex = 0;
        foreach (var component in cardView.GetComponentsInChildren<UnityEngine.Component>(true))
        {
            if (component == null) continue;
            var typeName = component.GetType().FullName ?? component.GetType().Name;
            var objectName = ReadUnityName(component) ?? "";
            if (!LooksLikeComboDiagnostic(objectName, typeName)) continue;

            var enabled = component is Behaviour behaviour ? $" enabled={behaviour.enabled}" : "";
            var active = component.gameObject == null
                ? ""
                : $" activeSelf={component.gameObject.activeSelf} activeInHierarchy={component.gameObject.activeInHierarchy}";
            visualState.ComboComponents.Add($"ComboProbe[{comboIndex}] {typeName} name={objectName}{enabled}{active}");
            InspectObjectMembers(
                $"ComboProbe[{comboIndex}]",
                component,
                visualState.ComboDiagnostics,
                180,
                LooksLikeComboDiagnostic,
                inspectNestedMatches: false);

            comboIndex++;
            if (comboIndex >= 80 || visualState.ComboComponents.Count >= 120) break;
        }
    }

    private static void InspectObjectMembers(string prefix, object owner, Dictionary<string, string> diagnostics, int maxCount)
    {
        InspectObjectMembers(prefix, owner, diagnostics, maxCount, LooksLikeVisualDiagnostic, inspectNestedMatches: false);
    }

    private static void InspectObjectMembers(
        string prefix,
        object owner,
        Dictionary<string, string> diagnostics,
        int maxCount,
        Func<string, string, bool> memberMatcher,
        bool inspectNestedMatches)
    {
        if (owner == null) return;
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var type = owner.GetType();

        foreach (var field in type.GetFields(flags))
        {
            if (diagnostics.Count >= maxCount) return;
            var value = SafeReadField(field, owner);
            if (!ShouldExportDiagnosticValue(field.Name, field.FieldType, value, memberMatcher)) continue;
            AddDiagnostic(diagnostics, $"{prefix}.{field.Name}", value);
            if (inspectNestedMatches && value != null && !(value is string) && memberMatcher(field.Name, field.FieldType.Name))
            {
                InspectObjectMembers($"{prefix}.{field.Name}", value, diagnostics, maxCount, memberMatcher, inspectNestedMatches: false);
            }
        }

        foreach (var property in type.GetProperties(flags))
        {
            if (diagnostics.Count >= maxCount) return;
            if (property.GetIndexParameters().Length > 0) continue;
            var value = SafeReadProperty(property, owner);
            if (!ShouldExportDiagnosticValue(property.Name, property.PropertyType, value, memberMatcher)) continue;
            AddDiagnostic(diagnostics, $"{prefix}.{property.Name}", value);
            if (inspectNestedMatches && value != null && !(value is string) && memberMatcher(property.Name, property.PropertyType.Name))
            {
                InspectObjectMembers($"{prefix}.{property.Name}", value, diagnostics, maxCount, memberMatcher, inspectNestedMatches: false);
            }
        }
    }

    private static void InspectObjectMethods(
        string prefix,
        object owner,
        Dictionary<string, string> diagnostics,
        int maxCount,
        Func<string, string, bool> memberMatcher)
    {
        if (owner == null) return;
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        foreach (var method in owner.GetType().GetMethods(flags))
        {
            if (diagnostics.Count >= maxCount) return;
            if (method.GetParameters().Length > 0) continue;
            if (method.ReturnType == typeof(void)) continue;
            if (!memberMatcher(method.Name, method.ReturnType.Name)) continue;
            if (!ShouldExportDiagnosticValue(method.Name, method.ReturnType, null, memberMatcher)) continue;

            try
            {
                AddDiagnostic(diagnostics, $"{prefix}.{method.Name}()", method.Invoke(owner, Array.Empty<object>()));
            }
            catch
            {
                AddDiagnostic(diagnostics, $"{prefix}.{method.Name}()", "<invoke failed>");
            }
        }
    }

    private static bool ShouldExportDiagnosticValue(string name, Type valueType, object value)
    {
        return ShouldExportDiagnosticValue(name, valueType, value, LooksLikeVisualDiagnostic);
    }

    private static bool ShouldExportDiagnosticValue(string name, Type valueType, object value, Func<string, string, bool> memberMatcher)
    {
        if (memberMatcher(name, valueType.Name)) return true;
        if (value == null) return true;
        if (valueType.IsPrimitive || valueType.IsEnum || valueType == typeof(string)) return true;
        if (value is UnityEngine.Object) return true;
        return false;
    }

    private static Transform FindChildTransform(Transform root, string childName)
    {
        if (root == null) return null;
        if (string.Equals(root.name, childName, StringComparison.OrdinalIgnoreCase)) return root;

        for (var index = 0; index < root.childCount; index++)
        {
            var found = FindChildTransform(root.GetChild(index), childName);
            if (found != null) return found;
        }

        return null;
    }

    private static bool LooksLikeVisualDiagnostic(string name, string typeName)
    {
        var combined = $"{name} {typeName}";
        return combined.Contains("crack", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("shatter", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("break", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("broken", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("damage", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("visual", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("overlay", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("stamp", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeComboDiagnostic(string name, string typeName)
    {
        var combined = $"{name} {typeName}";
        return combined.Contains("combo", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("highlight", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("glow", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("playable", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("afford", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("mana", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("cost", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("flame", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeCombatDiagnostic(string name, string typeName)
    {
        var combined = $"{name} {typeName}";
        return combined.Contains("combat", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("encounter", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("battle", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("turn", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("enemy", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("enemies", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("gameState", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("currentState", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("stateMachine", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("playerTurn", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeActiveCombatObject(string objectName)
    {
        return false;
    }

    private static bool LooksLikePlayerTurnObject(string objectName)
    {
        return objectName.Contains("EndTurnButton", StringComparison.OrdinalIgnoreCase)
            || objectName.Contains("_EndTurnButton", StringComparison.OrdinalIgnoreCase);
    }

    private static void AddDiagnostic(Dictionary<string, string> diagnostics, string key, object value)
    {
        if (diagnostics.Count >= 80 || diagnostics.ContainsKey(key)) return;
        diagnostics[key] = FormatDiagnosticValue(value);
    }

    private static string FormatDiagnosticValue(object value)
    {
        if (value == null) return "null";
        if (value is string text) return text;
        if (value is bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal)
        {
            return value.ToString();
        }

        var type = value.GetType();
        if (type.IsEnum) return value.ToString();

        if (value is GameObject gameObject)
        {
            return $"{type.FullName} name={gameObject.name} activeSelf={gameObject.activeSelf} activeInHierarchy={gameObject.activeInHierarchy}";
        }

        if (value is Behaviour behaviour)
        {
            return $"{type.FullName} name={behaviour.name} enabled={behaviour.enabled} activeSelf={behaviour.gameObject.activeSelf} activeInHierarchy={behaviour.gameObject.activeInHierarchy}";
        }

        if (value is UnityEngine.Component component)
        {
            return $"{type.FullName} name={component.name} activeSelf={component.gameObject.activeSelf} activeInHierarchy={component.gameObject.activeInHierarchy}";
        }

        if (value is UnityEngine.Object unityObject)
        {
            return $"{type.FullName} name={unityObject.name}";
        }

        return value.ToString();
    }

    private static List<LiveCard> ReadCards(object pile, Dictionary<string, LiveCardVisualState> visualStates)
    {
        if (pile is CardPileModel cardPileModel)
        {
            var typedCards = new List<LiveCard>();
            for (var index = 0; index < cardPileModel._cards.Count; index++)
            {
                typedCards.Add(ReadCard(cardPileModel._cards[index], visualStates));
            }
            return typedCards;
        }

        var cards = new List<LiveCard>();
        var collection = ReadMember(pile, "Cards")
            ?? ReadMember(pile, "CardConfigs")
            ?? ReadMember(pile, "_cards")
            ?? ReadMember(pile, "_cardConfigs")
            ?? ReadMember(pile, "cards");

        if (collection is not IEnumerable enumerable) return cards;

        foreach (var item in enumerable)
        {
            var card = ReadCard(item, visualStates);
            if (!string.IsNullOrWhiteSpace(card.CardConfigId)) cards.Add(card);
        }

        return cards;
    }

    private static LiveCard ReadCard(object value, Dictionary<string, LiveCardVisualState> visualStates)
    {
        if (value is CardModel cardModel)
        {
            var card = new LiveCard
            {
                CardConfigId = cardModel.CardConfig?.AssetId ?? "",
                BaseCardConfigId = cardModel.BaseCardConfig?.AssetId ?? cardModel.CardConfig?.AssetId ?? "",
                CardGuid = FormatGuidValue(cardModel.Guid),
                ManaCostModifier = cardModel.ManaCostModifier,
                TempManaCostModifier = cardModel.TempManaCostModifier,
                ConfusedManaCostModifier = cardModel.ConfuseManaCostModifier,
                IsBroken = cardModel.IsBroken,
                IsCopyWithDestroy = cardModel.IsCopyWithDestroy,
                TimesLimitBroken = cardModel.TimesLimitBroken,
                CardCrackStage = ReadCardCrackStage(cardModel),
                GemIds = ReadGemIds(cardModel),
            };
            card.Cost = GetEffectiveCostLabel(cardModel, card);
            InspectComboState(cardModel, card);
            AttachVisualState(card, visualStates);
            return card;
        }

        var config = ReadMember(value, "CardConfig")
            ?? ReadMember(value, "cardConfig")
            ?? ReadMember(value, "_cardConfig")
            ?? ReadMember(value, "BaseCardConfig")
            ?? ReadMember(value, "_baseCardConfig")
            ?? value;

        var cardId = ReadString(value, "CardConfigId")
            ?? ReadString(config, "CardConfigId")
            ?? ReadString(config, "AssetId")
            ?? ReadString(config, "_assetId")
            ?? ReadString(config, "name")
            ?? ReadUnityName(config);

        var baseConfig = ReadMember(value, "BaseCardConfig")
            ?? ReadMember(value, "_baseCardConfig");
        var baseId = ReadString(value, "BaseCardConfigId")
            ?? ReadString(baseConfig, "CardConfigId")
            ?? ReadString(baseConfig, "AssetId")
            ?? ReadString(baseConfig, "_assetId")
            ?? cardId;

        var fallbackCard = new LiveCard
        {
            CardConfigId = cardId ?? "",
            BaseCardConfigId = baseId ?? cardId ?? "",
            CardGuid = ReadString(value, "CardGuid") ?? FormatGuidValue(ReadMember(value, "Guid")),
            ManaCostModifier = ReadInt(value, "ManaCostModifier") ?? ReadInt(value, "_manaCostModifier") ?? 0,
            TempManaCostModifier = ReadInt(value, "TempManaCostModifier") ?? ReadInt(value, "_temporaryManaCostModifier") ?? 0,
            ConfusedManaCostModifier = ReadInt(value, "ConfusedManaCostModifier") ?? ReadInt(value, "_confuseManaCostModifier") ?? 0,
            CardCrackStage = ReadCardCrackStage(value),
            GemIds = ReadGemIds(value),
        };
        fallbackCard.Cost = GetEffectiveCostLabel(value, fallbackCard);
        InspectComboState(value, fallbackCard);
        AttachVisualState(fallbackCard, visualStates);
        return fallbackCard;
    }

    private static void AttachVisualState(LiveCard card, Dictionary<string, LiveCardVisualState> visualStates)
    {
        if (card == null
            || visualStates == null
            || string.IsNullOrWhiteSpace(card.CardGuid)
            || !visualStates.TryGetValue(card.CardGuid, out var visualState))
        {
            return;
        }

        card.CardViewType = visualState.CardViewType;
        card.CardViewName = visualState.CardViewName;
        card.CardViewDiagnostics = visualState.Diagnostics;
        card.CardViewComponents = visualState.Components;
        MergeDiagnostics(card.ComboDiagnostics, visualState.ComboDiagnostics);
        card.ComboComponents = visualState.ComboComponents;
        card.ComboCostText = visualState.ComboCostText
            ?? GetDiagnosticValue(card.ComboDiagnostics, "ComboProbe.CardView._costText.m_text")
            ?? "";
        card.IsComboCostHighlighted = card.ComboCostText.Contains("Orange Glow", StringComparison.OrdinalIgnoreCase);
        card.BreakableCrackState = visualState.BreakableCrackState;
        card.BreakableCrackStage = visualState.BreakableCrackStage;
        card.BreakableTimesPlayedThisTurn = visualState.BreakableTimesPlayedThisTurn;
        card.CardCrackSprite = visualState.CardCrackSprite;
    }

    private static void InspectComboState(object cardObject, LiveCard card)
    {
        if (!EnableVerboseDiagnostics) return;

        InspectObjectMembers(
            "ComboProbe.CardModel",
            cardObject,
            card.ComboDiagnostics,
            180,
            LooksLikeComboDiagnostic,
            inspectNestedMatches: true);
        InspectObjectMethods(
            "ComboProbe.CardModel",
            cardObject,
            card.ComboDiagnostics,
            220,
            LooksLikeComboDiagnostic);
    }

    private static void MergeDiagnostics(Dictionary<string, string> target, Dictionary<string, string> source)
    {
        if (target == null || source == null) return;
        foreach (var entry in source)
        {
            if (target.Count >= 240) return;
            if (!target.ContainsKey(entry.Key)) target[entry.Key] = entry.Value;
        }
    }

    private static string GetDiagnosticValue(Dictionary<string, string> diagnostics, string key)
    {
        return diagnostics != null && diagnostics.TryGetValue(key, out var value) ? value : null;
    }

    private static int ParseDiagnosticInt(string value)
    {
        return int.TryParse(value, out var parsed) ? parsed : 0;
    }

    private static string ExtractUnityObjectName(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value == "null") return "";

        const string marker = " name=";
        var markerIndex = value.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex < 0) return value;

        var nameStart = markerIndex + marker.Length;
        var nameEnd = value.IndexOf(" enabled=", nameStart, StringComparison.OrdinalIgnoreCase);
        if (nameEnd < 0) nameEnd = value.IndexOf(" activeSelf=", nameStart, StringComparison.OrdinalIgnoreCase);
        return nameEnd < 0 ? value.Substring(nameStart) : value.Substring(nameStart, nameEnd - nameStart);
    }

    private static string FormatHandManaTotal(LiveState state)
    {
        var hand = state.Piles.FirstOrDefault((pile) => pile.PileId == "HandPile");
        if (hand == null) return "--";

        var numericTotal = 0;
        var extras = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        foreach (var card in hand.Cards)
        {
            if (int.TryParse(card.Cost, out var cost))
            {
                numericTotal += cost;
                continue;
            }

            var label = string.IsNullOrWhiteSpace(card.Cost) ? "Unknown" : card.Cost;
            extras[label] = extras.TryGetValue(label, out var count) ? count + 1 : 1;
        }

        var parts = new List<string> { numericTotal.ToString() };
        parts.AddRange(extras.OrderBy((entry) => entry.Key).Select((entry) => $"{entry.Value}{entry.Key}"));
        return string.Join(" + ", parts);
    }

    private static string GetEffectiveCostLabel(object cardObject, LiveCard card)
    {
        if (HasWildCost(card)) return "W";

        var config = ReadMember(cardObject, "CardConfig")
            ?? ReadMember(cardObject, "cardConfig")
            ?? ReadMember(cardObject, "_cardConfig")
            ?? cardObject;

        var baseCost =
            InvokeInt(config, "GetManaCost")
            ?? InvokeInt(config, "GetCost")
            ?? ReadInt(config, "ManaCost")
            ?? ReadInt(config, "manaCost")
            ?? ReadInt(config, "_manaCost")
            ?? ReadInt(cardObject, "BaseCost")
            ?? ReadInt(cardObject, "baseCost");

        if (baseCost == null)
        {
            baseCost =
                ReadInt(cardObject, "ManaCost")
                ?? ReadInt(cardObject, "Cost")
                ?? InvokeInt(cardObject, "GetManaCost")
                ?? InvokeInt(cardObject, "GetCost");
        }

        if (baseCost == null) return "Unknown";
        var total = baseCost.Value
            + card.ManaCostModifier
            + card.TempManaCostModifier
            + card.ConfusedManaCostModifier
            + GetGemManaModifier(card.GemIds);
        return total.ToString();
    }

    private static bool HasWildCost(LiveCard card)
    {
        return card.CardConfigId.StartsWith("Card_W_", StringComparison.Ordinal)
            || card.CardConfigId.StartsWith("Card_E_", StringComparison.Ordinal)
            || card.CardConfigId == "Card_M_0_Wings"
            || card.GemIds.Any((gem) => gem == "GemConfig_SetCostType_Wild");
    }

    private static int GetGemManaModifier(List<string> gems)
    {
        var total = 0;
        foreach (var gem in gems)
        {
            var normalized = gem.Replace("GemConfig_Mana_", "", StringComparison.Ordinal)
                .Replace("GemConfig_Mana", "", StringComparison.Ordinal);
            if (normalized.StartsWith("Plus", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(normalized["Plus".Length..], out var plus))
            {
                total += plus;
            }
            else if (normalized.StartsWith("Minus", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(normalized["Minus".Length..], out var minus))
            {
                total -= minus;
            }
        }

        return total;
    }

    private static List<string> ReadGemIds(object value)
    {
        if (value is CardModel cardModel)
        {
            var typedGems = new List<string>();
            var gemSlots = cardModel.CardGemsModel?._gemSlots;
            if (gemSlots == null) return typedGems;

            for (var index = 0; index < gemSlots.Count; index++)
            {
                var slot = gemSlots[index];
                if (slot == null || slot.IsSlotEmpty || slot.GemConfig == null) continue;
                typedGems.Add(slot.GemConfig.AssetId);
            }

            return typedGems;
        }

        var gems = new List<string>();
        var collection = ReadMember(value, "GemIds") ?? ReadMember(value, "Gems") ?? ReadMember(value, "_gems");
        if (collection is not IEnumerable enumerable) return gems;

        foreach (var item in enumerable)
        {
            var id = ReadString(item, "GemConfigId")
                ?? ReadString(item, "AssetId")
                ?? ReadString(item, "_assetId")
                ?? ReadUnityName(item)
                ?? item?.ToString();
            if (!string.IsNullOrWhiteSpace(id)) gems.Add(id);
        }

        return gems;
    }

    private static object ReadMember(object value, string name)
    {
        if (value == null) return null;
        var type = value.GetType();
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        return type.GetProperty(name, flags)?.GetValue(value)
            ?? type.GetField(name, flags)?.GetValue(value);
    }

    private static string ReadString(object value, string name)
    {
        return ReadMember(value, name) as string;
    }

    private static string FormatGuidValue(object value)
    {
        if (value == null) return "";
        if (value is Guid guid) return guid.ToString();
        if (value is string text) return text;

        var candidateNames = new[]
        {
            "Value",
            "Guid",
            "_guid",
            "guid",
            "SerializedGuid",
            "_serializedGuid",
            "m_Guid",
        };
        foreach (var name in candidateNames)
        {
            var member = ReadMember(value, name);
            if (member == null) continue;
            var formatted = FormatGuidValue(member);
            if (!string.IsNullOrWhiteSpace(formatted)) return formatted;
        }

        var fields = value.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .Where((field) => field.FieldType == typeof(string) || field.FieldType == typeof(Guid) || field.FieldType.IsPrimitive)
            .Select((field) => field.GetValue(value)?.ToString())
            .Where((entry) => !string.IsNullOrWhiteSpace(entry))
            .ToList();
        if (fields.Count > 0) return string.Join("-", fields);

        var raw = value.ToString();
        return raw == value.GetType().FullName ? "" : raw;
    }

    private static string ReadUnityName(object value)
    {
        return value is UnityEngine.Object unityObject ? unityObject.name : null;
    }

    private static int? ReadInt(object value, string name)
    {
        var member = ReadMember(value, name);
        if (member == null) return null;
        return int.TryParse(member.ToString(), out var parsed) ? parsed : null;
    }

    private static int? ReadIntValue(object value, params string[] names)
    {
        if (value == null) return null;

        if (value is int directInt) return directInt;
        if (int.TryParse(value.ToString(), out var directParsed)) return directParsed;

        foreach (var name in names)
        {
            var member = ReadMember(value, name);
            var parsed = ReadIntValue(member, "Value", "value", "m_value", "_value");
            if (parsed != null) return parsed;
        }

        return null;
    }

    private static bool? ReadBool(object value, string name)
    {
        var member = ReadMember(value, name);
        if (member == null) return null;
        return bool.TryParse(member.ToString(), out var parsed) ? parsed : null;
    }

    private static string FormatStateName(object state)
    {
        if (state == null) return "";
        if (state is string text) return text;
        var type = state.GetType();
        if (state is UnityEngine.Object unityObject && !string.IsNullOrWhiteSpace(unityObject.name))
        {
            return $"{type.FullName ?? type.Name}:{unityObject.name}";
        }

        return type.FullName ?? type.Name;
    }

    private static int ReadCardCrackStage(object value)
    {
        if (value == null) return 0;

        return ReadInt(value, "CardCrackStage")
            ?? ReadInt(value, "CrackStage")
            ?? ReadInt(value, "_cardCrackStage")
            ?? ReadInt(value, "_crackStage")
            ?? ReadInt(value, "cardCrackStage")
            ?? ReadInt(value, "crackStage")
            ?? ReadInt(ReadMember(value, "CardCrackingConfig"), "Stage")
            ?? ReadInt(ReadMember(value, "_cardCrackingConfig"), "Stage")
            ?? ReadInt(ReadMember(value, "CrackingConfig"), "Stage")
            ?? ReadInt(ReadMember(value, "_crackingConfig"), "Stage")
            ?? 0;
    }

    private static int? InvokeInt(object value, string name)
    {
        if (value == null) return null;
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var method = value.GetType().GetMethod(name, flags, null, Type.EmptyTypes, null);
        if (method == null) return null;
        var result = method.Invoke(value, Array.Empty<object>());
        if (result == null) return null;
        return int.TryParse(result.ToString(), out var parsed) ? parsed : null;
    }
}

public sealed class LiveState
{
    public int SchemaVersion { get; set; } = 1;
    public string Source { get; set; } = "bepinex";
    public string UpdatedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");
    public bool? IsInCombat { get; set; }
    public bool? IsPlayerTurn { get; set; }
    public int? EnemiesRemaining { get; set; }
    public int? CurrentMana { get; set; }
    public int? CachedMana { get; set; }
    public int? StartingMana { get; set; }
    public int? FccMana { get; set; }
    public int? DisplayedMana { get; set; }
    public string GameStateName { get; set; } = "";
    public Dictionary<string, string> CombatDiagnostics { get; set; } = new();
    public List<string> CombatComponents { get; set; } = new();
    public Dictionary<string, string> ManaDiagnostics { get; set; } = new();
    public List<LivePile> Piles { get; set; } = new();
}

public sealed class LivePile
{
    public LivePile(string pileId, List<LiveCard> cards)
    {
        PileId = pileId;
        Cards = cards;
    }

    public string PileId { get; set; }
    public List<LiveCard> Cards { get; set; }
}

public sealed class LiveCard
{
    public string CardConfigId { get; set; } = "";
    public string BaseCardConfigId { get; set; } = "";
    public string CardGuid { get; set; } = "";
    public int ManaCostModifier { get; set; }
    public int TempManaCostModifier { get; set; }
    public int ConfusedManaCostModifier { get; set; }
    public string Cost { get; set; } = "Unknown";
    public bool IsBroken { get; set; }
    public bool IsCopyWithDestroy { get; set; }
    public int TimesLimitBroken { get; set; }
    public int CardCrackStage { get; set; }
    public string BreakableCrackState { get; set; } = "";
    public int BreakableCrackStage { get; set; }
    public int BreakableTimesPlayedThisTurn { get; set; }
    public string CardCrackSprite { get; set; } = "";
    public bool IsComboCostHighlighted { get; set; }
    public string ComboCostText { get; set; } = "";
    public List<string> GemIds { get; set; } = new();
    public string CardViewType { get; set; } = "";
    public string CardViewName { get; set; } = "";
    public Dictionary<string, string> CardViewDiagnostics { get; set; } = new();
    public List<string> CardViewComponents { get; set; } = new();
    public Dictionary<string, string> ComboDiagnostics { get; set; } = new();
    public List<string> ComboComponents { get; set; } = new();
}

public sealed class LiveCardVisualState
{
    public string CardViewType { get; set; } = "";
    public string CardViewName { get; set; } = "";
    public Dictionary<string, string> Diagnostics { get; set; } = new();
    public List<string> Components { get; set; } = new();
    public string ComboCostText { get; set; } = "";
    public string BreakableCrackState { get; set; } = "";
    public int BreakableCrackStage { get; set; }
    public int BreakableTimesPlayedThisTurn { get; set; }
    public string CardCrackSprite { get; set; } = "";
    public Dictionary<string, string> ComboDiagnostics { get; set; } = new();
    public List<string> ComboComponents { get; set; } = new();
}

public sealed class CardModelOwner
{
    public CardModelOwner(string memberName, CardModel card)
    {
        MemberName = memberName;
        Card = card;
    }

    public string MemberName { get; set; }
    public CardModel Card { get; set; }
}

public sealed class BridgeCommand
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public bool DryRun { get; set; }
    public string CardGuid { get; set; } = "";
    public string CardConfigId { get; set; } = "";
    public string PileId { get; set; } = "";
    public int Index { get; set; } = -1;
    public string IssuedAt { get; set; } = "";
}

public sealed class PlayCardInvocation
{
    public string Method { get; set; } = "";
    public bool Ok { get; set; }
    public string ReturnValue { get; set; } = "";
    public string Error { get; set; } = "";
}

public sealed class BridgeCommandResult
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public bool Ok { get; set; }
    public bool DryRun { get; set; }
    public string Message { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
    public LiveCard MatchedCard { get; set; }
    public List<string> CandidateMethods { get; set; } = new();
    public string RuntimeCardType { get; set; } = "";
    public string RuntimeCardGuid { get; set; } = "";
    public List<string> ReferenceOwners { get; set; } = new();
    public List<string> OwnerCandidateMethods { get; set; } = new();
    public string InvocationMethod { get; set; } = "";
    public string InvocationReturnValue { get; set; } = "";
    public string InvocationError { get; set; } = "";
}
