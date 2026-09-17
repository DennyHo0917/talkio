import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Image as ImageIcon, Plus, X } from "lucide-react";
import { useProviderStore } from "../../stores/provider-store";
import { useSettingsStore } from "../../stores/settings-store";
import { getAvailableImageModels } from "../../services/image-generation";
import { inferImageGenerationApi } from "../../services/image-model";
import { setModelOverride } from "../../services/provider-profiles/model-catalog";
import type { Model } from "../../types";

export function ImageSettingsPage() {
  const { t } = useTranslation();
  const providers = useProviderStore((state) => state.providers);
  const models = useProviderStore((state) => state.models);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const addModelById = useProviderStore((state) => state.addModelById);
  const updateModel = useProviderStore((state) => state.updateModel);
  const [showAddModel, setShowAddModel] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");

  const imageModels = useMemo(() => getAvailableImageModels(), [models, providers]);
  const compatibleProviders = useMemo(
    () =>
      providers.filter(
        (provider) =>
          provider.enabled !== false && inferImageGenerationApi(provider, ["image"]) !== undefined,
      ),
    [providers],
  );
  const selectedProviderId = compatibleProviders.some((provider) => provider.id === providerId)
    ? providerId
    : (compatibleProviders[0]?.id ?? "");

  const selectedId = imageModels.some((model) => model.id === settings.defaultImageModelId)
    ? settings.defaultImageModelId
    : (imageModels[0]?.id ?? "");

  useEffect(() => {
    if (selectedId !== settings.defaultImageModelId) {
      updateSettings({ defaultImageModelId: selectedId });
    }
  }, [selectedId, settings.defaultImageModelId, updateSettings]);

  const handleAddModel = () => {
    const trimmedModelId = modelId.trim();
    const provider = compatibleProviders.find((item) => item.id === selectedProviderId);
    if (!provider || !trimmedModelId) return;

    const model = addModelById(provider.id, trimmedModelId);
    const catalogImageModel =
      model.metadataSource === "models.dev" && model.outputModalities.includes("image");
    const outputModalities: Model["outputModalities"] = catalogImageModel
      ? model.outputModalities
      : ["image"];
    const imageGenerationApi = inferImageGenerationApi(provider, outputModalities);
    if (!imageGenerationApi) return;

    if (
      model.outputModalities.length !== outputModalities.length ||
      model.outputModalities.some((modality, index) => modality !== outputModalities[index])
    ) {
      setModelOverride(provider.profileId ?? provider.id, model.modelId, { outputModalities });
    }
    updateModel(model.id, {
      outputModalities: [...outputModalities],
      imageGenerationApi,
      metadataSource: catalogImageModel ? model.metadataSource : "manual",
      enabled: true,
    });
    updateSettings({ defaultImageModelId: model.id });
    setModelId("");
    setShowAddModel(false);
  };

  return (
    <div className="h-full overflow-y-auto" style={{ backgroundColor: "var(--secondary)" }}>
      <div className="mx-auto max-w-lg px-4 pt-4 pb-10">
        <div className="mb-3 flex items-center justify-between px-1 text-[13px] text-muted-foreground">
          <span>{t("settings.defaultImageModel")}</span>
          <span>{t("settings.imageModelsCount", { count: imageModels.length })}</span>
        </div>

        {imageModels.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <ImageIcon size={30} className="text-muted-foreground/40" />
            <p className="mt-3 text-muted-foreground text-sm">{t("settings.imageNotConfigured")}</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg" style={{ backgroundColor: "var(--card)" }}>
            {imageModels.map((model, index) => {
              const selected = model.id === selectedId;
              return (
                <button
                  key={model.id}
                  onClick={() => updateSettings({ defaultImageModelId: model.id })}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-black/5"
                  style={{
                    borderBottom:
                      index < imageModels.length - 1 ? "0.5px solid var(--border)" : "none",
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[15px] text-foreground">
                      {model.displayName}
                    </p>
                    <p className="truncate text-[12px] text-muted-foreground">
                      {model.providerName} · {model.modelId}
                    </p>
                  </div>
                  <div className="h-5 w-5 flex-shrink-0">
                    {selected ? <Check size={20} color="var(--primary)" /> : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-3">
          {showAddModel ? (
            <div
              className="space-y-3 rounded-lg p-3"
              style={{ backgroundColor: "var(--card)", border: "0.5px solid var(--border)" }}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground text-sm">
                  {t("settings.addImageModel")}
                </span>
                <button
                  onClick={() => setShowAddModel(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-md active:opacity-60"
                  title={t("common.cancel")}
                >
                  <X size={16} color="var(--muted-foreground)" />
                </button>
              </div>
              <select
                value={selectedProviderId}
                onChange={(event) => setProviderId(event.target.value)}
                className="w-full rounded-md px-3 py-2.5 text-foreground text-sm outline-none"
                style={{ backgroundColor: "var(--muted)" }}
                aria-label={t("settings.imageModelProvider")}
              >
                {compatibleProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
              <input
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleAddModel();
                }}
                className="w-full rounded-md px-3 py-2.5 text-foreground text-sm outline-none"
                style={{ backgroundColor: "var(--muted)" }}
                placeholder="Model ID"
                aria-label="Model ID"
              />
              <button
                onClick={handleAddModel}
                disabled={!selectedProviderId || !modelId.trim()}
                className="w-full rounded-md bg-primary py-2.5 font-medium text-sm text-white active:opacity-70 disabled:opacity-40"
              >
                {t("common.add")}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddModel(true)}
              disabled={compatibleProviders.length === 0}
              className="flex w-full items-center justify-center gap-1.5 rounded-md py-2.5 font-medium text-primary text-sm active:opacity-70 disabled:opacity-40"
              style={{ backgroundColor: "var(--card)", border: "0.5px solid var(--border)" }}
            >
              <Plus size={16} />
              {t("settings.addImageModel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
