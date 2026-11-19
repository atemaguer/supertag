#!/bin/bash
# The desktop app's Debian postinst. electron-builder fills in the two names in braces below; the
# script otherwise writes shell variables without braces, which the template would take as names.
#
# It links /usr/bin/supertag-desktop, keeps Chromium's setuid sandbox helper usable, and, where
# AppArmor can load it, installs the profile that lets the app's own executable create the user
# namespaces Chromium's sandbox needs: Ubuntu 23.10 and later refuse them to unconfined programs
# (kernel.apparmor_restrict_unprivileged_userns=1). The app is never started without its sandbox.
# shellcheck disable=SC2016
set -eu

app='/opt/${sanitizedProductName}'
executable='${executable}'
binary="$app/$executable"

if type update-alternatives > /dev/null 2>&1; then
  # Replace an earlier plain link with the alternative.
  if [ -L "/usr/bin/$executable" ] && [ "$(readlink "/usr/bin/$executable")" != "/etc/alternatives/$executable" ]; then
    rm -f "/usr/bin/$executable"
  fi
  update-alternatives --install "/usr/bin/$executable" "$executable" "$binary" 100 ||
    ln -sf "$binary" "/usr/bin/$executable"
else
  ln -sf "$binary" "/usr/bin/$executable"
fi

# Chromium falls back to this setuid helper when it can't create a user namespace. Unlike
# electron-builder's default script, keep it setuid even when root can create one now: the
# restriction applies to the user who runs the app, not to this script.
chown root:root "$app/chrome-sandbox"
chmod 4755 "$app/chrome-sandbox"

if type update-mime-database > /dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
if type update-desktop-database > /dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

profile_source="$app/resources/apparmor-profile"
profile="/etc/apparmor.d/$executable"
if [ -d /etc/apparmor.d ] && type apparmor_parser > /dev/null 2>&1; then
  # The profile needs AppArmor 4 (abi/4.0, Ubuntu 24.04). An older AppArmor has no such
  # restriction, so skip the profile rather than install one it can't parse.
  if apparmor_parser --skip-kernel-load --skip-cache "$profile_source" > /dev/null 2>&1; then
    install -m 0644 "$profile_source" "$profile"
    # Load it now when AppArmor is running, and not in a chroot, where it can't be.
    if [ "$(cat /sys/module/apparmor/parameters/enabled 2> /dev/null)" = Y ] &&
      ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --skip-read-cache --write-cache "$profile" ||
        echo "SuperTag: could not load the AppArmor profile $profile; it loads at the next boot." >&2
    fi
  else
    echo "SuperTag: this AppArmor can't parse the app's profile; skipping it." >&2
  fi
fi
