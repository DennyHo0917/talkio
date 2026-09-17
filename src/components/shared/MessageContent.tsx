import { memo } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ReasoningBlock } from "./ReasoningBlock";
import type { Message, MessageBlock } from "../../types";
import { MessageStatus, MessageBlockType, MessageBlockStatus } from "../../types";

interface MessageContentProps {
  message: Message;
  blocks?: MessageBlock[];
  isStreaming?: boolean;
}

export const MessageContent = memo(function MessageContent({
  message,
  blocks = [],
  isStreaming = false,
}: MessageContentProps) {
  const streaming = isStreaming || message.status === MessageStatus.STREAMING;
  const hasError = message.status === MessageStatus.ERROR;

  // Block-based rendering
  if (blocks.length > 0) {
    return (
      <div className="space-y-1">
        {blocks.map((block) => (
          <BlockRenderer
            key={block.id}
            block={block}
            isStreaming={block.status === MessageBlockStatus.STREAMING}
          />
        ))}
      </div>
    );
  }

  // Legacy single-content rendering
  return (
    <div>
      {message.reasoningContent && (
        <ReasoningBlock
          content={message.reasoningContent}
          duration={message.reasoningDuration}
          isStreaming={streaming && !message.content}
        />
      )}

      {message.content && <MarkdownRenderer content={message.content} isStreaming={streaming} />}

      {hasError && message.errorMessage && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-destructive/10 p-2.5 text-destructive text-xs">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{message.errorMessage}</span>
        </div>
      )}

      {streaming && !message.content && !message.reasoningContent && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-xs">Generating...</span>
        </div>
      )}

      {/* Fallback for empty non-streaming, non-error messages (e.g. legacy data) */}
      {!streaming &&
        !hasError &&
        !message.content &&
        !message.reasoningContent &&
        message.generatedImages.length === 0 && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <AlertCircle size={14} className="flex-shrink-0 opacity-60" />
            <span>Empty response from model</span>
          </div>
        )}
    </div>
  );
});

function BlockRenderer({ block, isStreaming }: { block: MessageBlock; isStreaming: boolean }) {
  switch (block.type) {
    case MessageBlockType.THINKING:
      return <ReasoningBlock content={block.content} isStreaming={isStreaming} />;
    case MessageBlockType.MAIN_TEXT:
      return <MarkdownRenderer content={block.content} isStreaming={isStreaming} />;
    case MessageBlockType.TOOL:
      return (
        <div className="my-1 rounded-md border border-border bg-muted p-2 text-xs">
          <div className="mb-1 font-medium text-muted-foreground">Tool Call</div>
          <pre className="overflow-x-auto whitespace-pre-wrap text-[11px]">{block.content}</pre>
        </div>
      );
    case MessageBlockType.ERROR:
      return (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-2.5 text-destructive text-xs">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{block.content}</span>
        </div>
      );
    case MessageBlockType.IMAGE:
      return (
        <img
          src={block.content}
          alt="Generated"
          className="max-h-80 max-w-full rounded-lg object-contain"
        />
      );
    default:
      return <MarkdownRenderer content={block.content} isStreaming={isStreaming} />;
  }
}
