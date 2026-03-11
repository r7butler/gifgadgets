FROM public.ecr.aws/lambda/python:3.11

# Pre-install numpy with a pinned version that has manylinux pre-built wheels.
# numpy >=2.x requires GCC >=9.3, but Amazon Linux 2 ships GCC 7.3.1, so we
# pin to 1.26.x which has wheels and is compatible with torch 2.x.
RUN pip install --no-cache-dir "numpy==1.26.4"

# Install PyTorch CPU-only wheel. Pass the pinned numpy so pip doesn't
# try to upgrade it to a version that needs a compiler to build.
RUN pip install --no-cache-dir \
    torch torchvision "numpy==1.26.4" \
    --extra-index-url https://download.pytorch.org/whl/cpu

# Install SAM2 from Meta's GitHub tarball (no git needed) and Pillow
RUN pip install --no-cache-dir \
    "https://github.com/facebookresearch/sam3/archive/refs/heads/main.tar.gz" \
    Pillow

# Download SAM2-tiny checkpoint (~38 MB) — baked into the image at build time
RUN curl -fsSL -o /var/task/sam2_tiny.pt \
    https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt

COPY handler.py /var/task/

CMD ["handler.handler"]
