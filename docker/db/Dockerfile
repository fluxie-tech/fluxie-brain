# Postgres 19 + pgvector 0.8.7 + pg_textsearch 1.6.0 (BM25), per SPEC-embeddings.md, Emenda 1.
# pg_textsearch is compiled here, against the exact server headers of the base image, from the release
# source tarball pinned by version and sha256 (GitHub release digest). Bump all three together, deliberately.
FROM pgvector/pgvector:0.8.7-pg19 AS build

ARG PG_TEXTSEARCH_VERSION=1.6.0
ARG PG_TEXTSEARCH_SHA256=356244be92ff10caa9669d41e313724ba1d94dd0542fd0da8432e95ef9b7f8fd

# Headers pinned to the installed server version, so the module matches the server it loads into.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates curl \
    "postgresql-server-dev-${PG_MAJOR}=$(dpkg-query -W -f='${Version}' "postgresql-${PG_MAJOR}")" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl -fsSL -o src.tar.gz \
    "https://github.com/timescale/pg_textsearch/releases/download/v${PG_TEXTSEARCH_VERSION}/pg_textsearch-${PG_TEXTSEARCH_VERSION}.tar.gz" \
  && echo "${PG_TEXTSEARCH_SHA256}  src.tar.gz" | sha256sum -c - \
  && mkdir src && tar -xzf src.tar.gz -C src --strip-components=1 \
  && make -C src -j"$(nproc)" \
  && make -C src install DESTDIR=/out

FROM pgvector/pgvector:0.8.7-pg19
COPY --from=build /out/ /
