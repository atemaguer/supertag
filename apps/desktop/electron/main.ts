/**
 * The desktop app's main process: one window loading the renderer from `app://supertag/`, locked
 * to it, with the channel table's guarded handlers as its only way to reach this process. A
 * signed build updates itself (`updater.ts`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GatewayState,
  PROTOCOL_VERSIONS,
  probeGateway,
  readLocalGateway,
} from "@supertag/client/node";
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  type WebContents,
} from "electron";
import { MacUpdater } from "electron-updater";
import { NOTIFICATION_CLICK, OPEN_SETTINGS, UPDATE_STATUS } from "./channels";
import { handlers } from "./handlers";
import { originOf, registerChannels, Streams } from "./ipc";
import { type AppIdentity, appCli } from "./local/cli";
import { FileLog, guardStdio } from "./log";
import { menuTemplate } from "./menu";
import { cacheDirectory, configDirectory, gatewayStore } from "./paths";
import { APP_ORIGIN, APP_SCHEME, APP_URL, appResponse, contentSecurityPolicy } from "./protocol";
import { chooseFolder, FOLDER_TITLES, Notifications, webUrl } from "./shell";
import type { UpdateStatus } from "./update-state";
import {
  InstallNote,
  latestRelease,
  localFeed,
  teamSigned,
  UPDATES_OFF,
  Updater,
  type UpdaterHost,
  updatedLine,
} from "./updater";

// A closed stdout or stderr (an app opened from Finder, or a terminal that went away) must never
// turn a log line into an uncaught exception.
guardStdio();

const here = path.dirname(fileURLToPath(import.meta.url));
const mac = process.platform === "darwin";
const development = !app.isPackaged;

/** In development only, the Vite server to load instead of the built renderer. */
function devServer(value: string | undefined): URL | undefined {
  if (!development || !value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("SUPERTAG_DESKTOP_DEV_URL must be an http URL on this machine");
  }
  return url;
}

const devUrl = devServer(process.env["SUPERTAG_DESKTOP_DEV_URL"]);
const devOrigin = devUrl ? originOf(devUrl.href) : undefined;
const trusted = { origins: devOrigin ? [APP_ORIGIN, devOrigin] : [APP_ORIGIN] };
const isAppUrl = (url: string) => {
  const origin = originOf(url);
  return origin !== undefined && trusted.origins.includes(origin);
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
// Chromium's own state sits beside the saved Gateways, in the directory the CLI reads them from.
const profileDirectory = devUrl?.searchParams.has("preview")
  ? path.join(app.getPath("temp"), "supertag-desktop-preview")
  : configDirectory();
app.setPath("userData", profileDirectory);

/**
 * This release and where it runs from, for the CLI it runs: the packaged app's bundled CLI is in
 * its resources; in development there is none, and the CLI on PATH must be this version.
 */
const appIdentity: AppIdentity = {
  version: app.getVersion(),
  execPath: process.execPath,
  resourcesPath: development ? undefined : process.resourcesPath,
  env: process.env,
};

let mainWindow: BrowserWindow | undefined;
const streams = new Streams();

/** The app's own log: ~/Library/Logs/SuperTag/main.log on macOS, under userData elsewhere. */
const log = new FileLog(path.join(app.getPath("logs"), "main.log"));

/** A staged update leaves this, so the new version restarts the local services once. */
const installNote = new InstallNote(profileDirectory, app.getVersion());

/** On the first launch after an update, logs how long the window took, once. */
let updatedFrom = installNote.updated();
function logUpdated() {
  if (!updatedFrom) return;
  const launchedAt = process.getCreationTime() ?? Date.now() - performance.now();
  log.info(updatedLine(updatedFrom, app.getVersion(), launchedAt, Date.now()));
  updatedFrom = undefined;
}

/**
 * How this build updates: macOS installs a downloaded release, but only when Developer ID
 * signed, as Squirrel.Mac requires; a Linux package opens the release page; development builds
 * never check. A packaged but unsigned Mac build may name a local feed in
 * SUPERTAG_DESKTOP_UPDATE_FEED, so the flow can be tried before a signed release; a signed
 * build ignores it and reads the GitHub Release its app-update.yml names.
 */
async function updateMode(): Promise<{ mode: UpdaterHost["mode"]; feed?: string }> {
  if (development) return { mode: "off" };
  if (process.platform === "linux") return { mode: "download" };
  if (!mac) return { mode: "off" };
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (await teamSigned(bundle)) return { mode: "install" };
  const feed = localFeed(process.env["SUPERTAG_DESKTOP_UPDATE_FEED"]);
  return feed ? { mode: "install", feed } : { mode: "off" };
}
const updating = updateMode();
let updater: Updater | undefined;

/** The window's view of the updater, which is off until `updating` decides. */
const updates = {
  get status(): UpdateStatus {
    return updater?.status ?? { state: "off" };
  },
  check: (manual: boolean) => (updater ? updater.check(manual) : Promise.resolve()),
  install: () => (updater ? updater.install() : Promise.reject(UPDATES_OFF)),
};

function say(message: string) {
  const options = { type: "info" as const, message, buttons: ["OK"] };
  void (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
}

async function startUpdates() {
  const { mode, feed } = await updating;
  updater = new Updater({
    version: app.getVersion(),
    mode,
    engine() {
      const engine = new MacUpdater(feed ? { provider: "generic", url: feed } : undefined);
      engine.autoDownload = true;
      // What makes electron-updater hand Squirrel.Mac the zip as soon as it is downloaded. Left
      // off, Squirrel.Mac would fetch, unpack and verify it only after "Restart to update",
      // while the user waits. A staged update also installs on an ordinary quit; the install
      // note has the next launch restart the local services either way.
      engine.autoInstallOnAppQuit = true;
      engine.logger = { info() {}, warn: log.warn, error: log.error, debug() {} };
      return Object.assign(engine, {
        onStaged: (listener: () => void) => autoUpdater.on("update-downloaded", () => listener()),
      });
    },
    latestRelease: () => latestRelease((url, init) => net.fetch(url, init)),
    publish: (status) => mainContents()?.send(UPDATE_STATUS, status),
    openExternal: (url) => shell.openExternal(url),
    say,
    noteInstall: (from, to, restartedAt) => installNote.write(from, to, restartedAt),
    log: (message, error) => log.error(message, error),
    info: (message) => log.info(message),
    now: () => Date.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    setInterval: (run, ms) => setInterval(run, ms),
  });
  if (mode === "off") return;
  // The window may have read "off" before this decided.
  mainContents()?.send(UPDATE_STATUS, updater.status);
  updater.start();
}

const gateway = new GatewayState({
  store: gatewayStore(),
  cache: cacheDirectory(),
  buildVersion: app.getVersion(),
  // The local Gateway, as the app's own CLI reports it.
  discoverLocal: async () => readLocalGateway(await appCli(appIdentity), appIdentity.env),
});

/** A reload, a crash or a closed window drops the session, its Watch and its follows. */
function resetWindow() {
  streams.endAll();
  gateway.disconnect();
}
const mainContents = (): WebContents | undefined =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;

function focusMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const notifications = new Notifications({
  create: (options) => new Notification(options),
  supported: () => Notification.isSupported(),
  clicked(tagId) {
    focusMain();
    mainContents()?.send(NOTIFICATION_CLICK, tagId);
  },
});

/** Keeps a webContents on the app's own pages: no navigation away, no new windows, no webviews. */
function lockNavigation(contents: WebContents) {
  const refuseUnlessApp = (event: { preventDefault(): void }, url: string) => {
    if (!isAppUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", (event) => refuseUnlessApp(event, event.url));
  contents.on("will-frame-navigate", (event) => refuseUnlessApp(event, event.url));
  contents.on("will-redirect", (event) => refuseUnlessApp(event, event.url));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const link = webUrl(url);
    if (link) void shell.openExternal(link).catch(() => {});
    return { action: "deny" };
  });
}

function createWindow() {
  const window = new BrowserWindow({
    title: "SuperTag",
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#19191c",
    show: false,
    // An overlay title bar: the page runs under it, with the window controls.
    ...(mac ? { titleBarStyle: "hidden", trafficLightPosition: { x: 18, y: 22 } } : {}),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true,
      navigateOnDragDrop: false,
      devTools: development,
    },
  });
  mainWindow = window;
  // `web-contents-created` already locked its navigation.
  const contents = window.webContents;
  // A reload or a new page drops what the last one opened.
  contents.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument) resetWindow();
  });
  contents.on("render-process-gone", resetWindow);
  window.once("ready-to-show", () => {
    window.show();
    logUpdated();
  });
  // Coming back to the app is a good moment to find a new release.
  window.on("focus", () => updater?.noticed());
  window.on("closed", () => {
    resetWindow();
    if (mainWindow === window) mainWindow = undefined;
  });
  void window.loadURL(devUrl ? devUrl.href : APP_URL);
}

