# Puck Workshop audit - the same pipeline as the operator's PC, in a container.
#
#   docker build -t puck-audit .
#   docker run --rm -e ID=3765045334 -v "%CD%\audit-out:/work/audit-out" puck-audit
#
# What is inside: Node 22 (scripts), .NET 8 + ILSpy CLI (decompilation),
# steamcmd (anonymous Workshop downloads) and the usual PE tooling.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DOTNET_ROOT=/usr/share/dotnet \
    TZ=UTC \
    PATH=/usr/share/dotnet:/root/.dotnet/tools:/opt/steamcmd:/usr/local/bin:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl file binutils unzip xz-utils python3 procps tzdata libicu72 \
      lib32gcc-s1 lib32stdc++6 \
 && rm -rf /var/lib/apt/lists/*

# .NET SDK: ilspycmd is a dotnet tool and needs the SDK to install.
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && bash /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
 && ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
 && dotnet --version

# ILSpy CLI (ICSharpCode.Decompiler) - the engine behind ILSpy.
RUN dotnet tool install --global ilspycmd \
 && ilspycmd --version

# steamcmd: anonymous Workshop downloads, no Steam account needed.
RUN mkdir -p /opt/steamcmd \
 && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
      | tar -xz -C /opt/steamcmd \
 && ln -sf /opt/steamcmd/steamcmd.sh /usr/local/bin/steamcmd \
 && (steamcmd +quit || true)

WORKDIR /work
COPY . .

RUN chmod +x docker/entrypoint.sh scripts/install-audit-tools.sh scripts/audit-box.mjs \
 && node --version && ilspycmd --version | head -2

ENTRYPOINT ["/work/docker/entrypoint.sh"]
CMD []
