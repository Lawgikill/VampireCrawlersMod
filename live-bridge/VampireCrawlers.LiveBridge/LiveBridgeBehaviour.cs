using System.Collections;
using System.Reflection;
using System.Text.Json;
using Nosebleed.Pancake.Models;
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
        WriteIndented = true,
    };

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
    private bool _overlayDisabled;

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
            _handManaTotal = $"HAND MANA\nTOTAL: {FormatHandManaTotal(state)}";
            UpdateOverlayCanvas();
            ProcessPendingCommand(state);

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

    private void ProcessPendingCommand(LiveState state)
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

        WriteCommandResult(InspectPlayCardCommand(command, state));
    }

    private static BridgeCommandResult InspectPlayCardCommand(BridgeCommand command, LiveState state)
    {
        var hand = state.Piles.FirstOrDefault((pile) => pile.PileId == "HandPile");
        var matched = FindCommandCard(hand, command);
        var candidates = FindPlayCardCandidates();
        var message = matched == null
            ? $"No matching hand card found for {command.CardConfigId} at index {command.Index}."
            : $"Matched {matched.CardConfigId} in hand. Play invocation is not enabled yet; inspect candidates to choose the real game API.";

        Plugin.BridgeLog?.LogInfo($"Received play-card command for {command.CardConfigId} index={command.Index} guid={command.CardGuid}. {message}");
        foreach (var candidate in candidates.Take(20))
        {
            Plugin.BridgeLog?.LogInfo($"Play-card candidate: {candidate}");
        }

        return new BridgeCommandResult
        {
            Id = command.Id,
            Type = command.Type,
            Ok = matched != null,
            DryRun = true,
            Message = message,
            MatchedCard = matched,
            CandidateMethods = candidates,
        };
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

    private void UpdateOverlayCanvas()
    {
        if (_overlayDisabled) return;

        try
        {
            EnsureOverlayCanvas();
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

        AddPile(best, "HandPile", First<HandPileModel>()?.CardPile);
        AddPile(best, "DrawPile", First<DrawPileModel>()?.CardPileModel);
        AddPile(best, "DiscardPile", First<DiscardPileModel>()?.CardPile);
        AddPile(best, "ComboPile", First<ComboPileModel>()?.CardPile);
        AddPile(best, "FccPile", First<FccPileModel>()?.CardPile);
        AddPile(best, "ThrowingPile", First<ThrowingPileModel>()?.CardPile);

        if (best.Piles.Count > 0)
        {
            best.UpdatedAt = DateTimeOffset.UtcNow.ToString("O");
            return best;
        }

        var components = UnityEngine.Object.FindObjectsOfType<MonoBehaviour>();
        foreach (var component in components)
        {
            if (component == null) continue;
            var typeName = component.GetType().Name;
            if (!LooksLikePileOwner(typeName)) continue;

            AddPile(best, component, "HandPile", "_handPile", "_handPileView", "HandPileView");
            AddPile(best, component, "DrawPile", "_drawPile", "_drawPileView", "DrawPileView");
            AddPile(best, component, "DiscardPile", "_discardPile", "_discardPileView", "DiscardPileView");
            AddPile(best, component, "ComboPile", "_comboPile", "_comboPileView", "ComboPileView");
            AddPile(best, component, "FccPile", "_fccPile", "_fccPileView", "FccPileView");
            AddPile(best, component, "ThrowingPile", "_throwingPileModel", "_throwingPileView", "ThrowingPileModel");
        }

        best.UpdatedAt = DateTimeOffset.UtcNow.ToString("O");
        return best;
    }

    private static T First<T>() where T : UnityEngine.Object
    {
        var items = UnityEngine.Object.FindObjectsOfType<T>();
        return items == null || items.Length == 0 ? null : items[0];
    }

    private static void AddPile(LiveState state, string pileId, CardPileModel pile)
    {
        if (pile == null) return;
        if (state.Piles.Any((entry) => entry.PileId == pileId)) return;

        state.Piles.Add(new LivePile(pileId, ReadCards(pile)));
    }

    private static bool LooksLikePileOwner(string typeName)
    {
        return typeName.Contains("Combat", StringComparison.OrdinalIgnoreCase)
            || typeName.Contains("Card", StringComparison.OrdinalIgnoreCase)
            || typeName.Contains("Pile", StringComparison.OrdinalIgnoreCase)
            || typeName.Contains("Run", StringComparison.OrdinalIgnoreCase);
    }

    private static void AddPile(LiveState state, object owner, string pileId, params string[] candidateNames)
    {
        if (state.Piles.Any((pile) => pile.PileId == pileId)) return;

        foreach (var name in candidateNames)
        {
            var candidate = ReadMember(owner, name);
            var model = UnwrapPileModel(candidate);
            var cards = ReadCards(model);
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

    private static List<LiveCard> ReadCards(object pile)
    {
        if (pile is CardPileModel cardPileModel)
        {
            var typedCards = new List<LiveCard>();
            for (var index = 0; index < cardPileModel._cards.Count; index++)
            {
                typedCards.Add(ReadCard(cardPileModel._cards[index]));
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
            var card = ReadCard(item);
            if (!string.IsNullOrWhiteSpace(card.CardConfigId)) cards.Add(card);
        }

        return cards;
    }

    private static LiveCard ReadCard(object value)
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
        return fallbackCard;
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
    public List<string> GemIds { get; set; } = new();
}

public sealed class BridgeCommand
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string CardGuid { get; set; } = "";
    public string CardConfigId { get; set; } = "";
    public string PileId { get; set; } = "";
    public int Index { get; set; } = -1;
    public string IssuedAt { get; set; } = "";
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
}
