import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Search, Check, CheckCircle, Circle, Image as ImageIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { useProviderStore } from "../../stores/provider-store";
import { getAvatarProps } from "../../lib/avatar-utils";
import { groupModelsByProvider } from "../../lib/model-utils";
import { isStandaloneImageModel } from "../../services/image-model";

interface ModelPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (modelId: string) => void;
  selectedModelId?: string;
  multiSelect?: boolean;
  onMultiSelect?: (modelIds: string[]) => void;
  includeImageModels?: boolean;
}

export function ModelPicker({
  open,
  onClose,
  onSelect,
  selectedModelId,
  multiSelect,
  onMultiSelect,
  includeImageModels = false,
}: ModelPickerProps) {
  const { t } = useTranslation();
  const models = useProviderStore((s) => s.models);
  const getProviderById = useProviderStore((s) => s.getProviderById);
  const providers = useProviderStore((s) => s.providers);
  const getEnabledModels = useProviderStore((s) => s.getEnabledModels);
  const getEnabledConversationModels = useProviderStore((s) => s.getEnabledConversationModels);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setSelectedIds(new Set());
      setSearch("");
    }
  }, [open]);

  const toggleModel = useCallback((modelId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (selectedIds.size > 0 && onMultiSelect) {
      onMultiSelect(Array.from(selectedIds));
    }
    onClose();
  }, [selectedIds, onMultiSelect, onClose]);

  const enabledModels = useMemo(
    () => (includeImageModels ? getEnabledConversationModels() : getEnabledModels()),
    [getEnabledConversationModels, getEnabledModels, includeImageModels, models, providers],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return enabledModels;
    const q = search.toLowerCase();
    return enabledModels.filter(
      (m) => m.displayName.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q),
    );
  }, [enabledModels, search]);

  const sections = useMemo(
    () => groupModelsByProvider(filtered, getProviderById),
    [filtered, getProviderById],
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[70vh] max-w-sm flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            {multiSelect ? t("chat.addMember") : t("chat.selectModel")}
          </DialogTitle>
        </DialogHeader>

        <div className="px-1">
          <div
            className="flex items-center rounded-xl px-3 py-2"
            style={{ backgroundColor: "var(--secondary)" }}
          >
            <Search size={16} className="flex-shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("providerEdit.searchModels")}
              className="ml-2 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="-mx-6 mt-2 flex-1 overflow-y-auto">
          {sections.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-xs">
              {models.length === 0 ? t("models.noModels") : t("chats.noResults")}
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.title}>
                <div
                  className="sticky top-0 z-10 px-5 py-1.5"
                  style={{ backgroundColor: "var(--secondary)" }}
                >
                  <p className="font-semibold text-[13px] text-muted-foreground">{section.title}</p>
                </div>
                {section.data.map((model, idx) => {
                  const { color: mColor, initials: mInitials } = getAvatarProps(model.displayName);
                  const imageOnly = isStandaloneImageModel(model);
                  const isSelected = multiSelect
                    ? selectedIds.has(model.id)
                    : model.id === selectedModelId;
                  return (
                    <button
                      key={model.id}
                      onClick={() => {
                        if (multiSelect) {
                          toggleModel(model.id);
                        } else {
                          onSelect(model.id);
                          onClose();
                        }
                      }}
                      className={`flex w-full items-center gap-4 px-4 py-3 text-left transition-colors active:opacity-70 ${isSelected && multiSelect ? "bg-primary/5" : ""}`}
                      style={{
                        backgroundColor: isSelected
                          ? "color-mix(in srgb, var(--primary) 8%, var(--background))"
                          : "var(--background)",
                        borderBottom:
                          idx < section.data.length - 1 ? "0.5px solid var(--border)" : "none",
                      }}
                    >
                      <div
                        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full font-semibold text-sm text-white"
                        style={{ backgroundColor: mColor }}
                      >
                        {mInitials}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-[16px] text-foreground">
                          {model.displayName}
                        </p>
                        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                          <span className="truncate">{model.modelId}</span>
                          {imageOnly && (
                            <ImageIcon
                              size={13}
                              className="flex-shrink-0"
                              aria-label={t("models.imageModel")}
                            />
                          )}
                        </p>
                      </div>
                      {multiSelect ? (
                        isSelected ? (
                          <CheckCircle size={22} className="flex-shrink-0 text-primary" />
                        ) : (
                          <Circle size={22} className="flex-shrink-0 text-muted-foreground" />
                        )
                      ) : (
                        isSelected && <Check size={18} className="flex-shrink-0 text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {multiSelect && (
          <div className="-mx-6 border-border border-t px-6 pt-3">
            <button
              onClick={handleConfirm}
              disabled={selectedIds.size === 0}
              className="w-full rounded-xl py-2.5 font-semibold text-[15px] transition-opacity disabled:opacity-40"
              style={{ backgroundColor: "var(--primary)", color: "var(--primary-foreground)" }}
            >
              {t("common.confirm")}
              {selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
