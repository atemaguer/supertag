import type { MenuItemConstructorOptions } from "electron";

/**
 * The app's menu, in place of Electron's default: the app menu on macOS (File elsewhere), with
 * "Settings…" and "Check for Updates…"; Edit (without it the standard copy, paste and undo shortcuts stop
 * working); View with zoom (and the developer tools only in development); and Window.
 */
export function menuTemplate(options: {
  mac: boolean;
  development: boolean;
  /** "Check for Updates…": in the app menu on macOS, in File elsewhere. */
  onCheckForUpdates?: () => void;
  /** "Settings…", with ⌘, (Ctrl+, elsewhere): beside "Check for Updates…". */
  onSettings?: () => void;
}): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const check: MenuItemConstructorOptions[] = options.onCheckForUpdates
    ? [{ label: "Check for Updates…", click: options.onCheckForUpdates }]
    : [];
  const settings: MenuItemConstructorOptions[] = options.onSettings
    ? [{ label: "Settings…", accelerator: "CmdOrCtrl+,", click: options.onSettings }]
    : [];
  if (options.mac) {
    template.push({
      role: "appMenu",
      submenu: [
        { role: "about" },
        ...check,
        ...(settings.length > 0 ? [{ type: "separator" } as const] : []),
        ...settings,
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({
      role: "fileMenu",
      submenu: [
        ...settings,
        ...check,
        ...(check.length + settings.length > 0 ? [{ type: "separator" } as const] : []),
        { role: "quit" },
      ],
    });
  }
  template.push({
    role: "editMenu",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(options.mac ? [{ role: "pasteAndMatchStyle" } as const] : []),
      { role: "delete" },
      { role: "selectAll" },
    ],
  });
  template.push({
    role: "viewMenu",
    submenu: [
      ...(options.development
        ? [{ role: "reload" } as const, { role: "toggleDevTools" } as const]
        : []),
      ...(options.development ? [{ type: "separator" } as const] : []),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });
  template.push({
    role: "windowMenu",
    submenu: options.mac
      ? [
          { role: "minimize" },
          { role: "zoom" },
          { role: "close" },
          { type: "separator" },
          { role: "front" },
        ]
      : [{ role: "minimize" }, { role: "close" }],
  });
  return template;
}
