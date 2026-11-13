import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { cn } from "cn";
import type { ComponentProps } from "react";

const DropdownMenu = Dropdown.Root;
const DropdownMenuTrigger = Dropdown.Trigger;
const DropdownMenuRadioGroup = Dropdown.RadioGroup;
const DropdownMenuItem = Dropdown.Item;
const DropdownMenuRadioItem = Dropdown.RadioItem;
const DropdownMenuItemIndicator = Dropdown.ItemIndicator;
const DropdownMenuSeparator = Dropdown.Separator;
const DropdownMenuSub = Dropdown.Sub;
const DropdownMenuSubTrigger = Dropdown.SubTrigger;

function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof Dropdown.SubContent>) {
  return (
    <Dropdown.Portal>
      <Dropdown.SubContent
        className={cn("rounded-lg border bg-popover text-popover-foreground shadow-lg", className)}
        {...props}
      />
    </Dropdown.Portal>
  );
}

function DropdownMenuContent({ className, ...props }: ComponentProps<typeof Dropdown.Content>) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content
        className={cn("rounded-lg border bg-popover text-popover-foreground shadow-lg", className)}
        {...props}
      />
    </Dropdown.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
