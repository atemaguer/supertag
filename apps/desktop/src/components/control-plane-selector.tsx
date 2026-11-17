import { Bell, Check, ChevronRight, Pencil, Plus, Server, Unplug } from "lucide-react";
import type { RefObject } from "react";
import {
  type ControlPlaneProfile,
  LOCAL_CONTROL_PLANE,
  type LocalControlPlane,
} from "../control-plane";
import { type NotificationLevel, useNotificationLevel } from "../lib/notifications";
import type { PaletteAction } from "./command-palette";
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
  /** A wide button naming the Control Plane, in the expanded sidebar, or a round one in the rail. */
  wide: boolean;
  busy: boolean;
  switching: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onSelect(origin: string): void;
  onEdit(profile?: ControlPlaneProfile): void;
  onDisconnect(): void;
  /** Opening the menu checks the local Control Plane again. */
  onOpen(): void;
}

/** What this device notifies about; the setting is kept on this device only. */
const NOTIFICATION_CHOICES: readonly [NotificationLevel, string][] = [
  ["all", "All messages"],
  ["questions", "Questions only"],
  ["off", "Off"],
];

interface Choice extends ControlPlaneProfile {
  /** The address shown under the name. */
  address: string;
}

/** The Control Planes to choose from: Local first while it runs, then each saved one. */
function controlPlaneChoices(
  active: string | undefined,
  profiles: ControlPlaneProfile[],
  local: LocalControlPlane | undefined,
) {
  const localChoice: Choice | undefined =
    active === LOCAL_CONTROL_PLANE || local?.origin
      ? { name: "Local", origin: LOCAL_CONTROL_PLANE, address: local?.origin ?? "This machine" }
      : undefined;
  const choices: Choice[] = [
    ...(localChoice ? [localChoice] : []),
    ...profiles.map((profile) => ({ ...profile, address: profile.origin })),
  ];
  return { localChoice, choices };
}

/**
 * What the Control Plane menu offers, as command palette actions: switching to another Control
 * Plane, adding or editing one, what this device notifies about, and disconnecting.
 */
export function controlPlaneActions({
  active,
  profiles,
  local,
  preview,
  busy,
  switching,
  notifications,
  onSelect,
  onEdit,
  onDisconnect,
  onNotifications,
}: Pick<
  ControlPlaneSelectorProps,
  | "active"
  | "profiles"
  | "local"
  | "preview"
  | "busy"
  | "switching"
  | "onSelect"
  | "onEdit"
  | "onDisconnect"
> & {
  notifications: NotificationLevel;
  onNotifications(level: NotificationLevel): void;
}): PaletteAction[] {
  const { choices } = controlPlaneChoices(active, profiles, local);
  const selected = choices.find((choice) => choice.origin === active);
  const disabled = busy || switching;
  return [
    ...choices
      .filter((choice) => choice.origin !== active)
      .map((choice) => ({
        id: `control-plane:${choice.origin}`,
        label: `Switch to ${choice.name}`,
        caption: choice.address,
        icon: <Server aria-hidden />,
        keywords: "control plane connect",
        disabled,
        run: () => onSelect(choice.origin),
      })),
    {
      id: "add-control-plane",
      label: "Add Control Plane",
      caption: "an address and a token",
      icon: <Plus aria-hidden />,
      keywords: "connect",
      disabled,
      run: () => onEdit(),
    },
    ...profiles.map((profile) => ({
      id: `edit-control-plane:${profile.origin}`,
      label: `Edit Control Plane · ${profile.name}`,
      caption: profile.origin,
      icon: <Pencil aria-hidden />,
      disabled,
      run: () => onEdit(profile),
    })),
    ...NOTIFICATION_CHOICES.map(([level, label]) => ({
      id: `notifications:${level}`,
      label: `Notifications · ${label}`,
      caption: level === notifications ? "on this device now" : "on this device",
      icon: level === notifications ? <Check aria-hidden /> : <Bell aria-hidden />,
      keywords: "notify alerts",
      run: () => onNotifications(level),
    })),
    ...(selected || preview
      ? [
          {
            id: "disconnect",
            label: "Disconnect",
            caption: selected?.name ?? "Preview workspace",
            icon: <Unplug aria-hidden />,
            keywords: "control plane",
            disabled,
            run: onDisconnect,
          },
        ]
      : []),
  ];
}

export function ControlPlaneSelector({
  active,
  principal,
  profiles,
  local,
  preview,
  wide,
  busy,
  switching,
  trigger,
  onSelect,
  onEdit,
  onDisconnect,
  onOpen,
}: ControlPlaneSelectorProps) {
  const { localChoice, choices } = controlPlaneChoices(active, profiles, local);
  const selected = choices.find((choice) => choice.origin === active);
  const [notifications, setNotifications] = useNotificationLevel();
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
          className={wide ? "connection wide" : "connection"}
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
          {wide && (
            <span className="connection-text">
              <span className="row-title">{name}</span>
              <small>{connected ? (client ?? "Connected") : "Not connected"}</small>
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="control-plane-menu"
        side={wide ? "top" : "right"}
        align={wide ? "start" : "end"}
        sideOffset={wide ? 8 : 24}
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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="control-plane-action">
            <Bell size={15} aria-hidden /> Notifications
            <ChevronRight className="control-plane-edit-arrow" size={14} aria-hidden />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="control-plane-edit-menu" sideOffset={6}>
            <DropdownMenuRadioGroup
              value={notifications}
              onValueChange={(value) => setNotifications(value as NotificationLevel)}
            >
              {NOTIFICATION_CHOICES.map(([level, label]) => (
                <DropdownMenuRadioItem
                  className="control-plane-choice"
                  key={level}
                  value={level}
                  textValue={label}
                >
                  <span className="control-plane-indicator" aria-hidden>
                    <DropdownMenuItemIndicator>
                      <Check size={14} />
                    </DropdownMenuItemIndicator>
                  </span>
                  <span className="control-plane-choice-text">
                    <span>{label}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {connected && (
          <DropdownMenuItem className="control-plane-action" onSelect={onDisconnect}>
            <Unplug size={15} aria-hidden /> Disconnect
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
