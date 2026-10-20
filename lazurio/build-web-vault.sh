#!/usr/bin/env bash
# Lazurio overlay "web-vault: sign in with Lazurio or with email".
#
# Builds the web vault that upstream's docker/Dockerfile.debian ships, the way
# dani-garcia/bw_web_builds builds it, with web-vault-login-labels.patch applied,
# and checks the result. The image then takes it in place of the prebuilt one:
#
#   lazurio/build-web-vault.sh "$out"
#   docker build --file docker/Dockerfile.debian --build-context vault="$out" .
#
# Writes into the empty directory $out:
#   web-vault/        the web vault, which the stage `vault` provides as /web-vault
#   web-vault.sha256  sha256sum of every file, sorted by path
#   web-vault.json    the pins, the patch's sha256 and the sha256 of web-vault.sha256
#
# Needs bash, git, curl, jq and Docker. npm runs only inside the Node container.
# Runbook: docs/lazurio-fork-release.md.
set -euo pipefail

# The web vault that upstream pins (vault_version in docker/DockerSettings.yaml),
# the vaultwarden/vw_web_builds commit that bw_web_builds builds for it and the
# Node image it builds in (both from bw_web_builds' Dockerfile at that tag), and
# that image's digest. An upstream refresh updates all four (see the runbook).
VAULT_VERSION=v2026.7.0
VW_WEB_BUILDS_COMMIT=d2a095eb800fe80a9bc524579b974796eae51994
NODE_IMAGE=node:24-trixie
NODE_IMAGE_DIGEST=sha256:ff054b356ab93ed540518ca23cfcd9840e5256dd04db5a8d8afc43f4ecc7c9f8

fail() {
  echo "web vault: $*" >&2
  exit 1
}

[ "$#" = 1 ] || fail "usage: $0 <empty output directory>"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patch="$here/web-vault-login-labels.patch"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
[ -z "$(ls -A "$out")" ] || fail "$out is not empty"

# The pins follow upstream.
grep -Fxq "vault_version: \"$VAULT_VERSION\"" "$here/../docker/DockerSettings.yaml" ||
  fail "docker/DockerSettings.yaml no longer pins $VAULT_VERSION; refresh the pins in $0 (see the runbook)"
bw_dockerfile="$(curl -fsSL --retry 3 "https://raw.githubusercontent.com/dani-garcia/bw_web_builds/refs/tags/$VAULT_VERSION/Dockerfile")"
grep -Fxq "FROM $NODE_IMAGE AS build" <<< "$bw_dockerfile" ||
  fail "bw_web_builds $VAULT_VERSION does not build in $NODE_IMAGE"
grep -Fxq "ARG VAULT_VERSION=$VW_WEB_BUILDS_COMMIT" <<< "$bw_dockerfile" ||
  fail "bw_web_builds $VAULT_VERSION does not build vw_web_builds $VW_WEB_BUILDS_COMMIT"

# The exact source with the patch. A patch that no longer applies stops here.
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/web-vault.XXXXXX")"
trap 'rm -rf "$work"' EXIT
src="$work/vw_web_builds"
git init -q "$src"
git -C "$src" fetch -q --depth 1 https://github.com/vaultwarden/vw_web_builds.git "$VW_WEB_BUILDS_COMMIT"
git -C "$src" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
[ "$(git -C "$src" rev-parse HEAD)" = "$VW_WEB_BUILDS_COMMIT" ] || fail "fetched the wrong commit"
git -C "$src" apply --verbose "$patch" ||
  fail "web-vault-login-labels.patch does not apply to vw_web_builds $VW_WEB_BUILDS_COMMIT; re-author it (see the runbook)"

# The commands of bw_web_builds' scripts/build_web_vault.sh, in its Node image.
docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp/home \
  --volume "$src:/vw_web_builds" --workdir /vw_web_builds \
  "docker.io/library/$NODE_IMAGE@$NODE_IMAGE_DIGEST" \
  bash -euo pipefail -c 'mkdir -p "$HOME" && node --version && npm --version && npm ci && cd apps/web && npm run dist:oss:selfhost'
# bw_web_builds writes its newest tag here, which is the built version only at
# its release; this records the version that was built.
printf '{"version":"%s"}' "${VAULT_VERSION#v}" > "$src/apps/web/build/vw-version.json"
vault="$out/web-vault"
mv "$src/apps/web/build" "$vault"

# The labels.
label() { # label <language> <key> <text>
  jq -e --arg key "$2" --arg text "$3" '.[$key].message == $text' "$vault/locales/$1/messages.json" > /dev/null ||
    fail "locales/$1/messages.json does not say \"$3\" for $2"
}
label en lazurioSignIn "Sign in with Lazurio"
label en lazurioSignInWithEmail "Sign in with email"
label cs lazurioSignIn "Přihlásit se účtem Lazurio"
label cs lazurioSignInWithEmail "Přihlásit se e-mailem"

# The login page, the only code with the class vw-sso-login, uses both keys and
# keeps the class that SSO_ONLY hides. The old SSO label, which only the login
# page used, is gone.
login="$(grep -rlw --include='*.js' vw-sso-login "$vault" || true)"
[ -n "$login" ] || fail "no script renders the login page"
while IFS= read -r file; do
  for word in lazurioSignIn lazurioSignInWithEmail vw-other-login; do
    grep -qw "$word" "$file" || fail "${file#"$vault/"} renders the login page without $word"
  done
  echo "Login page: ${file#"$vault/"}"
done <<< "$login"
if grep -rlw --include='*.js' useSingleSignOn "$vault"; then
  fail "the web vault still uses useSingleSignOn"
fi

# What was built.
(cd "$out" && find web-vault -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$out/web-vault.sha256"
jq -n --sort-keys \
  --arg version "$VAULT_VERSION" \
  --arg commit "$VW_WEB_BUILDS_COMMIT" \
  --arg node_image "docker.io/library/$NODE_IMAGE@$NODE_IMAGE_DIGEST" \
  --arg patch_sha256 "$(sha256sum < "$patch" | cut -d ' ' -f 1)" \
  --argjson files "$(wc -l < "$out/web-vault.sha256")" \
  --arg files_sha256 "$(sha256sum < "$out/web-vault.sha256" | cut -d ' ' -f 1)" \
  '{
    version: $version,
    source_repository: "https://github.com/vaultwarden/vw_web_builds",
    source_commit: $commit,
    node_image: $node_image,
    patch: "lazurio/web-vault-login-labels.patch",
    patch_sha256: $patch_sha256,
    files: $files,
    files_sha256: $files_sha256
  }' > "$out/web-vault.json"
cat "$out/web-vault.json"
