Wheels for the packages in requirements.txt go here.

Workpeg builds a function image with no network, so the Dockerfile installs
from this folder only (pip install --no-index --find-links=/wheels). Fill it
before you build or submit, by running pip inside the image your Dockerfile
starts FROM. Run it from the folder that holds the Dockerfile and
requirements.txt (the one above this README). If you change the FROM line,
change the image below to match:

    docker run --rm --platform linux/amd64 \
      --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$PWD:/w" -w /w --entrypoint pip \
      registry.gitlab.com/workpeg/workpeg-sdk/pegfn-base:0.158.0 \
      wheel --no-cache-dir --wheel-dir wheels -r requirements.txt

Inside that image pip picks the wheels it can install, with every package
they depend on. Avoid `pip download --platform ...` on your own computer: it
matches one tag exactly and misses wheels tagged with older Linux names.

Run it again whenever requirements.txt changes. When requirements.txt is
empty there is nothing to fill, but keep this folder and this file: the
Dockerfile copies wheels/, and the build fails without it. The SDK itself is
already in the base image; do not list workpeg in requirements.txt.

To build the way Workpeg does before you submit, from the same folder:

    workpeg function build --like-workpeg

It checks the Dockerfile by the rules Workpeg's install applies, then builds
with --pull --network=none --platform=linux/amd64, as Workpeg does.
