import {
  type GatewayProfile,
  LOCAL_GATEWAY,
  type LocalGateway,
  type NotificationLevel,
} from "@supertag/client/model";
import {
  Bell,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Pencil,
  Plus,
  Server,
  Unplug,
} from "lucide-react";
import type { RefObject } from "react";
import { useNotificationLevel } from "../lib/notifications";
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

interface GatewaySelectorProps {
  active?: string;
  /** Whom the active connection acts as; a client device shows it. */
  principal?: string;
  profiles: GatewayProfile[];
  /** The local Gateway: listed first while it runs, otherwise why it is unavailable. */
  local?: LocalGateway;
  preview?: boolean;
  /** A wide button naming the Gateway, in the expanded sidebar, or a round one in the rail. */
  wide: boolean;
  busy: boolean;
  switching: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onSelect(origin: string): void;
  onEdit(profile?: GatewayProfile): void;
  onDisconnect(): void;
  /** Opening the menu checks the local Gateway again. */
  onOpen(): void;
}

/** What this device notifies about; the setting is kept on this device only. */
const NOTIFICATION_CHOICES: readonly [NotificationLevel, string][] = [
  ["all", "All messages"],
  ["questions", "Questions only"],
  ["off", "Off"],
];

interface Choice extends GatewayProfile {
  /** The address shown under the name. */
  address: string;
}

/** The Gateways to choose from: Local first while it runs, then each saved one. */
function gatewayChoices(
  active: string | undefined,
  profiles: GatewayProfile[],
  local: LocalGateway | undefined,
) {
  const localChoice: Choice | undefined =
    active === LOCAL_GATEWAY || local?.origin
      ? { name: "Local", origin: LOCAL_GATEWAY, address: local?.origin ?? "This machine" }
      : undefined;
  const choices: Choice[] = [
    ...(localChoice ? [localChoice] : []),
    ...profiles.map((profile) => ({ ...profile, address: profile.origin })),
  ];
  return { localChoice, choices };
}

/**
 * What the Gateway menu offers, as command palette actions: switching to another Control
 * Plane, adding or editing one, what this device notifies about, and disconnecting.
 */
export function gatewayActions({
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
  GatewaySelectorProps,
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
  const { choices } = gatewayChoices(active, profiles, local);
  const selected = choices.find((choice) => choice.origin === active);
  const disabled = busy || switching;
  return [
    ...choices
      .filter((choice) => choice.origin !== active)
      .map((choice) => ({
        id: `gateway:${choice.origin}`,
        label: `Switch to ${choice.name}`,
        caption: choice.address,
        icon: <Server aria-hidden />,
        keywords: "gateway connect",
        disabled,
        run: () => onSelect(choice.origin),
      })),
    {
      id: "add-gateway",
      label: "Add Gateway",
      caption: "an address and a token",
      icon: <Plus aria-hidden />,
      keywords: "connect",
      disabled,
      run: () => onEdit(),
    },
    ...profiles.map((profile) => ({
      id: `edit-gateway:${profile.origin}`,
      label: `Edit Gateway · ${profile.name}`,
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
            keywords: "gateway",
            disabled,
            run: onDisconnect,
          },
        ]
      : []),
  ];
}

export function GatewaySelector({
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
}: GatewaySelectorProps) {
  const { localChoice, choices } = gatewayChoices(active, profiles, local);
  const selected = choices.find((choice) => choice.origin === active);
  const [notifications, setNotifications] = useNotificationLevel();
  // The local Gateway counts as connected only while it runs.
  const connected = Boolean(
    (selected && (selected.origin !== LOCAL_GATEWAY || local?.origin)) || preview,
  );
  const client = selected && principal?.startsWith("client:") ? principal : undefined;
  const name = selected?.name ?? (preview ? "Preview workspace" : "Select Gateway");
  const status = switching ? "Connecting…" : connected ? "Connected" : "Not connected";

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
          data-connected={connected && !switching}
          aria-label={connected ? "Switch Gateway" : "Select Gateway"}
          aria-description={
            selected
              ? `Current Gateway is ${selected.name}${client ? `, connected as ${client}` : ""}`
              : undefined
          }
          title={client ? `${name} · ${selected?.address} · connected as ${client}` : name}
          disabled={busy || switching}
        >
          <span className="connection-icon" aria-hidden>
            <Server size={17} />
          </span>
          {wide ? (
            <>
              <span className="connection-text">
                <span className="row-title">{name}</span>
                <small className="connection-status">
                  <span className="connection-dot" aria-hidden />
                  {status}
                </small>
              </span>
              <ChevronsUpDown className="connection-chevron" size={14} aria-hidden />
            </>
          ) : (
            <span className="connection-dot" aria-hidden />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="gateway-menu"
        side={wide ? "top" : "right"}
        align={wide ? "start" : "end"}
        sideOffset={wide ? 8 : 24}
      >
        <div className="gateway-current">
          <span>{name}</span>
          {selected && selected.name !== selected.address && <small>{selected.address}</small>}
          {client && <small>Connected as {client}</small>}
        </div>
        <DropdownMenuSeparator className="gateway-separator" />
        {!localChoice && local?.problem && (
          <>
            <DropdownMenuItem className="gateway-choice" disabled>
              <span className="gateway-indicator" aria-hidden />
              <span className="gateway-choice-text">
                <span>Local · not running</span>
                <small>{local.problem}</small>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="gateway-separator" />
          </>
        )}
        {choices.length > 0 && (
          <>
            <DropdownMenuRadioGroup value={active ?? ""} onValueChange={onSelect}>
              {choices.map((choice) => (
                <DropdownMenuRadioItem
                  className="gateway-choice"
                  key={choice.origin}
                  value={choice.origin}
                  textValue={choice.name}
                >
                  <span className="gateway-indicator" aria-hidden>
                    <DropdownMenuItemIndicator>
                      <Check size={14} />
                    </DropdownMenuItemIndicator>
                  </span>
                  <span className="gateway-choice-text">
                    <span>{choice.name}</span>
                    {choice.name !== choice.address && <small>{choice.address}</small>}
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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gateway-action">
            <Bell size={15} aria-hidden /> Notifications
            <ChevronRight className="gateway-edit-arrow" size={14} aria-hidden />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="gateway-edit-menu" sideOffset={6}>
            <DropdownMenuRadioGroup
              value={notifications}
              onValueChange={(value) => setNotifications(value as NotificationLevel)}
            >
              {NOTIFICATION_CHOICES.map(([level, label]) => (
                <DropdownMenuRadioItem
                  className="gateway-choice"
                  key={level}
                  value={level}
                  textValue={label}
                >
                  <span className="gateway-indicator" aria-hidden>
                    <DropdownMenuItemIndicator>
                      <Check size={14} />
                    </DropdownMenuItemIndicator>
                  </span>
                  <span className="gateway-choice-text">
                    <span>{label}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {connected && (
          <DropdownMenuItem className="gateway-action" onSelect={onDisconnect}>
            <Unplug size={15} aria-hidden /> Disconnect
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
