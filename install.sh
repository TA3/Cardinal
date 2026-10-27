#!/bin/sh
# Installs the `cardinal` binary: the whole app plus its proxy, run on your own
# machine so credentials and queries never reach a Cardinal server.
#
#   curl -fsSL https://github.com/TA3/cardinal/releases/latest/download/install.sh | sh
#
# CARDINAL_VERSION=v1.2.3 picks a release (default: latest).
# CARDINAL_INSTALL_DIR picks where it goes (default: ~/.local/bin).
set -eu

repo="TA3/cardinal"
version="${CARDINAL_VERSION:-latest}"
dir="${CARDINAL_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS: $(uname -s). On Windows, download cardinal-windows-x64.exe from the releases page." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# A shell under Rosetta reports x86_64 on Apple Silicon: install the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

asset="cardinal-$os-$arch"
if [ "$version" = latest ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  base="https://github.com/$repo/releases/download/$version"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset ($version)"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $asset; not installing." >&2
  exit 1
fi

mkdir -p "$dir"
install -m 755 "$tmp/$asset" "$dir/cardinal"
echo "Installed $dir/cardinal"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, or run $dir/cardinal" ;;
esac
echo "Run \`cardinal\` and open http://localhost:9181"
