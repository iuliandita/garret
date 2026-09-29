# Private APK build environment; no app data or signing keys in this image.
FROM rust:1.98.1-bookworm@sha256:c49256cbe5ea0188bc658a689500d70c41eb51f009a7a7be209caf60a944f3ec

RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jdk-headless nodejs npm unzip python3 \
 && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV JAVA_TOOL_OPTIONS=-XX:ActiveProcessorCount=8
ENV NDK_HOME=/opt/android-sdk/ndk/30.0.16248370
ENV PATH=/opt/android-sdk/cmdline-tools/current/bin:/opt/android-sdk/platform-tools:$PATH
ENV CARGO_BUILD_JOBS=8

RUN curl --fail --location --retry 3 \
      https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip \
      --output /tmp/android-tools.zip \
 && printf '%s  %s\n' 4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583 /tmp/android-tools.zip > /tmp/android-tools.sha256 \
 && sha256sum --check /tmp/android-tools.sha256 \
 && mkdir -p /opt/android-sdk/cmdline-tools \
 && unzip -q /tmp/android-tools.zip -d /opt/android-sdk/cmdline-tools \
 && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/current \
 && rm /tmp/android-tools.zip /tmp/android-tools.sha256

RUN python3 -c 'import subprocess; subprocess.run(["sdkmanager", "--licenses"], input="y\n" * 100, text=True, check=True); subprocess.run(["sdkmanager", "platform-tools", "platforms;android-37.0", "build-tools;37.0.0", "ndk;30.0.16248370"], input="y\n" * 100, text=True, check=True)'
RUN rustup target add aarch64-linux-android x86_64-linux-android
RUN npm install --global --ignore-scripts @tauri-apps/cli@2.11.5
RUN useradd --create-home --uid 1000 builder

# Tauri's generated Android project currently compiles against API 36.
RUN sdkmanager "platforms;android-36" "build-tools;36.0.0"
RUN sdkmanager "build-tools;35.0.0"

# The launcher supplies the host UID and writable task-specific cache mounts.
USER builder
WORKDIR /src
CMD ["tauri", "--help"]
