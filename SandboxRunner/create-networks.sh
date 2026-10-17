#!/bin/sh
set -eu

docker network inspect sigmagpt-build-egress >/dev/null 2>&1 || docker network create --driver bridge --internal sigmagpt-build-egress
docker network inspect sigmagpt-preview-internal >/dev/null 2>&1 || docker network create --driver bridge --internal sigmagpt-preview-internal
install -d -m 0700 -o 1000 -g 1000 /srv/sigmagpt-sandboxes