function start() {
  nativeTheme.themeSource = "dark";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        mac,
        development,
        onCheckForUpdates: () => void updates.check(true),
        onSettings: () => mainContents()?.send(OPEN_SETTINGS),
      }),
    ),
  );
  app.setAboutPanelOptions({ applicationName: "SuperTag", applicationVersion: app.getVersion() });

  const renderer = path.join(app.getAppPath(), "dist");
  protocol.handle(APP_SCHEME, (request) => appResponse(renderer, request));

  const defaultSession = session.defaultSession;
  // The page may copy text it shows; it asks for nothing else (notifications go through IPC).
  defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(permission === "clipboard-sanitized-write" && isAppUrl(details.requestingUrl)),
  );
  defaultSession.setPermissionCheckHandler(
    (_contents, permission, origin) =>
      permission === "clipboard-sanitized-write" && isAppUrl(origin),
  );
  if (devOrigin) {
    // The Vite server sends no CSP; the window gets the development one.
    defaultSession.webRequest.onHeadersReceived({ urls: [`${devOrigin}/*`] }, (details, done) =>
      done({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy(devOrigin)],
        },
      }),
    );
  }

  registerChannels(
    ipcMain,
    handlers(
      {
        notify: (request) => notifications.show(request),
        setBadge: (count) => {
          app.setBadgeCount(count);
        },
        openExternal: (url) => shell.openExternal(url),
        chooseFolder: () => chooseFolder(dialog, mainWindow),
        reveal: (file) => shell.showItemInFolder(file),
        updates,
      },
      { state: gateway, cacheRoot: cacheDirectory() },
      {
        app: appIdentity,
        protocolVersions: PROTOCOL_VERSIONS,
        probe: (url, token) => probeGateway(url, token, app.getVersion()),
        chooseWorkspaceFolder: () => chooseFolder(dialog, mainWindow, FOLDER_TITLES.workspace),
        localStateOf: (connectionId) => gateway.localStateOf(connectionId),
        update: installNote,
      },
    ),
    { mainWindow: mainContents, trusted, streams },
  );

  createWindow();
  void startUpdates();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch focuses the window this one shows.
  app.on("second-instance", focusMain);
  app.on("web-contents-created", (_event, contents) => lockNavigation(contents));
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => updater?.quitting());
  app.on("activate", () => {
    if (!app.isReady()) return;
    if (!mainWindow) createWindow();
    else focusMain();
  });
  void app.whenReady().then(start);
}
