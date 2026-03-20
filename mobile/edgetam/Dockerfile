FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    EDGETAM_REPO_URL=https://github.com/facebookresearch/EdgeTAM.git \
    EDGETAM_ROOT=/opt/edgetam \
    OUTPUT_DIR=/workspace/mobile/ios/GifWidgetsMobile/Resources/EdgeTAM

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/mobile/edgetam

COPY mobile/edgetam/export_coreml.py /workspace/mobile/edgetam/export_coreml.py
COPY mobile/edgetam/docker-entrypoint.sh /usr/local/bin/edgetam-export

RUN chmod +x /usr/local/bin/edgetam-export

ENTRYPOINT ["edgetam-export"]
