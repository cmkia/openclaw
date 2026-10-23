#!/bin/sh
# Run the installed gog owner with the tenant's persistent config and keyring.
set -eu
tenant=${1:?Usage: sh auth.sh TENANT GOG_ARGUMENTS...}
shift
case "$tenant" in
  ''|*[!a-z0-9-]*) echo 'Invalid tenant slug' >&2; exit 2 ;;
esac
container=$(docker ps --filter "label=com.docker.swarm.service.name=openclaw-${tenant}_gateway" --format '{{.ID}}')
if [ -z "$container" ] || [ "$(printf '%s\n' "$container" | wc -l)" -ne 1 ]; then
  echo 'Exactly one tenant Gateway must be running on this node' >&2
  exit 1
fi
exec docker exec -i --user 1000:1000 "$container" /bin/sh -ec '
  export GOG_KEYRING_PASSWORD="$(cat /run/secrets/calendar_keyring_password)"
  exec gog "$@"
' -- "$@"
