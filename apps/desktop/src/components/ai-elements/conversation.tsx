// AI Elements Conversation (https://registry.ai-sdk.dev/conversation.json), vendored and edited:
// the log role moves to the scrolling element, which takes its own props so the transcript can be
// labelled and reached by keyboard; the unused empty state is dropped; and imports are relative
// so the root Vitest run resolves them.
import { cn } from "cn";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "../ui/button";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<"div"> & {
  /** Props for the scrolling element around the content. */
  scrollProps?: ComponentProps<"div">;
};

export const ConversationContent = ({
  className,
  scrollProps,
  ...props
}: ConversationContentProps) => {
  const { scrollRef, contentRef } = useStickToBottomContext();
  return (
    <div
      role="log"
      {...scrollProps}
      ref={scrollRef}
      className={cn("size-full overflow-y-auto", scrollProps?.className)}
    >
      <div {...props} ref={contentRef} className={cn("flex flex-col gap-8 p-4", className)} />
    </div>
  );
};

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn("absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full", className)}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
