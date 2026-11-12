#!/usr/bin/env bash
# What the configuration of the demo names as `claude`: runs the stand-in next to this file.
exec node "$(dirname "$0")/fake-claude.ts" "$@"
