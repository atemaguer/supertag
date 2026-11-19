#!/bin/bash
# Install the desktop app's Debian package, launch it with Chromium's sandbox, and remove it,
# checking that it leaves nothing behind.
#
#   check-desktop-deb.sh DEB
#
# Where AppArmor runs, as on Ubuntu 24.04, it turns on Ubuntu's restriction on unprivileged user
# namespaces (kernel.apparmor_restrict_unprivileged_userns=1), checks that the package loaded its
# AppArmor profile, and launches the app twice: once as installed, and once with the setuid
# sandbox helper made unusable, so that only the profile's user namespaces can sandbox it. Where
# AppArmor doesn't run, such as in most containers, it launches the app once, on the setuid helper.
#
# Run it as a user with passwordless sudo (Chromium never runs sandboxed as root), from a checkout
# with `pnpm install` done: the launch is apps/desktop's smoke test, under xvfb-run.
set -euo pipefail

deb=$(realpath "${1:?Usage: check-desktop-deb.sh DEB}")
repo=$(cd "$(dirname "$0")/.." && pwd)
app=/opt/SuperTag
profile=/etc/apparmor.d/supertag-desktop
fail() { echo "check-desktop-deb: $*" >&2; exit 1; }

[[ "$(id -u)" != 0 ]] || fail "run this as a user other than root"
sudo apt-get install -y --no-install-recommends "$deb"

[[ "$(stat -c '%U %a' "$app/chrome-sandbox")" == "root 4755" ]] ||
  fail "$app/chrome-sandbox is not setuid root"
[[ "$(readlink -f /usr/bin/supertag-desktop)" == "$app/supertag-desktop" ]] ||
  fail "/usr/bin/supertag-desktop does not run the app"
[[ -f /usr/share/applications/supertag-desktop.desktop ]] || fail "no desktop entry"

apparmor=false
if [[ "$(cat /sys/module/apparmor/parameters/enabled 2> /dev/null)" == Y ]] &&
  sudo test -r /sys/kernel/security/apparmor/profiles; then
  apparmor=true
fi
loaded() { sudo grep -q '^supertag-desktop ' /sys/kernel/security/apparmor/profiles; }

launch() {
  (cd "$repo" && xvfb-run -a pnpm --filter @supertag/desktop smoke "$app/supertag-desktop")
}

if [[ "$apparmor" == true ]]; then
  [[ -f "$profile" ]] || fail "the package installed no $profile"
  loaded || fail "the AppArmor profile supertag-desktop is not loaded"
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1
  echo "Launching with the setuid helper and the AppArmor profile:"
  launch
  echo "Launching without the setuid helper, so only the AppArmor profile can sandbox it:"
  sudo chmod 0755 "$app/chrome-sandbox"
  status=0
  launch || status=$?
  sudo chmod 4755 "$app/chrome-sandbox"
  [[ "$status" == 0 ]] || fail "the app did not start sandboxed through its AppArmor profile"
else
  echo "AppArmor is not running here: loading the profile and the user-namespace restriction go unchecked."
  if [[ -d /etc/apparmor.d ]] && type apparmor_parser > /dev/null 2>&1; then
    [[ -f "$profile" ]] || fail "the package installed no $profile"
    sudo apparmor_parser --skip-kernel-load --skip-cache "$profile" ||
      fail "AppArmor can't parse $profile"
    echo "The package installed $profile, and it parses."
  fi
  echo "Launching with the setuid helper:"
  launch
fi

sudo apt-get purge -y supertag-desktop
for path in "$app" /usr/bin/supertag-desktop /usr/share/applications/supertag-desktop.desktop "$profile"; do
  [[ ! -e "$path" && ! -L "$path" ]] || fail "removing the package left $path"
done
if [[ "$apparmor" == true ]] && loaded; then
  fail "removing the package left the AppArmor profile loaded"
fi
echo "The package installed, launched sandboxed, and uninstalled cleanly."
