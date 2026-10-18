#!/bin/sh
# FFmpeg extracted from Ubuntu packages, without modifying system packages.
PEX_FFMPEG_RUNTIME="$HOME/.local/opt/pex-fileshare/ffmpeg-runtime"
export LD_LIBRARY_PATH="$PEX_FFMPEG_RUNTIME/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$PEX_FFMPEG_RUNTIME/usr/bin/ffmpeg" "$@"
