import type { MenuItemConstructorOptions } from "electron";

/**
 * The app's menu, in place of Electron's default: the app menu on macOS, Edit (without it the
 * standard copy, paste and undo shortcuts stop working), View with zoom (and the developer tools
 * only in development), and Window.
 */
export function menuTemplate(options: {
  mac: boolean;
  development: boolean;
}): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (options.mac) {
    template.push({
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({ role: "fileMenu", submenu: [{ role: "quit" }] });
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
