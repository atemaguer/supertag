#!/bin/bash
# The desktop app's Debian postrm. electron-builder fills in the two names in braces below; the
# script otherwise writes shell variables without braces, which the template would take as names.
#
# On remove and purge it drops the /usr/bin/supertag-desktop link and unloads and deletes the
# AppArmor profile after-install.sh installed. On upgrade it does nothing: the new version's
# postinst, which runs after this, keeps both.
# shellcheck disable=SC2016
set -eu

app='/opt/${sanitizedProductName}'
executable='${executable}'

case "${1:-remove}" in
  remove | purge | abort-install | disappear) ;;
  *) exit 0 ;;
esac

if type update-alternatives > /dev/null 2>&1; then
  update-alternatives --remove "$executable" "$app/$executable" || true
fi
# A plain link from a system without alternatives, or one update-alternatives left behind.
if [ -L "/usr/bin/$executable" ] && [ ! -e "/usr/bin/$executable" ]; then
  rm -f "/usr/bin/$executable"
fi

profile="/etc/apparmor.d/$executable"
if [ -f "$profile" ]; then
  # Unload it first so the kernel doesn't keep it until the next boot.
  if [ "$(cat /sys/module/apparmor/parameters/enabled 2> /dev/null)" = Y ] &&
    ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } && type apparmor_parser > /dev/null 2>&1; then
    apparmor_parser --remove "$profile" || true
  fi
  rm -f "$profile" "/var/cache/apparmor/"*/"$executable"
fi
