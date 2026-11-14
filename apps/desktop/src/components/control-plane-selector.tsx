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
import type { ControlPlaneProfile } from "../control-plane";

interface ControlPlaneSelectorProps {
  active?: string;
  /** Whom the active connection acts as; a client device shows it. */
  principal?: string;
  profiles: ControlPlaneProfile[];
  preview?: boolean;
  busy: boolean;
  switching: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onSelect(origin: string): void;
  onEdit(profile?: ControlPlaneProfile): void;
  onDisconnect(): void;
}

export function ControlPlaneSelector({
  active,
  principal,
  profiles,
  preview,
  busy,
  switching,
  trigger,
  onSelect,
  onEdit,
  onDisconnect,
}: ControlPlaneSelectorProps) {
  const selected = profiles.find((profile) => profile.origin === active);
  const connected = Boolean(selected || preview);
  const client = selected && principal?.startsWith("client:") ? principal : undefined;
  const name = switching
    ? "Connecting…"
    : (selected?.name ?? (preview ? "Preview workspace" : "Select Control Plane"));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          ref={trigger}
          className="connection"
          data-connected={connected}
          aria-label={connected ? "Switch Control Plane" : "Select Control Plane"}
          aria-description={
            selected
              ? `Current Control Plane is ${selected.name}${client ? `, connected as ${client}` : ""}`
              : undefined
          }
          title={client ? `${selected?.origin} · connected as ${client}` : selected?.origin}
          disabled={busy || switching}
        >
          <span className="connection-dot" aria-hidden />
          <span className="row-title">{name}</span>
          {client && <small className="connection-principal">{client}</small>}
          <ChevronsUpDown className="connection-arrow" size={15} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="control-plane-menu" side="top" align="start" sideOffset={6}>
        {profiles.length > 0 && (
          <>
            <DropdownMenuRadioGroup value={active ?? ""} onValueChange={onSelect}>
              {profiles.map((profile) => (
                <DropdownMenuRadioItem
                  className="control-plane-choice"
                  key={profile.origin}
                  value={profile.origin}
                  textValue={profile.name}
                >
                  <span className="control-plane-indicator" aria-hidden>
                    <DropdownMenuItemIndicator>
                      <Check size={14} />
                    </DropdownMenuItemIndicator>
                  </span>
                  <span className="control-plane-choice-text">
                    <span>{profile.name}</span>
                    {profile.name !== profile.origin && <small>{profile.origin}</small>}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator className="control-plane-separator" />
          </>
        )}
        <DropdownMenuItem className="control-plane-action" onSelect={() => onEdit()}>
          <Plus size={15} aria-hidden /> Add Control Plane
        </DropdownMenuItem>
        {profiles.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="control-plane-action">
              <Pencil size={15} aria-hidden /> Edit Control Plane
              <ChevronRight className="control-plane-edit-arrow" size={14} aria-hidden />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="control-plane-edit-menu" sideOffset={6}>
              {profiles.map((profile) => (
                <DropdownMenuItem
                  className="control-plane-action"
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
          <DropdownMenuItem className="control-plane-action" onSelect={onDisconnect}>
            <Unplug size={15} aria-hidden /> Disconnect
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
