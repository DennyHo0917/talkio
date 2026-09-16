import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Minus, Plus, Users } from "lucide-react";
import type { Conversation } from "../../types";
import { useChatStore } from "../../stores/chat-store";
import type { BatchMemberChangeResult } from "../../stores/chat-store-actions";
import { useProviderStore } from "../../stores/provider-store";
import { useIdentityStore } from "../../stores/identity-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { AddMemberContent, type SelectedMember } from "./AddMemberPicker";

interface BatchGroupMembersDialogProps {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
}

type Operation = "add" | "remove";
type Step = "groups" | "members" | "preview" | "result";

function memberKey(member: SelectedMember): string {
  return `${member.modelId}\u0000${member.identityId ?? ""}`;
}

export function BatchGroupMembersDialog({
  open,
  onClose,
  conversations,
}: BatchGroupMembersDialogProps) {
  const { t } = useTranslation();
  const updateMembersAcrossGroups = useChatStore((state) => state.updateMembersAcrossGroups);
  const models = useProviderStore((state) => state.models);
  const identities = useIdentityStore((state) => state.identities);
  const groups = useMemo(
    () =>
      conversations.filter(
        (conversation) => conversation.type === "group" && !conversation.archived,
      ),
    [conversations],
  );
  const [step, setStep] = useState<Step>("groups");
  const [operation, setOperation] = useState<Operation>("add");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<SelectedMember[]>([]);
  const [results, setResults] = useState<BatchMemberChangeResult[]>([]);

  const selectedGroups = groups.filter((group) => selectedGroupIds.includes(group.id));
  const selectedKeys = new Set(selectedMembers.map(memberKey));
  const removableMembers = Array.from(
    new Map(
      selectedGroups.flatMap((group) =>
        group.participants.map((member) => [memberKey(member), member] as const),
      ),
    ).values(),
  );
  const modelName = (modelId: string) =>
    models.find((model) => model.id === modelId)?.displayName ?? modelId;
  const identityName = (identityId: string | null) =>
    identityId ? identities.find((identity) => identity.id === identityId)?.name : null;
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setStep("groups");
    setOperation("add");
    setSelectedGroupIds([]);
    setSelectedMembers([]);
    setResults([]);
    setSubmitting(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggleGroup = (id: string) => {
    setSelectedGroupIds((current) =>
      current.includes(id) ? current.filter((groupId) => groupId !== id) : [...current, id],
    );
  };

  const changesFor = (group: Conversation) => {
    const existingKeys = new Set(group.participants.map(memberKey));
    return operation === "add"
      ? selectedMembers.filter((member) => !existingKeys.has(memberKey(member)))
      : group.participants.filter((participant) => selectedKeys.has(memberKey(participant)));
  };

  const execute = async () => {
    setSubmitting(true);
    const nextResults = await updateMembersAcrossGroups(
      selectedGroupIds,
      operation,
      selectedMembers,
    );
    setResults(nextResults);
    setSubmitting(false);
    setStep("result");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-border border-b px-5 py-4">
          <DialogTitle className="text-base">{t("batchMembers.title")}</DialogTitle>
        </DialogHeader>

        {step === "groups" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-border flex gap-2 border-b px-5 py-3">
              {(["add", "remove"] as Operation[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setOperation(item)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                    operation === item
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {item === "add" ? <Plus size={16} /> : <Minus size={16} />}
                  {t(`batchMembers.${item}`)}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {groups.length === 0 ? (
                <p className="text-muted-foreground px-3 py-8 text-center text-sm">
                  {t("batchMembers.noGroups")}
                </p>
              ) : (
                groups.map((group) => {
                  const selected = selectedGroupIds.includes(group.id);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      className="hover:bg-muted/50 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left"
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border"
                        }`}
                      >
                        {selected && <Check size={14} />}
                      </span>
                      <Users size={17} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm font-medium">
                          {group.title}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {t("chat.modelCount", { count: group.participants.length })}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="border-border flex justify-end gap-2 border-t px-5 py-3">
              <button type="button" onClick={close} className="rounded-md px-4 py-2 text-sm">
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={selectedGroupIds.length === 0}
                onClick={() => setStep("members")}
                className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
              >
                {t("common.next")}
              </button>
            </div>
          </div>
        )}

        {step === "members" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {operation === "add" ? (
              <AddMemberContent
                onConfirm={(members) => {
                  setSelectedMembers(
                    members.filter(
                      (member, index, list) =>
                        list.findIndex((item) => memberKey(item) === memberKey(member)) === index,
                    ),
                  );
                  setStep("preview");
                }}
                confirmLabel={t("batchMembers.preview")}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {removableMembers.map((member) => {
                  const key = memberKey(member);
                  const selected = selectedKeys.has(key);
                  const identity = identityName(member.identityId);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setSelectedMembers((current) =>
                          selected
                            ? current.filter((item) => memberKey(item) !== key)
                            : [
                                ...current,
                                { modelId: member.modelId, identityId: member.identityId },
                              ],
                        )
                      }
                      className="hover:bg-muted/50 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm"
                    >
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                      >
                        {selected && <Check size={14} />}
                      </span>
                      {modelName(member.modelId)}
                      {identity ? ` · ${identity}` : ""}
                    </button>
                  );
                })}
                <button
                  type="button"
                  disabled={selectedMembers.length === 0}
                  onClick={() => setStep("preview")}
                  className="bg-primary text-primary-foreground mt-3 w-full rounded-md py-2.5 text-sm font-medium disabled:opacity-40"
                >
                  {t("batchMembers.preview")}
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setSelectedMembers([]);
                setStep("groups");
              }}
              className="text-muted-foreground px-5 pb-3 text-left text-sm"
            >
              {t("common.back")}
            </button>
          </div>
        )}
        {step === "preview" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <p className="text-muted-foreground mb-3 text-sm">
                {t("batchMembers.previewSummary", {
                  groups: selectedGroups.length,
                  members: selectedMembers.length,
                })}
              </p>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {selectedMembers.map((member) => {
                  const identity = identityName(member.identityId);
                  return (
                    <span key={memberKey(member)} className="bg-muted rounded-md px-2 py-1 text-xs">
                      {modelName(member.modelId)}
                      {identity ? ` · ${identity}` : ""}
                    </span>
                  );
                })}
              </div>
              <div className="space-y-1">
                {selectedGroups.map((group) => {
                  const changes = changesFor(group);
                  const wouldEmpty =
                    operation === "remove" && changes.length === group.participants.length;
                  return (
                    <div key={group.id} className="border-border border-b py-3">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {group.title}
                        </span>
                        {wouldEmpty ? (
                          <span className="text-destructive flex items-center gap-1 text-xs">
                            <AlertCircle size={14} /> {t("chat.cannotRemoveLast")}
                          </span>
                        ) : (
                          <span
                            className={
                              changes.length > 0
                                ? "text-foreground text-xs"
                                : "text-muted-foreground text-xs"
                            }
                          >
                            {changes.length > 0
                              ? t(`batchMembers.${operation}Count`, { count: changes.length })
                              : t("batchMembers.noChange")}
                          </span>
                        )}
                      </div>
                      {changes.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {changes.map((member) => {
                            const identity = identityName(member.identityId);
                            return (
                              <span
                                key={memberKey(member)}
                                className="bg-muted rounded px-2 py-1 text-[11px]"
                              >
                                {modelName(member.modelId)}
                                {identity ? ` · ${identity}` : ""}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="border-border flex justify-end gap-2 border-t px-5 py-3">
              <button
                type="button"
                onClick={() => setStep("members")}
                className="rounded-md px-4 py-2 text-sm"
              >
                {t("common.back")}
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={execute}
                className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
              >
                {submitting ? t("common.processing") : t("common.confirm")}
              </button>
            </div>
          </div>
        )}

        {step === "result" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-2">
                {results.map((result) => (
                  <div
                    key={result.conversationId}
                    className="border-border flex items-start gap-3 border-b py-2.5"
                  >
                    {result.status === "failed" ? (
                      <AlertCircle size={17} className="text-destructive mt-0.5 shrink-0" />
                    ) : (
                      <Check size={17} className="text-success mt-0.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {result.title}
                      </span>
                      <span
                        className={
                          result.status === "failed"
                            ? "text-destructive text-xs"
                            : "text-muted-foreground text-xs"
                        }
                      >
                        {result.status === "failed"
                          ? result.error
                          : result.status === "unchanged"
                            ? t("batchMembers.noChange")
                            : t("batchMembers.updatedCount", { count: result.changedCount })}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-border flex justify-end border-t px-5 py-3">
              <button
                type="button"
                onClick={close}
                className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
              >
                {t("common.done")}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
