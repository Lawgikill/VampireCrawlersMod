using System.Collections;
using System.Reflection;
using System.Text.Json;
using Nosebleed.Pancake.Models;
using UnityEngine;

namespace VampireCrawlers.LiveBridge;

public sealed class LiveBridgeBehaviour : MonoBehaviour
{
    private static readonly string OutputPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "VampireCrawlersDeckTracker",
        "live-state.json");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    private float _nextWriteAt;
    private float _nextErrorLogAt;

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
            return new LiveCard
            {
                CardConfigId = cardModel.CardConfig?.AssetId ?? "",
                BaseCardConfigId = cardModel.BaseCardConfig?.AssetId ?? cardModel.CardConfig?.AssetId ?? "",
                CardGuid = cardModel.Guid.ToString(),
                ManaCostModifier = cardModel.ManaCostModifier,
                TempManaCostModifier = cardModel.TempManaCostModifier,
                ConfusedManaCostModifier = cardModel.ConfuseManaCostModifier,
                IsBroken = cardModel.IsBroken,
                IsCopyWithDestroy = cardModel.IsCopyWithDestroy,
                TimesLimitBroken = cardModel.TimesLimitBroken,
                GemIds = ReadGemIds(cardModel),
            };
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

        return new LiveCard
        {
            CardConfigId = cardId ?? "",
            BaseCardConfigId = baseId ?? cardId ?? "",
            CardGuid = ReadString(value, "CardGuid") ?? "",
            ManaCostModifier = ReadInt(value, "ManaCostModifier") ?? ReadInt(value, "_manaCostModifier") ?? 0,
            TempManaCostModifier = ReadInt(value, "TempManaCostModifier") ?? ReadInt(value, "_temporaryManaCostModifier") ?? 0,
            ConfusedManaCostModifier = ReadInt(value, "ConfusedManaCostModifier") ?? ReadInt(value, "_confuseManaCostModifier") ?? 0,
            GemIds = ReadGemIds(value),
        };
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
    public bool IsBroken { get; set; }
    public bool IsCopyWithDestroy { get; set; }
    public int TimesLimitBroken { get; set; }
    public List<string> GemIds { get; set; } = new();
}
