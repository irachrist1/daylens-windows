#!/bin/sh
# Custom post-remove script for Daylens (shared by .deb and .rpm).
#
# Mirrors electron-builder's default after-remove: drop the PATH symlink and refresh
# the desktop database on uninstall. POSIX sh (no bashisms) so rpm's %postun can run it.

set -e

EXECUTABLE='daylens'

# Only clean up on a real uninstall, NOT during an upgrade. rpm runs the old
# package's %postun AFTER the new package's %post, so an unconditional removal
# would delete the symlink the upgrade just created, leaving users without
# `daylens` on PATH. rpm passes the remaining-instance count ($1 = 0 on final
# removal, >= 1 on upgrade); deb passes an action word ("remove"/"purge" for a
# real removal, "upgrade" otherwise).
case "${1:-}" in
  0|remove|purge)
    if [ -L "/usr/bin/$EXECUTABLE" ]; then
        rm -f "/usr/bin/$EXECUTABLE"
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
    fi
    # The marker records the exact path used when XDG_CONFIG_HOME is custom.
    if command -v getent >/dev/null 2>&1; then
        getent passwd | cut -d: -f6 | while read -r home; do
            if [ -n "$home" ] && [ "$home" != "/" ]; then
                rm -f "$home/.config/autostart/daylens.desktop" 2>/dev/null || true
                marker="$home/.daylens-autostart-path"
                if [ -f "$marker" ]; then
                    IFS= read -r autostart < "$marker" || true
                    case "$autostart" in
                      */autostart/daylens.desktop)
                        if [ -f "$autostart" ] && grep -q '^Name=Daylens$' "$autostart" && grep -q '^StartupWMClass=daylens$' "$autostart"; then
                            rm -f "$autostart" 2>/dev/null || true
                        fi
                        ;;
                    esac
                    rm -f "$marker" 2>/dev/null || true
                fi
            fi
        done
    else
        rm -f /home/*/.config/autostart/daylens.desktop /root/.config/autostart/daylens.desktop 2>/dev/null || true
    fi
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then
        rm -f "$XDG_CONFIG_HOME/autostart/daylens.desktop" 2>/dev/null || true
    fi
    ;;
esac

exit 0
