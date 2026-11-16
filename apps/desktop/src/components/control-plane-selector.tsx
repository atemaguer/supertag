import { Check, ChevronRight, Pencil, Plus, Server, Unplug } from "lucide-react";
import type { RefObject } from "react";
import {
  type ControlPlaneProfile,
  LOCAL_CONTROL_PLANE,
  type LocalControlPlane,
} from "../control-plane";
import { Button } from "./ui/button";
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
} from "./ui/dropdown-menu";

interface ControlPlaneSelectorProps {
  active?: string;
  /** Whom the active connection acts as; a client device shows it. */
  principal?: string;
  profiles: ControlPlaneProfile[];
  /** The local Control Plane: listed first while it runs, otherwise why it is unavailable. */
  local?: LocalControlPlane;
  preview?: boolean;
  /** Where the menu opens: beside the rail, or below the button at the top of the window. */
  side: "right" | "bottom";
  busy: boolean;
  switching: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onSelect(origin: string): void;
  onEdit(profile?: ControlPlaneProfile): void;
  onDisconnect(): void;
  /** Opening the menu checks the local Control Plane again. */
  onOpen(): void;
}

interface Choice extends ControlPlaneProfile {
  /** The address shown under the name. */
  address: string;
}

export function ControlPlaneSelector({
  active,
  principal,
  profiles,
  local,
  preview,
  side,
  busy,
  switching,
  trigger,
  onSelect,
  onEdit,
  onDisconnect,
  onOpen,
}: ControlPlaneSelectorProps) {
  const localChoice: Choice | undefined =
    active === LOCAL_CONTROL_PLANE || local?.origin
      ? { name: "Local", origin: LOCAL_CONTROL_PLANE, address: local?.origin ?? "This machine" }
      : undefined;
  const choices: Choice[] = [
    ...(localChoice ? [localChoice] : []),
    ...profiles.map((profile) => ({ ...profile, address: profile.origin })),
  ];
  const selected = choices.find((choice) => choice.origin === active);
  const connected = Boolean(selected || preview);
  const client = selected && principal?.startsWith("client:") ? principal : undefined;
  const name = switching
    ? "Connecting…"
    : (selected?.name ?? (preview ? "Preview workspace" : "Select Control Plane"));

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
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
          title={client ? `${name} · ${selected?.address} · connected as ${client}` : name}
          disabled={busy || switching}
        >
          <Server size={17} aria-hidden />
          <span className="connection-dot" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="control-plane-menu"
        side={side}
        align={side === "right" ? "end" : "start"}
        sideOffset={side === "right" ? 24 : 8}
      >
        <div className="control-plane-current">
          <span>{name}</span>
          {selected && selected.name !== selected.address && <small>{selected.address}</small>}
          {client && <small>Connected as {client}</small>}
        </div>
        <DropdownMenuSeparator className="control-plane-separator" />
        {!localChoice && local?.problem && (
          <>
            <DropdownMenuItem className="control-plane-choice" disabled>
              <span className="control-plane-indicator" aria-hidden />
              <span className="control-plane-choice-text">
                <span>Local · not running</span>
                <small>{local.problem}</small>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="control-plane-separator" />
          </>
        )}
        {choices.length > 0 && (
          <>
            <DropdownMenuRadioGroup value={active ?? ""} onValueChange={onSelect}>
              {choices.map((choice) => (
                <DropdownMenuRadioItem
                  className="control-plane-choice"
                  key={choice.origin}
                  value={choice.origin}
                  textValue={choice.name}
                >
                  <span className="control-plane-indicator" aria-hidden>
                    <DropdownMenuItemIndicator>
                      <Check size={14} />
                    </DropdownMenuItemIndicator>
                  </span>
                  <span className="control-plane-choice-text">
                    <span>{choice.name}</span>
                    {choice.name !== choice.address && <small>{choice.address}</small>}
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
