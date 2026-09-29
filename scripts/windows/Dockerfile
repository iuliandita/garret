# Cross-builds the host for Windows. A container rather than the host toolchain
# because the development machine's Rust is the distro package, which ships Linux std only;
# adding a Windows target needs rustup, and on Arch installing rustup REPLACES
# the rust package. A container leaves the machine untouched and makes the build
# the same everywhere.
#
# Tauri documents this route (cargo-xwin + the MSVC target) but calls it a last
# resort. It is a last resort here too: the binary it produces has never been
# run on real Windows by this project, only cross-compiled and exercised under
# wine for its non-GUI paths.
FROM rust:1-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends clang lld llvm \
 && rm -rf /var/lib/apt/lists/*

RUN rustup target add x86_64-pc-windows-msvc
RUN cargo install --locked -j8 cargo-xwin

ENV XWIN_CACHE_DIR=/xwin
ENV CARGO_HOME=/cargo
