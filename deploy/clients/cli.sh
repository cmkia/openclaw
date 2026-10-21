#!/bin/sh
# Run native maintenance commands with this tenant's runtime secret references.
set -eu
tenant=${1:?Usage: sh cli.sh TENANT COMMAND [ARGUMENTS...]}
shift
case "$tenant" in
  ''|*[!a-z0-9-]*) echo 'Invalid tenant slug' >&2; exit 2 ;;
esac
container=$(docker ps --filter "label=com.docker.swarm.service.name=openclaw-${tenant}_gateway" --format '{{.ID}}')
if [ -z "$container" ]; then
  echo 'No running tenant Gateway on this node' >&2
  exit 1
fi
exec docker exec -i "$container" /bin/sh -ec '
  export OPENCLAW_GATEWAY_TOKEN="$(cat /run/secrets/gateway_token)"
  export OMNIROUTE_API_KEY="$(cat /run/secrets/omniroute_key)"
  exec node dist/index.js "$@"
' -- "$@"
