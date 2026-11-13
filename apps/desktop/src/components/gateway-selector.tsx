import { Check, ChevronRight, ChevronsUpDown, Pencil, Plus, Unplug } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
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
} from "@/components/ui/dropdown-menu";
import type { GatewayProfile } from "../gateway";

interface GatewaySelectorProps {
  active?: string;
  profiles: GatewayProfile[];
  preview?: boolean;
  busy: boolean;
  switching: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onSelect(origin: string): void;
  onEdit(profile?: GatewayProfile): void;
  onDisconnect(): void;
}

export function GatewaySelector({
  active,
  profiles,
  preview,
  busy,
  switching,
  trigger,
  onSelect,
  onEdit,
  onDisconnect,
}: GatewaySelectorProps) {
  const selected = profiles.find((profile) => profile.origin === active);
  const connected = Boolean(selected || preview);
  const name = switching
    ? "Connecting…"
    : (selected?.name ?? (preview ? "Preview workspace" : "Select Gateway"));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          ref={trigger}
          className="connection"
          data-connected={connected}
          aria-label={connected ? "Switch Gateway" : "Select Gateway"}
          aria-description={selected ? `Current Gateway is ${selected.name}` : undefined}
          title={selected?.origin}
          disabled={busy || switching}
        >
          <span className="connection-dot" aria-hidden />
          <span className="row-title">{name}</span>
          <ChevronsUpDown className="connection-arrow" size={15} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="gateway-menu" side="top" align="start" sideOffset={6}>
        {profiles.length > 0 && (
          <>
            <DropdownMenuRadioGroup value={active ?? ""} onValueChange={onSelect}>
              {profiles.map((profile) => (
                <DropdownMenuRadioItem
                  className="gateway-choice"
                  key={profile.origin}
                  value={profile.origin}
                  textValue={profile.name}
                >
                  <span className="gateway-indicator" aria-hidden>
                    <DropdownMenuItemIndicator>
                      <Check size={14} />
                    </DropdownMenuItemIndicator>
                  </span>
                  <span className="gateway-choice-text">
                    <span>{profile.name}</span>
                    {profile.name !== profile.origin && <small>{profile.origin}</small>}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator className="gateway-separator" />
          </>
        )}
        <DropdownMenuItem className="gateway-action" onSelect={() => onEdit()}>
          <Plus size={15} aria-hidden /> Add Gateway
        </DropdownMenuItem>
        {profiles.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gateway-action">
              <Pencil size={15} aria-hidden /> Edit Gateway
              <ChevronRight className="gateway-edit-arrow" size={14} aria-hidden />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="gateway-edit-menu" sideOffset={6}>
              {profiles.map((profile) => (
                <DropdownMenuItem
                  className="gateway-action"
                  key={profile.origin}
                  onSelect={() => onEdit(profile)}
                  title={profile.origin}
                >
                  <span className="row-title">{profile.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {connected && (
          <DropdownMenuItem className="gateway-action" onSelect={onDisconnect}>
            <Unplug size={15} aria-hidden /> Disconnect
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
